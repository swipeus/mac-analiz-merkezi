"""Oyuncu sayfası verisi: FotMob'dan sezonun tüm turnuvalarındaki istatistikler, şut haritası, son maçlar.

Ham oyuncu verisi büyük olduğu için önbelleğe sadece özet (compact) kaydedilir: anahtar "player:<id>".
"""
import asyncio
import logging
import time

from .sources import FOTMOB

log = logging.getLogger("players")

PLAYER_TTL = 12 * 3600
PLAYER_VERSION = 2


def _num(v):
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("%", "").strip()
    if "/" in s:  # "1/3" (kurtarılan/karşılaşılan penaltı) -> 1
        s = s.split("/")[0]
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _shot(s, keeper):
    d = {
        "x": s.get("x"), "y": s.get("y"),
        "xg": s.get("expectedGoals"), "xgot": s.get("expectedGoalsOnTarget"),
        "ev": s.get("eventType"), "on": s.get("isOnTarget"), "box": s.get("isFromInsideBox"),
        "type": s.get("shotType"), "sit": s.get("situation"), "min": s.get("min"),
        "home": s.get("homeTeamName"), "away": s.get("awayTeamName"),
        "hs": s.get("homeScore"), "as": s.get("awayScore"), "date": s.get("matchDate"),
    }
    if keeper:
        g = s.get("onGoalShot") or {}
        d.update({"gx": g.get("x"), "gy": g.get("y"), "by": s.get("playerName")})
    return d


def parse_comp(t, stats, keeper):
    top = [{"key": i.get("localizedTitleId"), "title": i.get("title"), "value": _num(i.get("statValue")),
            "raw": i.get("statValue")} for i in (stats.get("topStatCard") or {}).get("items") or []]
    sections = []
    for g in (stats.get("statsSection") or {}).get("items") or []:
        items = []
        for it in g.get("items") or []:
            items.append({
                "key": it.get("localizedTitleId"), "title": it.get("title"),
                "value": _num(it.get("statValue")), "raw": it.get("statValue"), "fmt": it.get("statFormat"),
                "per90": it.get("per90"), "pct": it.get("percentileRank"),
            })
        sections.append({"key": g.get("localizedTitleId"), "title": g.get("title"), "items": items})
    shots = [_shot(s, False) for s in stats.get("shotmap") or []]
    faced = [_shot(s, True) for s in stats.get("keeperShotmap") or []] if keeper else []

    def topv(*keys):
        for i in top:
            if i["key"] in keys or (i["title"] or "").lower() in keys:
                return i["value"]
        return None

    matches = topv("matches_uppercase", "matches")
    minutes = topv("minutes_played", "minutes")
    comp = {
        "id": t.get("tournamentId"), "name": t.get("name"), "entry": t.get("entryId"),
        # kaleci kartında dakika yok: ağırlıklandırma ve 90 dk başına değerler için maç × 90 kullanılır
        "minutes": minutes if minutes is not None else (matches * 90 if matches else None),
        "minutes_est": minutes is None and bool(matches),
        "matches": matches,
        "top": top, "sections": sections, "shots": shots, "faced": faced,
    }
    # türetilen değerler: şut isabet oranı, kalede görülen şut ve xG
    derived = []
    sec_items = {i["key"]: i["value"] for s in sections for i in s["items"]}
    sh, sot = sec_items.get("shots"), sec_items.get("ShotsOnTarget")
    if sh:
        derived.append({"key": "shot_accuracy", "title": "Shot accuracy", "value": round((sot or 0) / sh * 100, 1), "fmt": "percent"})
    if keeper and faced:
        on = [s for s in faced if s["on"]]
        derived += [
            {"key": "shots_faced", "title": "Shots faced", "value": len(faced), "fmt": "number"},
            {"key": "shots_on_target_faced", "title": "Shots on target faced", "value": len(on), "fmt": "number"},
            {"key": "xg_faced", "title": "xG faced", "value": round(sum(s["xg"] or 0 for s in faced), 2), "fmt": "fraction"},
            {"key": "xgot_faced", "title": "xGOT faced", "value": round(sum(s["xgot"] or 0 for s in on), 2), "fmt": "fraction"},
        ]
    comp["derived"] = derived
    return comp


def aggregate(comps):
    """Tüm kulvarlar: sayılar toplanır, yüzdeler ve reyting dakikaya göre ağırlıklı ortalanır."""
    if not comps:
        return None
    total_min = sum(c["minutes"] or 0 for c in comps) or 1

    def merge(lists):
        out, order = {}, []
        for c, items in lists:
            w = (c["minutes"] or 0) / total_min
            for i in items:
                k = i["key"]
                if k not in out:
                    out[k] = {**i, "value": 0.0, "raw": None, "pct": None, "per90": None, "_w": 0.0}
                    order.append(k)
                v = i["value"]
                if v is None:
                    continue
                if i.get("fmt") == "percent" or k == "rating":
                    out[k]["value"] += v * w
                    out[k]["_w"] += w
                else:
                    out[k]["value"] += v
        res = []
        for k in order:
            i = out.pop(k)
            if (i.get("fmt") == "percent" or k == "rating") and i["_w"]:
                i["value"] = i["value"] / i["_w"]
            i.pop("_w", None)
            if i.get("fmt") != "percent" and k != "rating" and total_min > 1:
                i["per90"] = i["value"] / total_min * 90
            i["value"] = round(i["value"], 2)
            res.append(i)
        return res

    sec_keys = []
    for c in comps:
        for s in c["sections"]:
            if s["key"] not in [k for k, _ in sec_keys]:
                sec_keys.append((s["key"], s["title"]))
    sections = []
    for key, title in sec_keys:
        lists = [(c, next((s["items"] for s in c["sections"] if s["key"] == key), [])) for c in comps]
        sections.append({"key": key, "title": title, "items": merge(lists)})
    total = {
        "id": 0, "name": "Tüm kulvarlar", "entry": "all", "minutes": total_min if total_min > 1 else 0,
        "matches": sum(c["matches"] or 0 for c in comps),
        "top": merge([(c, c["top"]) for c in comps]),
        "sections": sections,
        "shots": [s for c in comps for s in c["shots"]],
        "faced": [s for c in comps for s in c["faced"]],
    }
    total["derived"] = merge([(c, c["derived"]) for c in comps])
    # türetilen yüzdeyi toplamdan yeniden hesapla (ağırlıklı ortalama yerine)
    items = {i["key"]: i["value"] for s in sections for i in s["items"]}
    for d in total["derived"]:
        if d["key"] == "shot_accuracy" and items.get("shots"):
            d["value"] = round((items.get("ShotsOnTarget") or 0) / items["shots"] * 100, 1)
    return total


def _info(raw):
    out = {}
    for i in raw.get("playerInformation") or []:
        v = i.get("value") or {}
        fb = v.get("fallback")
        if isinstance(fb, dict):
            fb = fb.get("utcTime")
        out[i.get("title")] = fb
    return out


async def fetch_player(src, pid):
    raw = await src.fetch_json(f"{FOTMOB}/playerData?id={pid}")
    if not raw or not raw.get("name"):
        return None
    pd = raw.get("positionDescription") or {}
    prim = (pd.get("primaryPosition") or {})
    keeper = prim.get("key") == "keeper_long" or any(
        p.get("isMainPosition") and (p.get("strPosShort") or {}).get("label") == "GK" for p in pd.get("positions") or [])
    seasons = raw.get("statSeasons") or []
    comps = []
    if seasons:
        for t in seasons[0].get("tournaments") or []:
            try:
                if t.get("entryId") == "0-0":
                    st = raw.get("firstSeasonStats")
                else:
                    st = await src.fetch_json(
                        f"{FOTMOB}/playerStats?playerId={pid}&seasonId={t.get('entryId')}&isFirstSeason=false")
            except Exception as e:  # noqa: BLE001
                log.warning("oyuncu turnuva istatistiği alınamadı %s %s: %s", pid, t.get("name"), e)
                continue
            if st:
                comps.append(parse_comp(t, st, keeper))
    team = raw.get("primaryTeam") or {}
    recent = []
    for m in raw.get("recentMatches") or []:
        if not m.get("playedInMatch") and not m.get("onBench"):
            continue
        recent.append({
            "id": m.get("id"), "date": (m.get("matchDate") or {}).get("utcTime"),
            "team": m.get("teamName"), "opp": m.get("opponentTeamName"), "oppId": m.get("opponentTeamId"),
            "home": m.get("isHomeTeam"), "comp": m.get("leagueName"),
            "hs": m.get("homeScore"), "as": m.get("awayScore"), "min": m.get("minutesPlayed"),
            "g": m.get("goals"), "a": m.get("assists"), "yc": m.get("yellowCards"), "rc": m.get("redCards"),
            "rating": (m.get("ratingProps") or {}).get("rating"), "potm": m.get("playerOfTheMatch"),
            "bench": m.get("onBench") and not m.get("playedInMatch"),
        })
        if len(recent) >= 12:
            break
    traits = raw.get("traits") or {}
    info = _info(raw)
    inj = raw.get("injuryInformation")
    return {
        "v": PLAYER_VERSION, "id": pid, "name": raw.get("name"), "keeper": keeper,
        "team": {"id": team.get("teamId"), "name": team.get("teamName"), "loan": team.get("onLoan"),
                 "color": (team.get("teamColors") or {}).get("color")},
        "position": prim.get("label"),
        "positions": [p["strPos"]["label"] for p in pd.get("positions") or [] if p.get("strPos")],
        "birth": (raw.get("birthDate") or {}).get("utcTime"),
        "contract": (raw.get("contractEnd") or {}).get("utcTime"),
        "info": {"height": info.get("Height"), "shirt": info.get("Shirt"), "age": info.get("Age"),
                 "foot": info.get("Preferred foot"), "country": info.get("Country"), "value": info.get("Market value")},
        "injury": inj if isinstance(inj, dict) else None,
        "season": seasons[0].get("seasonName") if seasons else None,
        "comps": comps,
        "total": aggregate(comps) if len(comps) > 1 else None,
        "recent": recent,
        "traits": [{"key": i.get("key"), "title": i.get("title"), "value": i.get("value")} for i in traits.get("items") or []],
        "updated": time.time(),
    }


async def get_player(src, store, pid, ttl=PLAYER_TTL):
    key = f"player:{pid}"
    hit = store.cache_get(key)
    if hit and hit[1] and hit[1].get("v") == PLAYER_VERSION and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        p = await fetch_player(src, pid)
    except Exception as e:  # noqa: BLE001
        log.warning("oyuncu alınamadı %s: %s", pid, e)
        return hit[1] if hit else None
    if p:
        store.cache_put(key, p)
    return p or (hit[1] if hit else None)


def cached_player(store, pid):
    hit = store.cache_get(f"player:{pid}")
    return hit[1] if hit and hit[1] and hit[1].get("v") == PLAYER_VERSION else None


def stale_player(store, pid, ttl=PLAYER_TTL):
    hit = store.cache_get(f"player:{pid}")
    return not hit or not hit[1] or hit[1].get("v") != PLAYER_VERSION or time.time() - hit[0] >= ttl


def lineup_player_ids(bundle):
    lu = bundle.get("lineup") or {}
    ids = []
    for s in ("home", "away"):
        side = lu.get(s) or {}
        for grp in ("starters", "subs", "unavailable"):
            for p in side.get(grp) or []:
                if p.get("id"):
                    ids.append(int(p["id"]))
    return ids


async def refresh_players(src, store, ids, budget):
    """Bayat oyuncuları sırayla yeniler (en fazla `budget` oyuncu); paralellik Sources semaforuyla sınırlı."""
    todo = [pid for pid in dict.fromkeys(ids) if stale_player(store, pid)][:budget]
    for i in range(0, len(todo), 8):
        await asyncio.gather(*[get_player(src, store, pid) for pid in todo[i:i + 8]], return_exceptions=True)
    return len(todo)
