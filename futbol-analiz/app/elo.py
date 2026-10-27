"""Takım gücü puanı (Elo). Takip edilen liglerin ve Avrupa kupalarının son iki sezon + bu sezon sonuçlarından
hesaplanır; Avrupa maçları ligleri birbirine bağlar. Gol farkı da hesaba katılır (World Football Elo usulü)."""
import asyncio
import logging
import math
import time

from .config import LEAGUES

log = logging.getLogger(__name__)

FOTMOB = "https://www.fotmob.com/api/data"
K = 22
HFA = 60            # ev sahibi avantajı (Elo puanı)
NEW_GAP = 60        # lige yeni gelen (alt ligden çıkan) takım, ligin ortalamasının bu kadar altından başlar
# ligler arası başlangıç farkı; Avrupa maçlarıyla zamanla düzelir
START = {47: 1660, 87: 1630, 55: 1615, 54: 1610, 53: 1580, 61: 1540, 57: 1525, 40: 1490, 71: 1475,
         48: 1460, 64: 1430}
CUPS = {42, 73, 10216}
HIST_SEASONS = ("2024/2025", "2025/2026")
HIST_TTL = 30 * 86400


def _compact(data, lid):
    out = []
    for m in ((data or {}).get("fixtures") or {}).get("allMatches") or []:
        st = m.get("status") or {}
        if not st.get("finished") or st.get("cancelled") or st.get("awarded"):
            continue
        try:
            hs, as_ = (int(x) for x in (st.get("scoreStr") or "").replace(" ", "").split("-")[:2])
        except ValueError:
            continue
        out.append({"id": int(m["id"]), "t": st.get("utcTime"), "l": lid,
                    "h": int(m["home"]["id"]), "a": int(m["away"]["id"]), "hs": hs, "as": as_})
    return out


async def load_matches(src, season_ttl):
    """Bütün sonuçlar (en eskisi önce). Geçmiş sezonlar uzun süre önbellekte tutulur (sadece özet)."""
    async def hist(lid, season):
        key = f"elo:{lid}:{season}"
        hit = src.store.cache_get(key)
        if hit and time.time() - hit[0] < HIST_TTL:
            return hit[1]
        try:
            data = await src.fetch_json(f"{FOTMOB}/leagues?id={lid}&season={season.replace('/', '%2F')}")
        except Exception as e:  # noqa: BLE001
            log.warning("elo geçmişi alınamadı %s %s: %s", lid, season, e)
            return hit[1] if hit else []
        rows = _compact(data, lid)
        src.store.cache_put(key, rows)
        return rows

    async def current(lid):
        try:
            return _compact(await src.league(lid, season_ttl), lid)
        except Exception as e:  # noqa: BLE001
            log.warning("elo için lig alınamadı %s: %s", lid, e)
            return []

    parts = await asyncio.gather(*[hist(l, s) for l in LEAGUES for s in HIST_SEASONS], *[current(l) for l in LEAGUES])
    seen, out = set(), []
    for rows in parts:
        for r in rows:
            if r["id"] not in seen:
                seen.add(r["id"])
                out.append(r)
    out.sort(key=lambda r: r["t"] or "")
    return out


def run(matches, hist=None):
    """Sırayla Elo günceller. Dönüş: (son puanlar {takım: puan}, maç öncesi puanlar {maç id: (ev, dep)}).
    hist verilirse her takımın maç sonrası puanı tarihiyle eklenir: {takım: [(utc, puan), ...]}."""
    rating, pre = {}, {}
    league_of = {}
    for m in matches:
        if m["l"] not in CUPS:
            league_of[m["h"]] = league_of[m["a"]] = m["l"]

    def get(tid, lid):
        if tid not in rating:
            base_l = league_of.get(tid, lid)
            peers = [rating[t] for t, l in league_of.items() if l == base_l and t in rating]
            # ligde puanı olan takımlar varsa yeni gelen onların ortalamasının altından başlar
            rating[tid] = (sum(peers) / len(peers) - NEW_GAP) if len(peers) >= 8 else START.get(base_l, 1450)
        return rating[tid]

    for m in matches:
        rh, ra = get(m["h"], m["l"]), get(m["a"], m["l"])
        pre[m["id"]] = (round(rh, 1), round(ra, 1))
        exp = 1 / (1 + 10 ** (-(rh + HFA - ra) / 400))
        res = 1.0 if m["hs"] > m["as"] else (0.5 if m["hs"] == m["as"] else 0.0)
        gd = abs(m["hs"] - m["as"])
        mult = 1 if gd <= 1 else (1.5 if gd == 2 else (11 + gd) / 8)
        d = K * mult * (res - exp)
        rating[m["h"]], rating[m["a"]] = rh + d, ra - d
        if hist is not None:
            hist.setdefault(m["h"], []).append((m["t"], round(rh + d)))
            hist.setdefault(m["a"], []).append((m["t"], round(ra - d)))
    return rating, pre


def expected(rh, ra):
    """Ev sahibinin beklenen skoru (galibiyet 1, beraberlik 0.5)."""
    return 1 / (1 + 10 ** (-(rh + HFA - ra) / 400))


def supremacy(rh, ra):
    """Elo farkından beklenen gol farkı (yaklaşık: 100 puan ≈ 0.28 gol, ev avantajı dahil)."""
    return (rh + HFA - ra) / 100 * 0.28


def win_prob_gap(rh, ra):
    return math.log10(1 / expected(rh, ra) - 1)
