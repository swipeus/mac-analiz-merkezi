"""Günün kombineleri: model her gün beş temada (Banko, En garantiler, Gol şöleni, Kornerler, Değerli oranlar)
üçer kupon hazırlar; her kupon 2-5 maç.

Bir kupon içinde her maçtan tek tercih olur. Aynı tercih (aynı maçta aynı seçenek) günün en fazla iki kuponunda
kullanılır. Her temanın toplam oran aralığı sabittir. Tercih başına risk düşük tutulur (model olasılığı temaya göre
en az %52-75). Kuponlar maçlar başlayana kadar en güncel verilerle yeniden hazırlanır; kupondaki ilk maç başladığında
o günün kuponları kilitlenir ve karneye yazılır.
"""
import re
from collections import Counter
from datetime import datetime, timezone

from .analysis import SAFE_CODES, TOTAL_CODE, code_label, pick_hit

STAKE = 1000           # kupon başına
PER_THEME = 3          # her temada günlük kupon sayısı
MAX_LEGS = 5
MAX_USE = 2            # aynı tercih günün en fazla kaç kuponunda yer alır

GOALISH = re.compile(r"^(o1\.5|o2\.5|o3\.5|btts_yes|[ha]o[01]\.5)$")
CORNER = re.compile(r"^(c[ou]\d+(\.\d+)?|cm[12X])$")

# (anahtar, ad, simge, açıklama, seçici, en az olasılık, tek tercih oran aralığı, toplam oran aralığı)
THEMES = [
    ("banko", "Banko", "🔒", "Modelin en emin olduğu tercihler; düşük oran, yüksek isabet.",
     lambda c: True, 0.75, (1.25, 1.60), (2.0, 3.5)),
    ("garanti", "En garantiler", "✅", "Farklı pazarlardan, her biri yüksek olasılıklı ve oranı makul tercihler.",
     lambda c: True, 0.68, (1.25, 1.90), (2.0, 3.5)),
    ("gol", "Gol şöleni", "⚽", "Gol beklentisi yüksek maçlardan üst, karşılıklı gol ve takım golü tercihleri.",
     lambda c: bool(GOALISH.match(c)) or c == "btts_yes&o2.5", 0.58, (1.25, 2.30), (2.5, 6.0)),
    ("korner", "Kornerler", "🚩", "Toplam korner alt/üst ve en çok korner tercihleri.",
     lambda c: bool(CORNER.match(c)), 0.57, (1.25, 2.30), (2.5, 6.0)),
    ("deger", "Değerli oranlar", "💎", "Oranı 1.45 üstü olup modelin piyasa kadar ya da daha olası gördüğü tercihler.",
     lambda c: True, 0.52, (1.45, 2.60), (3.0, 10.0)),
]
MIN_LEG_ODDS = 1.25
MAX_SAME = 2  # bir kuponda aynı pazardan en çok kaç tercih


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


def _theme_key(tk):
    edge = lambda x: x[1] * x[2] - 1
    if tk == "deger":
        return lambda x: (edge(x), x[1])
    if tk == "gol":  # 1.5 üst her maçta tutar gibi görünür; daha gollü seçenekler öne
        return lambda x: (2 if x[0] in ("o2.5", "o3.5", "btts_yes", "btts_yes&o2.5") and x[1] >= 0.58
                          else 0 if x[0] == "o1.5" else 1, x[1])
    return lambda x: (round(x[1], 2), x[2])  # önce olasılık, yakın olasılıklarda daha yüksek oran


def _one(pool, theme, relax, use, theme_use, seen):
    """Temaya uygun tek kupon: hedef toplam orana ulaşana kadar en güvenilir tercihleri ekler."""
    tk, name, icon, desc, sel, pmin, (omin, omax), (tmin, tmax) = theme
    key = _theme_key(tk)
    edge = lambda x: x[1] * x[2] - 1
    best = []
    for b, cs in pool:
        ok = [x for x in cs if sel(x[0]) and x[1] >= pmin - relax and omin <= x[2] <= omax
              and use[(b["id"], x[0])] < MAX_USE and (tk != "deger" or edge(x) >= -0.01 - relax / 4)]
        if ok:
            # bu temada henüz kullanılmamış tercihler önce: temanın üç kuponu birbirinin kopyası olmasın
            ok.sort(key=lambda x: (theme_use[(b["id"], x[0])] == 0, key(x)), reverse=True)
            best.append((ok, b))
    best.sort(key=lambda t: (theme_use[(t[1]["id"], t[0][0][0])] == 0, key(t[0][0])), reverse=True)
    legs, tot, fam = [], 1.0, Counter()
    for ok, b in best:
        if len(legs) >= MAX_LEGS or (len(legs) >= 2 and tot >= tmin):
            break
        # pazarlar karışık olsun: önce kuponda henüz olmayan bir pazar, yoksa en çok 2 aynı pazar
        x = next((y for y in ok if not fam[family(y[0])]), None) \
            or next((y for y in ok if fam[family(y[0])] < MAX_SAME), None)
        if x is None or tot * x[2] > tmax:
            continue
        legs.append((x, b))
        fam[family(x[0])] += 1
        tot *= x[2]
    if len(legs) < 2 or not tmin <= tot <= tmax:
        return None
    sig = tuple(sorted((b["id"], x[0]) for x, b in legs))
    if sig in seen:
        return None
    return legs


def build(bundles, date):
    """bundles: o günün başlamamış, oranı olan maç paketleri. Her temada en fazla 3 kupon (veri yetmezse daha az)."""
    pool = [(b, _cands(b)) for b in bundles]
    pool = [(b, [x for x in cs if x[2] >= MIN_LEG_ODDS]) for b, cs in pool]
    pool = [(b, cs) for b, cs in pool if cs]
    coupons, seen, use = [], set(), Counter()
    for theme in THEMES:
        tk, name, icon, desc = theme[:4]
        theme_use, n = Counter(), 0
        for relax in (0.0, 0.04, 0.08, 0.12):  # yeterli kupon çıkmazsa olasılık eşiği biraz gevşer
            while n < PER_THEME:
                legs = _one(pool, theme, relax, use, theme_use, seen)
                if not legs:
                    break
                seen.add(tuple(sorted((b["id"], x[0]) for x, b in legs)))
                for x, b in legs:
                    use[(b["id"], x[0])] += 1
                    theme_use[(b["id"], x[0])] += 1
                legs.sort(key=lambda t: t[1].get("utc") or "")
                lg = [_leg(b, *x) for x, b in legs]
                odds, prob = 1.0, 1.0
                for l in lg:
                    odds *= l["odds"]
                    prob *= l["p"]
                n += 1
                coupons.append({"id": f"{date}-{tk}-{n}", "date": date, "theme": tk, "name": f"{name} {n}", "icon": icon,
                                "desc": desc, "legs": lg, "odds": round(odds, 2), "p": round(prob, 3),
                                "stake": STAKE, "state": "pending"})
            if n >= PER_THEME:
                break
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
