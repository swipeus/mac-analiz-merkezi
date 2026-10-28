"""Katlama serisi: her gün tek kupon, kazanınca dönen paranın tamamı ertesi günün kuponuna yatırılır
(1.000 → 2.000 → 4.000 ...). Kaybedince seri biter, ertesi gün 1.000 ₺ ile yeni seri başlar.

Kurallar: toplam oran 1.90-3.00, her tercihin model olasılığı en az %65, her maçtan tek tercih. Diğer kuponlardan
bağımsızdır (aynı tercih başka kuponlarda da olabilir) ve karnenin kâr/zarar hesabına girmez. Kupon, maçlarından
birinin resmi ilk 11'i açıklanınca (en geç ilk maç başlayınca) kilitlenir.
"""
from datetime import datetime, timezone

from . import kupon
from .analysis import fav_side, fav_under

START_DATE = "2026-10-28"
START_STAKE = 1000
ODDS = (1.90, 3.00)
MIN_P = 0.65
MIN_LEG_ODDS = 1.15
MIN_COUPON_P = 0.35


def build(bundles, date):
    """O günün başlamamış maçlarından tek katlama kuponu (kurulamazsa None)."""
    best = []
    for b in bundles:
        fav = fav_side(((b.get("analysis") or {}).get("prediction") or {}).get("probs") or {})
        ok = [x for x in kupon._cands(b) if x[1] >= MIN_P and x[2] >= MIN_LEG_ODDS and not kupon._weak(x[0])
              and not fav_under(x[0], fav)]
        if ok:
            ok.sort(key=lambda x: (round(x[1], 2), x[2]), reverse=True)
            best.append((ok, b))
    best.sort(key=lambda t: (round(t[0][0][1], 2), t[0][0][2]), reverse=True)
    legs = None
    for skip in range(max(1, len(best) - 1)):  # en güvenilir maçlarla kurulamazsa bir sonrakinden dene
        legs = kupon._fill(best[skip:], ODDS[0], ODDS[1], MIN_COUPON_P)
        if legs:
            break
    if not legs:
        return None
    legs.sort(key=lambda t: t[1].get("utc") or "")
    lg = [kupon._leg(b, *x) for x, b in legs]
    odds, prob = 1.0, 1.0
    for l in lg:
        odds *= l["odds"]
        prob *= l["p"]
    return {"id": f"katlama-{date}", "date": date, "theme": "katlama", "name": "Katlama", "icon": "🔁",
            "desc": "Günde tek kupon; kazanınca dönen para ertesi günün kuponuna yatırılır.",
            "legs": lg, "odds": round(odds, 2), "p": round(prob, 3), "state": "pending"}


def update_day(store, date, bundles):
    """Günün katlama kuponunu kurar ya da (kilitliyse) olduğu gibi bırakır."""
    if date < START_DATE:
        return store.kat_get(date)
    now = datetime.now(timezone.utc)
    doc = store.kat_get(date)
    if doc and (doc.get("locked") or any(kupon._started(l, now) for l in doc["coupon"]["legs"])):
        if not doc.get("locked"):
            doc["locked"] = True
            store.kat_put(date, doc)
        return doc
    fresh = [b for b in bundles if not (b.get("status") or {}).get("started") and b.get("odds")
             and not kupon._started({"utc": b.get("utc")}, now)]
    c = build(fresh, date)
    if not c:
        return doc
    by_id = {b["id"]: b for b in fresh}
    final = any((by_id.get(l["mid"], {}).get("lineup") or {}).get("confirmed") for l in c["legs"])
    doc = {"date": date, "locked": final, "coupon": c}
    store.kat_put(date, doc)
    return doc


def settle(store):
    """Ayakları maç sonuçlarıyla günceller; bir ayak kaybederse kupon kaybeder, hepsi tutunca kazanır."""
    for doc in store.kat_all():
        c, changed = doc["coupon"], False
        for l in c["legs"]:
            changed |= kupon._update_leg(store, l)
        if c["state"] == "pending":
            if any(l.get("hit") is False for l in c["legs"]):
                c["state"], c["won"], changed = "done", False, True
            elif all(l.get("hit") is True or l.get("void") for l in c["legs"]):
                odds = 1.0
                for l in c["legs"]:
                    if not l.get("void"):
                        odds *= l["odds"]
                c["state"], c["won"], c["paid_odds"], changed = "done", True, round(odds, 2), True
        if changed:
            store.kat_put(doc["date"], doc)


def export(store):
    """Seri hesabı: her günün yatırılan ve dönen tutarı, seri numarası, kasa ve toplam."""
    days, bank, series, streak, best = [], START_STAKE, 1, 0, 0
    lost_series, pending_before = [], False
    for doc in store.kat_all():
        if doc["date"] < START_DATE:
            continue
        c = doc["coupon"]
        row = {"date": doc["date"], "locked": bool(doc.get("locked")), "coupon": c, "series": series}
        if pending_before:  # önceki gün sonuçlanmadan yatırılacak tutar belli değil
            row["stake"] = None
        else:
            row["stake"] = round(bank, 2)
        if c["state"] == "done" and not pending_before:
            if c.get("won"):
                bank = round(bank * c["paid_odds"], 2)
                streak += 1
                best = max(best, streak)
                row["ret"] = bank
            else:
                row["ret"] = 0
                lost_series.append({"series": series, "days": streak, "peak": row["stake"]})
                bank, series, streak = START_STAKE, series + 1, 0
        elif c["state"] != "done":
            pending_before = True
        days.append(row)
    invested = START_STAKE * series
    return {"start": START_DATE, "start_stake": START_STAKE, "rules": {"odds": ODDS, "min_p": MIN_P},
            "days": days[::-1], "bank": bank, "series": series, "streak": streak, "best": best,
            "lost_series": lost_series, "invested": invested, "net": round(bank - invested, 2)}


def seed(store, data):
    """Yayındaki katlama geçmişini geri yükler (önbellek kaybolduysa)."""
    n = 0
    for row in (data or {}).get("days") or []:
        local = store.kat_get(row["date"])
        if not local or (row["coupon"]["state"] == "done" and local["coupon"]["state"] != "done") \
                or (row.get("locked") and not local.get("locked")):
            store.kat_put(row["date"], {"date": row["date"], "locked": row.get("locked"), "coupon": row["coupon"]})
            n += 1
    return n
