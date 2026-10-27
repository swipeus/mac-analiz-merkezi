"""Takım sayfaları: son maçlar ve ortalamalar, güç puanı (Elo) geçmişi, sezon sıralamaları, öne çıkan oyuncular
ve sıradaki maçlar. Yayındaki maçların takımları için en güncel maç paketinden üretilir."""
import logging
from datetime import datetime, timezone

from . import collect
from .config import LEAGUES, SEASON_TTL

log = logging.getLogger(__name__)

# sezon istatistiklerinden takım sayfasında gösterilenler (anahtar, ad, ondalık, yüksek mi iyi)
SEASON_KEYS = [("rating_team", "FotMob reytingi", 2, True), ("expected_goals_team", "xG (maç başı)", 2, True),
               ("expected_goals_conceded_team", "Yenen xG (maç başı)", 2, False),
               ("goals_conceded_team_match", "Yenen gol (maç başı)", 2, False),
               ("possession_percentage_team", "Topla oynama %", 1, True), ("big_chance_team", "Net gol fırsatı", 1, True),
               ("touches_in_opp_box_team", "Rakip ceza sahasında topla buluşma", 1, True),
               ("corner_taken_team", "Korner", 1, True), ("total_yel_card_team", "Sarı kart", 1, False)]


async def upcoming(src):
    """Takip edilen liglerin fikstüründen her takımın sıradaki 3 maçı."""
    now = datetime.now(timezone.utc).isoformat()
    out = {}
    for lid in LEAGUES:
        try:
            data = await src.league(lid, SEASON_TTL)
        except Exception as e:  # noqa: BLE001
            log.warning("fikstür alınamadı %s: %s", lid, e)
            continue
        for m in ((data or {}).get("fixtures") or {}).get("allMatches") or []:
            st = m.get("status") or {}
            t = st.get("utcTime") or ""
            if st.get("finished") or st.get("cancelled") or t < now:
                continue
            row = {"id": int(m["id"]), "utc": t, "league_id": lid,
                   "home": {"id": int(m["home"]["id"]), "name": m["home"].get("name")},
                   "away": {"id": int(m["away"]["id"]), "name": m["away"].get("name")}}
            for side in ("home", "away"):
                out.setdefault(row[side]["id"], []).append(row)
    return {k: sorted(v, key=lambda r: r["utc"])[:3] for k, v in out.items()}


def _season(stats):
    rows = []
    for k, label, d, hi in SEASON_KEYS:
        x = (stats or {}).get(k)
        if x and x.get("per_match") is not None:
            rows.append({"key": k, "label": label, "value": round(x["per_match"], d), "rank": x.get("rank"), "of": x.get("of"), "hi": hi})
    return rows


def _players(pl):
    out = {}
    for k, v in (pl or {}).items():
        lst = (v or {}).get("list") or []
        if lst:
            out[k] = {"title": v.get("title"), "list": [{"id": p.get("id"), "name": p.get("name"), "value": p.get("value")} for p in lst[:3]]}
    return out


def build(bodies, hist, fixtures):
    """bodies: yayındaki maç paketleri (yeniden eskiye). Dönüş: {takım id: sayfa}."""
    pages = {}
    for b in sorted(bodies, key=lambda b: b.get("utc") or "", reverse=True):
        for side in ("home", "away"):
            t = b[side]
            tid = t["id"]
            if tid in pages:
                continue
            rec = b["recent"][side]
            rows = (rec.get("rows") or []) + (rec.get("rows_more") or [])
            pages[tid] = {
                "id": tid, "name": t["name"], "league_id": b.get("league_id"), "league": b.get("league_name"),
                "updated": b.get("updated"), "elo": (b.get("elo") or [None, None])[0 if side == "home" else 1],
                "elo_hist": [[d[:10], r] for d, r in (hist.get(tid) or [])[-40:]],
                "recent": {k: rec.get(k) for k in ("n", "n_stats", "avg_for", "avg_against", "form", "points")},
                "rows": [{k: r.get(k) for k in ("match_id", "date", "comp", "opponent", "opp_id", "home", "gf", "ga", "result")}
                         | {"xg": (r.get("for") or {}).get("xg"), "xga": (r.get("against") or {}).get("xg")} for r in rows[:10]],
                "table": (b.get("season") or {}).get("table_" + side),
                "season": _season((b.get("season") or {}).get(side)),
                "players": _players((b.get("season") or {}).get("players_" + side)),
                "next": fixtures.get(tid) or [],
            }
    return pages


async def collect_pages(src, bodies):
    try:
        hist = await collect.elo_history(src)
    except Exception as e:  # noqa: BLE001
        log.warning("güç puanı geçmişi alınamadı: %s", e)
        hist = {}
    return build(bodies, hist, await upcoming(src))
