"""Kural tabanlı Türkçe takım analizi, senaryolar ve Poisson tahmin modeli."""
import math
import re

HOME_ADV = 1.08
AWAY_ADJ = 0.93


def f(x, nd=1):
    if x is None:
        return "—"
    return f"{x:.{nd}f}".replace(".", ",")


def pct(x):
    return f"%{round(x * 100)}" if x is not None else "—"


def _s(season, key, field="per_match"):
    v = (season or {}).get(key)
    return v.get(field) if v else None


def _rank_txt(season, key):
    # FotMob sıralaması: 1 = ligin en iyisi (yenilen xG'de en az yiyen)
    v = (season or {}).get(key)
    if not v or not v.get("rank"):
        return ""
    return f" (ligde {v['rank']}./{v['of']})"


MONTHS = {"January": "Ocak", "February": "Şubat", "March": "Mart", "April": "Nisan", "May": "Mayıs", "June": "Haziran",
          "July": "Temmuz", "August": "Ağustos", "September": "Eylül", "October": "Ekim", "November": "Kasım", "December": "Aralık"}
PHASE = {"Early": "başı", "Mid": "ortası", "Late": "sonu"}


def tr_return(s):
    """'Late October 2026' -> 'Ekim 2026 sonu', 'Doubtful' -> 'şüpheli'."""
    if not s:
        return s
    low = s.lower()
    if low == "doubtful":
        return "Maça yetişmesi şüpheli"
    if low in ("unknown", "no return date"):
        return "Belirsiz"
    fixed = {"day to day": "Günlük kontrol ediliyor", "few weeks": "Birkaç hafta", "few days": "Birkaç gün",
             "end of season": "Sezon sonu", "next season": "Gelecek sezon", "long term": "Uzun süre", "long-term": "Uzun süre"}
    if low in fixed:
        return fixed[low]
    m = re.fullmatch(r"(?:about |approx\.? |around )?(\d+(?:\s*-\s*\d+)?)\s+(day|days|week|weeks|month|months)", low)
    if m:
        unit = {"day": "gün", "week": "hafta", "month": "ay"}[m.group(2).rstrip("s")]
        return f"Yaklaşık {m.group(1).replace(' ', '')} {unit}"
    parts = s.split()
    if len(parts) == 3 and parts[0] in PHASE and parts[1] in MONTHS:
        return f"{MONTHS[parts[1]]} {parts[2]} {PHASE[parts[0]]}"
    if len(parts) == 2 and parts[0] in MONTHS:
        return f"{MONTHS[parts[0]]} {parts[1]}"
    return s


def _wavg(pairs):
    pairs = [(v, w) for v, w in pairs if v is not None]
    if not pairs:
        return None
    return sum(v * w for v, w in pairs) / sum(w for _, w in pairs)


def is_regular(p, rec):
    """Son maçlarda as kadroda mı: en az 2 kez ilk 11 ya da en az 150 dakika. Son maçların kadro verisi
    yoksa None (bilinmiyor). Süre almayan / az oynayan oyuncunun yokluğu takımı etkilemez; uzun süredir
    sakat olanın yokluğu da son maç verisinde zaten var."""
    usage = (rec or {}).get("usage")
    if not usage:
        return None
    u = usage.get(str(p.get("id"))) or [0, 0]
    return u[0] >= 2 or u[1] >= 150


def key_absentees(lineup_side, rec=None):
    out = []
    for p in (lineup_side or {}).get("unavailable", []):
        reg = is_regular(p, rec)
        important = reg is not False and ((p.get("rating") or 0) >= 6.9 or (p.get("value") or 0) >= 15_000_000)
        out.append({**p, "important": important, "regular": reg})
    return out


TYPE_TR = {"injury": "Sakat", "suspension": "Cezalı", "red card": "Cezalı", "yellow card": "Kart cezalı",
           "international duty": "Milli takımda", "other": "Kadroda yok"}


def _cap(s):
    # Türkçe büyük harf: "i" -> "İ"
    if not s:
        return s
    first = "İ" if s[0] == "i" else s[0].upper()
    return first + s[1:]


def absent_txt(p):
    t = TYPE_TR.get((p.get("type") or "").lower(), _cap(p.get("type")) or "Kadroda yok")
    ret = f", Dönüş: {_cap(tr_return(p['return']))}" if p.get("return") else ""
    return f"{p['name']} ({t}{ret})"


def team_profile(name, rec, season, lu_side, players, table):
    af, aa = rec.get("avg_for") or {}, rec.get("avg_against") or {}
    n = rec.get("n_stats") or 0
    sec = {"plan": [], "attack": [], "setpiece": [], "defence": [], "form": [], "absent": [], "players": []}

    # --- Oyun planı / taktik ---
    if lu_side and lu_side.get("formation"):
        coach = f", teknik direktör {lu_side['coach']}" if lu_side.get("coach") else ""
        sec["plan"].append(f"Beklenen diziliş {lu_side['formation']}{coach}.")
    pos = af.get("possession") or _s(season, "possession_percentage_team")
    if pos is not None:
        if pos >= 58:
            sec["plan"].append(f"Topa sahip olarak oyunu kuran, rakibi kendi yarı sahasına hapsetmeye çalışan bir takım (ort. %{round(pos)} topla oynama).")
        elif pos >= 52:
            sec["plan"].append(f"Topu kontrol etmeyi tercih ediyor ama aşırı sahiplenmiyor (ort. %{round(pos)}).")
        elif pos >= 46:
            sec["plan"].append(f"Topa sahip olma açısından dengeli bir profil (ort. %{round(pos)}); maça göre plan değiştirebiliyor.")
        else:
            sec["plan"].append(f"Topu rakibe bırakan reaktif bir yapı (ort. %{round(pos)}): blok savunup geçiş ve kontra ataklarla sonuç arıyor.")
    if af.get("long_balls") and af.get("passes_acc"):
        r = af["long_balls"] / af["passes_acc"]
        if r >= 0.1:
            sec["plan"].append(f"Uzun top oranı yüksek (isabetli pasların %{round(r * 100)}'i uzun top): direkt oyun ve ikinci top mücadelesi öne çıkıyor.")
        elif r <= 0.05:
            sec["plan"].append("Uzun topa nadiren başvuruyor; kısa paslarla, yerden oyun kurmayı tercih ediyor.")
    if af.get("crosses") is not None and af["crosses"] >= 5:
        sec["plan"].append(f"Kanatlar ve ortalar önemli bir silah (maç başı {f(af['crosses'])} isabetli orta).")
    if af.get("box_touches") is not None:
        if af["box_touches"] >= 30:
            sec["plan"].append(f"Rakip ceza sahasında çok top buluyor (maç başı {f(af['box_touches'])} temas).")
        elif af["box_touches"] <= 16:
            sec["plan"].append(f"Rakip ceza sahasına girmekte zorlanıyor (maç başı yalnızca {f(af['box_touches'])} temas).")
    press = (season or {}).get("poss_won_att_3rd_team")
    if press and press.get("rank") and press.get("of"):
        if press["rank"] <= press["of"] / 3:
            sec["plan"].append(f"Rakip yarı sahada en çok top kazanan takımlardan ({press['rank']}./{press['of']}, maç başı {f(press['per_match'])}): yüksek ve agresif pres.")
        elif press["rank"] >= press["of"] * 2 / 3:
            sec["plan"].append(f"Önde baskısı zayıf ({press['rank']}./{press['of']}); daha çok orta/alçak blokta savunmayı tercih ediyor.")

    # --- Hücum ---
    if af.get("shots") is not None:
        txt = f"Maç başı {f(af['shots'])} şut, {f(af.get('sot'))} isabetli."
        if af.get("shots_in") is not None and af.get("shots_out") is not None:
            tot = (af["shots_in"] + af["shots_out"]) or 1
            out_share = af["shots_out"] / tot
            txt += f" Bunların {f(af['shots_in'])} tanesi ceza sahası içinden, {f(af['shots_out'])} tanesi dışından (dış şut oranı %{round(out_share * 100)})."
            if out_share >= 0.45:
                txt += " Uzaktan şutlara fazla bağımlı."
        sec["attack"].append(txt)
    if af.get("xg") is not None:
        txt = f"Son {n} maçta maç başı {f(af['xg'], 2)} xG üretiyor"
        if af.get("shots"):
            xps = af["xg"] / af["shots"]
            txt += f"; şut başına xG {f(xps, 2)}"
            if xps >= 0.13:
                txt += " (yüksek kaliteli pozisyonlar)"
            elif xps <= 0.08:
                txt += " (düşük kaliteli, zor pozisyonlardan şutlar)"
        sec["attack"].append(txt + ".")
        gsum = sum(r["gf"] or 0 for r in rec["rows"] if r["for"])
        xsum = sum(r["for"].get("xg") or 0 for r in rec["rows"] if r["for"])
        if xsum:
            d = gsum - xsum
            if d >= 2:
                sec["attack"].append(f"Son maçlarda {gsum} gol / {f(xsum)} xG: beklentinin üstünde bitiricilik. Bu seviyenin sürmesi zor.")
            elif d <= -2:
                sec["attack"].append(f"Son maçlarda {gsum} gol / {f(xsum)} xG: pozisyonları harcıyor. Gol sayısının xG seviyesine yükselmesi beklenir.")
    if af.get("big_chances") is not None:
        sec["attack"].append(f"Maç başı {f(af['big_chances'])} net pozisyon, {f(af.get('big_missed'))} tanesi kaçırılıyor.")
    sx = (season or {}).get("expected_goals_team")
    if sx:
        sec["attack"].append(f"Sezon geneli: maç başı {f(sx['per_match'], 2)} xG{_rank_txt(season, 'expected_goals_team')}, {f(_s(season, 'goals_team_match'), 2)} gol.")

    # --- Duran top / korner ---
    if af.get("corners") is not None:
        sec["setpiece"].append(f"Son {n} maçta maç başı {f(af['corners'])} korner kullandı, {f(aa.get('corners'))} korner verdi.")
    sc = (season or {}).get("corner_taken_team")
    if sc:
        sec["setpiece"].append(f"Sezon: maç başı {f(sc['per_match'])} korner{_rank_txt(season, 'corner_taken_team')}.")
    if af.get("xg_set") is not None and af.get("xg"):
        share = af["xg_set"] / af["xg"] if af["xg"] else 0
        txt = f"Ürettiği xG içinde duran topların payı %{round(share * 100)} ({f(af['xg_set'], 2)} / maç)."
        if share >= 0.35:
            txt += " Duran top tehdidi yüksek."
        sec["setpiece"].append(txt)
    spg, spc = (season or {}).get("_set_piece_goals_team"), (season or {}).get("_set_piece_goals_conceded_team")
    if spg or spc:
        sec["setpiece"].append(f"Sezonda duran toptan {f(spg['value'], 0) if spg else '—'} gol attı, {f(spc['value'], 0) if spc else '—'} gol yedi.")

    # --- Savunma ---
    if aa.get("xg") is not None:
        txt = f"Rakiplerine maç başı {f(aa['xg'], 2)} xG ve {f(aa.get('shots'))} şut ({f(aa.get('sot'))} isabetli) izin veriyor."
        if aa["xg"] <= 0.9:
            txt += " Pozisyon vermeyen sağlam bir savunma."
        elif aa["xg"] >= 1.6:
            txt += " Savunmada ciddi açıklar var."
        sec["defence"].append(txt)
    if aa.get("shots_in") is not None:
        sec["defence"].append(f"Yenilen şutların {f(aa['shots_in'])} tanesi ceza sahası içinden, {f(aa.get('shots_out'))} tanesi dışından. Rakibe net pozisyon: maç başı {f(aa.get('big_chances'))}.")
    if af.get("tackles") is not None:
        t, i_ = af.get("tackles") or 0, af.get("interceptions") or 0
        txt = f"Maç başı {f(t)} müdahale, {f(i_)} top kesme, {f(af.get('clearances'))} uzaklaştırma, {f(af.get('blocks'))} blok."
        if (af.get("clearances") or 0) >= 25:
            txt += " Uzaklaştırma sayısı yüksek: derin blokta, ceza sahası savunmasına dayalı bir yapı."
        elif t + i_ >= 26:
            txt += " İkili mücadeleye giren, aktif bir savunma."
        sec["defence"].append(txt)
    if af.get("aerials") is not None:
        sec["defence"].append(f"Maç başı {f(af['aerials'])} hava topu kazanıyor (rakip {f(aa.get('aerials'))}).")
    sxa = (season or {}).get("expected_goals_conceded_team")
    if sxa:
        cs = (season or {}).get("clean_sheet_team")
        sec["defence"].append(
            f"Sezon geneli: maç başı {f(sxa['per_match'], 2)} xG yiyor{_rank_txt(season, 'expected_goals_conceded_team')}"
            + (f", {f(cs['value'], 0)} maçta gol yemedi." if cs else ".")
        )

    # --- Form ---
    if rec.get("rows"):
        res = " ".join(r["result"] or "-" for r in rec["rows"])
        gf = sum(r["gf"] or 0 for r in rec["rows"])
        ga = sum(r["ga"] or 0 for r in rec["rows"])
        sec["form"].append(f"Son {len(rec['rows'])} maç: {res} ({rec['points']} puan), attığı {gf} / yediği {ga}.")
    if table:
        sec["form"].append(f"Puan durumu: {table['pos']}. sıra, {table['played']} maçta {table['pts']} puan ({table['w']}G {table['d']}B {table['l']}M, averaj {table['goals']}).")

    # --- Eksikler ---
    absents = key_absentees(lu_side, rec)
    for p in absents:
        sec["absent"].append(("Önemli eksik: " if p["important"] else "") + absent_txt(p)
                             + (" (son maçlarda süre almıyordu, eksik sayılmadı)" if p["regular"] is False else ""))
    if lu_side is not None and not absents:
        sec["absent"].append("Bilinen eksik yok.")

    # --- Kilit oyuncular ---
    labels = {"goals": "Gol", "expected_goals": "xG", "total_scoring_att": "Şut/90", "ontarget_scoring_att": "İsabetli şut/90",
              "big_chance_created": "Net pozisyon yarattı", "expected_assists": "xA", "defensive_contributions": "Savunma aksiyonu/90"}
    for k, lab in labels.items():
        top = (players or {}).get(k)
        if top and top["list"]:
            sec["players"].append(f"{lab}: " + ", ".join(f"{p['name']} {f(p['value'], 2 if p['value'] and p['value'] % 1 else 0)}" for p in top["list"]))

    return {"name": name, "sections": sec, "important_absent": sum(1 for p in absents if p["important"])}


def _pois(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


# kart (k), şut (s), isabetli şut (t) alt/üst kodları: ko4.5 toplam kart 4.5 üst, kho1.5 ev sahibi kart 1.5 üst
STAT_CODE = re.compile(r"^([kst])([ha]?)([ou])(\d+(?:\.\d+)?)$")
STAT_K = {"k": 1.3, "s": 1.2, "t": 1.25}  # dağılım genişliği (varyans / ortalama)
STAT_NAME = {"k": "kart", "s": "şut", "t": "isabetli şut"}


# garanti tercih ve kupon için anlamlı çizgiler ("takım 0.5 kart üst" gibi neredeyse kesin ama bilgisiz olanlar elenir)
STAT_LINES = {("k", ""): (2.5, 6.5), ("k", "t"): (1.5, 3.5), ("s", ""): (18.5, 30.5), ("s", "t"): (8.5, 17.5),
              ("t", ""): (5.5, 11.5), ("t", "t"): (2.5, 6.5)}


def stat_ok(code):
    m = STAT_CODE.match(code)
    if not m:
        return False
    lo, hi = STAT_LINES[(m.group(1), "t" if m.group(2) else "")]
    return lo <= float(m.group(4)) <= hi


# kutularda gösterilen sabit çizgiler (sadece bilgi; tercihleri etkilemez). Kartta 3.5 Üst seçildi:
# bitmiş maçlarda ortalama 4.1 kart, 3.5 Üst %55 tutuyor (4.5 Üst %38), olasılığı en bilgilendirici çizgi
BOX_CORNER, BOX_CARD = "co8.5", "ko3.5"


def fixed_box(code, p, oddsmap):
    """Kutu için sabit çizginin olasılığı ve (varsa) oranı, ör. {"label": "8.5 Üst", "p": 0.58, "odds": 1.72}."""
    if p is None:
        return None
    return {"label": f"{code[2:]} Üst", "p": round(p, 3), "odds": (oddsmap or {}).get(code)}


def stat_prob(mm, stat_mu):
    stat, side, ou, line = mm.group(1), mm.group(2), mm.group(3), float(mm.group(4))
    h, a = stat_mu.get(stat, (None, None))
    mu = {"": (h + a) if h is not None and a is not None else None, "h": h, "a": a}[side]
    if not mu:
        return None
    p = _nb_over(mu, line, STAT_K[stat])
    return p if ou == "o" else 1 - p


def stat_value(mm, final):
    """Maç sonu (ya da canlı) istatistikten değer: kartta sarı + kırmızı."""
    stat, side = mm.group(1), mm.group(2)
    f = final or {}
    if stat == "k":
        y, r = f.get("yellow") or [None, None], f.get("red") or [0, 0]
        vals = [None if y[i] is None else y[i] + (r[i] or 0) for i in (0, 1)]
    else:
        vals = f.get("shots" if stat == "s" else "sot") or [None, None]
    if side == "h":
        return vals[0]
    if side == "a":
        return vals[1]
    return None if None in vals else vals[0] + vals[1]


def _nb_over(mu, line, k=1.4):
    """Negatif binom (varyans = k × ortalama): korner sayıları Poisson'dan daha dağınıktır."""
    r, q = mu / (k - 1), 1 / k
    pmf = lambda n: math.exp(math.lgamma(n + r) - math.lgamma(r) - math.lgamma(n + 1) + r * math.log(q) + n * math.log(1 - q))
    return 1 - sum(pmf(n) for n in range(int(line) + 1))


def _over(lam, line):
    return 1 - sum(_pois(k, lam) for k in range(int(line) + 1))


RHO = -0.08          # Dixon-Coles düşük skor düzeltmesi
# oran varsa piyasanın ağırlığı: maç sonucunda (1X2) piyasa bizden belirgin bilgili, gol sayısında modelin xG'si işe yarıyor
MARKET_WEIGHT = 0.6      # gol beklentisi / toplam gol dağılımı
MARKET_WEIGHT_1X2 = 0.9  # maç sonucu olasılıkları
MOVE_K = 1.0         # oran hareketi açılıştan bu yana bir o kadar daha devam eder sayılır (0 = sadece güncel oran)
MIN_ODDS = 1.30      # en garanti tercih bu orandan düşük olamaz
N_GOALS = 10


def fit_outcome(mat, target):
    """Skor matrisini, toplam gol dağılımı korunurken 1/X/2 olasılıkları hedef matrisinkine eşit olacak şekilde
    yeniden ağırlıklar (iki kenar dağılıma dönüşümlü oranlama, birkaç tur yeter)."""
    n = len(mat)
    kind = lambda i, j: 0 if i > j else (1 if i == j else 2)
    want_o = [0.0, 0.0, 0.0]
    for i in range(n):
        for j in range(n):
            want_o[kind(i, j)] += target[i][j]
    want_t = [0.0] * (2 * n)
    for i in range(n):
        for j in range(n):
            want_t[i + j] += mat[i][j]
    m = [r[:] for r in mat]
    for _ in range(8):
        have = [0.0, 0.0, 0.0]
        for i in range(n):
            for j in range(n):
                have[kind(i, j)] += m[i][j]
        m = [[m[i][j] * want_o[kind(i, j)] / have[kind(i, j)] if have[kind(i, j)] else 0 for j in range(n)] for i in range(n)]
        have_t = [0.0] * (2 * n)
        for i in range(n):
            for j in range(n):
                have_t[i + j] += m[i][j]
        m = [[m[i][j] * want_t[i + j] / have_t[i + j] if have_t[i + j] else 0 for j in range(n)] for i in range(n)]
    return m


def score_matrix(lh, la):
    m = [[_pois(i, lh) * _pois(j, la) for j in range(N_GOALS)] for i in range(N_GOALS)]
    for (i, j), t in {(0, 0): 1 - lh * la * RHO, (0, 1): 1 + lh * RHO, (1, 0): 1 + la * RHO, (1, 1): 1 - RHO}.items():
        m[i][j] *= max(t, 0.0)
    tot = sum(map(sum, m))
    return [[x / tot for x in r] for r in m]


def market_probs(mat, lh, la, corners=None, red_rate=None):
    """Skor matrisinden modelin her bahis seçeneği için olasılığı (kod -> olasılık)."""
    n = len(mat)
    cells = [(i, j, mat[i][j]) for i in range(n) for j in range(n)]
    ph = sum(p for i, j, p in cells if i > j)
    pd = sum(p for i, j, p in cells if i == j)
    pa = sum(p for i, j, p in cells if i < j)
    pr = {"1": ph, "X": pd, "2": pa, "1X": ph + pd, "12": ph + pa, "X2": pd + pa}
    btts = sum(p for i, j, p in cells if i > 0 and j > 0)
    pr.update({"btts_yes": btts, "btts_no": 1 - btts})
    for line in (0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5):
        o = sum(p for i, j, p in cells if i + j > line)
        pr[f"o{line:g}"], pr[f"u{line:g}"] = o, 1 - o
    odd = sum(p for i, j, p in cells if (i + j) % 2 == 1)
    pr.update({"odd": odd, "even": 1 - odd})
    # takım gol alt/üstü (ho1.5 = ev sahibi 2+ gol)
    for line in (0.5, 1.5, 2.5, 3.5, 4.5):
        ho = sum(p for i, j, p in cells if i > line)
        ao = sum(p for i, j, p in cells if j > line)
        pr.update({f"ho{line:g}": ho, f"hu{line:g}": 1 - ho, f"ao{line:g}": ao, f"au{line:g}": 1 - ao})
    if ph + pa:
        pr.update({"dnb1": ph / (ph + pa), "dnb2": pa / (ph + pa)})
    p00 = mat[0][0]
    pr.update({"fts0": p00, "fts1": (1 - p00) * lh / (lh + la), "fts2": (1 - p00) * la / (lh + la)})
    for i, j, p in cells:
        if i <= 6 and j <= 6:
            pr[f"cs:{i}-{j}"] = p
    if corners:
        ch, ca = corners["home"], corners["away"]
        mid = (ch + ca) / 2
        ch, ca = mid + 0.5 * (ch - mid), mid + 0.5 * (ca - mid)
        h = [_pois(k, ch) for k in range(30)]
        a = [_pois(k, ca) for k in range(30)]
        c1 = sum(h[i] * a[j] for i in range(30) for j in range(30) if i > j)
        cx = sum(h[i] * a[i] for i in range(30))
        pr.update({"cm1": c1, "cmX": cx, "cm2": max(0.0, 1 - c1 - cx)})
        # toplam korner alt/üstü (co9.5 = 10+ korner); oranlarla ayrıca harmanlanır
        for k in range(10):
            line = 5.5 + k
            co = _nb_over(corners["total"], line)
            pr.update({f"co{line:g}": co, f"cu{line:g}": 1 - co})
        # ilk korner 8. dakikadan önce mi: korner sayısı maç boyunca Poisson süreci varsayılır
        f8 = 1 - math.exp(-(ch + ca) * 8 / 90)
        pr.update({"fc8_yes": f8, "fc8_no": 1 - f8})
    if red_rate is not None:
        r = 1 - math.exp(-red_rate)
        pr.update({"rc_yes": r, "rc_no": 1 - r})
    return pr


def _odds_market(odds, key, line=None):
    for m in (odds or {}).get("markets") or []:
        if m["key"] == key and (line is None or m.get("line") == line):
            return m
    return None


def fit_market_lambdas(odds):
    """Maç sonucu ve alt/üst oranlarına en iyi uyan gol beklentileri (Poisson, 0.1 adımlı ızgara araması)."""
    from .odds import implied
    mw = _odds_market(odds, "who_will_win")
    if not mw or len(mw["selections"]) != 3:
        return None
    imp = dict(zip([s.get("code") for s in mw["selections"]], implied(mw)))
    if not all(k in imp for k in ("1", "X", "2")):
        return None
    if MOVE_K and all(s.get("o0") for s in mw["selections"]):
        # oran hareketi: açılıştan bu yana olasılığı artan taraf biraz daha öne çekilir
        op = dict(zip([s.get("code") for s in mw["selections"]],
                      implied({**mw, "selections": [{**s, "odds": s["o0"]} for s in mw["selections"]]})))
        imp = {k: max(0.01, v + MOVE_K * (v - op.get(k, v))) for k, v in imp.items()}
        t = sum(imp.values())
        imp = {k: v / t for k, v in imp.items()}
    ou = _odds_market(odds, "odds_goals_over_under", 2.5)
    if not ou:
        ous = [m for m in (odds.get("markets") or []) if m["key"] == "odds_goals_over_under" and m.get("line")]
        ou = min(ous, key=lambda m: abs(m["line"] - 2.5)) if ous else None
    over = None
    if ou and len(ou["selections"]) == 2:
        oi = {s["code"][0]: p for s, p in zip(ou["selections"], implied(ou)) if s.get("code")}
        over = (ou["line"], oi.get("o"))
    grid = [round(0.15 + 0.1 * k, 2) for k in range(40)]
    n = 9
    pmf = {l: [_pois(k, l) for k in range(n)] for l in grid}
    best, best_err = None, 1e9
    for lh in grid:
        ph_ = pmf[lh]
        for la in grid:
            pa_ = pmf[la]
            p1 = p2 = 0.0
            for i in range(n):
                for j in range(n):
                    if i > j:
                        p1 += ph_[i] * pa_[j]
                    elif i < j:
                        p2 += ph_[i] * pa_[j]
            err = (p1 - imp["1"]) ** 2 + (p2 - imp["2"]) ** 2
            if over and over[1] is not None:
                po = 1 - sum(ph_[i] * pa_[j] for i in range(n) for j in range(n) if i + j <= over[0])
                err += (po - over[1]) ** 2
            if err < best_err:
                best, best_err = (lh, la), err
    return best


DRAW_GAP = 0.12  # ev ve deplasman galibiyet olasılıkları bu kadar yakınsa maç dengeli sayılır, skor beraberlik
TOTAL_SHIFT = 0.2  # toplam gol: beklenen toplam + 0.2 yuvarlanır (gerçek gol dağılımına en yakın sonuç bununla çıktı)


def coherent_score(mat, pr, lh, la):
    """Skor tahmini, iki takımın beklenen gollerinden (Elo, rakibe göre düzeltilmiş xG, rakibin yediği goller ve
    oranlar zaten bunların içinde) kurulur:
    1) Sonuç: maç dengeliyse (1 ile 2 arasında %12'den az fark) beraberlik, değilse favorinin galibiyeti.
    2) Toplam gol: beklenen toplam golün yuvarlanmışı; alt/üst olasılıklarıyla tutarlı olmak zorunda
       (3.5 Üst olasılığı %50'yi geçiyorsa en az 4 gol, 2.5 Üst %50'nin altındaysa en fazla 2 gol).
    3) Gol farkı: beklenen gol farkına en yakın skor.
    761 maçlık testte tam isabet önceki kurallarla aynı (%10.4); 4+ gollü skor tahmini %9'dan %28'e çıktı
    (gerçekte %38), 2-1 / 1-2 yığılması kalktı."""
    n = len(mat)
    if abs(pr["1"] - pr["2"]) < DRAW_GAP:
        ok = lambda i, j: i == j
    elif pr["1"] > pr["2"]:
        ok = lambda i, j: i > j
    else:
        ok = lambda i, j: i < j
    tot = int(lh + la + 0.5 + TOTAL_SHIFT)
    p25 = sum(mat[i][j] for i in range(n) for j in range(n) if i + j > 2)
    p35 = sum(mat[i][j] for i in range(n) for j in range(n) if i + j > 3)
    if p35 >= 0.5:
        tot = max(tot, 4)
    elif p25 >= 0.5:
        tot = max(tot, 3)
    else:
        tot = min(tot, 2)
    cands = [(i, j) for i in range(n) for j in range(n) if ok(i, j)]
    pref = [c for c in cands if c[0] + c[1] == tot] or [c for c in cands if abs(c[0] + c[1] - tot) == 1] or cands
    i, j = min(pref, key=lambda c: (abs((c[0] - c[1]) - (lh - la)), -mat[c[0]][c[1]]))
    return {"score": f"{i}-{j}", "p": round(mat[i][j], 3)}

# garanti tercih adayları: maç sonucu, çifte şans, iade, KG, alt/üst, korner ve kart pazarları
SAFE_CODES = {"1", "X", "2", "1X", "12", "X2", "btts_yes", "btts_no", "o1.5", "u1.5", "o2.5", "u2.5",
              "o3.5", "u3.5", "cm1", "cm2", "cmX", "rc_yes", "rc_no"}  # beraberlikte iade bilerek yok


COMBO_SHORT = {"1": "MS 1", "X": "MS X", "2": "MS 2", "1X": "ÇŞ 1X", "12": "ÇŞ 12", "X2": "ÇŞ X2",
               "btts_yes": "KG Var", "btts_no": "KG Yok"}


# anlamlı çizgiler: "takım 4.5 alt" ya da "13.5 korner alt" gibi neredeyse kesin ama bilgisiz seçenekler elenir
TOTAL_CODE = re.compile(r"^([ha]o[01]\.5|[ha]u[12]\.5|co([789]|10)\.5|cu(8|9|10|11)\.5)$")


def safe_ok(code):
    """Garanti tercih adayı: klasik pazarlar, takım gol ve korner alt/üstleri, bunlardan oluşan kombineler."""
    legs = code.split("&")
    return len(legs) <= 3 and all(x in SAFE_CODES or TOTAL_CODE.match(x) or stat_ok(x) for x in legs)


def safe_score(p, odds, code=None):
    """Önce yüksek olasılık; piyasanın ima ettiğinden iyi görülen (değerli) seçenekler biraz öne çıkar.
    Karnede modelin sandığından zayıf çıkan tercih türleri biraz geri alınır."""
    edge = p * odds - 1
    return p + 0.5 * max(-0.10, min(edge, 0.10)) + LESSON.get(pick_type(code), 0.0)


def code_label(code, home, away):
    if "&" in code:  # kombine: "MS 1 + KG Var + 2.5 Üst"
        return " + ".join(COMBO_SHORT.get(c) or code_label(c, home, away) for c in code.split("&"))
    fixed = {"1": f"MS 1 ({home})", "X": "MS X (beraberlik)", "2": f"MS 2 ({away})", "1X": "Çifte şans 1X", "12": "Çifte şans 12",
             "X2": "Çifte şans X2", "btts_yes": "KG Var", "btts_no": "KG Yok", "odd": "Toplam gol tek", "even": "Toplam gol çift",
             "dnb1": f"Beraberlikte iade: {home}", "dnb2": f"Beraberlikte iade: {away}", "fts0": "Maçta gol olmaz",
             "fts1": f"İlk golü {home} atar", "fts2": f"İlk golü {away} atar", "cm1": f"Daha çok korneri {home} kullanır",
             "cmX": "Korner sayıları eşit", "cm2": f"Daha çok korneri {away} kullanır",
             "rc_yes": "Maçta kırmızı kart çıkar", "rc_no": "Maçta kırmızı kart çıkmaz",
             "fc8_yes": "İlk korner 8. dakikadan önce", "fc8_no": "İlk 8 dakikada korner yok",
             "o25": "2.5 Üst", "u25": "2.5 Alt"}
    if code in fixed:
        return fixed[code]
    m = re.fullmatch(r"([ou])(\d+(?:\.\d+)?)", code)
    if m:
        return f"{m.group(2)} {'Üst' if m.group(1) == 'o' else 'Alt'}"
    m = STAT_CODE.match(code)
    if m:
        what = STAT_NAME[m.group(1)]
        who = {"": f"Toplam {what}", "h": f"{home} {what}", "a": f"{away} {what}"}[m.group(2)]
        return f"{who} {m.group(4)} {'Üst' if m.group(3) == 'o' else 'Alt'}"
    m = re.fullmatch(r"([hac])([ou])(\d+(?:\.\d+)?)", code)
    if m:
        who = {"h": f"{home} gol", "a": f"{away} gol", "c": "Toplam korner"}[m.group(1)]
        return f"{who} {m.group(3)} {'Üst' if m.group(2) == 'o' else 'Alt'}"
    if code.startswith("cs:"):
        return "Skor " + code[3:]
    return code


def pick_type(code):
    """Tercih türü (karnede tür bazında isabet ve kalibrasyon için)."""
    c = code or ""
    if "&" in c:
        return "kombine"
    if c in ("1", "X", "2"):
        return "MS"
    if c in ("1X", "X2", "12"):
        return "çifte şans"
    if c.startswith("btts"):
        return "KG"
    if re.match(r"^[ou]\d", c):
        return "toplam gol"
    if re.match(r"^[ha][ou]\d", c):
        return "takım golü"
    if re.match(r"^c[ou]\d", c):
        return "korner"
    if re.match(r"^cm", c):
        return "en çok korner"
    if re.match(r"^k[ha]?[ou]\d", c):
        return "kart"
    if re.match(r"^[st][ha]?[ou]\d", c):
        return "şut"
    return "diğer"


REF_W = 0.5        # hakemin kart eğiliminin ağırlığı (0 = yok sayılır, 1 = tamamen hakemin ortalaması)
REF_FULL_N = 4     # hakemin bu kadar maçı varsa ağırlığın tamamı kullanılır
CARD_TIRED = 0.10  # 3.5 günden az dinlenen takımın kart beklentisi +%10 (geri testte kart log-loss iyileşti)

# karneden öğrenilenler (her yayın başında karneden hesaplanır):
# LESSON: karnede zayıf çıkan türlerin garanti tercih seçimindeki puan cezası (negatif, küçültülmüş)
# PROVEN: modelin olasılıklarının karnede tuttuğu türler; değerli oran tercihi yalnızca bunlardan seçilir
LESSON = {}
PROVEN = set()
VALUE_ODDS = (1.60, 3.20)  # değerli tercihin oran aralığı
VALUE_MIN_P = 0.42
VALUE_EDGE = 0.05          # model olasılığı x oran - 1 en az %5

# karneden öğrenilen tür bazında düzeltme çarpanları ({tür: çarpan}); her yayın başında karneden hesaplanır.
# Yalnızca yeterince veri birikip sapma istatistiksel olarak belirgin olan türlerde dolar.
CALIB = {}


def code_odds(odds, code):
    """Bir seçeneğin güncel ve ilk görülen (açılış) oranı."""
    for m in (odds or {}).get("markets") or []:
        for s in m["selections"]:
            if s.get("code") == code:
                return s.get("odds"), s.get("o0")
    return None, None


def make_picks(pr, odds, home, away):
    """En garanti tercih (oran >= 1.30) ve olası sürpriz."""
    sel = []  # (kod, model olasılığı, oran)
    for m in (odds or {}).get("markets") or []:
        for s in m["selections"]:
            if s.get("code") and s["code"] in pr:
                sel.append((s["code"], pr[s["code"]], s["odds"]))
    safe = None
    cands = [c for c in sel if c[2] >= MIN_ODDS and c[1] >= 0.5 and safe_ok(c[0])]
    if cands:
        code, p, o = max(cands, key=lambda c: (safe_score(c[1], c[2], c[0]), c[2]))
        safe = {"code": code, "p": round(p, 3), "odds": o}
    else:  # oran yoksa: adil oranı (1/olasılık) 1.30'un altında kalan seçenekler elenir
        model = [(c, pr[c]) for c in SAFE_CODES if c in pr and 1 / max(pr[c], 1e-9) >= MIN_ODDS]
        if model:
            code, p = max(model, key=lambda c: c[1])
            safe = {"code": code, "p": round(p, 3), "odds": None}
    sc = [c for c in sel if 2.8 <= c[2] <= 15 and c[1] >= (0.07 if c[0].startswith("cs:") else 0.15)
          and not c[0].startswith(("cm", "fts", "odd", "even", "dnb"))]
    if sc:
        code, p, o = max(sc, key=lambda c: c[1] * c[2])
        surprise = {"code": code, "p": round(p, 3), "odds": o, "ev": round(p * o, 2)}
    else:
        dog = min(("1", pr["1"]), ("2", pr["2"]), key=lambda x: x[1])
        code, p = dog if dog[1] >= 0.18 else ("X", pr["X"])
        surprise = {"code": code, "p": round(p, 3), "odds": None, "ev": None}
    # değerli oran: makul oranlı, karnede kendini kanıtlamış türden, modelin piyasadan belirgin şekilde olası gördüğü tercih
    vc = [c for c in sel if VALUE_ODDS[0] <= c[2] <= VALUE_ODDS[1] and c[1] >= VALUE_MIN_P and c[1] * c[2] - 1 >= VALUE_EDGE
          and "&" not in c[0] and safe_ok(c[0]) and pick_type(c[0]) in PROVEN and (not safe or c[0] != safe["code"])]
    value = None
    if vc:
        code, p, o = max(vc, key=lambda c: c[1] * c[2])
        value = {"code": code, "p": round(p, 3), "odds": o, "edge": round(p * o - 1, 3)}
    for x in (safe, surprise, value):
        if x:
            x["label"] = code_label(x["code"], home, away)
    return safe, surprise, value


BLEND_PREFIX = ("cm", "rc", "fc8", "co", "cu", "ho", "hu", "ao", "au")
GOAL_CODE = re.compile(r"^(1|X|2|1X|12|X2|btts_yes|btts_no|[ou]\d+(\.\d+)?|[ha][ou]\d+(\.\d+)?|cs:\d+-\d+)$")


def _is_goal_code(c):
    return bool(GOAL_CODE.match(c))


def blend_scores(mat, cs_market, w=0.5):
    """Skor matrisini piyasanın skor oranlarıyla harmanlar. Piyasa yalnızca listelediği skorlara olasılık verir;
    o skorların modeldeki toplam payı korunur, liste dışı skorlar modelde kalır."""
    if not cs_market or len(cs_market["selections"]) < 8:
        return mat
    from .odds import implied
    mk = {}
    for s_, ip in zip(cs_market["selections"], implied(cs_market)):
        c = s_.get("code")
        if c:
            i, j = map(int, c[3:].split("-"))
            if i < len(mat) and j < len(mat):
                mk[(i, j)] = ip
    if not mk:
        return mat
    mass = sum(mat[i][j] for i, j in mk)
    tot = sum(mk.values()) or 1
    out = [r[:] for r in mat]
    for (i, j), ip in mk.items():
        out[i][j] = (1 - w) * mat[i][j] + w * ip / tot * mass
    return out


# model düzeltmeleri (geri test için kapatılabilir)
# 761 bitmiş maçlık geri test (1 Eylül - 26 Ekim): rakip gücü isabeti artırdı, ev/deplasman ağırlığı nötr.
# Dinlenme günü ve eksik oyuncu düzeltmeleri isabeti düşürdü (az dinlenenler çoğunlukla Avrupa'da oynayan güçlü
# takımlar; eksiklerin etkisi son maç verisinde ve oranlarda zaten var), bu yüzden beklentiye katılmıyor,
# analizde sadece bilgi olarak yazılıyor
ADJ = {"opp": True, "venue": True, "rest": False, "absent": False}
VENUE_W = 1.25     # bu maçla aynı sahada (iç/dış) oynanan son maçların ağırlığı
RECENT_N = 5       # gol beklentisi için bakılan son maç sayısı (en fazla 10)
DECAY = 1.0        # her eski maçın ağırlığı bir öncekinin bu katı
STAT_N = 10        # korner, şut, kart için bakılan son maç sayısı (bu istatistikler daha uzun geçmişle iyileşiyor)
STAT_DECAY = 0.95
ABSENT_SCALE = 1.0  # eksik etkisinin gücü
# takım gücü puanı (Elo): beklenen gol farkının yarısı Elo'dan. 761 maçlık testte (verinin iki yarısında da)
# oransız 1X2 isabeti belirgin arttı (0.989 -> 0.963); xG'ye dayalı gol farkı tek başına fazla sıkışık kalıyordu
ELO_W = 0.5
ELO_SLOPE = 0.85   # 100 Elo puanı ≈ bu kadar gol farkı
CARD_PAIR = True   # kart beklentisinde rakibin karşısındakilere gördürdüğü kartlar da hesaba katılsın


def recent_rows(rec, n=None, decay=None):
    """Son maçlar (en yenisi önce) ve ağırlıkları: eski maçlar DECAY oranında daha az sayılır."""
    rows = ((rec.get("rows") or []) + (rec.get("rows_more") or []))[:n or RECENT_N]
    return [(r, (decay or DECAY) ** k) for k, r in enumerate(rows)]


def stat_avg(rec, side, key):
    """Son maçlarda bir istatistiğin (korner, şut, kart...) ağırlıklı maç başı ortalaması."""
    num = den = 0.0
    for r, w in recent_rows(rec, STAT_N, STAT_DECAY):
        v = (r.get(side) or {}).get(key)
        if v is not None:
            num += w * v
            den += w
    return num / den if den else None
TIRED_DAYS = 3     # bu kadar gün ya da daha az dinlenme yorgunluk sayılır


def recent_avg(rec, side, at_home):
    """Son maçlarda maç başı xG (yoksa gol). Rakip gücüne göre düzeltilir: zayıf savunmaya üretilen xG
    daha az, güçlü savunmaya üretilen daha çok değerlidir. Bu maçla aynı sahadaki (iç/dış) maçlar daha ağır basar."""
    num = den = 0.0
    for r, w0 in recent_rows(rec):
        v = (r.get(side) or {}).get("xg")
        if v is None:
            v = r.get("gf" if side == "for" else "ga")
        if v is None:
            continue
        if ADJ["opp"]:
            ratio = r.get("opp_def" if side == "for" else "opp_att") or 1.0
            v /= min(1.6, max(0.6, ratio))
        w = w0 * (VENUE_W if ADJ["venue"] and r.get("home") == at_home else 1.0)
        num += w * v
        den += w
    return num / den if den else None


def rest_days(rec, utc):
    """Son maçtan bu maça kaç gün dinlenme (tüm kulvarlar)."""
    from datetime import datetime
    dates = [r.get("date") for r in rec.get("rows") or [] if r.get("date")]
    if not dates or not utc:
        return None
    try:
        last = max(datetime.fromisoformat(d.replace("Z", "+00:00")) for d in dates)
        ko = datetime.fromisoformat(utc.replace("Z", "+00:00"))
    except ValueError:
        return None
    d = (ko - last).total_seconds() / 86400
    return round(d, 1) if 0 < d < 30 else None


def absence_impact(lu_side, players, season, rec=None):
    """Eksik oyuncuların gerçek etkisi. Sezon xG'sinin ve asistlerinin (xA) ne kadarını bu oyuncular üretiyor:
    payın %60'ı kayıp sayılır (yerine oynayan kalanını telafi eder). Gol katkısı listelerinde olmayan
    önemli oyuncular (reyting 7.0+ ya da değer 20M+) savunmayı zayıflatır. "Şüpheli" olanlar yarım sayılır.
    Dönüş: (hücum çarpanı, rakibin gol beklentisi çarpanı, açıklama satırları)."""
    lu_side = lu_side or {}
    starters = {p["id"] for p in lu_side.get("starters") or []}
    team_xg = (season.get("expected_goals_team") or {}).get("value")
    team_n = (season.get("expected_goals_team") or {}).get("matches") or 0
    lists = {k: {p["id"]: p for p in ((players or {}).get(k) or {}).get("list", [])} for k in ("expected_goals", "expected_assists")}
    att = dfn = 0.0
    notes = []
    for p in lu_side.get("unavailable") or []:
        if p["id"] in starters or is_regular(p, rec) is False:
            continue  # ilk 11'de ya da son maçlarda süre almayan / az oynayan oyuncu: eksik sayılmaz
        doubt = 0.5 if "şüpheli" in (p.get("return") or "").lower() else 1.0
        share = 0.0
        if team_xg:
            for k, w in (("expected_goals", 1.0), ("expected_assists", 0.5)):
                q = lists[k].get(p["id"])
                if q and q.get("value"):
                    # sezonun çoğunu kaçırdıysa takımın son maç verisi onsuz oynanmış demektir
                    reg = min(1.0, (q.get("matches") or 0) / team_n) if team_n else 1.0
                    share += w * reg * q["value"] / team_xg
        if share >= 0.04:
            att += doubt * 0.6 * share
            notes.append((p["name"], f"xG/xA üretiminde payı %{round(min(share, 1) * 100)}", doubt < 1))
        elif (p.get("rating") or 0) >= 7.0 or (p.get("value") or 0) >= 20_000_000:
            dfn += doubt * 0.025
            notes.append((p["name"], "kilit oyuncu", doubt < 1))
    att, dfn = att * ABSENT_SCALE, dfn * ABSENT_SCALE
    return max(0.82, 1 - att), min(1.08, 1 + dfn), notes


def predict(b, prof_h, prof_a):
    rh, ra = b["recent"]["home"], b["recent"]["away"]
    sh, sa = b["season"]["home"], b["season"]["away"]
    H, A = b["home"]["name"], b["away"]["name"]

    def att(rec, season, at_home):
        return _wavg([(recent_avg(rec, "for", at_home), 0.6), (_s(season, "expected_goals_team"), 0.4)]) or \
            _wavg([(rec["avg_for"].get("goals"), 0.6), (_s(season, "goals_team_match"), 0.4)])

    def dfn(rec, season, at_home):
        return _wavg([(recent_avg(rec, "against", at_home), 0.6), (_s(season, "expected_goals_conceded_team"), 0.4)]) or \
            _wavg([(rec["avg_against"].get("goals"), 0.6), (_s(season, "goals_conceded_team_match"), 0.4)])

    ah, aa_, dh, da = att(rh, sh, True), att(ra, sa, False), dfn(rh, sh, True), dfn(ra, sa, False)
    lam_h = _wavg([(ah, 1), (da, 1)]) or 1.35
    lam_a = _wavg([(aa_, 1), (dh, 1)]) or 1.1
    lam_h *= HOME_ADV
    lam_a *= AWAY_ADJ
    factors = []
    # dinlenme: 3 gün ya da daha az dinlenen takım rakibinden en az 2 gün daha yorgunsa hücumu düşer, savunması açılır
    rest = (rest_days(rh, b.get("utc")), rest_days(ra, b.get("utc")))
    if None not in rest:
        for i, (me, op) in enumerate((rest, rest[::-1])):
            if me <= TIRED_DAYS and op - me >= 2:
                team = (H, A)[i]
                factors.append(f"{team} {round(me)} gün dinlenerek çıkıyor, rakibi {round(op)} gün dinlendi.")
                if not ADJ["rest"]:
                    continue
                if i == 0:
                    lam_h *= 0.95
                    lam_a *= 1.03
                else:
                    lam_a *= 0.95
                    lam_h *= 1.03
    # eksik oyuncular
    lu = b.get("lineup") or {}
    # eksik oyuncular (geri testte isabeti düşürdüğü için kapalı; açılırsa etkisi analizde de yazılır)
    if ADJ["absent"]:
        imp = {}
        for side, season, pl, team, rec in (("home", sh, b["season"].get("players_home"), H, rh), ("away", sa, b["season"].get("players_away"), A, ra)):
            a_f, d_f, notes = absence_impact(lu.get(side), pl, season or {}, rec)
            imp[side] = (a_f, d_f)
            if notes and (a_f < 0.99 or d_f > 1.01):
                names = ", ".join(f"{n}{' (şüpheli)' if dbt else ''}: {why}" for n, why, dbt in notes[:4])
                eff = ([f"kendi gol beklentisi %{round((1 - a_f) * 100)} düşürüldü"] if a_f < 0.99 else []) +                       ([f"rakibin gol beklentisi %{round((d_f - 1) * 100)} artırıldı"] if d_f > 1.01 else [])
                factors.append(f"{team} eksikleri: {names}. Bu yüzden {' ve '.join(eff)}.")
        lam_h *= imp["home"][0] * imp["away"][1]
        lam_a *= imp["away"][0] * imp["home"][1]
    # takım gücü puanı (Elo): beklenen gol farkı kısmen Elo'dan gelir, toplam gol beklentisi değişmez
    elo_r = b.get("elo")
    elo_sup = None
    if ELO_W and elo_r and None not in elo_r:
        tot = lam_h + lam_a
        sup = (1 - ELO_W) * (lam_h - lam_a) + ELO_W * (elo_r[0] + 60 - elo_r[1]) / 100 * ELO_SLOPE
        elo_sup = (elo_r[0] + 60 - elo_r[1]) / 100 * ELO_SLOPE
        lam_h, lam_a = (tot + sup) / 2, (tot - sup) / 2
    lam_h, lam_a = max(0.2, lam_h), max(0.2, lam_a)
    model_lam = (round(lam_h, 2), round(lam_a, 2))

    odds = b.get("odds")
    mk = fit_market_lambdas(odds) if odds else None
    if mk:
        lam_xh = MARKET_WEIGHT_1X2 * mk[0] + (1 - MARKET_WEIGHT_1X2) * lam_h
        lam_xa = MARKET_WEIGHT_1X2 * mk[1] + (1 - MARKET_WEIGHT_1X2) * lam_a
        lam_h = MARKET_WEIGHT * mk[0] + (1 - MARKET_WEIGHT) * lam_h
        lam_a = MARKET_WEIGHT * mk[1] + (1 - MARKET_WEIGHT) * lam_a

    def exp_pair(k):
        h = _wavg([(stat_avg(rh, "for", k), 1), (stat_avg(ra, "against", k), 1)])
        a = _wavg([(stat_avg(ra, "for", k), 1), (stat_avg(rh, "against", k), 1)])
        return h, a

    c_h, c_a = exp_pair("corners")
    if c_h is None:
        c_h = _s(sh, "corner_taken_team")
    if c_a is None:
        c_a = _s(sa, "corner_taken_team")
    corners = None
    if c_h is not None and c_a is not None:
        ct = c_h + c_a
        corners = {"home": round(c_h, 1), "away": round(c_a, 1), "total": round(ct, 1),
                   "over": {str(l): round(_over(ct, l), 3) for l in (7.5, 8.5, 9.5, 10.5, 11.5)}}

    # kırmızı kart beklentisi: iki takımın sezon (yoksa son maç) maç başı kırmızı kart ortalaması
    def red(season):
        v = (season or {}).get("total_red_card_team")
        if not v or not v.get("matches"):
            return 0.1
        return ((v.get("value") or 0) + 0.1 * 10) / (v["matches"] + 10)
    red_rate = red(sh) + red(sa)
    mat = score_matrix(lam_h, lam_a)
    if mk:  # skor matrisi: toplam gol dağılımı %60 piyasalı, maç sonucu %90 piyasalı olacak şekilde uzlaştırılır
        mat = fit_outcome(mat, score_matrix(lam_xh, lam_xa))
    pr = market_probs(mat, lam_h, lam_a, corners, max(0.05, red_rate))
    if odds:  # gol pazarları zaten λ üzerinden piyasaya kalibre; korner ve kart için doğrudan %50 harmanla
        from .odds import implied
        for m in odds.get("markets") or []:
            old = m["key"] in ("odds_most_corners", "odds_red_card", "odds_time_of_first_corner") and len(m["selections"]) >= 2
            ips = implied(m) if old else [s_.get("ip") for s_ in m["selections"]]
            for s_, ip in zip(m["selections"], ips):
                c = s_.get("code")
                if ip is not None and c in pr and c.startswith(BLEND_PREFIX):
                    # toplam korner çizgilerinde piyasa çok daha bilgili (modelin korner beklentisi kaba)
                    w = 0.75 if c.startswith(("co", "cu")) else 0.5
                    pr[c] = (1 - w) * pr[c] + w * ip
    # kombine bahisler: gol ayakları skor matrisinde aynı anda tutmalı; korner/kart ayakları bağımsız sayılır
    for m in (odds or {}).get("markets") or []:
        for s_ in m["selections"]:
            c = s_.get("code")
            if c and "&" in c and c not in pr:
                legs = c.split("&")
                goal = [x for x in legs if _is_goal_code(x)]
                other = [x for x in legs if not _is_goal_code(x)]
                if any(x not in pr for x in other):
                    continue
                p_ = sum(mat[i][j] for i in range(len(mat)) for j in range(len(mat))
                         if all(pick_hit(x, i, j) for x in goal)) if goal else 1.0
                for x in other:
                    p_ *= pr[x]
                pr[c] = p_
    # skor tahmini: modelin skor matrisi ile piyasanın skor oranları harmanlanır (geniş yelpaze)
    smat = blend_scores(mat, _odds_market(odds, "odds_correct_score"))
    n = len(mat)
    scores = sorted(((mat[i][j], f"{i}-{j}") for i in range(n) for j in range(n)), reverse=True)[:6]
    s_h, s_a = exp_pair("shots")
    o_h, o_a = exp_pair("sot")
    y_h, y_a = exp_pair("yellow") if CARD_PAIR else (stat_avg(rh, "for", "yellow"), stat_avg(ra, "for", "yellow"))

    n_min = min(rh.get("n_stats") or 0, ra.get("n_stats") or 0)
    has_season = bool(sh) and bool(sa)
    conf = "Yüksek" if n_min >= 5 and has_season else ("Orta" if n_min >= 3 else "Düşük")
    best = max((pr["1"], "1"), (pr["X"], "X"), (pr["2"], "2"))
    # kart, şut ve isabetli şut beklentileri (son maçlar; kartta hakemin sertliği de hesaba katılır)
    rs = b.get("referee_stats") or {}
    ref_f = 1.0
    if rs.get("matches", 0) >= 4 and rs.get("yellow_pm") and rs.get("yellow_avg"):
        w_ = REF_W * min(1.0, rs["matches"] / REF_FULL_N)  # az maçlı hakemin eğilimine daha az güvenilir
        ref_f = 1 - w_ + w_ * rs["yellow_pm"] / rs["yellow_avg"]
    # yorgunluk: 3 günden az dinlenen takım daha çok faul yapar mı (geri testle ayarlanır, 0 = etkisiz)
    tired = [r_ is not None and r_ <= 3.5 for r_ in rest]
    k_h, k_a = (((y_h if y_h is not None else 2.0) + 0.07) * ref_f * (1 + CARD_TIRED * tired[0]),
                ((y_a if y_a is not None else 2.0) + 0.07) * ref_f * (1 + CARD_TIRED * tired[1]))
    stat_mu = {"k": (k_h, k_a), "s": (s_h, s_a), "t": (o_h, o_a)}
    cards = {"home": round(k_h, 1), "away": round(k_a, 1), "total": round(k_h + k_a, 1),
             "over": {str(l): round(_nb_over(k_h + k_a, l, STAT_K["k"]), 3) for l in (2.5, 3.5, 4.5, 5.5, 6.5)}}
    for m in (odds or {}).get("markets") or []:
        ips = [s_.get("ip") for s_ in m["selections"]]
        for s_, ip in zip(m["selections"], ips):
            c = s_.get("code")
            mm = STAT_CODE.match(c or "")
            if not mm or c in pr:
                continue
            p_ = stat_prob(mm, stat_mu)
            if p_ is None:
                continue
            # piyasa bu pazarlarda modelden çok daha bilgili: %75 piyasa, %25 model
            pr[c] = 0.25 * p_ + 0.75 * ip if ip is not None else p_
    if CALIB:
        for c in list(pr):
            f_ = CALIB.get(pick_type(c))
            if f_ and pr[c] is not None:
                pr[c] = min(0.97, pr[c] * f_)
    safe, surprise, value = make_picks(pr, odds, H, A)
    score_pick = coherent_score(smat, pr, lam_h, lam_a)
    cs_m = _odds_market(odds, "odds_correct_score")
    if cs_m:  # skor tahmininin oranı (karnede 10 ₺'lik skor bahsi için)
        score_pick["odds"] = next((s_["odds"] for s_ in cs_m["selections"] if s_.get("code") == "cs:" + score_pick["score"]), None)
    # oran sayfası için: oranı olan her seçeneğin model olasılığı
    codes = {s["code"] for m in (odds or {}).get("markets") or [] for s in m["selections"] if s.get("code")}
    oddsmap = {s["code"]: s["odds"] for m in (odds or {}).get("markets") or [] for s in m["selections"] if s.get("code")}
    return {
        "lam_home": round(lam_h, 2), "lam_away": round(lam_a, 2),
        "lam_model": model_lam, "lam_market": mk, "uses_odds": bool(mk),
        "factors": factors, "rest": rest,
        # beklenen gollerin kaynağı (skor tahmininin açıklaması için)
        "lam_parts": {"att": [ah and round(ah, 2), aa_ and round(aa_, 2)], "conc": [da and round(da, 2), dh and round(dh, 2)],
                      "elo": elo_r, "elo_sup": elo_sup and round(elo_sup, 2)},
        "p_over35": round(pr["o3.5"], 3),
        "p_home": round(pr["1"], 3), "p_draw": round(pr["X"], 3), "p_away": round(pr["2"], 3),
        "over15": round(pr["o1.5"], 3), "over25": round(pr["o2.5"], 3), "over35": round(pr["o3.5"], 3),
        "btts": round(pr["btts_yes"], 3),
        "scores": [{"score": s, "p": round(p, 3)} for p, s in scores],
        "score_pick": score_pick,
        "corners": corners,
        "cards": cards,
        "box_odds": {"o2.5": oddsmap.get("o2.5"), "btts_yes": oddsmap.get("btts_yes")},  # kutularda gösterilen oranlar
        "corner_pick": fixed_box(BOX_CORNER, pr.get(BOX_CORNER), oddsmap),
        "card_pick": fixed_box(BOX_CARD, pr.get(BOX_CARD, cards["over"].get("3.5")), oddsmap),
        "shots": {"home": s_h and round(s_h, 1), "away": s_a and round(s_a, 1)},
        "sot": {"home": o_h and round(o_h, 1), "away": o_a and round(o_a, 1)},
        "yellow": {"home": y_h and round(y_h, 2), "away": y_a and round(y_a, 2), "total": round(y_h + y_a, 1) if y_h is not None and y_a is not None else None},
        "confidence": conf,
        "pick": best[1],
        "best_pick": safe,
        "value_pick": value,
        "surprise": surprise,
        "probs": {c: round(pr[c], 4) for c in codes if c in pr},
    }


def pick_hit(code, hs, as_, final=None):
    """Tercih tuttu mu? hs/as_ maç sonu skoru, final: korner/kart istatistikleri. None: iade/bilinmiyor (karnede sayılmaz)."""
    t = hs + as_
    if "&" in code:  # kombine: bütün ayaklar tutmalı; biri bilinmiyorsa değerlendirilmez
        res = [pick_hit(c, hs, as_, final) for c in code.split("&")]
        return None if None in res else all(res)
    if code in ("cm1", "cm2", "cmX"):
        c = (final or {}).get("corners") or [None, None]
        if c[0] is None or c[1] is None:
            return None
        return {"cm1": c[0] > c[1], "cm2": c[0] < c[1], "cmX": c[0] == c[1]}[code]
    if code in ("rc_yes", "rc_no"):
        r = (final or {}).get("red")
        if not r:
            return None
        return (sum(r) > 0) == (code == "rc_yes")
    fixed = {
        "1": hs > as_, "X": hs == as_, "2": hs < as_, "1X": hs >= as_, "12": hs != as_, "X2": hs <= as_,
        "btts_yes": hs > 0 and as_ > 0, "btts_no": hs == 0 or as_ == 0,
        "o25": t > 2.5, "u25": t < 2.5, "odd": t % 2 == 1, "even": t % 2 == 0,
    }
    if code in fixed:
        return fixed[code]
    if code in ("dnb1", "dnb2"):
        if hs == as_:
            return None
        return (hs > as_) == (code == "dnb1")
    m = re.fullmatch(r"([ou])(\d+(?:\.\d+)?)", code)
    if m:
        line = float(m.group(2))
        return t > line if m.group(1) == "o" else t < line
    if code.startswith("cs:"):
        return code[3:] == f"{hs}-{as_}"
    m = STAT_CODE.match(code)
    if m:  # kart, şut, isabetli şut alt/üst
        v = stat_value(m, final)
        if v is None:
            return None
        return v > float(m.group(4)) if m.group(3) == "o" else v < float(m.group(4))
    m = re.fullmatch(r"([hac])([ou])(\d+(?:\.\d+)?)", code)
    if m:  # takım golü (h/a) veya toplam korner (c) alt/üst
        line = float(m.group(3))
        if m.group(1) == "c":
            c = (final or {}).get("corners") or [None, None]
            if c[0] is None or c[1] is None:
                return None
            v = c[0] + c[1]
        else:
            v = hs if m.group(1) == "h" else as_
        return v > line if m.group(2) == "o" else v < line
    return None


def lineup_warnings(b):
    """Resmi ilk 11'de olmayan önemli oyuncular (sezonun en yüksek reytingli ve en golcü oyuncuları; sakat/cezalılar hariç)."""
    lu = b.get("lineup") or {}
    if not lu.get("confirmed"):
        return []
    out = []
    for side, key in (("home", "players_home"), ("away", "players_away")):
        team = b[side]["name"]
        sl = lu.get(side) or {}
        starters = {p.get("id") for p in sl.get("starters") or []}
        out_ids = {p.get("id") for p in sl.get("unavailable") or []}
        stars = {}
        for stat in ("rating", "goals"):
            for p in (((b.get("season") or {}).get(key) or {}).get(stat) or {}).get("list") or []:
                if p.get("id"):
                    stars.setdefault(p["id"], p.get("name"))
        missing = [n for pid, n in stars.items() if pid not in starters and pid not in out_ids and n]
        if missing and starters:
            out.append(f"⚠️ {team} resmi ilk 11'inde {', '.join(missing[:3])} yok; sezonun en etkili oyuncularından {'biri' if len(missing) == 1 else 'bazıları'} kenarda başlıyor.")
    return out


def early_hit(code, hs, as_, live=None):
    """Maç sürerken sonucu kesinleşmiş tercihler: KG Var iki takım da gol atınca, üstler çizgi aşılınca tutar;
    altlar ve KG Yok aynı durumda kaybeder. Maç sonucu, çifte şans, en çok korner gibi tercihler bitişi bekler (None)."""
    if hs is None or as_ is None:
        return None
    if "&" in code:
        res = [early_hit(c, hs, as_, live) for c in code.split("&")]
        return False if False in res else True if all(r is True for r in res) else None
    sm = STAT_CODE.match(code)
    if sm:
        v = stat_value(sm, live)
        if v is not None and v > float(sm.group(4)):
            return sm.group(3) == "o"
        return None
    if code == "btts_yes" and hs > 0 and as_ > 0:
        return True
    if code == "btts_no" and hs > 0 and as_ > 0:
        return False
    m = re.fullmatch(r"([hac]?)([ou])(\d+(?:\.\d+)?)", code)
    if not m:
        return None
    if m.group(1) == "c":
        c = (live or {}).get("corners") or [None, None]
        if c[0] is None or c[1] is None:
            return None
        v = c[0] + c[1]
    else:
        v = {"": hs + as_, "h": hs, "a": as_}[m.group(1)]
    if v > float(m.group(3)):
        return m.group(2) == "o"
    return None


def scenarios(b, pr, prof_h, prof_a):
    H, A = b["home"]["name"], b["away"]["name"]
    rh, ra = b["recent"]["home"]["avg_for"], b["recent"]["away"]["avg_for"]
    rha, raa = b["recent"]["home"]["avg_against"], b["recent"]["away"]["avg_against"]
    out = []
    ph, pa = pr["p_home"], pr["p_away"]
    fav, und = (H, A) if ph >= pa else (A, H)
    gap = abs(ph - pa)

    pos_h, pos_a = rh.get("possession"), ra.get("possession")
    if pos_h is not None and pos_a is not None:
        if pos_h - pos_a >= 10:
            out.append(f"Oyunun kontrolü büyük ihtimalle ev sahibi {H} tarafında olacak. {A} bloğunu koruyup geçiş arayacak; ev sahibinin top kayıplarında arkada bıraktığı boşluklar kritik.")
        elif pos_a - pos_h >= 10:
            out.append(f"{A} deplasmanda da topa sahip olmaya çalışacak. Ev sahibi {H} reaktif oynayıp kontra atak ve duran toplara yönelebilir.")
        else:
            out.append("İki takımın topa sahip olma profilleri birbirine yakın. Orta saha mücadelesi ve ikinci toplar maçın kaderini belirleyebilir.")

    if gap >= 0.2:
        out.append(f"Erken gol senaryosu: favori {fav} erken golü bulursa {und} açılmak zorunda kalır; bu da favorinin geçiş oyununa alan açar ve skor büyüyebilir. {und} ilk 30 dakikayı golsüz geçirirse maç kilitlenir, beraberlik ihtimali yükselir.")
    else:
        out.append("Dengeli bir maç bekleniyor. İlk golü atan takım büyük avantaj elde eder, sonrasında oyun genelde golü yiyen tarafın riski artırmasıyla açılır.")

    tot = pr["lam_home"] + pr["lam_away"]
    if tot >= 3.0:
        out.append(f"Gollü maç sinyali: toplam beklenen gol {f(tot, 2)}. İki takımın da hücum üretimi ve savunma açıkları bunu destekliyor.")
    elif tot <= 2.1:
        out.append(f"Az pozisyonlu, kontrollü bir maç beklentisi (toplam beklenen gol {f(tot, 2)}). Tek gol farkı veya beraberlik senaryoları öne çıkıyor.")

    for me, my, opp_name, opp_ag in ((H, rh, A, raa), (A, ra, H, rha)):
        if my.get("xg_set") and my.get("xg") and my["xg_set"] / my["xg"] >= 0.35:
            out.append(f"{me} duran toplardan ciddi tehdit üretiyor. Rakip {opp_name} için hava topu savunması belirleyici olacak.")
        if my.get("shots_out") and my.get("shots_in") and my["shots_out"] >= my["shots_in"]:
            out.append(f"{me} şutlarının çoğunu ceza sahası dışından çekiyor. Rakip {opp_name} ceza sahasını kapatırsa çözüm üretmekte zorlanabilir.")

    if pr.get("corners"):
        c = pr["corners"]
        out.append(f"Korner beklentisi: {H} {f(c['home'])}, {A} {f(c['away'])}, toplam {f(c['total'])} (9.5 üst olasılığı {pct(c['over']['9.5'])}).")

    for prof, team in ((prof_h, H), (prof_a, A)):
        if prof["important_absent"]:
            out.append(f"{team} {prof['important_absent']} önemli eksikle oynayacak; bu, plan ve rotasyonu doğrudan etkiliyor.")

    w = b.get("weather") or {}
    desc = (w.get("description") or "").lower()
    if "rain" in desc or "storm" in desc:
        out.append("Yağışlı hava: kaygan zeminde uzun top ve şutlar sürpriz yaratabilir, pas oyunu zorlaşabilir.")
    if (w.get("windSpeed") or 0) >= 8:
        out.append("Rüzgarlı hava: uzun toplar ve ortalar etkilenebilir.")

    h2h = b.get("h2h") or {}
    if h2h.get("summary") and sum(h2h["summary"]) > 0:
        s = h2h["summary"]
        out.append(f"Aralarındaki son {sum(s)} maç: {H} {s[0]} galibiyet, {s[1]} beraberlik, {A} {s[2]} galibiyet.")
    return out


EURO_CUPS = {42: "Şampiyonlar Ligi", 73: "Avrupa Ligi", 10216: "Konferans Ligi"}
ZONE_TR = {"championsleague": "Şampiyonlar Ligi", "clqual": "Şampiyonlar Ligi eleme", "euroqual": "Avrupa Ligi",
           "europaleague": "Avrupa Ligi", "europa_conference_league": "Konferans Ligi", "conferenceleague": "Konferans Ligi",
           "promotion": "üst lig", "playoff": "play-off", "relegation": "küme düşme"}


def _streak_lines(team, st):
    """Takımın tüm kulvarlardaki serilerinden yorum cümleleri (en önemlisi önce) ve kısa etiketler."""
    if not st or not st.get("last"):
        return [], []
    out, tags = [], []
    if st["wins"] >= 3:
        out.append(f"{team} tüm kulvarlarda üst üste {st['wins']} maçtır kazanıyor; özgüveni yüksek ve bu seriyi sürdürmek isteyecek.")
        tags.append(f"🔥 {team}: {st['wins']} maçlık galibiyet serisi")
    elif st["unbeaten"] >= 5:
        out.append(f"{team} tüm kulvarlarda {st['unbeaten']} maçtır kaybetmiyor; bu yenilmezlik serisini bozmak istemeyecektir.")
        tags.append(f"🛡️ {team}: {st['unbeaten']} maçtır yenilmiyor")
    if st["losses"] >= 3:
        out.append(f"{team} üst üste {st['losses']} maçtır kaybediyor; kötü gidişe dur demek zorunda, baskı altında.")
        tags.append(f"📉 {team}: {st['losses']} maçtır kaybediyor")
    elif st["winless"] >= 4:
        out.append(f"{team} {st['winless']} maçtır kazanamıyor; galibiyet hasreti oyunculara ağır gelebilir.")
        tags.append(f"⏳ {team}: {st['winless']} maçtır galibiyet yok")
    if st["scoring"] >= 6:
        out.append(f"{team} son {st['scoring']} maçın hepsinde gol buldu; hücum hattı üretken.")
        tags.append(f"⚽ {team}: {st['scoring']} maçtır gol atıyor")
    if st["clean_last5"] >= 3:
        out.append(f"{team} son 5 maçın {st['clean_last5']} tanesinde kalesini gole kapattı.")
        tags.append(f"🧱 {team}: son 5 maçta {st['clean_last5']} kez gol yemedi")
    elif st["conceding"] >= 6:
        out.append(f"{team} {st['conceding']} maçtır gol yiyor; savunmada istikrar sorunu var.")
    return out, tags


def _table_line(team, t, league_id):
    if not t or not t.get("pos") or (t.get("league_id") and league_id and t["league_id"] != league_id):
        return None
    pos, pts, of = t["pos"], t["pts"], t["of"]
    if league_id in EURO_CUPS:
        return f"{team} {EURO_CUPS[league_id]} lig aşamasında {pos}. sırada ({pts} puan, {t.get('played') or 0} maç)."
    if (t.get("played") or 0) < 5:
        return f"{team} sezonun başında {pos}. sırada ({pts} puan, {t.get('played') or 0} maç)."
    zone = ZONE_TR.get(t.get("zone") or "", None)
    gap = (t.get("leader_pts") or pts) - pts
    if pos == 1:
        lead = pts - (t.get("second_pts") or pts)
        return (f"{team} {pts} puanla lider; takipçisiyle arasında {lead} puan fark var. Liderliği korumak için kazanmak isteyecektir."
                if lead > 0 else f"{team} {pts} puanla zirvede ama takipçisiyle puanları eşit; puan kaybı liderliği kaybettirebilir.")
    if pos <= 3 and gap <= 6:
        return f"{team} şampiyonluk yarışında kritik konumda: {pos}. sırada, liderin {gap} puan gerisinde. Puan kaybı istemeyecektir."
    if zone == "küme düşme":
        safe = t.get("safe_pts")
        need = (f" Kurtuluş hattıyla arası {safe - pts} puan." if safe is not None and safe > pts
                else " Kurtuluş hattındaki takımla puanı eşit." if safe == pts else "")
        return f"{team} {pos}. sırada, düşme hattında.{need} Her puan hayati önemde."
    if t.get("first_rel_pts") is not None and pts - t["first_rel_pts"] <= 3 and pos > of / 2:
        d_ = pts - t["first_rel_pts"]
        return (f"{team} düşme hattının sadece {d_} puan üzerinde ({pos}. sıra); alt sıralardan uzaklaşmak isteyecek." if d_ > 0
                else f"{team} {pos}. sırada, düşme hattındaki takımla puanı eşit; kaybederse aşağı düşebilir.")
    if zone:
        return f"{team} {pos}. sırada, {zone} hattında yer alıyor; bu konumu korumak isteyecek."
    return f"{team} {of} takımlı ligde {pos}. sırada ({pts} puan)."


def _var(seed, *options):
    """Aynı anlamdaki cümle kalıplarından maça göre birini seçer (her maçta aynı kalıp tekrar etmesin)."""
    return options[seed % len(options)]


def _form_line(team, rec, seed):
    """Son maçlardaki sonuçlar ile üretilen/yenen xG karşılaştırması: form gerçek mi, şans mı?"""
    rows = [r for r in (rec or {}).get("rows") or [] if r.get("for") and r["for"].get("xg") is not None]
    if len(rows) < 4:
        return None
    gf, ga = sum(r["gf"] or 0 for r in rows), sum(r["ga"] or 0 for r in rows)
    xf, xa = sum(r["for"]["xg"] for r in rows), sum((r.get("against") or {}).get("xg") or 0 for r in rows)
    pts = sum({"G": 3, "B": 1}.get(r["result"], 0) for r in rows)
    n = len(rows)
    luck = (gf - ga) - (xf - xa)
    base = f"{team} son {n} maçta {pts} puan topladı (gol {gf}-{ga}, xG {f(xf, 1)}-{f(xa, 1)})"
    if luck >= 3:
        return base + _var(seed, "; skorlar oyunun önünde gidiyor, bu verimlilik her maç sürmeyebilir.",
                           "; ürettiğinden fazlasını skora çeviriyor, şans faktörü de payını almış görünüyor.")
    if luck <= -3:
        return base + _var(seed, "; oyun skordan iyi, sonuçlar yakında düzelebilir.",
                           "; pozisyon üretiyor ama karşılığını alamıyor, bu tablo genelde uzun sürmez.")
    if xf - xa >= 3:
        return base + _var(seed, "; rakiplerine açık ara üstünlük kuruyor, form gerçek.", "; üstünlüğü istatistiklerle de sağlam.")
    if xf - xa <= -3:
        return base + _var(seed, "; oyunda da geride kalıyor, sıkıntılı bir dönem.", "; rakiplerine pozisyon üstünlüğü kaptırıyor.")
    return base + "."


def commentary(b, pr, prof_h, prof_a):
    """Maç yorumu: güç dengesi, form ile oyunun gerçeği, hücum-savunma eşleşmesi, eksikler, maçın temposu,
    piyasa ile modelin görüşü ve skorun gerekçesi. Cümle kalıpları maça göre değişir."""
    H, A = b["home"]["name"], b["away"]["name"]
    lid = b.get("league_id")
    seed = int(b.get("id") or 0)
    paras, tags = [], []
    lp = pr.get("lam_parts") or {}
    elo_r = b.get("elo") or [None, None]

    # 1) güç dengesi ve puan durumu
    ctx = []
    if None not in elo_r:
        gap = elo_r[0] - elo_r[1]
        strong, weak = (H, A) if gap > 0 else (A, H)
        if abs(gap) >= 200:
            ctx.append(_var(seed, f"Kağıt üstünde büyük bir güç farkı var: {strong}, son iki sezonun sonuçlarına göre {weak} takımından belirgin şekilde güçlü.",
                            f"İki takım aynı seviyede değil; uzun dönem güç puanında {strong} açık ara önde.",
                            f"Bu eşleşmede kalite farkı {strong} lehine çok net."))
        elif abs(gap) >= 80:
            ctx.append(_var(seed, f"Güç dengesi {strong} lehine; uzun dönem sonuçlarına göre bir adım önde.",
                            f"{strong} kağıt üstünde daha güçlü taraf, ama fark ezici değil.",
                            f"Uzun dönem performansı {strong} takımını hafif favori yapıyor."))
        else:
            ctx.append(_var(seed, "İki takım uzun dönem güç puanında birbirine çok yakın; kalite olarak denk bir eşleşme.",
                            "Güç puanları neredeyse aynı, maçın kaderini günün performansı belirleyecek.",
                            "Denk iki takım karşı karşıya; ev sahipliği avantajı bu yüzden daha da önemli."))
    if lid in EURO_CUPS:
        ctx.append(f"Maç {EURO_CUPS[lid]} kapsamında oynanıyor.")
    for team, key in ((H, "table_home"), (A, "table_away")):
        line = _table_line(team, (b.get("season") or {}).get(key), lid)
        if line:
            ctx.append(line)
    paras.append(" ".join(ctx))

    # 2) form: sonuçlar ve oyunun gerçeği
    fl = [x for x in (_form_line(H, b["recent"]["home"], seed), _form_line(A, b["recent"]["away"], seed + 1)) if x]
    st = b.get("streaks") or {}
    streak_seen = set()
    for team, k in ((H, "home"), (A, "away")):
        lines, t = _streak_lines(team, st.get(k))
        tags += t
        if lines:
            tail = lines[0].split(";", 1)[-1]
            if tail in streak_seen:  # iki takımın aynı seri cümlesi: ikincisinde yalnızca olgu
                lines[0] = lines[0].split(";", 1)[0] + "."
            streak_seen.add(tail)
            fl.append(lines[0])
    if fl:
        paras.append(" ".join(fl))

    # 3) hücum-savunma eşleşmesi
    att, conc = lp.get("att") or [None, None], lp.get("conc") or [None, None]
    mm = []
    if None not in att and None not in conc:
        for k_, (atk, dfn, a_, c_) in enumerate(((H, A, att[0], conc[0]), (A, H, att[1], conc[1]))):
            if a_ >= 1.6 and c_ >= 1.4:
                mm.append(_var(seed + k_, f"{atk} hücumu (maç başı {f(a_, 1)} xG) {dfn} savunmasının zaafına (maç başı {f(c_, 1)} xG yiyor) denk geliyor; bu tarafta gol beklentisi yüksek.",
                               f"Maçın kilit eşleşmesi {atk} hücumu ile {dfn} savunması: biri bol pozisyon üretiyor ({f(a_, 1)} xG), diğeri bol pozisyon veriyor ({f(c_, 1)} xG)."))
            elif a_ <= 1.0 and c_ <= 1.0:
                mm.append(f"{atk} az pozisyon üretiyor ({f(a_, 1)} xG) ve {dfn} savunması sağlam ({f(c_, 1)} xG yiyor); {atk} cephesinde gol zor gelebilir.")
            elif a_ >= 1.6 and c_ <= 1.0:
                mm.append(f"Güçlü hücum ile güçlü savunma karşı karşıya: {atk} maç başı {f(a_, 1)} xG üretiyor, {dfn} ise sadece {f(c_, 1)} xG veriyor.")
            elif c_ >= 2.0:
                mm.append(f"{dfn} savunması son maçlarda çok pozisyon veriyor (maç başı {f(c_, 1)} xG); {atk} hücumu ({f(a_, 1)} xG) üretken olmasa da bu maçta fırsat bulabilir.")
        if not mm:
            mm.append(f"Hücum-savunma dengesinde uç bir eşleşme yok: {H} {f(att[0], 1)} xG üretip {f(conc[1], 1)} yiyor, "
                      f"{A} {f(att[1], 1)} üretip {f(conc[0], 1)} yiyor (son maçlar, rakip gücüne göre düzeltilmiş).")
    if mm:
        paras.append(" ".join(mm))

    # 4) eksikler: yalnızca son maçlarda as oynayanlar
    miss = []
    for team, prof in ((H, prof_h), (A, prof_a)):
        names = [x.split(": ", 1)[1].split(" (")[0] for x in prof["sections"]["absent"] if x.startswith("Önemli eksik: ")]
        if names:
            miss.append(f"{team} tarafında {', '.join(names[:3])}")
    if miss:
        paras.append(_var(seed, f"As kadrodan eksikler: {'; '.join(miss)}.",
                          f"Son haftalarda düzenli oynayan isimlerden {'; '.join(miss)} bu maçta yok.",
                          f"Kadroda boşluk var: {'; '.join(miss)} forma giyemeyecek."))

    # 5) maçın temposu: gol, korner, kart, dinlenme
    tempo = []
    tot = pr["lam_home"] + pr["lam_away"]
    if pr.get("p_over35", 0) >= 0.45 or tot >= 3.3:
        tempo.append(f"Beklenen toplam gol {f(tot, 1)}; 3.5 üst ihtimali {pct(pr.get('p_over35') or 0)} ile bol gollü bir maç bekleniyor.")
    elif pr["over25"] <= 0.42:
        tempo.append(f"Beklenen toplam gol {f(tot, 1)}; kontrollü, az gollü bir maç bekleniyor (2.5 alt {pct(1 - pr['over25'])}).")
    else:
        tempo.append(f"Beklenen toplam gol {f(tot, 1)} (2.5 üst {pct(pr['over25'])}, karşılıklı gol {pct(pr['btts'])}).")
    cor, crd = pr.get("corners") or {}, pr.get("cards") or {}
    if cor.get("total"):
        tempo.append(f"Korner beklentisi {f(cor['total'], 1)}" + (f", kart beklentisi {f(crd['total'], 1)}." if crd.get("total") else "."))
    rs = b.get("referee_stats") or {}
    if rs.get("matches", 0) >= 4 and rs.get("yellow_pm") and rs.get("yellow_avg") and abs(rs["yellow_pm"] / rs["yellow_avg"] - 1) >= 0.15:
        tempo.append(f"Hakem {b.get('referee')} maç başı {f(rs['yellow_pm'], 1)} sarı kart gösteriyor (lig ortalaması {f(rs['yellow_avg'], 1)}).")
    rest = pr.get("rest") or (None, None)
    if None not in rest and abs(rest[0] - rest[1]) >= 2 and min(rest) <= 3.5:
        tired = H if rest[0] < rest[1] else A
        tempo.append(f"{tired} {round(min(rest))} gün dinlenerek çıkıyor, rakibi {round(max(rest))} gün.")
    paras.append(" ".join(tempo))

    # 6) piyasa ile modelin karşılaştırması
    mw = _odds_market(b.get("odds"), "who_will_win")
    if mw and len(mw["selections"]) == 3:
        from .odds import implied
        imp = dict(zip([s_.get("code") for s_ in mw["selections"]], implied(mw)))
        od = {s_.get("code"): s_["odds"] for s_ in mw["selections"]}
        if all(k in imp for k in ("1", "X", "2")):
            fav = "1" if imp["1"] >= imp["2"] else "2"
            ft = H if fav == "1" else A
            mp = pr["p_home"] if fav == "1" else pr["p_away"]
            mv = next((s_ for s_ in mw["selections"] if s_.get("code") == fav and s_.get("o0") and abs(s_["o0"] - s_["odds"]) >= 0.05), None)
            txt = (f"Oranlar dengeli (1: {f(od['1'], 2)}, X: {f(od['X'], 2)}, 2: {f(od['2'], 2)})." if abs(imp["1"] - imp["2"]) < 0.08
                   else f"Bahis piyasasının favorisi {ft} (oran {f(od[fav], 2)}, %{round(imp[fav] * 100)}).")
            if mv:
                txt += (f" Favorinin oranı açılışta {f(mv['o0'], 2)} iken şimdi {f(mv['odds'], 2)}; "
                        + ("para bu tarafa geliyor." if mv["odds"] < mv["o0"] else "piyasa favoriye eskisi kadar güvenmiyor."))
            if mp - imp[fav] >= 0.04:
                txt += f" Model favoriye piyasadan biraz daha fazla şans veriyor (%{round(mp * 100)})."
            elif imp[fav] - mp >= 0.04:
                txt += f" Model piyasadan daha temkinli (%{round(mp * 100)})."
            paras.append(txt)

    # 7) sonuç ve skorun gerekçesi
    sp, bp, su = pr.get("score_pick") or {}, pr.get("best_pick"), pr.get("surprise")
    try:
        si, sj = map(int, sp.get("score", "").split("-"))
        so = "1" if si > sj else ("X" if si == sj else "2")
    except ValueError:
        so = pr["pick"]
    out = {"1": f"{H} galibiyeti", "X": "dengeli bir maç, beraberlik ön planda", "2": f"{A} galibiyeti"}[so]
    concl = (f"Genel beklenti {out}. Beklenen goller {H} {f(pr['lam_home'], 1)}, {A} {f(pr['lam_away'], 1)}; "
             f"buna en uygun skor {sp.get('score', '—')}.")
    if bp:
        concl += f" Modelin en güvendiği tercih {bp['label']}" + (f" (oran {f(bp['odds'], 2)})." if bp.get("odds") else ".")
    if su:
        concl += f" Sürpriz için: {su['label']}" + (f" (oran {f(su['odds'], 2)})." if su.get("odds") else ".")
    paras.append(concl)
    return {"paragraphs": [p_ for p_ in paras if p_], "tags": tags[:6]}


def score_why(pr, H, A):
    """Skor tahmininin nereden geldiği: iki takımın beklenen golleri ve bunları oluşturan parçalar."""
    lp = pr.get("lam_parts") or {}
    att, conc, elo_r = lp.get("att") or [None, None], lp.get("conc") or [None, None], lp.get("elo")
    bits = []
    if None not in att and None not in conc:
        bits.append(f"{H} maç başı {f(att[0], 1)} xG üretiyor, {A} {f(conc[0], 1)} xG yiyor; "
                    f"{A} {f(att[1], 1)} üretiyor, {H} {f(conc[1], 1)} yiyor (rakip gücüne göre düzeltilmiş)")
    if elo_r and None not in elo_r and lp.get("elo_sup") is not None:
        gap = round(elo_r[0] - elo_r[1])
        bits.append(f"güç puanları {H} {round(elo_r[0])}, {A} {round(elo_r[1])}"
                    + (f" ({H if gap > 0 else A} {abs(gap)} puan önde)" if abs(gap) >= 15 else " (denk)"))
    if pr.get("uses_odds"):
        bits.append("oranlar da hesaba katıldı")
    head = f"Skorun dayanağı: beklenen goller {H} {f(pr['lam_home'], 1)}, {A} {f(pr['lam_away'], 1)} (toplam {f(pr['lam_home'] + pr['lam_away'], 1)}, 3.5 üst {pct(pr.get('p_over35') or 0)})"
    return head + (": " + "; ".join(bits) if bits else "") + ". "


def build(b):
    lu = b.get("lineup") or {}
    prof_h = team_profile(b["home"]["name"], b["recent"]["home"], b["season"]["home"], lu.get("home"),
                          b["season"]["players_home"], b["season"]["table_home"])
    prof_a = team_profile(b["away"]["name"], b["recent"]["away"], b["season"]["away"], lu.get("away"),
                          b["season"]["players_away"], b["season"]["table_away"])
    pr = predict(b, prof_h, prof_a)
    sc = scenarios(b, pr, prof_h, prof_a)
    H, A = b["home"]["name"], b["away"]["name"]
    # kadro henüz son maçın 11'i ise, o 11'den bu maçta olmayacakları belirt
    if lu.get("type") == "lastStarting11":
        for s, team in (("home", H), ("away", A)):
            side = lu.get(s) or {}
            out_ids = {p["id"] for p in side.get("unavailable", [])}
            gone = [p["name"] for p in side.get("starters", []) if p["id"] in out_ids]
            if gone:
                # aynı takım için genel "önemli eksik" senaryosu varsa bu daha somut cümle yerine geçer
                sc = [x for x in sc if not x.startswith(f"{team} ") or "önemli eksikle oynayacak" not in x]
                sc.insert(0, f"{team} son maçtaki ilk 11'inden {', '.join(gone)} bu maçta yok; kadroda zorunlu değişiklik olacak.")
    # resmi ilk 11 açıklandıysa: sezonun en iyi (reyting/gol) oyuncularından ilk 11'de olmayanlar
    warn = lineup_warnings(b)
    for w_ in reversed(warn):
        sc.insert(0, w_)
    for x in pr.get("factors") or []:
        # eksiklerin somut etkisi yazıldıysa aynı takımın genel "önemli eksik" cümlesi kalkar
        if " eksikleri: " in x:
            team = x.split(" eksikleri: ")[0]
            sc = [y for y in sc if not (y.startswith(f"{team} ") and "önemli eksikle oynayacak" in y)]
        sc.append(x)
    rs = b.get("referee_stats") or {}
    if rs.get("matches", 0) >= 4 and rs.get("yellow_pm") and rs.get("yellow_avg"):
        ratio = rs["yellow_pm"] / rs["yellow_avg"]
        if ratio >= 1.15:
            sc.append(f"Hakem {b.get('referee')} kartı bol kullanıyor: maç başı {f(rs['yellow_pm'], 1)} sarı kart (lig ortalaması {f(rs['yellow_avg'], 1)}).")
        elif ratio <= 0.85:
            sc.append(f"Hakem {b.get('referee')} az kart gösteriyor: maç başı {f(rs['yellow_pm'], 1)} sarı kart (lig ortalaması {f(rs['yellow_avg'], 1)}).")
    pick_txt = {"1": f"{H} kazanır", "X": "beraberlik", "2": f"{A} kazanır"}[pr["pick"]]
    src = "istatistikler ve bahis oranları birlikte" if pr.get("uses_odds") else "istatistikler"
    bp, sp = pr.get("best_pick"), pr.get("surprise")
    odds_txt = lambda x: f", oran {f(x['odds'], 2)}" if x and x.get("odds") else ""
    summary = (
        f"Model ({src}), {H} için {f(pr['lam_home'], 2)}, {A} için {f(pr['lam_away'], 2)} beklenen gol hesaplıyor. "
        f"Olasılıklar: 1 {pct(pr['p_home'])} · X {pct(pr['p_draw'])} · 2 {pct(pr['p_away'])}. "
        f"En olası sonuç {pick_txt}; skor tahmini {pr['score_pick']['score']}. "
        + score_why(pr, H, A)
        + f"2.5 üst {pct(pr['over25'])}, karşılıklı gol {pct(pr['btts'])}. "
        + (f"En garanti tercih: {bp['label']} ({pct(bp['p'])}{odds_txt(bp)}). " if bp else "")
        + (f"Olası sürpriz: {sp['label']} ({pct(sp['p'])}{odds_txt(sp)}). " if sp else "")
        + f"Güven: {pr['confidence']}."
    )
    return {"home": prof_h, "away": prof_a, "prediction": pr, "scenarios": sc, "summary": summary,
            "commentary": commentary(b, pr, prof_h, prof_a)}
