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


def market_probs(mat, lh, la, corners=None):
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
    if ph + pa:
        pr.update({"dnb1": ph / (ph + pa), "dnb2": pa / (ph + pa)})
    p00 = mat[0][0]
    pr.update({"fts0": p00, "fts1": (1 - p00) * lh / (lh + la), "fts2": (1 - p00) * la / (lh + la)})
    for i, j, p in cells:
        if i <= 6 and j <= 6:
            pr[f"cs:{i}-{j}"] = p
    if corners:
        ch, ca = corners["home"], corners["away"]
        h = [_pois(k, ch) for k in range(30)]
        a = [_pois(k, ca) for k in range(30)]
        c1 = sum(h[i] * a[j] for i in range(30) for j in range(30) if i > j)
        cx = sum(h[i] * a[i] for i in range(30))
        pr.update({"cm1": c1, "cmX": cx, "cm2": max(0.0, 1 - c1 - cx)})
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
    imp = dict(zip([s["code"] for s in mw["selections"]], implied(mw)))
    if not all(k in imp for k in ("1", "X", "2")):
        return None
    ou = _odds_market(odds, "odds_goals_over_under", 2.5)
    if not ou:
        ous = [m for m in (odds.get("markets") or []) if m["key"] == "odds_goals_over_under" and m.get("line")]
        ou = min(ous, key=lambda m: abs(m["line"] - 2.5)) if ous else None
    over = None
    if ou and len(ou["selections"]) == 2:
        oi = dict(zip([s["code"][0] for s in ou["selections"] if s["code"]], implied(ou)))
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


SAFE_CODES = {"1", "X", "2", "1X", "12", "X2", "btts_yes", "btts_no", "o1.5", "u1.5", "o2.5", "u2.5",
              "o3.5", "u3.5", "dnb1", "dnb2"}


def code_label(code, home, away):
    fixed = {"1": f"MS 1 ({home})", "X": "MS X (beraberlik)", "2": f"MS 2 ({away})", "1X": "Çifte şans 1X", "12": "Çifte şans 12",
             "X2": "Çifte şans X2", "btts_yes": "KG Var", "btts_no": "KG Yok", "odd": "Toplam gol tek", "even": "Toplam gol çift",
             "dnb1": f"Beraberlikte iade: {home}", "dnb2": f"Beraberlikte iade: {away}", "fts0": "Maçta gol olmaz",
             "fts1": f"İlk golü {home} atar", "fts2": f"İlk golü {away} atar", "cm1": f"Daha çok korneri {home} kullanır",
             "cmX": "Korner sayıları eşit", "cm2": f"Daha çok korneri {away} kullanır",
             "o25": "2.5 Üst", "u25": "2.5 Alt"}
    if code in fixed:
        return fixed[code]
    m = re.fullmatch(r"([ou])(\d+(?:\.\d+)?)", code)
    if m:
        return f"{m.group(2)} {'Üst' if m.group(1) == 'o' else 'Alt'}"
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
    cands = [c for c in sel if c[0] in SAFE_CODES and c[2] >= MIN_ODDS]
    if cands:
        code, p, o = max(cands, key=lambda c: (c[1], c[2]))
        safe = {"code": code, "p": round(p, 3), "odds": o}
    else:  # oran yoksa: adil oranı (1/olasılık) 1.30'un altında kalan seçenekler elenir
        model = [(c, pr[c]) for c in SAFE_CODES if c in pr and 1 / max(pr[c], 1e-9) >= MIN_ODDS]
        if model:
            code, p = max(model, key=lambda c: c[1])
            safe = {"code": code, "p": round(p, 3), "odds": None}
    sc = [c for c in sel if 2.8 <= c[2] <= 15 and c[1] >= (0.07 if c[0].startswith("cs:") else 0.15)
          and not c[0].startswith(("cm", "fts", "odd", "even"))]
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

    mat = score_matrix(lam_h, lam_a)
    pr = market_probs(mat, lam_h, lam_a, corners)
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
    # oran sayfası için: oranı olan her seçeneğin model olasılığı
    codes = {s["code"] for m in (odds or {}).get("markets") or [] for s in m["selections"] if s.get("code")}
    return {
        "lam_home": round(lam_h, 2), "lam_away": round(lam_a, 2),
        "lam_model": model_lam, "lam_market": mk, "uses_odds": bool(mk),
        "p_home": round(pr["1"], 3), "p_draw": round(pr["X"], 3), "p_away": round(pr["2"], 3),
        "over15": round(pr["o1.5"], 3), "over25": round(pr["o2.5"], 3), "over35": round(pr["o3.5"], 3),
        "btts": round(pr["btts_yes"], 3),
        "scores": [{"score": s, "p": round(p, 3)} for p, s in scores],
        "score_pick": coherent_score(mat, pr, lam_h, lam_a),
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


def pick_hit(code, hs, as_):
    """Tercih tuttu mu? hs/as_ maç sonu skoru. None: iade (karnede sayılmaz)."""
    t = hs + as_
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
                sc.insert(0, f"{team} son maçtaki ilk 11'inden {', '.join(gone)} bu maçta yok; kadroda zorunlu değişiklik olacak.")
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
    return {"home": prof_h, "away": prof_a, "prediction": pr, "scenarios": sc, "summary": summary}
