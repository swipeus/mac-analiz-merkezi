"""Basketbol: NBA (ESPN), EuroLeague (resmi servis) ve Türkiye Basketbol Süper Ligi (TBF resmi servisi).

Üç kaynak tek biçime çevrilir: maç, takım özeti, oyuncu ortalaması ve maç kutusu (box score). Biten günlerin ve
maçların özeti kalıcı saklanır; böylece her turda yalnızca yakın günler yeniden çekilir.
Her lig ayrı işlenir: birinin kaynağı düşerse diğerleri ve futbol tarafı etkilenmez.
"""
import asyncio
import logging
import re
import time
from datetime import datetime, timedelta

from . import basket_model as bm
from .config import TR_TZ

log = logging.getLogger("basket")

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba"
EL_API = "https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/{s}/games?limit=500"
EL_FEED = "https://feeds.incrowdsports.com/provider/euroleague-feeds/v3/competitions/E"
EL_BOX = "https://live.euroleague.net/api/Boxscore?gamecode={c}&seasoncode={s}"
TBF = "https://miniappapi.tbf.org.tr/webapi-service/api"

# sezon değişince güncellenir
ESPN_SEASON = 2027
EL_SEASON = "E2026"
BSL_ID, BSL_SEASON = 22214, 174
EL_PRIOR, BSL_PRIOR = "E2025", 20728
PRIOR = {"nba": ("2025-10-20", 245), "bsl": ("2025-09-20", 270)}

LEAGUES = {
    "nba": {"name": "NBA", "start": "2026-10-20"},
    "el": {"name": "EuroLeague", "start": None},
    "bsl": {"name": "Türkiye Basketbol Süper Ligi", "start": "2026-09-20"},
}
LOGO = {
    "nba": "https://a.espncdn.com/i/teamlogos/leagues/500/nba.png",
    "el": "https://media-cdn.incrowdsports.com/23610a1b-1c2e-4d2a-8fe4-ac2f8e400632.svg",
    "bsl": "https://tbf.org.tr/assets/images/sites-logo/bslrenkli.svg",
}
LIVE_TTL = 120
SOON_TTL = 600
BOX_BUDGET = {"el": 12}  # bir turda çekilecek en fazla geçmiş maç kutusu (varsayılan 40); live.euroleague.net sık isteği keser
ABSENT_MIN = 15          # son maçta yoksa "oynamadı" sayılacak oyuncunun dakika ortalaması
ROSTER_SHOWN = 9         # maç sayfasında takım başına oyuncu

INJ_STATUS = {"out": "Yok", "day-to-day": "Günlük takip", "questionable": "Belirsiz", "doubtful": "Şüpheli",
              "probable": "Muhtemel", "suspension": "Cezalı"}
INJ_PART = {"ankle": "ayak bileği", "knee": "diz", "foot": "ayak", "hamstring": "arka adale", "back": "bel",
            "groin": "kasık", "calf": "baldır", "shoulder": "omuz", "wrist": "el bileği", "hand": "el",
            "finger": "parmak", "thumb": "başparmak", "hip": "kalça", "illness": "hastalık", "quad": "ön adale",
            "achilles": "aşil", "elbow": "dirsek", "toe": "ayak parmağı", "concussion": "beyin sarsıntısı",
            "rest": "dinlenme", "personal": "kişisel neden", "neck": "boyun", "rib": "kaburga", "shin": "kaval kemiği",
            "abdomen": "karın", "oblique": "yan karın", "lower leg": "alt bacak", "leg": "bacak", "face": "yüz",
            "eye": "göz", "nose": "burun", "not injury related": "sakatlık dışı"}


def tr_title(s):
    """'FENERBAHÇE BEKO' -> 'Fenerbahçe Beko'; 'A.Ş.' gibi kısaltmalar olduğu gibi kalır."""
    out = []
    for w in (s or "").split():
        if "." in w or len(w) <= 2:
            out.append(w)
        else:
            low = w.replace("I", "ı").replace("İ", "i").lower()
            head = {"i": "İ", "ı": "I"}.get(low[0], low[0].upper())
            out.append(head + low[1:])
    return " ".join(out)


def last_first(s):
    """'LAUVERGNE, JOFFREY' -> 'Joffrey Lauvergne'"""
    parts = [p.strip() for p in (s or "").split(",")]
    return " ".join(p.title() for p in (parts[::-1] if len(parts) == 2 else parts))


def tr_day(utc):
    return datetime.fromisoformat(utc.replace("Z", "+00:00")).astimezone(TR_TZ).strftime("%Y-%m-%d")


def to_min(v):
    """'24:31' -> 24.5; ESPN'de düz sayı."""
    if v in (None, "", "-", "DNP"):
        return 0.0
    s = str(v)
    if ":" in s:
        m, _, sec = s.partition(":")
        return (int(m or 0) + int(sec or 0) / 60) if m.strip("0123456789") == "" else 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


async def cached(store, key, ttl, make):
    """Özet (ham yanıt değil) önbelleği: ttl=None kalıcı; kaynak hata verirse eski kopya."""
    hit = store.cache_get(key)
    if hit and (ttl is None or time.time() - hit[0] < ttl):
        return hit[1]
    try:
        data = await make()
    except Exception as e:  # noqa: BLE001
        if hit:
            log.warning("%s yenilenemedi, eski kopya: %s", key, e)
            return hit[1]
        raise
    store.cache_put(key, data)
    return data


def side(tid, name, short, logo, score):
    return {"id": str(tid), "name": name, "short": short or name, "logo": logo, "score": score}


def game(gid, lg, utc, home, away, state, clock=None, q=None, venue=None, round_=None, refs=None):
    return {"id": f"{lg}-{gid}", "lg": lg, "utc": utc, "home": home, "away": away, "state": state,
            "clock": clock, "q": q, "venue": venue, "round": round_, "refs": refs}


def day_ttl(day, now):
    """Bir günün listesi ne sıklıkla yenilensin: 2 günden eskisi kalıcı, yakın günler sık."""
    d = (now.date() - datetime.strptime(day, "%Y-%m-%d").date()).days
    return None if d >= 2 else LIVE_TTL if d >= -1 else 3600


def date_range(start, end):
    d = datetime.strptime(start, "%Y-%m-%d").date()
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)


# ---------- NBA (ESPN) ----------
def _espn_game(e):
    c = e["competitions"][0]
    t = c["status"]["type"]
    state = {"pre": "pre", "in": "live", "post": "post"}.get(t.get("state"), "pre")
    if t.get("name") in ("STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_SUSPENDED"):
        state = "off"
    period = c["status"].get("period") or 0
    clock = None
    if state == "live":
        clock = "Devre arası" if t.get("name") == "STATUS_HALFTIME" else (
            f"{period}. çeyrek {c['status'].get('displayClock', '')}" if period <= 4 else f"Uzatma {c['status'].get('displayClock', '')}")

    def team(x):
        tm = x["team"]
        return side(tm["id"], tm.get("displayName"), tm.get("shortDisplayName"), tm.get("logo"),
                    _int(x.get("score")) if state != "pre" else None)
    h = next(x for x in c["competitors"] if x["homeAway"] == "home")
    a = next(x for x in c["competitors"] if x["homeAway"] == "away")
    q = None
    if h.get("linescores"):
        q = [[_int(x.get("value")) for x in h["linescores"]], [_int(x.get("value")) for x in a.get("linescores") or []]]
    return game(e["id"], "nba", e["date"], team(h), team(a), state, clock, q, (c.get("venue") or {}).get("fullName"))


async def _nba_day(src, store, day, now):
    ymd = day.replace("-", "")

    async def make():
        d = await src.fetch_json(f"{ESPN}/scoreboard?dates={ymd}")
        return [_espn_game(e) for e in d.get("events", []) if (e.get("season") or {}).get("type") in (2, 3, 5)]
    return await cached(store, f"bk:nba:d:{day}", day_ttl(day, now), make)


async def _nba_players(src, store):
    async def make():
        d = await src.fetch_json(f"{ESPN_WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false"
                                 f"&page=1&limit=700&sort=offensive.avgPoints%3Adesc&season={ESPN_SEASON}&seasontype=2")
        names = {c["name"]: c.get("names") or [] for c in d.get("categories", [])}
        out = {}
        for a in d.get("athletes", []):
            ath = a.get("athlete") or {}
            st = {}
            for c in a.get("categories", []):
                st.update(zip(names.get(c.get("name"), []), c.get("totals") or []))
            tid = str(ath.get("teamId") or "")
            if not tid:
                continue
            f = lambda k: _num(st.get(k))  # noqa: E731
            out.setdefault(tid, []).append({
                "id": ath.get("id"), "name": ath.get("displayName"), "pos": (ath.get("position") or {}).get("abbreviation"),
                "gp": _int(st.get("gamesPlayed")), "min": f("avgMinutes"), "pts": f("avgPoints"), "reb": f("avgRebounds"),
                "ast": f("avgAssists"), "stl": f("avgSteals"), "blk": f("avgBlocks"), "tp": f("avgThreePointFieldGoalsMade"),
                "photo": (ath.get("headshot") or {}).get("href"),
            })
        return out
    return await cached(store, "bk:nba:players", 6 * 3600, make)


def _num(v):
    try:
        return round(float(str(v).replace(",", "").replace("%", "")), 1)
    except (TypeError, ValueError):
        return None


async def _nba_injuries(src, store):
    async def make():
        d = await src.fetch_json(f"{ESPN}/injuries")
        out = {}
        for t in d.get("injuries", []):
            rows = []
            for i in t.get("injuries", []):
                ath = i.get("athlete") or {}
                det = i.get("details") or {}
                part = (det.get("type") or "").strip()
                st = (i.get("status") or "").strip().lower()
                rows.append({"name": ath.get("displayName"), "status": INJ_STATUS.get(st, i.get("status")),
                             "out": st == "out", "part": INJ_PART.get(part.lower(), part.lower() or None),
                             "ret": det.get("returnDate"), "date": i.get("date")})
            out[str(t.get("id"))] = rows
        return out
    return await cached(store, "bk:nba:inj", 1800, make)


async def _nba_groups(src, store):
    async def make():
        d = await src.fetch_json(f"https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season={ESPN_SEASON}")
        out = {}
        for c in d.get("children", []):
            for e in (c.get("standings") or {}).get("entries", []):
                out[str(e["team"]["id"])] = "Doğu" if "East" in c.get("name", "") else "Batı"
        return out
    return await cached(store, "bk:nba:groups", 24 * 3600, make)


async def _nba_box(src, store, g):
    gid = g["id"].split("-", 1)[1]

    async def make():
        d = await src.fetch_json(f"{ESPN}/summary?event={gid}")
        out = {"home": [], "away": []}
        for t in (d.get("boxscore") or {}).get("players", []):
            sd = "home" if str(t["team"]["id"]) == g["home"]["id"] else "away"
            s = (t.get("statistics") or [{}])[0]
            names = s.get("names") or []
            for a in s.get("athletes", []):
                st = dict(zip(names, a.get("stats") or []))
                ath = a.get("athlete") or {}
                out[sd].append({
                    "id": ath.get("id"), "name": ath.get("displayName"), "start": bool(a.get("starter")),
                    "min": to_min(st.get("MIN")), "pts": _int(st.get("PTS")) or 0, "reb": _int(st.get("REB")) or 0,
                    "ast": _int(st.get("AST")) or 0, "stl": _int(st.get("STL")) or 0, "blk": _int(st.get("BLK")) or 0,
                    "to": _int(st.get("TO")) or 0, "pf": _int(st.get("PF")) or 0, "fg": st.get("FG"), "tp": st.get("3PT"),
                })
        return out
    return await cached(store, f"bk:box:{g['id']}", None if g["state"] == "post" else LIVE_TTL, make)


async def load_nba(src, store, now):
    days = list(date_range(LEAGUES["nba"]["start"], now.date() + timedelta(days=2)))
    games = []
    for rows in await asyncio.gather(*[_nba_day(src, store, d, now) for d in days]):
        games += rows
    players, injuries, groups = await asyncio.gather(
        _nba_players(src, store), _nba_injuries(src, store), _nba_groups(src, store))
    return {"games": games, "players": players, "injuries": injuries, "groups": groups, "rank": {}}


# ---------- EuroLeague ----------
def _el_game(g):
    st = (g.get("status") or "").lower()
    state = "post" if st == "result" else "off" if st in ("postponed", "cancelled", "canceled") else (
        "pre" if st in ("confirmed", "scheduled", "") and not g.get("quarter") else "live")

    def team(x):
        return side(x.get("code"), x.get("name"), x.get("abbreviatedName") or x.get("editorialName"),
                    (x.get("imageUrls") or {}).get("crest"), x.get("score") if state != "pre" else None)
    q = None
    if state != "pre":
        names = ["q1", "q2", "q3", "q4"] + [f"ot{i}" for i in range(1, 6)]
        q = [[(x.get("quarters") or {}).get(k) for k in names] for x in (g["home"], g["away"])]
        keep = [i for i in range(len(names)) if q[0][i] is not None or q[1][i] is not None]
        q = [[r[i] for i in keep] for r in q]
    refs = [last_first(r.get("name")) for r in g.get("referees") or [] if r.get("name")]
    clock = None
    if state == "live":
        clock = f"{g['quarter']}. çeyrek {g.get('quarterMinute') or ''}".strip() if g.get("quarter") else "Canlı"
    return game(g.get("code"), "el", g.get("date"), team(g["home"]), team(g["away"]), state, clock, q,
                tr_title((g.get("venue") or {}).get("name")), (g.get("round") or {}).get("round"), refs or None)


def _el_row(p):
    tot = p.get("FieldGoalsMade2", 0) + p.get("FieldGoalsMade3", 0)
    att = p.get("FieldGoalsAttempted2", 0) + p.get("FieldGoalsAttempted3", 0)
    # kutuda "P011982", sezon listesinde "011982" yazılır
    return {"id": (p.get("Player_ID") or "").strip().lstrip("P"), "name": last_first(p.get("Player")), "start": bool(p.get("IsStarter")),
            "min": to_min(p.get("Minutes")), "pts": p.get("Points") or 0, "reb": p.get("TotalRebounds") or 0,
            "ast": p.get("Assistances") or 0, "stl": p.get("Steals") or 0, "blk": p.get("BlocksFavour") or 0,
            "to": p.get("Turnovers") or 0, "pf": p.get("FoulsCommited") or 0, "fg": f"{tot}-{att}",
            "tp": f"{p.get('FieldGoalsMade3', 0)}-{p.get('FieldGoalsAttempted3', 0)}"}


async def _el_box(src, store, g):
    code = g["id"].split("-", 1)[1]

    async def make():
        d = await src.fetch_json(EL_BOX.format(c=code, s=EL_SEASON))
        st = d.get("Stats") or []
        if len(st) < 2:
            return {"home": [], "away": []}
        rows = [[_el_row(p) for p in s.get("PlayersStats", []) if (p.get("Player") or "") != "Team"] for s in st[:2]]
        return {"home": rows[0], "away": rows[1]}
    return await cached(store, f"bk:box:{g['id']}", None if g["state"] == "post" else LIVE_TTL, make)


async def _el_players(src, store):
    async def make():
        d = await src.fetch_json(f"{EL_FEED}/statistics/players/traditional?seasonMode=Single&seasonCode={EL_SEASON}&limit=500")
        out = {}
        for r in d.get("players", []):
            p = r.get("player") or {}
            out.setdefault((p.get("team") or {}).get("code"), []).append({
                "id": p.get("code"), "name": last_first(p.get("name")), "gp": _int(r.get("gamesPlayed")),
                "min": _num(r.get("minutesPlayed")), "pts": _num(r.get("pointsScored")), "reb": _num(r.get("totalRebounds")),
                "ast": _num(r.get("assists")), "stl": _num(r.get("steals")), "blk": _num(r.get("blocks")),
                "tp": _num(r.get("threePointersMade")), "photo": p.get("imageUrl"),
            })
        return out
    return await cached(store, "bk:el:players", 3 * 3600, make)


async def load_el(src, store, now):
    async def make():
        d = await src.fetch_json(EL_API.format(s=EL_SEASON))
        return [_el_game(g) for g in d.get("data", []) if g.get("home") and g.get("away")]
    games = await cached(store, "bk:el:games", LIVE_TTL, make)
    return {"games": games, "players": await _el_players(src, store), "injuries": {}, "groups": {}, "rank": {}}


# ---------- Türkiye Basketbol Süper Ligi (TBF) ----------
def _bsl_game(m):
    def team(x):
        return side(_int(x.get("id")), tr_title(x.get("name")), None, x.get("logoUrl"), _int(x.get("score")))
    h, a = team(m["homeTeam"]), team(m["awayTeam"])
    sid = _int(m.get("matchStatusId"))
    state = "post" if sid == 1 else "live" if h["score"] is not None and sid not in (1, 4) else "pre"
    return game(_int(m.get("matchId")), "bsl", m["matchDate"] + "+03:00", h, a, state, "Canlı" if state == "live" else None,
                None, tr_title(m.get("venueName") or m.get("salonAdi") or ""), m.get("week"))


async def _bsl_day(src, store, day, now):
    async def make():
        d = await src.fetch_json(f"{TBF}/Match/get-daily-matches?MatchDate={day}")
        return [_bsl_game(m) for g in d.get("data") or [] for m in g.get("matches", [])
                if (m.get("activityCode") or "").lower() == "bsl" and _int(m.get("activityId")) == BSL_ID]
    return await cached(store, f"bk:bsl:d:{day}", day_ttl(day, now), make)


def _bsl_row(p):
    return {"id": p.get("playerId"), "name": tr_title(p.get("playerName")) if (p.get("playerName") or "").isupper() else p.get("playerName"),
            "start": bool(p.get("isStarter")), "min": to_min(p.get("minutesPlayed")), "pts": p.get("points") or 0,
            "reb": p.get("totalRebounds") or 0, "ast": p.get("assists") or 0, "stl": p.get("steals") or 0,
            "blk": p.get("blocks") or 0, "to": p.get("turnovers") or 0, "pf": p.get("fouls") or 0,
            "fg": f"{p.get('successfulShots', 0)}-{p.get('shotAttempts', 0)}",
            "tp": f"{p.get('threePointShots', 0)}-{p.get('threePointShotAttempts', 0)}", "eff": p.get("efficiency")}


async def _bsl_box(src, store, g):
    gid = g["id"].split("-", 1)[1]

    async def make():
        d = (await src.fetch_json(f"{TBF}/Match/mac-istatistik?matchId={gid}")).get("data") or {}
        h = await src.fetch_json(f"{TBF}/Match/mac-header?matchId={gid}")
        hd = h.get("data") or {}
        refs = [tr_title(hd.get(k)) for k in ("mainReferee", "firstAssistantReferee", "secondAssistantReferee") if hd.get(k)]
        return {"home": [_bsl_row(p) for p in (d.get("homeTopFive") or []) + (d.get("homeBenchPlayers") or [])],
                "away": [_bsl_row(p) for p in (d.get("awayTopFive") or []) + (d.get("awayBenchPlayers") or [])], "refs": refs}
    return await cached(store, f"bk:box:{g['id']}", None if g["state"] == "post" else LIVE_TTL, make)


async def load_bsl(src, store, now):
    days = list(date_range(LEAGUES["bsl"]["start"], now.date() + timedelta(days=3)))
    games = []
    for rows in await asyncio.gather(*[_bsl_day(src, store, d, now) for d in days]):
        games += rows

    async def make():
        d = await src.fetch_json(f"{TBF}/League/get-standings-table?leagueId={BSL_ID}&seasonId={BSL_SEASON}")
        return {str(_int(r.get("takimIslemId"))): r.get("sira") for g in d.get("data") or [] for r in g.get("standings", [])}
    rank = await cached(store, "bk:bsl:rank", 1800, make)
    return {"games": games, "players": {}, "injuries": {}, "groups": {}, "rank": rank}


async def prior_games(src, store, lg):
    """Geçen sezonun oynanmış maçları (takım gücünün sezon başı için): özet saklanır."""
    async def make():
        rows = []
        if lg == "el":
            d = await src.fetch_json(EL_API.format(s=EL_PRIOR))
            rows = [_el_game(g) for g in d.get("data", []) if g.get("home") and g.get("away")]
        else:
            start, n = PRIOR[lg]
            d0 = datetime.strptime(start, "%Y-%m-%d").date()

            async def one(i):
                day = d0 + timedelta(days=i)
                try:
                    if lg == "nba":
                        d = await src.fetch_json(f"{ESPN}/scoreboard?dates={day.strftime('%Y%m%d')}")
                        return [_espn_game(e) for e in d.get("events", []) if (e.get("season") or {}).get("type") in (2, 3, 5)]
                    d = await src.fetch_json(f"{TBF}/Match/get-daily-matches?MatchDate={day.isoformat()}")
                    return [_bsl_game(m) for g in d.get("data") or [] for m in g.get("matches", []) if _int(m.get("activityId")) == BSL_PRIOR]
                except Exception as e:  # noqa: BLE001
                    log.warning("geçen sezon günü alınamadı %s %s: %s", lg, day, e)
                    return []
            for part in await asyncio.gather(*[one(i) for i in range(n)]):
                rows += part
        return bm.compact(rows, key_name=lg == "bsl")
    return await cached(store, f"bk:prior:{lg}", 30 * 86400, make)


LOADERS = {"nba": load_nba, "el": load_el, "bsl": load_bsl}
BOXES = {"nba": _nba_box, "el": _el_box, "bsl": _bsl_box}


# ---------- özetler ----------
def team_table(games):
    """Oynanmış maçlardan takım özeti: galibiyet, sayı ortalamaları, iç/dış, seri, son maçlar."""
    t = {}
    for g in sorted((x for x in games if x["state"] == "post"), key=lambda x: x["utc"]):
        hs, as_ = g["home"]["score"], g["away"]["score"]
        if hs is None or as_ is None:
            continue
        for sd, me, op, pf, pa in (("home", g["home"], g["away"], hs, as_), ("away", g["away"], g["home"], as_, hs)):
            r = t.setdefault(me["id"], {"id": me["id"], "name": me["name"], "short": me["short"], "logo": me["logo"],
                                        "gp": 0, "w": 0, "l": 0, "pf": 0, "pa": 0, "hw": 0, "hl": 0, "aw": 0, "al": 0, "log": []})
            win = pf > pa
            r["gp"] += 1
            r["w" if win else "l"] += 1
            r["pf"] += pf
            r["pa"] += pa
            r[("h" if sd == "home" else "a") + ("w" if win else "l")] += 1
            r["log"].append({"id": g["id"], "utc": g["utc"], "home": sd == "home", "opp": op["short"], "opp_id": op["id"],
                             "pf": pf, "pa": pa, "win": win})
    for r in t.values():
        n = r["gp"] or 1
        r["ppg"], r["opp"] = round(r["pf"] / n, 1), round(r["pa"] / n, 1)
        r["diff"] = round(r["ppg"] - r["opp"], 1)
        last5 = r["log"][-5:]
        r["l5"] = "".join("G" if x["win"] else "M" for x in last5)
        r["l5ppg"] = round(sum(x["pf"] for x in last5) / len(last5), 1) if last5 else None
        r["l5opp"] = round(sum(x["pa"] for x in last5) / len(last5), 1) if last5 else None
        s, first = 0, r["log"][-1]["win"] if r["log"] else None
        for x in reversed(r["log"]):
            if x["win"] != first:
                break
            s += 1
        r["streak"] = f"{s}{'G' if first else 'M'}" if s else ""
    return t


def standings(lg, table, groups, rank):
    def key(r):
        return (rank[r["id"]], 0) if rank.get(r["id"]) else (10 ** 6, -(r["w"] / (r["gp"] or 1)), -r["diff"])
    rows = [{k: r[k] for k in ("id", "name", "short", "logo", "gp", "w", "l", "ppg", "opp", "diff", "l5", "streak")}
            for r in sorted(table.values(), key=key)]
    if not groups:
        return [{"group": "", "rows": rows}]
    return [{"group": g, "rows": [r for r in rows if groups.get(r["id"]) == g]} for g in ("Doğu", "Batı")]


def bsl_season_players(boxes):
    """TBF'de takım başına toplu liste açık değil: maç kutularından sezon ortalaması çıkarılır."""
    agg = {}
    for tid, row in boxes:
        if row["min"] <= 0:
            continue
        a = agg.setdefault(tid, {}).setdefault(row["id"], {"id": row["id"], "name": row["name"], "gp": 0, "min": 0, "pts": 0,
                                                           "reb": 0, "ast": 0, "stl": 0, "blk": 0})
        a["gp"] += 1
        for k in ("min", "pts", "reb", "ast", "stl", "blk"):
            a[k] += row[k]
    out = {}
    for tid, ps in agg.items():
        out[tid] = [{**p, **{k: round(p[k] / p["gp"], 1) for k in ("min", "pts", "reb", "ast", "stl", "blk")}} for p in ps.values()]
    return out


def absences(players, last_box):
    """Önemli oyuncu son maçın kutusunda yoksa (ya da hiç oynamadıysa) bilgi olarak yazılır."""
    if not last_box:
        return []
    played = {str(r["id"]) for r in last_box if r["min"] > 0}
    return [{"name": p["name"], "min": p["min"], "pts": p["pts"]} for p in sorted(players, key=lambda x: -(x["min"] or 0))
            if (p["min"] or 0) >= ABSENT_MIN and (p.get("gp") or 0) >= 2 and str(p["id"]) not in played]


def card(g, table):
    def rec(t):
        r = table.get(t["id"])
        return {**t, "rec": f"{r['w']}-{r['l']}" if r else None}
    return {**{k: g[k] for k in ("id", "lg", "utc", "state", "clock", "q", "round")}, "home": rec(g["home"]), "away": rec(g["away"])}


def team_summary(r):
    if not r:
        return None
    return {k: r[k] for k in ("gp", "w", "l", "hw", "hl", "aw", "al", "ppg", "opp", "diff", "l5", "l5ppg", "l5opp", "streak")}


def rest_days(table_row, utc):
    if not table_row or not table_row["log"]:
        return None
    a = datetime.fromisoformat(table_row["log"][-1]["utc"].replace("Z", "+00:00"))
    b = datetime.fromisoformat(utc.replace("Z", "+00:00"))
    return max(0, (b.date() - a.date()).days - 1)


NEWS_HIT = re.compile(r"sakat|ameliyat|sezonu kapat|forma giye|kadroda yok|kadro dışı|yok|injur", re.I)
NEWS_BASKET = re.compile(r"basket|pota|euroleague|bsl|nba|beko|tarfin|mct|boa", re.I)
# futbol takımı da olan kulüplerde başlıkta basketbol geçmesi aranır
NEWS_FOOTBALL = re.compile(r"galatasaray|fenerbah|beşiktaş|besiktas|trabzon|bursaspor|real madrid|barcelona|bayern|monaco|"
                           r"panathinaikos|olympiacos|partizan|zvezda|paris|virtus|maccabi|hapoel|dubai", re.I)


async def team_news(src, name):
    rows = await src.google_news(f'"{name}" basketbol sakat', 3600, limit=8)
    keep = [n for n in rows if NEWS_HIT.search(n["title"]) and (NEWS_BASKET.search(n["title"]) or not NEWS_FOOTBALL.search(name))]
    return keep[:3]


async def build(src, store, write, now):
    """Bütün basketbol dosyalarını yazar; dönüş: ligler (meta için)."""
    today = now.strftime("%Y-%m-%d")
    shown = [(now + timedelta(days=i)).strftime("%Y-%m-%d") for i in (-1, 0, 1)]
    all_cards, out_lg = {d: [] for d in shown}, []
    events = await bm.nesine_events(src, store)
    day_cands = {d: [] for d in shown}
    for lg, info in LEAGUES.items():
        try:
            d = await LOADERS[lg](src, store, now)
            games = [g for g in d["games"] if g["state"] != "off"]
            table = team_table(games)
            try:
                prior = await prior_games(src, store, lg)
            except Exception as e:  # noqa: BLE001
                log.warning("geçen sezon alınamadı %s: %s", lg, e)
                prior = []
            rating = bm.fit(prior + bm.compact(games, key_name=lg == "bsl"), now.timestamp() / 86400)
            # maç kutuları: yeniler önce; geçmiş sezon maçları tur başına sınırlı
            need = [g for g in sorted(games, key=lambda x: x["utc"], reverse=True) if g["state"] in ("post", "live")]
            if lg == "nba":  # NBA'de oyuncu ortalaması hazır; yalnızca gösterilecek günlerin kutuları gerekir
                need = [g for g in need if tr_day(g["utc"]) in shown]
            todo = [g for g in need if g["state"] == "live" or not store.cache_get(f"bk:box:{g['id']}")][:BOX_BUDGET.get(lg, 40)]
            res = await asyncio.gather(*[BOXES[lg](src, store, g) for g in todo], return_exceptions=True)
            for g, r in zip(todo, res):
                if isinstance(r, Exception):
                    log.warning("maç kutusu alınamadı %s: %s", g["id"], r)
            boxes = {}
            for g in need:
                hit = store.cache_get(f"bk:box:{g['id']}")
                if hit:
                    boxes[g["id"]] = hit[1]
            players = d["players"]
            if lg == "bsl":
                players = bsl_season_players([(g[sd]["id"], r) for g in need if g["id"] in boxes
                                              for sd in ("home", "away") for r in boxes[g["id"]].get(sd, [])])
            last_box = {}  # takımın son maçındaki kutu satırları
            for g in sorted(need, key=lambda x: x["utc"]):
                if g["id"] in boxes:
                    for sd in ("home", "away"):
                        last_box[g[sd]["id"]] = boxes[g["id"]].get(sd)

            def roster(tid):
                return sorted(players.get(tid, []), key=lambda p: -(p.get("min") or 0))

            for g in games:
                dk = tr_day(g["utc"])
                if dk in shown:
                    ev = bm.find_event(g, events) if g["state"] == "pre" else None
                    pr = bm.predict(lg, g, rating, ev)
                    opts = bm.options(pr, ev, g["home"]["short"], g["away"]["short"])
                    pick = bm.best_pick(opts)
                    rec = bm.record(store, g, pr, pick)
                    if g["state"] == "pre" and opts:
                        day_cands[dk].append((g, opts))
                    model = {"pred": pr, "options": opts, "rec": rec}
                    all_cards[dk].append({**card(g, table), "pred": short_pred(g, pr, rec)})
                    write(f"bk-match-{g['id']}.json", {**await bundle(src, g, lg, d, table, games, roster, boxes.get(g["id"]), last_box), **model})
            for tid, r in table.items():
                write(f"bk-team-{lg}-{tid}.json", {
                    "lg": lg, "lg_name": info["name"], **{k: r[k] for k in ("id", "name", "short", "logo")}, "stats": team_summary(r),
                    "log": r["log"][::-1], "next": [card(g, table) for g in sorted(games, key=lambda x: x["utc"])
                                                    if g["state"] == "pre" and tid in (g["home"]["id"], g["away"]["id"])][:5],
                    "roster": roster(tid), "injuries": d["injuries"].get(tid) or [],
                    "absent": absences(roster(tid), last_box.get(tid)) if lg != "nba" else [],
                })
            allp = [{**p, "team": table[t]["short"], "team_id": t} for t, ps in players.items() if t in table for p in ps]
            min_gp = max(1, max((r["gp"] for r in table.values()), default=1) // 2)
            lead = lambda k: sorted((p for p in allp if (p.get("gp") or 0) >= min_gp), key=lambda p: -(p.get(k) or 0))[:10]  # noqa: E731
            write(f"bk-league-{lg}.json", {"lg": lg, "name": info["name"], "table": standings(lg, table, d["groups"], d["rank"]),
                                           "leaders": {"pts": lead("pts"), "reb": lead("reb"), "ast": lead("ast")}})
            out_lg.append({"id": lg, "name": info["name"], "logo": LOGO[lg]})
            bm.settle(store, games)
            log.info("basketbol %s: %s maç, %s oynandı, %s kutu", lg, len(games), sum(g["state"] == "post" for g in games), len(boxes))
        except Exception as e:  # noqa: BLE001
            log.exception("basketbol %s işlenemedi: %s", lg, e)
    for d in shown:
        doc = bm.update_coupons(store, d, day_cands[d]) if d >= today else (store.bk_get("coupons", d) or {})
        write(f"bk-day-{d}.json", {"date": d, "matches": sorted(all_cards[d], key=lambda m: (list(LEAGUES).index(m["lg"]), m["utc"])),
                                   "coupons": doc.get("coupons") or []})
    write("bk-karne.json", bm.karne(store))
    log.info("basketbol günleri: %s (%s)", {k: len(v) for k, v in all_cards.items()}, today)
    return out_lg


def short_pred(g, pr, rec):
    """Maç listesi için özet: başlamış maçta maç öncesi kayıttaki tercih gösterilir."""
    if g["state"] == "pre":
        if not pr:
            return None
        return {"p_home": pr["p_home"], "p_away": pr["p_away"], "total": pr["total"], "safe": (rec or {}).get("pick")}
    if not rec:
        return None
    return {"p_home": rec.get("p_home"), "p_away": round(1 - rec["p_home"], 3) if rec.get("p_home") is not None else None,
            "safe": rec.get("pick"), "hit": rec.get("hit"), "done": rec.get("state") == "done"}


async def bundle(src, g, lg, d, table, games, roster, box, last_box):
    h, a = g["home"]["id"], g["away"]["id"]
    h2h = [x for x in sorted(games, key=lambda y: y["utc"], reverse=True)
           if x["state"] == "post" and {x["home"]["id"], x["away"]["id"]} == {h, a}][:5]
    news = {"home": [], "away": []}
    if g["state"] == "pre" and lg != "nba":
        news["home"], news["away"] = await asyncio.gather(team_news(src, g["home"]["short"]), team_news(src, g["away"]["short"]))

    def pack(tid):
        rows = roster(tid)
        return rows[:ROSTER_SHOWN]
    refs = g.get("refs") or (box or {}).get("refs")
    return {
        **{k: g[k] for k in ("id", "lg", "utc", "state", "clock", "q", "venue", "round")}, "lg_name": LEAGUES[lg]["name"], "refs": refs,
        "home": {**g["home"], "rec": team_summary(table.get(h)), "rest": rest_days(table.get(h), g["utc"]), "log": (table.get(h) or {}).get("log", [])[-5:][::-1]},
        "away": {**g["away"], "rec": team_summary(table.get(a)), "rest": rest_days(table.get(a), g["utc"]), "log": (table.get(a) or {}).get("log", [])[-5:][::-1]},
        "players": {"home": pack(h), "away": pack(a)},
        "injuries": {"home": d["injuries"].get(h) or [], "away": d["injuries"].get(a) or []},
        "absent": {"home": absences(roster(h), last_box.get(h)) if lg != "nba" else [],
                   "away": absences(roster(a), last_box.get(a)) if lg != "nba" else []},
        "news": news, "h2h": [{"id": x["id"], "utc": x["utc"], "home": x["home"]["short"], "away": x["away"]["short"],
                               "hs": x["home"]["score"], "as": x["away"]["score"]} for x in h2h],
        "box": {"home": (box or {}).get("home") or [], "away": (box or {}).get("away") or []},
    }
