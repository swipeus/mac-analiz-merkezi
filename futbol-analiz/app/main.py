import asyncio
import hashlib
import hmac
import json
import logging
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse, RedirectResponse,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

from . import players
from .config import DB_PATH, LEAGUES, SITE_PASSWORD, STATIC_DIR, TR_TZ
from .sources import Sources
from .store import Store
from .updater import Updater, enrich_day

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

store = Store(DB_PATH)
src = Sources(store)
updater = Updater(store, src)


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(updater.run())
    yield
    task.cancel()
    await src.close()


app = FastAPI(title="Futbol Analiz", lifespan=lifespan)

# --- basit şifre koruması (arkadaş grubu için) ---
COOKIE = "mac_oturum"
OPEN_PATHS = {"/giris", "/healthz"}


def _token():
    return hmac.new(SITE_PASSWORD.encode(), b"mac-analiz-merkezi", hashlib.sha256).hexdigest()


@app.middleware("http")
async def require_login(request: Request, call_next):
    if not SITE_PASSWORD or request.url.path in OPEN_PATHS:
        return await call_next(request)
    if hmac.compare_digest(request.cookies.get(COOKIE, ""), _token()):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "Giriş gerekli"}, status_code=401)
    return RedirectResponse("/giris", status_code=303)


LOGIN_HTML = """<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Giriş · Maç Analiz Merkezi</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;
color:#e6edf3;font:15px system-ui,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
form{background:#161b22;border:1px solid #2b3440;border-radius:14px;padding:24px;width:100%;max-width:340px}
h1{font-size:19px;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;
border-radius:9px;border:1px solid #2b3440;background:#1f2630;color:#e6edf3}button{margin-top:12px;background:#2ea043;
border-color:#2ea043;color:#fff;font-weight:600;cursor:pointer}.err{color:#f85149;margin-top:10px}</style></head>
<body><form method="post" action="/giris"><h1>Maç Analiz Merkezi</h1>
<input type="password" name="sifre" placeholder="Şifre" autocomplete="current-password" autofocus required>
<button type="submit">Giriş</button>{err}</form></body></html>"""


@app.get("/giris")
def login_page():
    return HTMLResponse(LOGIN_HTML.replace("{err}", ""))


@app.post("/giris")
async def login(request: Request):
    form = urllib.parse.parse_qs((await request.body()).decode())
    pw = (form.get("sifre") or [""])[0]
    if not SITE_PASSWORD or not hmac.compare_digest(pw, SITE_PASSWORD):
        return HTMLResponse(LOGIN_HTML.replace("{err}", '<div class="err">Şifre yanlış</div>'), status_code=401)
    resp = RedirectResponse("/", status_code=303)
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp.set_cookie(COOKIE, _token(), max_age=90 * 24 * 3600, httponly=True, samesite="lax", secure=secure)
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True, "last_cycle": updater.last_cycle}


@app.get("/api/leagues")
def leagues():
    return [{"id": k, "name": v} for k, v in LEAGUES.items()]


@app.get("/api/day")
async def day(date: str | None = None):
    d = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=TR_TZ) if date else datetime.now(TR_TZ)
    try:
        matches = await updater.day(d)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Maç listesi alınamadı: {e}")
    enrich_day(store, matches)
    return {"date": d.strftime("%Y-%m-%d"), "matches": matches, "last_cycle": updater.last_cycle}


@app.get("/api/match/{match_id}")
async def match(match_id: int, refresh: bool = False):
    b = store.bundle_get(match_id)
    if b is None or refresh:
        try:
            body = await updater.refresh_match(match_id, datetime.now(TR_TZ).strftime("%Y-%m-%d"))
        except Exception as e:  # noqa: BLE001
            if b is None:
                raise HTTPException(502, f"Maç verisi alınamadı: {e}")
            body = b["body"]
        return body
    return b["body"]


@app.get("/api/player/{player_id}")
async def player(player_id: int):
    p = await players.get_player(src, store, player_id)
    if not p:
        raise HTTPException(404, "Oyuncu verisi bulunamadı")
    return p


@app.get("/api/team/{team_id}")
async def team(team_id: int):
    from . import teams
    bodies = [b["body"] for b in (store.bundle_get(r[0]) for r in store.conn.execute("select match_id from bundles")) if b]
    bodies = [b for b in bodies if team_id in (b["home"]["id"], b["away"]["id"])]
    if not bodies:
        raise HTTPException(404, "Bu takımın sayfası yok (yalnızca listedeki maçların takımları)")
    return (await teams.collect_pages(src, bodies)).get(team_id)


@app.get("/api/teams")
def team_list():
    seen = {}
    for (body,) in store.conn.execute("select body from bundles"):
        import json
        b = json.loads(body)
        for s in ("home", "away"):
            seen[b[s]["id"]] = {"id": b[s]["id"], "name": b[s]["name"], "league_id": b.get("league_id")}
    return list(seen.values())


@app.get("/api/karne")
def karne_rows():
    from . import karne
    return karne.export(store)


@app.get("/api/events/recent")
def recent_events(limit: int = 30):
    return store.recent_events(limit)


@app.get("/api/events")
async def events(request: Request):
    q = asyncio.Queue()
    updater.subscribers.add(q)

    async def gen():
        try:
            yield "retry: 5000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            updater.subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
