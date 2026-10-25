"""Lig sayfaları: puan durumu (bölge renkleriyle), son 5 maç puanı, gol ve asist krallığı."""
import asyncio
import logging

from .config import LEAGUES, SEASON_TTL

log = logging.getLogger("leagues")

ZONE_TR = {
    "championsleague": "Şampiyonlar Ligi", "clqual": "Şampiyonlar Ligi elemeleri", "euroqual": "Avrupa Ligi elemeleri",
    "europaleague": "Avrupa Ligi", "europa_conference_league": "Konferans Ligi elemeleri", "conferenceleague": "Konferans Ligi",
    "relegation": "Küme düşme", "relegationplayoff": "Küme düşme play-off", "promotion": "Üst lige yükselme",
    "promotionplayoff": "Yükselme play-off", "playoff": "Play-off", "playoffs": "Play-off",
    "qualified": "Son 16", "knockoutplayoffs": "Son 16 play-off", "eliminated": "Elendi",
}
TITLE_TR = {
    "Qualification to 1/8 finals": "Son 16'ya doğrudan", "Qualification to 1/16 finals": "Son 16 play-off",
    "Promotion qualification": "Yükselme play-off", "Promotion": "Üst lige yükselme", "Relegation": "Küme düşme",
    "Relegation playoff": "Küme düşme play-off", "Champions League": "Şampiyonlar Ligi", "Europa League": "Avrupa Ligi",
    "Conference League": "Konferans Ligi", "Champions League qualification": "Şampiyonlar Ligi elemeleri",
    "Europa League qualification": "Avrupa Ligi elemeleri", "Conference League qualification": "Konferans Ligi elemeleri",
    "Championship round": "Şampiyonluk grubu", "Relegation round": "Düşme grubu", "Playoff": "Play-off",
}
TOP_N = 20


def _rows(tbl, form):
    pts5 = {r["id"]: r.get("pts") for r in form or []}
    return [{
        "pos": r.get("idx"), "id": r.get("id"), "name": r.get("shortName") or r.get("name"),
        "played": r.get("played"), "w": r.get("wins"), "d": r.get("draws"), "l": r.get("losses"),
        "goals": r.get("scoresStr"), "gd": r.get("goalConDiff"), "pts": r.get("pts"),
        "color": r.get("qualColor"), "pts5": pts5.get(r.get("id")),
    } for r in sorted(tbl, key=lambda r: r.get("idx") or 99)]


def _tables(lg):
    out = []
    for block in lg.get("table") or []:
        data = block.get("data") or {}
        # tek tablo (lig) ya da gruplar (kupa)
        tabs = [data] if data.get("table") else [t for t in data.get("tables") or [] if t.get("table")]
        legend = [{"title": TITLE_TR.get(z.get("title")) or ZONE_TR.get((z.get("tKey") or "").lower(), z.get("title")), "color": z.get("color")}
                  for z in data.get("legend") or []]
        for t in tabs:
            tb = t.get("table") or {}
            if tb.get("all"):
                out.append({"name": t.get("leagueName") if len(tabs) > 1 else None,
                            "legend": legend, "rows": _rows(tb["all"], tb.get("form"))})
    return out


def _top(data):
    try:
        lst = data["TopLists"][0].get("StatList") or []
    except (KeyError, IndexError, TypeError):
        return []
    return [{"id": e.get("ParticiantId"), "name": e.get("ParticipantName"), "team_id": e.get("TeamId"),
             "team": e.get("TeamName"), "value": e.get("StatValue"), "matches": e.get("MatchesPlayed"),
             "sub": e.get("SubStatValue")} for e in lst[:TOP_N]]


async def league_page(src, league_id):
    lg = await src.league(league_id, SEASON_TTL)
    urls = {p["name"]: p["fetchAllUrl"] for p in (lg.get("stats") or {}).get("players") or []
            if p.get("name") in ("goals", "goal_assist")}
    files = await asyncio.gather(*[src.stat_file(u, SEASON_TTL) for u in urls.values()], return_exceptions=True)
    tops = {n: (_top(f) if not isinstance(f, Exception) else []) for n, f in zip(urls, files)}
    details = lg.get("details") or {}
    return {"id": league_id, "name": LEAGUES.get(league_id) or details.get("name"),
            "season": details.get("selectedSeason") or (lg.get("allAvailableSeasons") or [None])[0],
            "tables": _tables(lg), "scorers": tops.get("goals", []), "assists": tops.get("goal_assist", [])}


async def all_pages(src):
    async def one(lid):
        try:
            return await league_page(src, lid)
        except Exception as e:  # noqa: BLE001
            log.warning("lig sayfası hazırlanamadı %s: %s", lid, e)
            return None
    return [p for p in await asyncio.gather(*[one(lid) for lid in LEAGUES]) if p]


def odds_moves(bundles, limit=400):
    """Başlamamış maçlarda açılıştan bu yana değişen oranlar (yalnızca modelin bildiği ana pazarlar)."""
    out = []
    for b in bundles:
        if (b.get("status") or {}).get("started"):
            continue
        for m in (b.get("odds") or {}).get("markets") or []:
            for s in m["selections"]:
                o0, o = s.get("o0"), s.get("odds")
                if not o0 or not o or o0 == o or not s.get("code") or s["code"].startswith("cs:"):
                    continue
                if max(o0, o) > 6:  # sürpriz oranlardaki küçük oynamalar yüzde olarak abartılı görünür
                    continue
                out.append({"mid": b["id"], "utc": b.get("utc"), "league_id": b.get("league_id"),
                            "home": {"id": b["home"]["id"], "name": b["home"]["name"]},
                            "away": {"id": b["away"]["id"], "name": b["away"]["name"]},
                            "group": m.get("group"), "market": m.get("title"), "label": s["label"], "code": s["code"],
                            "open": o0, "now": o, "chg": round(o / o0 - 1, 4)})
    out.sort(key=lambda x: abs(x["chg"]), reverse=True)
    return out[:limit]
