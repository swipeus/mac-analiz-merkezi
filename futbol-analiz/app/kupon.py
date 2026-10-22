"""Günün kombineleri: modelin o günün maçlarından hazırladığı 3-5 kupon (her biri 2-5 maç).

Her kuponun bir teması var (Banko, En garantiler, Günün favorileri, Gol şöleni, Korner kombinesi, Değerli oranlar).
Bir kupon içinde her maçtan tek tercih olur; aynı tercih farklı kuponlarda yer alabilir. Tercih başına risk düşük
tutulur (model olasılığı en az %50, çoğu temada %60-75). Kuponlar maçlar başlayana kadar en güncel verilerle
yeniden hazırlanır; kupondaki ilk maç başladığında o günün kuponları kilitlenir ve karneye yazılır.
"""
import re
from collections import Counter
from datetime import datetime, timezone

from .analysis import SAFE_CODES, TOTAL_CODE, code_label, pick_hit

STAKE = 250
MAX_LEGS = 5

GOALISH = re.compile(r"^(o1\.5|o2\.5|o3\.5|btts_yes|[ha]o[01]\.5)$")
CORNER = re.compile(r"^(c[ou]\d+(\.\d+)?|cm[12X])$")
WINS = {"1", "2"}

# (ad, simge, açıklama, seçici, en az olasılık, tek tercih oran aralığı, hedef toplam oran, en çok maç)
THEMES = [
    ("Banko", "🔒", "Modelin en emin olduğu tercihler; düşük oran, yüksek isabet.",
     lambda c: True, 0.75, (1.25, 1.55), (2.0, 3.0), 4),
    ("En garantiler", "✅", "Farklı pazarlardan, her biri yüksek olasılıklı ve oranı makul tercihler.",
     lambda c: True, 0.68, (1.25, 1.90), (2.5, 5.0), 4),
    ("Günün favorileri", "⭐", "Günün favori takımlarının kazanması (galibiyet ya da galibiyetli kombine).",
     lambda c: c in WINS or c.split("&")[0] in ("1", "2"), 0.55, (1.25, 2.20), (2.5, 6.0), 4),
    ("Gol şöleni", "⚽", "Gol beklentisi yüksek maçlardan üst, karşılıklı gol ve takım golü tercihleri.",
     lambda c: bool(GOALISH.match(c)) or c == "btts_yes&o2.5", 0.58, (1.25, 2.20), (2.5, 6.0), 4),
    ("Korner kombinesi", "🚩", "Toplam korner alt/üst ve en çok korner tercihleri.",
     lambda c: bool(CORNER.match(c)), 0.57, (1.25, 2.20), (2.5, 6.0), 4),
    ("Değerli oranlar", "💎", "Oranı 1.45 üstü olup modelin piyasa kadar ya da daha olası gördüğü tercihler.",
     lambda c: True, 0.52, (1.45, 2.60), (4.0, 12.0), 5),
]
MIN_LEG_ODDS = 1.25
MAX_SAME = 2  # bir kuponda aynı pazardan en çok kaç tercih
MIN_TOTAL, MAX_TOTAL = 2.0, 12.0  # kupon toplam oranı bu aralıkta olmalı


def family(c):
    """Tercihin pazar ailesi (kuponda çeşitlilik için)."""
    if "&" in c:
        return "kombine"
    if c in ("1", "X", "2"):
        return "ms"
    if c in ("1X", "12", "X2"):
        return "cifte"
    if c.startswith("dnb"):
        return "iade"
    if c.startswith("btts"):
        return "kg"
    if c[0] in "ou":
        return "altust"
    if c[0] in "ha":
        return "takim"
    if c.startswith(("co", "cu")):
        return "korner"
    if c.startswith("cm"):
        return "kornerms"
    return c


def _cands(b):
    """Bir maçın kupona girebilecek seçenekleri: (kod, olasılık, oran)."""
    pr = (b.get("analysis") or {}).get("prediction") or {}
    probs = pr.get("probs") or {}
    out = {}
    for m in (b.get("odds") or {}).get("markets") or []:
        for s in m["selections"]:
            c = s.get("code")
            if not c or c not in probs or c.startswith(("cs:", "fts", "odd", "even", "rc_", "fc8", "dnb")):
                continue
            legs = c.split("&")
            if len(legs) > 2 or not all(x in SAFE_CODES or TOTAL_CODE.match(x) for x in legs):
                continue
            p, o = probs[c], s["odds"]
            if p < 0.5 or o < 1.05:
                continue
            if c not in out or o > out[c][2]:
                out[c] = (c, p, o)
    return list(out.values())


def _leg(b, c, p, o):
    return {"mid": b["id"], "utc": b.get("utc"), "league": b.get("league_name"),
            "home": {"id": b["home"]["id"], "name": b["home"]["name"]},
            "away": {"id": b["away"]["id"], "name": b["away"]["name"]},
            "code": c, "label": code_label(c, b["home"]["name"], b["away"]["name"]),
            "p": round(p, 3), "odds": o}


def build(bundles, date, relax=0.0):
    """bundles: o günün başlamamış, oranı olan maç paketleri. 3-5 kupon döner (yeterli maç yoksa daha az)."""
    pool = [(b, _cands(b)) for b in bundles]
    pool = [(b, cs) for b, cs in pool if cs]
    coupons, seen = [], set()
    for name, icon, desc, sel, pmin, (omin, omax), (tmin, tmax), max_legs in THEMES:
        value = name == "Değerli oranlar"
        edge = lambda x: x[1] * x[2] - 1
        if value:
            key = lambda x: (edge(x), x[1])
        elif name == "Günün favorileri":  # favori temasında düz galibiyet, iadeden önce gelir
            key = lambda x: (x[0] in ("1", "2") and x[1] >= 0.62, x[1])
        elif name == "Gol şöleni":  # 1.5 üst her maçta tutar gibi görünür; daha gollü seçenekler öne
            key = lambda x: (2 if x[0] in ("o2.5", "o3.5", "btts_yes", "btts_yes&o2.5") and x[1] >= 0.58
                             else 0 if x[0] == "o1.5" else 1, x[1])
        else:  # önce olasılık, yakın olasılıklarda daha yüksek oran
            key = lambda x: (round(x[1], 2), x[2])
        best = []
        for b, cs in pool:  # her maçın temaya uyan tercihleri, en uygundan başlayarak
            ok = [x for x in cs if sel(x[0]) and x[1] >= pmin - relax and max(omin, MIN_LEG_ODDS) <= x[2] <= omax
                  and (not value or edge(x) >= -0.01)]
            if ok:
                best.append((sorted(ok, key=key, reverse=True), b))
        best.sort(key=lambda t: key(t[0][0]), reverse=True)
        legs, tot, used = [], 1.0, Counter()
        for ok, b in best:  # hedef toplam orana ulaşana kadar en güvenilir tercihleri ekle
            if len(legs) >= min(max_legs, MAX_LEGS) or (len(legs) >= 2 and tot >= tmin):
                break
            # pazarlar karışık olsun: önce kuponda henüz olmayan bir pazar, yoksa en çok 2 aynı pazar
            x = next((y for y in ok if not used[family(y[0])]), None) \
                or next((y for y in ok if used[family(y[0])] < MAX_SAME), None)
            if x is None or (tot * x[2] > tmax and len(legs) >= 2):
                continue
            legs.append((x, b))
            used[family(x[0])] += 1
            tot *= x[2]
        if len(legs) < 2 or not MIN_TOTAL <= tot <= MAX_TOTAL:
            continue
        sig = tuple(sorted((b["id"], x[0]) for x, b in legs))
        if sig in seen:
            continue
        seen.add(sig)
        legs.sort(key=lambda t: t[1].get("utc") or "")
        lg = [_leg(b, *x) for x, b in legs]
        odds, prob = 1.0, 1.0
        for l in lg:
            odds *= l["odds"]
            prob *= l["p"]
        coupons.append({"id": f"{date}-{len(coupons) + 1}", "date": date, "name": name, "icon": icon, "desc": desc,
                        "legs": lg, "odds": round(odds, 2), "p": round(prob, 3), "stake": STAKE, "state": "pending"})
        if len(coupons) == 5:
            break
    if len(coupons) < 3 and relax < 0.12 and len(pool) >= 2:
        return build(bundles, date, relax + 0.06)
    return coupons


def _started(leg, now):
    try:
        return datetime.fromisoformat(leg["utc"].replace("Z", "+00:00")) <= now
    except (AttributeError, KeyError, ValueError):
        return False


def update_day(store, date, bundles):
    """O günün kuponlarını hazırlar: hiçbir kupon maçı başlamadıysa güncel verilerle yeniden kurar,
    biri başladıysa mevcut kuponları kilitler (karnede maç öncesi hâl kalır)."""
    now = datetime.now(timezone.utc)
    doc = store.coupon_get(date)
    if doc and (doc.get("locked") or any(_started(l, now) for c in doc["coupons"] for l in c["legs"])):
        if not doc.get("locked"):
            doc["locked"] = True
            store.coupon_put(date, doc)
        return doc
    fresh = [b for b in bundles if not (b.get("status") or {}).get("started") and b.get("odds")
             and not _started({"utc": b.get("utc")}, now)]
    coupons = build(fresh, date)
    if not coupons:
        return doc
    doc = {"date": date, "locked": False, "coupons": coupons}
    store.coupon_put(date, doc)
    return doc


def settle(store):
    """Bekleyen kuponları maç sonuçlarıyla değerlendirir. Ertelenen/iptal ya da iadeli ayak kupondan düşer (oran 1)."""
    for doc in store.coupon_all():
        changed = False
        for c in doc["coupons"]:
            if c["state"] != "pending":
                continue
            done = True
            for l in c["legs"]:
                if l.get("hit") is not None or l.get("void"):
                    continue
                b = store.bundle_get(l["mid"])
                body = (b or {}).get("body") or {}
                st = body.get("status") or {}
                if st.get("cancelled"):
                    l["void"] = True
                    changed = True
                    continue
                hs, as_ = body.get("home", {}).get("score"), body.get("away", {}).get("score")
                if not st.get("finished") or hs is None or as_ is None:
                    done = False
                    continue
                h = pick_hit(l["code"], hs, as_, body.get("final"))
                l["result"] = [hs, as_]
                if h is None:
                    l["void"] = True
                else:
                    l["hit"] = h
                changed = True
            if any(l.get("hit") is False for l in c["legs"]):
                c["state"] = "done"
                c["won"] = False
                c["profit"] = -c["stake"]
                changed = True
            elif done:
                odds = 1.0
                for l in c["legs"]:
                    if not l.get("void"):
                        odds *= l["odds"]
                c["state"], c["won"] = "done", True
                c["paid_odds"] = round(odds, 2)
                c["profit"] = round(c["stake"] * (odds - 1), 2)
                changed = True
        if changed:
            store.coupon_put(doc["date"], doc)


def seed(store, docs):
    """Yayındaki karneden kuponları geri yükler (yerelde yoksa ya da yayındaki daha ileri bir durumdaysa)."""
    n = 0
    for d in docs or []:
        local = store.coupon_get(d["date"])
        def settled(x):
            return sum(c["state"] == "done" for c in (x or {}).get("coupons") or [])
        if not local or (d.get("locked") and not local.get("locked")) or settled(d) > settled(local):
            store.coupon_put(d["date"], d)
            n += 1
    return n
