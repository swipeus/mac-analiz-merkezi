"""Basketbol modeli, Unibet oranları, en garanti tercih, kuponlar ve karne.

Maç farkı ve toplam sayı normal dağılımla hesaplanır. Ortalama: takım gücü (hücum/savunma, ağırlıklı en küçük kareler,
geçen sezon + bu sezon) ile piyasa çizgisinin karışımı. Parametreler geçen sezonun yürüyen pencere testinden:
NBA 995, EuroLeague 302 maç; piyasasız kazananı bilme %68 ve %65.
"""
import collections
import hashlib
import logging
import math
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone

log = logging.getLogger("basket")

KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub"
KAMBI_Q = "lang=en_GB&market=GB"
KAMBI_PATHS = ("nba", "nba_cup", "euroleague")
FIT_LAMBDA = 8           # güç puanını lig ortalamasına çeken ağırlık (maç sayısı cinsinden)
FIT_HALF_LIFE = 120      # gün; eski maçların ağırlığı yarıya iner
FIT_ITERS = 20
MARKET_W = 0.8           # piyasa çizgisi varken ağırlığı
SIGMA = {"nba": (12.5, 18.5), "el": (11.5, 16.5)}   # fark ve toplam için maç içi sapma (piyasalı)
# piyasa yokken: fark için test edilen en iyi değer, toplam için modelin gerçek hatası
SIGMA_ALONE = {"nba": (10.0, 21.5), "el": (10.0, 18.0)}
TEAM_SIGMA = 11.5        # takım toplamı sapması

MIN_ODDS, MAX_ODDS = 1.15, 2.30   # en garanti tercihin oran aralığı
REMOVED_COUPONS = {"sayi-2026-10-30-2"}  # istekle silinen kuponlar
LOCK_BEFORE = timedelta(hours=1)  # kupon, ilk maçına bu kadar kala kesinleşir
MAX_USE = 2              # aynı tercih günün en fazla kaç kuponunda yer alır
MAX_USE_FROM = "2026-10-31"
STAKE = 1000             # karnede tek tercih başına yatırılan tutar

# temalar: anahtar, ad, simge, tercih türü süzgeci, en düşük olasılık, ayak oranı, toplam oran, kupon adedi
THEMES = [
    ("banko", "Banko", "✅", lambda c: True, 0.66, (1.15, 1.70), (2.0, 3.6), 3),
    ("fav", "Favoriler", "🏆", lambda c: re.match(r"^(ms|[ha][+-])", c), 0.60, (1.15, 1.90), (2.0, 4.5), 2),
    ("sayi", "Sayılar", "🎯", lambda c: re.match(r"^([ou]|h[ou]|a[ou])\d", c), 0.55, (1.30, 1.95), (2.0, 5.0), 2),
]


def Phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


# ---------- takım gücü ----------
def compact(games):
    """Oynanmış maçlar: (gün, ev, konuk, ev sayısı, konuk sayısı)."""
    out = []
    for g in games:
        h, a = g["home"], g["away"]
        if g["state"] == "post" and h["score"] is not None and a["score"] is not None:
            t = datetime.fromisoformat(g["utc"].replace("Z", "+00:00")).timestamp() / 86400
            out.append([t, h["id"], a["id"], h["score"], a["score"]])
    return out


def fit(rows, now):
    """Sayı = lig ortalaması ± ev avantajının yarısı + hücum - rakip savunma."""
    if not rows:
        return None
    w = [0.5 ** (max(0, now - r[0]) / FIT_HALF_LIFE) for r in rows]
    sw = sum(w)
    L = sum(wi * (r[3] + r[4]) / 2 for wi, r in zip(w, rows)) / sw
    h = 2.0
    o, d = collections.defaultdict(float), collections.defaultdict(float)
    for _ in range(FIT_ITERS):
        no, nd, so, sd = [collections.defaultdict(float) for _ in range(4)]
        for wi, (_, a, b, hs, as_) in zip(w, rows):
            no[a] += wi * (hs - L - h / 2 + d[b])
            so[a] += wi
            no[b] += wi * (as_ - L + h / 2 + d[a])
            so[b] += wi
            nd[b] += wi * (L + h / 2 + o[a] - hs)
            sd[b] += wi
            nd[a] += wi * (L - h / 2 + o[b] - as_)
            sd[a] += wi
        for k in no:
            o[k] = no[k] / (so[k] + FIT_LAMBDA)
        for k in nd:
            d[k] = nd[k] / (sd[k] + FIT_LAMBDA)
        h = 2 * sum(wi * ((r[3] - r[4]) / 2 - (o[r[1]] - d[r[2]] - o[r[2]] + d[r[1]]) / 2) for wi, r in zip(w, rows)) / sw
    return {"L": L, "h": h, "o": dict(o), "d": dict(d)}


# ---------- Unibet (Kambi) ----------
def _fold(s):
    s = (s or "").lower().translate(str.maketrans({"ı": "i", "ş": "s", "ğ": "g", "ç": "c", "ö": "o", "ü": "u"}))
    return re.sub(r"[^a-z0-9 ]", " ", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode())


def _sim(a, b):
    """Takım adı benzerliği: 'Golden State' ~ 'Golden State Warriors', 'LA Lakers' ~ 'Los Angeles Lakers'."""
    x, y = set(_fold(a).split()), set(_fold(b).split())
    x -= {"bc", "bk", "sk", "kk", "fc", "basket", "basketbol", "spor"}
    y -= {"bc", "bk", "sk", "kk", "fc", "basket", "basketbol", "spor"}
    if not x or not y:
        return 0.0
    hit = sum(any(p == q or (len(p) > 3 and (p.startswith(q) or q.startswith(p))) for q in y) for p in x)
    return hit / min(len(x), len(y))


def _outcomes(bo):
    return {o.get("type"): o for o in bo.get("outcomes", []) if o.get("status", "OPEN") == "OPEN" and o.get("odds")}


def _kambi_markets(raw, home, away):
    """Tam maç pazarları (uzatmalar dahil): hepsi ev sahibine göre, oranlar ondalık."""
    mk = {"ml": None, "sp": [], "tot": [], "ht": [], "at": []}
    for bo in raw.get("betOffers", []):
        name = (bo.get("criterion") or {}).get("englishLabel") or ""
        if "Including Overtime" not in name:
            continue
        o = _outcomes(bo)
        one, two, over, under = o.get("OT_ONE"), o.get("OT_TWO"), o.get("OT_OVER"), o.get("OT_UNDER")
        if name.startswith("Moneyline") and one and two:
            mk["ml"] = [one["odds"] / 1000, two["odds"] / 1000]
        elif name.startswith("Point Spread") and one and two and one.get("line") is not None:
            mk["sp"].append([one["line"] / 1000, one["odds"] / 1000, two["odds"] / 1000])
        elif over and under and over.get("line") is not None:
            row = [over["line"] / 1000, under["odds"] / 1000, over["odds"] / 1000]
            if name.startswith("Total Points -"):
                mk["tot"].append(row)
            elif name.startswith(f"Total Points by {home} "):
                mk["ht"].append(row)
            elif name.startswith(f"Total Points by {away} "):
                mk["at"].append(row)
    return mk


async def odds_events(src, store):
    """Başlamamış NBA ve EuroLeague maçlarının oranları; özet saklanır."""
    hit = store.cache_get("bk:kambi")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    out = []
    for path in KAMBI_PATHS:
        try:
            d = await src.fetch_json(f"{KAMBI}/listView/basketball/{path}/all/all/matches.json?{KAMBI_Q}&useCombined=true")
        except Exception as e:  # noqa: BLE001
            log.warning("Unibet listesi alınamadı %s: %s", path, e)
            continue
        for e in d.get("events", []):
            ev = e.get("event") or {}
            if ev.get("state") != "NOT_STARTED" or not ev.get("homeName"):
                continue
            try:
                raw = await src.fetch_json(f"{KAMBI}/betoffer/event/{ev['id']}.json?{KAMBI_Q}")
            except Exception as ex:  # noqa: BLE001
                log.warning("Unibet maçı alınamadı %s: %s", ev.get("id"), ex)
                continue
            ts = datetime.fromisoformat(ev["start"].replace("Z", "+00:00")).timestamp()
            out.append({"id": ev["id"], "home": ev["homeName"], "away": ev["awayName"], "ts": ts,
                        "mk": _kambi_markets(raw, ev["homeName"], ev["awayName"])})
    if not out and hit:
        return hit[1]
    store.cache_put("bk:kambi", out)
    return out


def find_event(g, events):
    t = datetime.fromisoformat(g["utc"].replace("Z", "+00:00")).timestamp()
    best, top = None, 0
    for e in events:
        if abs(e["ts"] - t) > 2 * 3600:
            continue
        s = _sim(e["home"], g["home"]["name"]) + _sim(e["away"], g["away"]["name"])
        s = max(s, _sim(e["home"], g["home"]["short"]) + _sim(e["away"], g["away"]["short"]))
        if s > top:
            best, top = e, s
    return best if top >= 1.5 else None


def _center(ladder):
    """Çift yönlü çizgilerde iki tarafın oranının eşitlendiği nokta (piyasanın gerçek çizgisi)."""
    if not ladder:
        return None
    if len(ladder) == 1:  # tek çizgide oranların dengesizliği çizgiye çevrilir (1 sayı ≈ %3 olasılık)
        line, a, b = ladder[0]
        return line - (1 / a / (1 / a + 1 / b) - 0.5) / 0.03
    pts = sorted((x[0], 1 / x[1] - 1 / x[2]) for x in ladder if x[1] and x[2])
    for (a, u), (b, v) in zip(pts, pts[1:]):
        if u == v:
            continue
        if u * v <= 0:
            return a + (b - a) * u / (u - v)
    return min(pts, key=lambda p: abs(p[1]))[0] if pts else None


# ---------- tahmin ----------
def predict(lg, g, rating, ev):
    """Beklenen fark ve toplam; piyasa varsa onunla karışır."""
    a, b = g["home"]["id"], g["away"]["id"]
    mm = mt = None
    if rating:
        o, d = rating["o"], rating["d"]
        mm = rating["h"] + o.get(a, 0) - d.get(b, 0) - o.get(b, 0) + d.get(a, 0)
        mt = 2 * rating["L"] + o.get(a, 0) - d.get(b, 0) + o.get(b, 0) - d.get(a, 0)
    sp = _center((ev or {}).get("mk", {}).get("sp"))
    tot = _center((ev or {}).get("mk", {}).get("tot"))
    k_m, k_t = (MARKET_W if sp is not None else 0), (MARKET_W if tot is not None else 0)
    if mm is None and sp is None:
        return None
    mkt_m = -sp if sp is not None else 0
    margin = k_m * mkt_m + (1 - k_m) * (mm or 0)
    total = k_t * (tot or 0) + (1 - k_t) * (mt or 0) if (mt is not None or tot is not None) else None
    sm = SIGMA[lg][0] if sp is not None else SIGMA_ALONE[lg][0]
    st = SIGMA[lg][1] if tot is not None else SIGMA_ALONE[lg][1]
    return {"margin": round(margin, 1), "total": round(total, 1) if total else None, "sm": sm, "st": st,
            "p_home": round(Phi(margin / sm), 3), "p_away": round(1 - Phi(margin / sm), 3),
            "mkt_margin": round(mkt_m, 1) if sp is not None else None, "mkt_total": round(tot, 1) if tot is not None else None,
            "model_margin": round(mm, 1) if mm is not None else None, "model_total": round(mt, 1) if mt is not None else None}


def fnum(x):
    return f"{x:g}"


def options(pr, ev, home, away):
    """Bültendeki seçenekler: kod, ad, oran, model olasılığı, grup."""
    if not ev or not pr:
        return []
    m, t, sm, st = pr["margin"], pr["total"], pr["sm"], pr["st"]
    mk, out = ev["mk"], []
    if mk["ml"]:
        out.append(("ms1", f"MS 1 ({home})", mk["ml"][0], pr["p_home"], "Maç sonucu"))
        out.append(("ms2", f"MS 2 ({away})", mk["ml"][1], pr["p_away"], "Maç sonucu"))
    for line, o1, o2 in sorted(mk["sp"]):
        p = Phi((m + line) / sm)
        out.append((f"h{line:+g}", f"{home} {line:+g}", o1, p, "Handikap"))
        out.append((f"a{-line:+g}", f"{away} {-line:+g}", o2, 1 - p, "Handikap"))
    if t:
        for line, under, over in sorted(mk["tot"]):
            p = 1 - Phi((line - t) / st)
            out.append((f"o{fnum(line)}", f"Toplam {fnum(line)} Üst", over, p, "Toplam sayı"))
            out.append((f"u{fnum(line)}", f"Toplam {fnum(line)} Alt", under, 1 - p, "Toplam sayı"))
        for key, name, exp, pre in (("ht", home, (t + m) / 2, "h"), ("at", away, (t - m) / 2, "a")):
            for line, under, over in sorted(mk[key]):
                p = 1 - Phi((line - exp) / TEAM_SIGMA)
                out.append((f"{pre}o{fnum(line)}", f"{name} {fnum(line)} Üst", over, p, "Takım toplamı"))
                out.append((f"{pre}u{fnum(line)}", f"{name} {fnum(line)} Alt", under, 1 - p, "Takım toplamı"))
    return [{"code": c, "label": lb, "odds": o, "p": round(p, 3), "group": gr} for c, lb, o, p, gr in out if o and o > 1]


def best_pick(opts):
    ok = [x for x in opts if MIN_ODDS <= x["odds"] <= MAX_ODDS]
    if not ok:
        return None
    # önce olasılık; piyasadan iyi görülen seçenek biraz öne çıkar
    return max(ok, key=lambda x: x["p"] + 0.5 * max(-0.10, min(x["p"] * x["odds"] - 1, 0.10)))


def pick_hit(code, hs, as_):
    """True / False / None (iade)."""
    m = hs - as_
    if code in ("ms1", "ms2"):
        return (m > 0) == (code == "ms1")
    x = re.match(r"^([ha])([+-]\d+(?:\.\d+)?)$", code)
    if x:
        v = (m if x[1] == "h" else -m) + float(x[2])
        return None if v == 0 else v > 0
    x = re.match(r"^([ha]?)([ou])(\d+(?:\.\d+)?)$", code)
    if x:
        v = {"": hs + as_, "h": hs, "a": as_}[x[1]] - float(x[3])
        return None if v == 0 else (v > 0) == (x[2] == "o")
    return None


def pick_type(code):
    if code in ("ms1", "ms2"):
        return "Maç sonucu"
    if code[0] in "ha" and code[1] in "+-":
        return "Handikap"
    if code[0] in "ou":
        return "Toplam sayı"
    return "Takım toplamı"


# ---------- kayıt: tercih ve kuponlar ----------
def _doc_id(g):
    return g["id"]


def boxes(opts, pr):
    """Maç kartındaki kutular: piyasanın ortasına en yakın çizgiler."""
    if not opts or not pr:
        return []
    near = lambda rows, target: min(rows, key=lambda x: abs(float(re.search(r"[\d.]+$", x["code"])[0]) - target)) if rows else None  # noqa: E731
    m, t = pr["margin"], pr["total"] or 0
    fav = "h" if m >= 0 else "a"
    picks = [("🏀", near([x for x in opts if re.match(r"^o\d", x["code"])], t), "{} Üst"),
             ("⚖", near([x for x in opts if x["code"].startswith(fav + "-")], abs(m)), None),
             ("🏠", near([x for x in opts if x["code"].startswith("ho")], (t + m) / 2), "Ev {} Üst"),
             ("✈️", near([x for x in opts if x["code"].startswith("ao")], (t - m) / 2), "Dep. {} Üst")]
    out = []
    for ic, x, fmt in picks:
        if x:
            line = re.search(r"[\d.]+$", x["code"])[0]
            out.append({"ic": ic, "label": fmt.format(line) if fmt else x["label"], "p": x["p"], "odds": x["odds"]})
    return out


def record(store, g, pr, pick, opts=None):
    """Maç başlayana kadar tahmin güncellenir, başlayınca donar; bitince sonuçlanır."""
    old = store.bk_get("pred", g["id"])
    if g["state"] == "pre":
        # oran henüz yoksa yalnızca tahmin saklanır (karneye girmez); maç başlayınca da favori belli kalır
        if pick or (pr and (not old or old["state"] == "nopick")):
            store.bk_put("pred", g["id"], {"id": g["id"], "lg": g["lg"], "utc": g["utc"], "home": g["home"]["short"], "away": g["away"]["short"],
                                           "pick": pick, "p_home": pr["p_home"], "state": "pending" if pick else "nopick", "pred": pr, "options": opts,
                                           "boxes": boxes(opts, pr)})
        return store.bk_get("pred", g["id"])
    if g["state"] == "off" and old and old["state"] == "pending":
        old["state"] = "void"
        store.bk_put("pred", g["id"], old)
    if g["state"] == "post" and old and old["state"] == "pending" and g["home"]["score"] is not None:
        old.update({"state": "done", "result": [g["home"]["score"], g["away"]["score"]],
                    "hit": pick_hit(old["pick"]["code"], g["home"]["score"], g["away"]["score"])})
        store.bk_put("pred", g["id"], old)
    return old


def build_coupons(date, cands, kept=()):
    """cands: [(oyun, seçenekler)]; aynı temada bir maç tek kuponda kullanılır, aynı kupon iki temada çıkmaz.
    Aynı tercih en fazla MAX_USE kupona girer; kept: kilitlenmiş kuponlar, bütün sayımlara dahildir ve numaraları korunur."""
    limit = MAX_USE if date >= MAX_USE_FROM else 99
    out, seen = [], {frozenset((l["mid"], l["code"]) for l in c["legs"]) for c in kept}
    use = collections.Counter((l["mid"], l["code"]) for c in kept for l in c["legs"])
    for key, name, icon, ok, pmin, (lo, hi), (tot_lo, tot_hi), quota in THEMES:
        mine = [c for c in kept if c["theme"] == key]
        used = {l["mid"] for c in mine for l in c["legs"]}
        nums, n = {int(c["id"].rsplit("-", 1)[1]) for c in mine}, 0
        while len(nums) < quota:
            pool = []  # kullanım sayısı her kuponda değişir
            for g, opts in cands:
                good = [x for x in opts if ok(x["code"]) and x["p"] >= pmin and lo <= x["odds"] <= hi and use[(g["id"], x["code"])] < limit]
                if good:
                    pool.append((max(good, key=lambda x: (round(x["p"], 2), x["odds"])), g))
            pool.sort(key=lambda t: t[0]["p"], reverse=True)
            legs, odds = [], 1.0
            for x, g in pool:
                if g["id"] in used or odds * x["odds"] > tot_hi:
                    continue
                legs.append((x, g))
                odds *= x["odds"]
                if odds >= tot_lo:
                    break
            if odds < tot_lo or not legs:
                break
            used |= {g["id"] for _, g in legs}
            sig = frozenset((g["id"], x["code"]) for x, g in legs)
            if sig in seen:
                continue
            seen.add(sig)
            use.update((g["id"], x["code"]) for x, g in legs)
            n = min(i for i in range(1, quota + 1) if i not in nums)
            nums.add(n)
            prob = 1.0
            for x, _ in legs:
                prob *= x["p"]
            out.append({"id": f"{key}-{date}-{n}", "theme": key, "name": f"{name} {n}", "icon": icon, "odds": round(odds, 2), "p": round(prob, 3), "state": "pending",
                        "legs": [{"mid": g["id"], "lg": g["lg"], "utc": g["utc"], "home": g["home"]["short"], "away": g["away"]["short"], "hlogo": g["home"]["logo"],
                                  "code": x["code"], "label": x["label"], "odds": x["odds"], "p": x["p"]} for x, g in legs]})
    return out


def drop_removed(store):
    """Elle silinen kuponlar kayıtlardan ve karneden çıkarılır; yayından geri gelse de yine silinir."""
    for doc in store.bk_all("coupons"):
        left = [c for c in doc["coupons"] if c["id"] not in REMOVED_COUPONS]
        if len(left) != len(doc["coupons"]):
            doc["coupons"] = left
            store.bk_put("coupons", doc["date"], doc)


def coupon_sig(c):
    """Kuponun içeriğinin kısa parmak izi: kayıtlarda değişip değişmediği görülür."""
    return hashlib.sha1("|".join(sorted(f"{l['mid']}:{l['code']}:{l['odds']}" for l in c["legs"])).encode()).hexdigest()[:6]


def update_coupons(store, date, cands):
    """Kuponlar yenilenir; bir kuponun ilk maçına LOCK_BEFORE kala o kupon kesinleşir ve donar."""
    doc = store.bk_get("coupons", date) or {"date": date, "coupons": []}
    now = datetime.now(timezone.utc)
    soon = lambda g: datetime.fromisoformat(g["utc"].replace("Z", "+00:00")) <= now + LOCK_BEFORE  # noqa: E731
    kept = [c for c in doc["coupons"] if c.get("locked") or c.get("state") == "done" or any(soon(l) for l in c["legs"])]
    for c in kept:
        c["locked"] = True  # kilitlenen kupon bir daha yeniden kurulmaz; yalnızca sonuçları işlenir
    cands = [(g, o) for g, o in cands if not soon(g)]  # kilit süresine girmiş maç yeni kupona alınmaz
    if cands:
        kept += build_coupons(date, cands, kept)
        kept.sort(key=lambda c: ([t[0] for t in THEMES].index(c["theme"]), int(c["id"].rsplit("-", 1)[1])))
    doc["coupons"] = kept
    store.bk_put("coupons", date, doc)
    log.info("basketbol kuponları %s: %s", date, " ".join(f"{c['id'].split('-')[0]}{c['id'].rsplit('-', 1)[1]}{'*' if c.get('locked') else ''}:{coupon_sig(c)}" for c in kept))
    return doc


def settle(store, games):
    by = {g["id"]: g for g in games}
    for doc in store.bk_all("coupons"):
        changed = False
        for c in doc["coupons"]:
            if c.get("state") == "done":
                continue
            for l in c["legs"]:
                g = by.get(l["mid"])
                if l.get("hit") is None and "done" not in l and g and g["state"] == "post" and g["home"]["score"] is not None:
                    l["hit"] = pick_hit(l["code"], g["home"]["score"], g["away"]["score"])
                    l["done"] = True
                    l["result"] = [g["home"]["score"], g["away"]["score"]]
                    changed = True
            if all(l.get("done") for l in c["legs"]) or any(l.get("hit") is False for l in c["legs"]):
                c["state"] = "done"
                c["won"] = all(l.get("hit") is not False for l in c["legs"])
                paid = 1.0
                for l in c["legs"]:
                    if l.get("hit") is not None:
                        paid *= l["odds"]
                c["paid"] = round(paid, 2)
                changed = True
        if changed:
            store.bk_put("coupons", doc["date"], doc)


def karne(store):
    rows = sorted(store.bk_all("pred"), key=lambda r: r["utc"], reverse=True)
    done = [r for r in rows if r["state"] == "done" and r.get("hit") is not None]

    def tally(xs):
        n, h = len(xs), sum(1 for r in xs if r["hit"])
        pl = sum((r["pick"]["odds"] - 1) * STAKE if r["hit"] else -STAKE for r in xs)
        return {"n": n, "hit": h, "pct": round(h / n, 3) if n else None, "exp": round(sum(r["pick"]["p"] for r in xs) / n, 3) if n else None, "pl": round(pl)}
    coupons = [c for d in sorted(store.bk_all("coupons"), key=lambda d: d["date"], reverse=True) for c in d["coupons"]]
    cd = [c for c in coupons if c.get("state") == "done"]
    slim = [{k: v for k, v in r.items() if k not in ("options", "comment")} for r in rows]  # karne dosyası küçük kalsın
    return {"stake": STAKE, "total": tally(done), "by_lg": {k: tally([r for r in done if r["lg"] == k]) for k in ("nba", "el")},
            "by_type": {k: tally([r for r in done if pick_type(r["pick"]["code"]) == k]) for k in ("Maç sonucu", "Handikap", "Toplam sayı", "Takım toplamı")},
            "coupons": {"n": len(cd), "won": sum(1 for c in cd if c.get("won"))},
            "recent": [r for r in slim if r.get("pick")][:60], "store": {"pred": slim, "coupons": store.bk_all("coupons")}}


def seed(store, doc):
    """Önbellek kaybolduysa kayıtlar yayındaki dosyadan geri yüklenir."""
    n = 0
    s = (doc or {}).get("store") or {}
    for r in s.get("pred", []):
        if not store.bk_get("pred", r["id"]):
            store.bk_put("pred", r["id"], r)
            n += 1
    now = datetime.now(timezone.utc)
    final = lambda c: c.get("locked") or c.get("state") == "done" or any(  # noqa: E731
        datetime.fromisoformat(l["utc"].replace("Z", "+00:00")) <= now + LOCK_BEFORE for l in c["legs"])
    for d in s.get("coupons", []):
        local = store.bk_get("coupons", d["date"])
        if not local:
            store.bk_put("coupons", d["date"], d)
            n += 1
            continue
        # yayındaki kilitli kupon yerelde yoksa (önbellek geri gittiyse) yayındaki geçerlidir
        mine = {c["id"]: c for c in local["coupons"]}
        lost = [c for c in d["coupons"] if final(c) and not final(mine.get(c["id"], {"legs": []}))]
        if lost:
            mine.update({c["id"]: {**c, "locked": True} for c in lost})
            local["coupons"] = sorted(mine.values(), key=lambda c: c["id"])
            store.bk_put("coupons", d["date"], local)
            n += len(lost)
    return n
