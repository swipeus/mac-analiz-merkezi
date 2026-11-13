"""Keskin piyasa: Pinnacle oranlarından marjı ayıklanmış olasılıklar (düşük marjlı site, gerçeğe en yakın fiyat kabul edilir).

Yalnızca karşılaştırma için kullanılır: kendi modelimizin bir tercihi piyasadan belirgin kötümser görüp görmediği bu
olasılıklara göre ölçülür. Alınamazsa Unibet'in kendi oranları kullanılır (analysis._fair).
"""
import asyncio
import logging
import time
from datetime import datetime

from .odds import _sim

log = logging.getLogger(__name__)

API = "https://guest.api.arcadia.pinnacle.com/0.1"
TTL = 600
_locks = {}
# FotMob lig kimliği -> Pinnacle lig kimliği
LEAGUES = {47: 1980, 87: 2196, 55: 2436, 54: 1842, 53: 2036, 57: 1928, 61: 2386, 40: 1817, 71: 2592, 48: 1977, 64: 2421,
           42: 2627, 73: 2630, 10216: 214101, 9806: 200719, 9807: 200721, 9808: 200726, 9809: 200727}


def _dec(us):
    """Amerikan oranı -> ondalık."""
    return 1 + us / 100 if us > 0 else 1 + 100 / -us


def _fair(prices):
    inv = [1 / _dec(p) for p in prices]
    t = sum(inv)
    return [x / t for x in inv]


def _num(x):
    return f"{x:g}"


async def _league(src, lid):
    async with _locks.setdefault(lid, asyncio.Lock()):  # aynı ligin maçları aynı anda yenilenince tek istek gitsin
        return await _league_locked(src, lid)


async def _league_locked(src, lid):
    key = f"pin:{lid}"
    hit = src.store.cache_get(key)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    try:
        mus = await src.fetch_json(f"{API}/leagues/{lid}/matchups")
        mks = await src.fetch_json(f"{API}/leagues/{lid}/markets/straight")
    except Exception as e:  # noqa: BLE001
        log.warning("Pinnacle alınamadı (%s): %s", lid, e)
        return hit[1] if hit else []
    by = {}
    for p in mks:
        if p.get("period") == 0 and not p.get("isAlternate", False):
            by.setdefault(p["matchupId"], []).append(p)
    out = []
    for m in mus:
        if m.get("type") != "matchup" or m.get("parent") or len(m.get("participants") or []) != 2:
            continue
        side = {x["alignment"]: x["name"] for x in m["participants"]}
        probs = {}
        for p in by.get(m["id"], []):
            pr = {x.get("designation"): x for x in p.get("prices", [])}
            try:
                if p["type"] == "moneyline" and {"home", "away", "draw"} <= set(pr):
                    h, a, d = _fair([pr["home"]["price"], pr["away"]["price"], pr["draw"]["price"]])
                    probs.update({"1": h, "2": a, "X": d, "1X": h + d, "X2": a + d, "12": h + a})
                elif p["type"] == "total" and {"over", "under"} <= set(pr):
                    o, u = _fair([pr["over"]["price"], pr["under"]["price"]])
                    line = _num(pr["over"]["points"])
                    probs[f"o{line}"], probs[f"u{line}"] = o, u
                elif p["type"] == "team_total" and {"over", "under"} <= set(pr):
                    o, u = _fair([pr["over"]["price"], pr["under"]["price"]])
                    t = "h" if p.get("side") == "home" or str(p.get("key", "")).endswith("home") else "a"
                    line = _num(pr["over"]["points"])
                    probs[f"{t}o{line}"], probs[f"{t}u{line}"] = o, u
            except (KeyError, TypeError, ZeroDivisionError):
                continue
        if probs:
            out.append({"t": m.get("startTime"), "home": side.get("home"), "away": side.get("away"), "p": {k: round(v, 4) for k, v in probs.items()}})
    src.store.cache_put(key, out)
    return out


async def fair_for(src, league_id, utc, home, away):
    """Maçın Pinnacle'daki marjsız olasılıkları {kod: olasılık}; bulunamazsa None."""
    lid = LEAGUES.get(league_id)
    if not lid or not utc:
        return None
    try:
        t = datetime.fromisoformat(utc.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    best, top = None, 0.0
    for e in await _league(src, lid):
        try:
            et = datetime.fromisoformat(e["t"].replace("Z", "+00:00")).timestamp()
        except (AttributeError, ValueError):
            continue
        if abs(et - t) > 3 * 3600:
            continue
        s = _sim(e["home"], home) + _sim(e["away"], away)
        if s > top:
            best, top = e, s
    return best["p"] if best and top >= 1.0 else None
