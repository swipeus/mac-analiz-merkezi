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


def key_absentees(lineup_side):
    out = []
    for p in (lineup_side or {}).get("unavailable", []):
        important = (p.get("rating") or 0) >= 6.9 or (p.get("value") or 0) >= 15_000_000
        out.append({**p, "important": important})
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
    absents = key_absentees(lu_side)
    for p in absents:
        sec["absent"].append(("Önemli eksik: " if p["important"] else "") + absent_txt(p))
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


def _nb_over(mu, line, k=1.4):
    """Negatif binom (varyans = k × ortalama): korner sayıları Poisson'dan daha dağınıktır."""
    r, q = mu / (k - 1), 1 / k
    pmf = lambda n: math.exp(math.lgamma(n + r) - math.lgamma(r) - math.lgamma(n + 1) + r * math.log(q) + n * math.log(1 - q))
    return 1 - sum(pmf(n) for n in range(int(line) + 1))


def _over(lam, line):
    return 1 - sum(_pois(k, lam) for k in range(int(line) + 1))


RHO = -0.08          # Dixon-Coles düşük skor düzeltmesi
MARKET_WEIGHT = 0.6  # oran varsa gol beklentisinde piyasanın ağırlığı
MIN_ODDS = 1.30      # en garanti tercih bu orandan düşük olamaz
N_GOALS = 10


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


def coherent_score(mat, pr, lh, la):
    """Skor tahmini: beklenen sonuç ve toplam golle tutarlı skorlar arasından, olasılığı yüksek ve her takımın
    beklenen gol sayısına yakın olanı seçer (matrisin tepesi tek başına hep 1-1 / 2-1 / 1-0 verir)."""
    outcome = max(("1", pr["1"]), ("X", pr["X"]), ("2", pr["2"]), key=lambda x: x[1])[0]
    ok = {"1": lambda i, j: i > j, "X": lambda i, j: i == j, "2": lambda i, j: i < j}[outcome]
    n = len(mat)
    cands = [(mat[i][j], i, j) for i in range(n) for j in range(n) if ok(i, j)]
    over = pr["o2.5"]
    if over >= 0.55:
        pref = [c for c in cands if c[1] + c[2] >= 3]
    elif over <= 0.45:
        pref = [c for c in cands if c[1] + c[2] <= 2]
    else:
        pref = cands
    p, i, j = max(pref or cands, key=lambda c: c[0] * math.exp(-((c[1] - lh) ** 2 + (c[2] - la) ** 2)))
    return {"score": f"{i}-{j}", "p": round(p, 3)}


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
    return len(legs) <= 3 and all(x in SAFE_CODES or TOTAL_CODE.match(x) for x in legs)


def safe_score(p, odds):
    """Önce yüksek olasılık; piyasanın ima ettiğinden iyi görülen (değerli) seçenekler biraz öne çıkar."""
    edge = p * odds - 1
    return p + 0.5 * max(-0.10, min(edge, 0.10))


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
    m = re.fullmatch(r"([hac])([ou])(\d+(?:\.\d+)?)", code)
    if m:
        who = {"h": f"{home} gol", "a": f"{away} gol", "c": "Toplam korner"}[m.group(1)]
        return f"{who} {m.group(3)} {'Üst' if m.group(2) == 'o' else 'Alt'}"
    if code.startswith("cs:"):
        return "Skor " + code[3:]
    return code


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
        code, p, o = max(cands, key=lambda c: (safe_score(c[1], c[2]), c[2]))
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
    for x in (safe, surprise):
        if x:
            x["label"] = code_label(x["code"], home, away)
    return safe, surprise


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


def predict(b, prof_h, prof_a):
    rh, ra = b["recent"]["home"], b["recent"]["away"]
    sh, sa = b["season"]["home"], b["season"]["away"]
    H, A = b["home"]["name"], b["away"]["name"]

    def att(rec, season):
        return _wavg([(rec["avg_for"].get("xg"), 0.6), (_s(season, "expected_goals_team"), 0.4)]) or \
            _wavg([(rec["avg_for"].get("goals"), 0.6), (_s(season, "goals_team_match"), 0.4)])

    def dfn(rec, season):
        return _wavg([(rec["avg_against"].get("xg"), 0.6), (_s(season, "expected_goals_conceded_team"), 0.4)]) or \
            _wavg([(rec["avg_against"].get("goals"), 0.6), (_s(season, "goals_conceded_team_match"), 0.4)])

    ah, aa_, dh, da = att(rh, sh), att(ra, sa), dfn(rh, sh), dfn(ra, sa)
    lam_h = _wavg([(ah, 1), (da, 1)]) or 1.35
    lam_a = _wavg([(aa_, 1), (dh, 1)]) or 1.1
    lam_h *= HOME_ADV
    lam_a *= AWAY_ADJ
    # önemli eksikler hücum gücünü düşürür
    lam_h *= max(0.88, 1 - 0.03 * prof_h["important_absent"])
    lam_a *= max(0.88, 1 - 0.03 * prof_a["important_absent"])
    lam_h, lam_a = max(0.2, lam_h), max(0.2, lam_a)
    model_lam = (round(lam_h, 2), round(lam_a, 2))

    odds = b.get("odds")
    mk = fit_market_lambdas(odds) if odds else None
    if mk:
        lam_h = MARKET_WEIGHT * mk[0] + (1 - MARKET_WEIGHT) * lam_h
        lam_a = MARKET_WEIGHT * mk[1] + (1 - MARKET_WEIGHT) * lam_a

    def exp_pair(k):
        h = _wavg([(rh["avg_for"].get(k), 1), (ra["avg_against"].get(k), 1)])
        a = _wavg([(ra["avg_for"].get(k), 1), (rh["avg_against"].get(k), 1)])
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
    y_h, y_a = rh["avg_for"].get("yellow"), ra["avg_for"].get("yellow")

    n_min = min(rh.get("n_stats") or 0, ra.get("n_stats") or 0)
    has_season = bool(sh) and bool(sa)
    conf = "Yüksek" if n_min >= 5 and has_season else ("Orta" if n_min >= 3 else "Düşük")
    best = max((pr["1"], "1"), (pr["X"], "X"), (pr["2"], "2"))
    safe, surprise = make_picks(pr, odds, H, A)
    score_pick = coherent_score(smat, pr, lam_h, lam_a)
    cs_m = _odds_market(odds, "odds_correct_score")
    if cs_m:  # skor tahmininin oranı (karnede 10 ₺'lik skor bahsi için)
        score_pick["odds"] = next((s_["odds"] for s_ in cs_m["selections"] if s_.get("code") == "cs:" + score_pick["score"]), None)
    # oran sayfası için: oranı olan her seçeneğin model olasılığı
    codes = {s["code"] for m in (odds or {}).get("markets") or [] for s in m["selections"] if s.get("code")}
    return {
        "lam_home": round(lam_h, 2), "lam_away": round(lam_a, 2),
        "lam_model": model_lam, "lam_market": mk, "uses_odds": bool(mk),
        "p_home": round(pr["1"], 3), "p_draw": round(pr["X"], 3), "p_away": round(pr["2"], 3),
        "over15": round(pr["o1.5"], 3), "over25": round(pr["o2.5"], 3), "over35": round(pr["o3.5"], 3),
        "btts": round(pr["btts_yes"], 3),
        "scores": [{"score": s, "p": round(p, 3)} for p, s in scores],
        "score_pick": score_pick,
        "corners": corners,
        "shots": {"home": s_h and round(s_h, 1), "away": s_a and round(s_a, 1)},
        "sot": {"home": o_h and round(o_h, 1), "away": o_a and round(o_a, 1)},
        "yellow": {"home": y_h, "away": y_a, "total": round(y_h + y_a, 1) if y_h is not None and y_a is not None else None},
        "confidence": conf,
        "pick": best[1],
        "best_pick": safe,
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
        need = f" Kurtuluş hattıyla arası {safe - pts} puan." if safe is not None and safe >= pts else ""
        return f"{team} {pos}. sırada, düşme hattında.{need} Her puan hayati önemde."
    if t.get("first_rel_pts") is not None and pts - t["first_rel_pts"] <= 3 and pos > of / 2:
        return f"{team} düşme hattının sadece {pts - t['first_rel_pts']} puan üzerinde ({pos}. sıra); alt sıralardan uzaklaşmak isteyecek."
    if zone:
        return f"{team} {pos}. sırada, {zone} hattında yer alıyor; bu konumu korumak isteyecek."
    return f"{team} {of} takımlı ligde {pos}. sırada ({pts} puan)."


def commentary(b, pr, prof_h, prof_a):
    """Kaynaklara ve oranlara dayalı maç yorumu: paragraflar ve öne çıkan etiketler."""
    H, A = b["home"]["name"], b["away"]["name"]
    lid = b.get("league_id")
    paras, tags = [], []
    # 1) bağlam: lig/kupa durumu
    ctx = []
    if lid in EURO_CUPS:
        ctx.append(f"Bu bir {EURO_CUPS[lid]} maçı; Avrupa'da alınacak her puan hem tur hem de ülke puanı için önemli.")
    for team, key in ((H, "table_home"), (A, "table_away")):
        line = _table_line(team, (b.get("season") or {}).get(key), lid)
        if line:
            ctx.append(line)
    if ctx:
        paras.append(" ".join(ctx))
    # 2) seriler
    st = b.get("streaks") or {}
    sl = []
    for team, k in ((H, "home"), (A, "away")):
        lines, t = _streak_lines(team, st.get(k))
        sl += lines[:2]
        tags += t
    if sl:
        paras.append(" ".join(sl))
    # 3) eksikler ve rekabet geçmişi
    ab = []
    lu = b.get("lineup") or {}
    miss = []
    for team, side in ((H, "home"), (A, "away")):
        imp = [p["name"] for p in (lu.get(side) or {}).get("unavailable", []) if (p.get("rating") or 0) >= 6.9 or (p.get("value") or 0) >= 15_000_000]
        if imp:
            miss.append(f"{team} cephesinde {', '.join(imp[:3])} {'gibi önemli isimler' if len(imp) > 1 else 'önemli bir eksik olarak'}")
    if miss:  # iki takımın eksikleri tek cümlede, yorum cümlesi bir kez
        ab.append(f"{'; '.join(miss)} forma giyemeyecek; bu eksikler planı ve kadro derinliğini etkileyecek.")
    h2h = (b.get("h2h") or {}).get("summary")
    if h2h and sum(h2h) >= 3:
        if h2h[0] - h2h[2] >= 3:
            ab.append(f"Rekabet geçmişinde {H} üstün ({h2h[0]} galibiyet, {h2h[1]} beraberlik, {h2h[2]} mağlubiyet); psikolojik avantaj ev sahibinde.")
        elif h2h[2] - h2h[0] >= 3:
            ab.append(f"Rekabet geçmişinde {A} üstün ({h2h[2]} galibiyet, {h2h[1]} beraberlik, {h2h[0]} mağlubiyet); deplasman ekibi bu maça moralli çıkacak.")
    if ab:
        paras.append(" ".join(ab))
    # 4) bahis piyasası ve modelin görüşü
    odds = b.get("odds")
    mw = _odds_market(odds, "who_will_win")
    mk = []
    if mw and len(mw["selections"]) == 3:
        from .odds import implied
        imp = dict(zip([s.get("code") for s in mw["selections"]], implied(mw)))
        od = {s.get("code"): s["odds"] for s in mw["selections"]}
        if all(k in imp for k in ("1", "X", "2")):
            fav = "1" if imp["1"] >= imp["2"] else "2"
            ft, other = (H, A) if fav == "1" else (A, H)
            if abs(imp["1"] - imp["2"]) < 0.08:
                mk.append(f"Bahis piyasası dengeli bir maç bekliyor (1: {f(od['1'], 2)}, X: {f(od['X'], 2)}, 2: {f(od['2'], 2)}).")
            else:
                mk.append(f"Bahis piyasası favori olarak {ft} takımını görüyor (oran {f(od[fav], 2)}, kazanma ihtimali {pct(imp[fav])}).")
                mp = pr["p_home"] if fav == "1" else pr["p_away"]
                if imp[fav] - mp >= 0.07:
                    mk.append(f"Model ise daha temkinli ({pct(mp)}); {other} için sürpriz ihtimali göz ardı edilmemeli.")
                elif mp - imp[fav] >= 0.07:
                    mk.append(f"Model favoriye piyasadan da fazla şans veriyor ({pct(mp)}).")
    ou = _odds_market(odds, "odds_goals_over_under", 2.5)
    if ou and len(ou["selections"]) == 2:
        from .odds import implied
        io = dict(zip([s.get("code") for s in ou["selections"]], implied(ou)))
        if io.get("o2.5", 0) >= 0.6:
            mk.append(f"Oranlar gollü bir maça işaret ediyor (2.5 üst ihtimali {pct(io['o2.5'])}).")
        elif io.get("u2.5", 0) >= 0.55:
            mk.append(f"Oranlar kontrollü, az gollü bir maç bekliyor (2.5 alt ihtimali {pct(io['u2.5'])}).")
    if mk:
        paras.append(" ".join(mk))
    # 5) sonuç
    sp, bp, su = pr.get("score_pick") or {}, pr.get("best_pick"), pr.get("surprise")
    out = {"1": f"{H} galibiyeti", "X": "beraberlik", "2": f"{A} galibiyeti"}[pr["pick"]]
    concl = f"Genel beklenti: {out}. Skor tahmini {sp.get('score', '—')}."
    if bp:
        concl += f" Modelin en güvendiği tercih {bp['label']}" + (f" (oran {f(bp['odds'], 2)})." if bp.get("odds") else ".")
    if su:
        concl += f" Sürpriz arayanlar için: {su['label']}" + (f" (oran {f(su['odds'], 2)})." if su.get("odds") else ".")
    paras.append(concl)
    return {"paragraphs": paras, "tags": tags[:6]}


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
        f"2.5 üst {pct(pr['over25'])}, karşılıklı gol {pct(pr['btts'])}. "
        + (f"En garanti tercih: {bp['label']} ({pct(bp['p'])}{odds_txt(bp)}). " if bp else "")
        + (f"Olası sürpriz: {sp['label']} ({pct(sp['p'])}{odds_txt(sp)}). " if sp else "")
        + f"Güven: {pr['confidence']}."
    )
    return {"home": prof_h, "away": prof_a, "prediction": pr, "scenarios": sc, "summary": summary,
            "commentary": commentary(b, pr, prof_h, prof_a)}
