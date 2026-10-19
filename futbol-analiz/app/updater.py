"""Arka plan güncelleyici: maçları periyodik yeniler, değişiklikleri olay olarak yayınlar."""
import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from . import collect
from .config import (CYCLE_SECONDS, DAY_LIST_TTL, FAR_INTERVAL, LEAGUES, LIVE_INTERVAL,
                     NEAR_INTERVAL, TODAY_INTERVAL, TR_TZ)

log = logging.getLogger("updater")


def day_key(d):
    return d.strftime("%Y-%m-%d")


def summarize_day(raw):
    out = []
    order = list(LEAGUES)
    for lg in (raw or {}).get("leagues") or []:
        lid = lg.get("primaryId")
        if lid not in LEAGUES:
            continue
        for m in lg.get("matches") or []:
            st = m.get("status") or {}
            out.append({
                "id": m["id"],
                "league_id": lid,
                "league": LEAGUES[lid],
                "stage": lg.get("name"),
                "utc": st.get("utcTime"),
                "home": {"id": m["home"]["id"], "name": m["home"]["name"], "score": m["home"].get("score")},
                "away": {"id": m["away"]["id"], "name": m["away"]["name"], "score": m["away"].get("score")},
                "started": st.get("started"), "finished": st.get("finished"),
                "cancelled": st.get("cancelled"),
                "live": (st.get("liveTime") or {}).get("short"),
                "score": st.get("scoreStr"),
            })
    out.sort(key=lambda m: (order.index(m["league_id"]), m["utc"] or ""))
    return out


def enrich_day(store, matches):
    """Gün listesine hazır analizlerden kısa tahmin/kadro özetini ekler."""
    for m in matches:
        b = store.bundle_get(m["id"])
        if b:
            pr = b["body"]["analysis"]["prediction"]
            lu = b["body"].get("lineup") or {}
            m["pred"] = {k: pr[k] for k in ("p_home", "p_draw", "p_away", "over25", "btts", "pick")}
            m["pred"]["score"] = pr["scores"][0]["score"]
            m["lineup_type"] = lu.get("type")
            m["absent"] = [len((lu.get(s) or {}).get("unavailable", [])) for s in ("home", "away")]
            m["updated"] = b["ts"]
    return matches


class Updater:
    def __init__(self, store, src):
        self.store, self.src = store, src
        self.subscribers = set()
        self.building = {}
        self.last_cycle = None

    # --- olay yayını ---
    def publish(self, match_id, kind, text):
        eid = self.store.add_event(match_id, kind, text)
        ev = {"id": eid, "ts": time.time(), "match_id": match_id, "kind": kind, "text": text}
        for q in list(self.subscribers):
            q.put_nowait(ev)

    # --- gün listesi ---
    async def day(self, d, ttl=DAY_LIST_TTL):
        raw = await self.src.day_matches(d.strftime("%Y%m%d"), ttl)
        return summarize_day(raw)

    # --- tek maç ---
    async def refresh_match(self, match_id, day, force=False):
        if match_id in self.building:
            return await self.building[match_id]
        fut = asyncio.ensure_future(self._refresh(match_id, day))
        self.building[match_id] = fut
        try:
            return await fut
        finally:
            self.building.pop(match_id, None)

    async def _refresh(self, match_id, day):
        old = self.store.bundle_get(match_id)
        b = await collect.build_bundle(self.src, match_id)
        sig = collect.signature(b)
        self.store.bundle_put(match_id, day, sig, b)
        if old and old["sig"] != sig:
            self.diff_events(old["body"], b)
        elif not old:
            for q in list(self.subscribers):
                q.put_nowait({"id": 0, "match_id": match_id, "kind": "ready", "text": ""})
        return b

    def diff_events(self, o, n):
        mid = n["id"]
        title = f"{n['home']['name']} - {n['away']['name']}"
        olu, nlu = o.get("lineup") or {}, n.get("lineup") or {}
        if olu.get("type") != nlu.get("type"):
            if nlu.get("confirmed"):
                self.publish(mid, "lineup", f"{title}: resmi ilk 11'ler açıklandı")
            elif nlu.get("type") == "predicted":
                self.publish(mid, "lineup", f"{title}: olası 11'ler yayınlandı")
        for s in ("home", "away"):
            before = {p["name"] for p in (olu.get(s) or {}).get("unavailable", [])}
            for p in (nlu.get(s) or {}).get("unavailable", []):
                if p["name"] not in before:
                    from .analysis import absent_txt
                    self.publish(mid, "absent", f"{n[s]['name']}: yeni eksik, {absent_txt(p)}")
            oldn = {x["title"] for x in o["news"][s]["tr"]}
            for x in n["news"][s]["tr"][:3]:
                if x["title"] not in oldn:
                    self.publish(mid, "news", f"{n[s]['name']}: {x['title']} ({x['source']})")
        if (o["home"]["score"], o["away"]["score"]) != (n["home"]["score"], n["away"]["score"]) and n["status"]["started"]:
            self.publish(mid, "goal", f"{title}: {n['home']['score']}-{n['away']['score']} ({n['status'].get('live') or ''})")
        if not o["status"].get("started") and n["status"].get("started"):
            self.publish(mid, "status", f"{title}: maç başladı")
        if not o["status"].get("finished") and n["status"].get("finished"):
            self.publish(mid, "status", f"{title}: maç bitti, {n['status'].get('score') or ''}")

    def interval(self, m):
        if m.get("finished") or m.get("cancelled"):
            return None
        if m.get("started"):
            return LIVE_INTERVAL
        try:
            ko = datetime.fromisoformat(m["utc"].replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            return TODAY_INTERVAL
        left = (ko - datetime.now(timezone.utc)).total_seconds()
        if left <= 3 * 3600:
            return NEAR_INTERVAL
        if left <= 18 * 3600:
            return TODAY_INTERVAL
        return FAR_INTERVAL

    async def cycle(self):
        today = datetime.now(TR_TZ)
        for d in (today, today + timedelta(days=1)):
            try:
                matches = await self.day(d)
            except Exception as e:  # noqa: BLE001
                log.warning("gün listesi alınamadı: %s", e)
                continue
            due = []
            for m in matches:
                old = self.store.bundle_get(m["id"])
                iv = self.interval(m)
                if old is None:
                    due.append(m)
                elif iv is not None and time.time() - old["ts"] >= iv:
                    due.append(m)
                elif iv is None and not old["body"]["status"].get("finished"):
                    due.append(m)  # bitişi bir kez kaydet
            for i in range(0, len(due), 4):
                chunk = due[i:i + 4]
                res = await asyncio.gather(
                    *[self.refresh_match(m["id"], day_key(d)) for m in chunk], return_exceptions=True
                )
                for m, r in zip(chunk, res):
                    if isinstance(r, Exception):
                        log.warning("maç güncellenemedi %s: %r", m["id"], r)
        self.last_cycle = time.time()

    async def run(self):
        last_prune = 0.0
        while True:
            try:
                await self.cycle()
            except Exception:  # noqa: BLE001
                log.exception("döngü hatası")
            if time.time() - last_prune > 86400:
                try:
                    self.store.prune()
                except Exception:  # noqa: BLE001
                    log.exception("temizlik hatası")
                last_prune = time.time()
            await asyncio.sleep(CYCLE_SECONDS)
