"""Günün kombineleri: model her gün beş temada kupon hazırlar: Banko 5, Gol şöleni, Kornerler, Kartlar ve
Değerli oranlar üçer kupon (az maçlı günlerde daha az); her kupon 2-5 maç.

Bir kupon içinde her maçtan tek tercih olur. Banko'daki bir tercih başka hiçbir kupona girmez
(tek kötü sonuç birden çok kuponu yakmasın); diğer temalarda aynı tercih en fazla iki kuponda olur. Karnede zayıf
çıkan çifte şans 12 ve en çok korner güvenli kuponlara alınmaz. Az maçlı günlerde tema başına daha az kupon çıkar. Her temanın toplam oran aralığı sabittir. Tercih başına risk düşük tutulur (model olasılığı temaya göre
en az %52-75). Kuponlar en güncel verilerle yeniden hazırlanır; kuponlardaki maçlardan birinin resmi ilk 11'i açıklanınca
son kontrol yapılır ve o günün kuponları kilitlenir (en geç ilk maç başlayınca), karneye bu hâliyle yazılır.
"""
import re
import time
from collections import Counter
from datetime import datetime, timezone

from .analysis import SAFE_CODES, STAT_CODE, TOTAL_CODE, code_label, code_odds, early_hit, fav_side, fav_under, pick_hit, stat_ok

STAKE = 5000           # kupon başına
PER_THEME = 3          # her temada günlük kupon sayısı
MAX_LEGS = 5
MAX_USE = 2            # aynı tercih günün en fazla kaç kuponunda yer alır

GOALISH = re.compile(r"^(o1\.5|o2\.5|o3\.5|btts_yes|[ha]o[01]\.5)$")
CORNER_TOTAL = re.compile(r"^c[ou]\d+(\.\d+)?$")
SAFE_THEMES = {"banko"}
# kuponun en az tutma ihtimali: altındaki kupon hiç kurulmaz
MIN_COUPON_P = {"banko": 0.35, "deger": 0.25}
MIN_COUPON_P_OTHER = 0.20


def _weak(code):
    """Karnede modelin sandığından zayıf çıkan tercihler (çifte şans 12, en çok korner) güvenli kuponlara girmez."""
    return any(x == "12" or x.startswith("cm") for x in code.split("&"))


def per_theme(n_matches, tk=None):
    """Az maçlı günlerde tema başına daha az kupon: tercih havuzu dar olunca kuponlar birbirine benzer.
    Banko yeterli maçlı günlerde 5 kupon (eski Banko + En garantiler birleşti)."""
    if tk == "banko":
        return 5 if n_matches >= 10 else 3 if n_matches >= 6 else 1
    return 3 if n_matches >= 8 else 2 if n_matches >= 5 else 1


def _card(c):
    m = STAT_CODE.match(c)
    return bool(m) and m.group(1) == "k"

# (anahtar, ad, simge, açıklama, seçici, en az olasılık, tek tercih oran aralığı, toplam oran aralığı)
THEMES = [
    ("banko", "Banko", "✅", "Modelin en emin olduğu tercihler, farklı pazarlardan; düşük oran, yüksek isabet.",
     lambda c: not _weak(c), 0.70, (1.25, 1.80), (2.0, 3.5)),
    ("gol", "Gol şöleni", "⚽", "Gol beklentisi yüksek maçlardan üst, karşılıklı gol ve takım golü tercihleri.",
     lambda c: bool(GOALISH.match(c)) or c == "btts_yes&o2.5", 0.58, (1.25, 2.30), (2.5, 6.0)),
    ("korner", "Kornerler", "🚩", "Toplam korner alt/üst tercihleri.",
     lambda c: bool(CORNER_TOTAL.match(c)), 0.57, (1.25, 2.30), (2.5, 6.0)),
    ("kart", "Kartlar", "🟨", "Yalnızca kart tercihleri: toplam ve takım kart alt/üstleri (hakemin ve takımların kart eğilimine göre).",
     _card, 0.58, (1.25, 2.30), (2.0, 6.0)),
    ("deger", "Değerli oranlar", "💎", "Oranı 1.45-2.20 arası, modelin en az %58 ihtimal verdiği ve piyasa kadar ya da daha olası gördüğü tercihler.",
     lambda c: True, 0.58, (1.45, 2.20), (3.0, 6.0)),
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
    if c.startswith(("co", "cu")):  # korner üst ve alt ayrı pazar sayılır (Kornerler kuponu 3-4 maç olabilsin)
        return "korner_" + c[1]
    m = STAT_CODE.match(c)
    if m:  # kart / şut / isabetli şut; toplam ve takım, alt ve üst ayrı pazar (Kartlar kuponu 3-4 maç olabilsin)
        return "stat_" + m.group(1) + (m.group(2) or "t") + m.group(3)
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
            if len(legs) > 2 or not all(x in SAFE_CODES or TOTAL_CODE.match(x) or stat_ok(x) for x in legs):
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
        # güvenli temalarda tercih başka hiçbir kupona girmemiş olmalı (ve sonra da girmez)
        limit = 1 if tk in SAFE_THEMES else MAX_USE
        # Banko'ya favori takımın gol altı girmez
        fav = fav_side(((b.get("analysis") or {}).get("prediction") or {}).get("probs") or {}) if tk in SAFE_THEMES else None
        ok = [x for x in cs if sel(x[0]) and x[1] >= pmin - relax and omin <= x[2] <= omax and not fav_under(x[0], fav)
              and use[(b["id"], x[0])] < limit and (tk != "deger" or edge(x) >= -0.01 - relax / 4)]
        if ok:
            # bu temada henüz kullanılmamış tercihler önce: temanın üç kuponu birbirinin kopyası olmasın
            ok.sort(key=lambda x: (theme_use[(b["id"], x[0])] == 0, key(x)), reverse=True)
            best.append((ok, b))
    best.sort(key=lambda t: (theme_use[(t[1]["id"], t[0][0][0])] == 0, key(t[0][0])), reverse=True)
    # aynı kupon başka temada zaten varsa en üstteki maçı atlayarak farklı bir kombinasyon dene
    for skip in range(max(1, len(best) - 1)):
        legs = _fill(best[skip:], tmin, tmax, MIN_COUPON_P.get(tk, MIN_COUPON_P_OTHER))
        if legs and tuple(sorted((b["id"], x[0]) for x, b in legs)) not in seen:
            return legs
    return None


def _fill(best, tmin, tmax, min_p):
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
    prob = 1.0
    for x, _ in legs:
        prob *= x[1]
    return legs if prob >= min_p else None


def build(bundles, date):
    """bundles: o günün başlamamış, oranı olan maç paketleri. Banko 5, diğer temalar en fazla 3 kupon (veri yetmezse daha az)."""
    pool = [(b, _cands(b)) for b in bundles]
    pool = [(b, [x for x in cs if x[2] >= MIN_LEG_ODDS]) for b, cs in pool]
    pool = [(b, cs) for b, cs in pool if cs]
    coupons, seen, use = [], set(), Counter()
    theme_use = {t[0]: Counter() for t in THEMES}
    count = Counter()
    # temalar sırayla birer kupon alır (önce herkesin 1. kuponu): güçlü tercihler tek temada tükenmesin
    quota = {t[0]: per_theme(len(pool), t[0]) for t in THEMES}
    for _round in range(max(quota.values())):
        for theme in THEMES:
            tk, name, icon, desc = theme[:4]
            if count[tk] >= quota[tk]:
                continue
            legs = None
            for relax in (0.0, 0.04, 0.08, 0.12, 0.16):  # yeterli tercih yoksa olasılık eşiği biraz gevşer
                legs = _one(pool, theme, relax, use, theme_use[tk], seen)
                if legs:
                    break
            if not legs:
                continue
            seen.add(tuple(sorted((b["id"], x[0]) for x, b in legs)))
            for x, b in legs:
                # güvenli kupona giren tercih başka kupona girmesin
                use[(b["id"], x[0])] += MAX_USE if tk in SAFE_THEMES else 1
                theme_use[tk][(b["id"], x[0])] += 1
            legs.sort(key=lambda t: t[1].get("utc") or "")
            lg = [_leg(b, *x) for x, b in legs]
            odds, prob = 1.0, 1.0
            for l in lg:
                odds *= l["odds"]
                prob *= l["p"]
            count[tk] += 1
            n = count[tk]
            coupons.append({"id": f"{date}-{tk}-{n}", "date": date, "theme": tk, "name": f"{name} {n}", "icon": icon,
                            "desc": desc, "legs": lg, "odds": round(odds, 2), "p": round(prob, 3),
                            "stake": STAKE, "state": "pending"})
    order = {t[0]: i for i, t in enumerate(THEMES)}
    coupons.sort(key=lambda c: (order[c["theme"]], c["id"]))
    return coupons


def _started(leg, now):
    try:
        return datetime.fromisoformat(leg["utc"].replace("Z", "+00:00")) <= now
    except (AttributeError, KeyError, ValueError):
        return False


def update_day(store, date, bundles):
    """O günün kuponlarını hazırlar: hiçbir kupon maçı başlamadıysa güncel verilerle yeniden kurar,
    biri başladıysa mevcut kuponları kilitler (karnede maç öncesi hâl kalır). Kuponlardaki bir maçın resmi
    ilk 11'i açıklandıysa bu kurulum son kontroldür: kuponlar kilitlenir ve artık değişmez."""
    now = datetime.now(timezone.utc)
    doc = store.coupon_get(date)
    if doc and not any(c.get("theme") for c in doc["coupons"]):
        doc = None  # eski düzen (temasız, günde 5 kupon): kalan maçlarla temalı kuponlar kurulur
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
    by_id = {b["id"]: b for b in fresh}
    final = any((by_id.get(l["mid"], {}).get("lineup") or {}).get("confirmed") for c in coupons for l in c["legs"])
    doc = {"date": date, "locked": final, "coupons": coupons}
    if final:
        doc["final_at"] = time.time()
    store.coupon_put(date, doc)
    return doc


def _update_leg(store, l):
    """Ayağın canlı skorunu ve sonucunu günceller. Değişiklik olduysa True."""
    if l.get("void") or (l.get("hit") is not None and not l.get("early")) or "result" in l:
        return False
    b = store.bundle_get(l["mid"])
    body = (b or {}).get("body") or {}
    st = body.get("status") or {}
    if st.get("cancelled"):
        l["void"] = True
        return True
    hs, as_ = body.get("home", {}).get("score"), body.get("away", {}).get("score")
    if hs is None or as_ is None or not st.get("started"):
        return False
    if "close" not in l:  # maç başladı: tercihin kapanış oranı (maç öncesi son oran)
        l["close"] = code_odds(body.get("odds"), l["code"])[0]
    if not st.get("finished"):
        if time.time() - b["ts"] > 3 * 3600:  # paket bayatsa "canlı" gösterme
            return False
        # maç sürüyor: canlı skor; sonucu kesinleşen ayak (KG Var, üstler...) erkenden sonuçlanır
        live = {"score": [hs, as_], "min": st.get("live")}
        changed = l.get("live") != live
        l["live"] = live
        if l.get("hit") is None:
            h = early_hit(l["code"], hs, as_, body.get("final"))
            if h is not None:
                l["hit"], l["early"] = h, True
                changed = True
        return changed
    l.pop("live", None)
    l["result"] = [hs, as_]
    if l.get("hit") is None:
        h = pick_hit(l["code"], hs, as_, body.get("final"))
        if h is None:
            l["void"] = True
        else:
            l["hit"] = h
    return True


def settle(store):
    """Kuponları maç sonuçlarıyla değerlendirir: bir ayak kaybederse kupon hemen kaybeder, bütün ayaklar tutunca
    kazanır. Ertelenen/iptal ya da iadeli ayak kupondan düşer (oranı 1 sayılır). Sonuçlanmış kuponlarda da
    kalan maçların skorları güncellenir (ekranda görünsün diye)."""
    for doc in store.coupon_all():
        changed = False
        for c in doc["coupons"]:
            for l in c["legs"]:
                changed |= _update_leg(store, l)
            if c["state"] != "pending":
                continue
            if any(l.get("hit") is False for l in c["legs"]):
                c["state"], c["won"], c["profit"] = "done", False, -c["stake"]
                changed = True
            elif all(l.get("hit") is True or l.get("void") for l in c["legs"]):
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
