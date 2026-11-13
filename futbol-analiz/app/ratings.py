"""Takımların hücum ve savunma gücü: son iki sezon + bu sezonun bütün maç sonuçlarından (lig ve Avrupa kupaları).

Çarpımsal Poisson modeli: ev sahibinin beklenen golü = ortalama × ev çarpanı × ev hücumu × deplasman savunması.
Yeni maçlar daha ağır sayılır (yarı ömür HALF_LIFE gün); az maçı olan takım ortalamaya çekilir (SHRINK maçlık
"ortalama takım" varsayımı). Avrupa maçları ligleri birbirine bağladığı için ligler arası güç farkı da ölçülür.
"""
import math
from datetime import datetime

HALF_LIFE = 365   # gün: bir maçın ağırlığı bu kadar süre sonra yarıya iner
SHRINK = 6.0      # az maçı olan takımı ortalamaya çeken ağırlık (maç sayısı cinsinden)
ITERS = 30


def _day(utc):
    try:
        return datetime.fromisoformat(str(utc).replace("Z", "+00:00")).timestamp() / 86400
    except (TypeError, ValueError):
        return None


def fit(matches, now_day=None):
    """matches: [{"h", "a", "hs", "as", "t"}]. now_day verilirse yalnızca ondan önceki maçlar kullanılır."""
    rows = []
    for m in matches:
        d = _day(m.get("t"))
        if d is None or (now_day is not None and d >= now_day):
            continue
        rows.append((m["h"], m["a"], m["hs"], m["as"], d))
    if not rows:
        return None
    ref = now_day if now_day is not None else max(r[4] for r in rows) + 1
    w = [0.5 ** ((ref - r[4]) / HALF_LIFE) for r in rows]
    sw = sum(w)
    base = sum(wi * (r[2] + r[3]) for wi, r in zip(w, rows)) / (2 * sw)
    home = sum(wi * r[2] for wi, r in zip(w, rows)) / (sw * base)
    away = sum(wi * r[3] for wi, r in zip(w, rows)) / (sw * base)
    att, dfn = {}, {}
    for r in rows:
        for t in (r[0], r[1]):
            att.setdefault(t, 1.0)
            dfn.setdefault(t, 1.0)
    for _ in range(ITERS):
        gf, ef, ga, ea = {}, {}, {}, {}
        for wi, (h, a, hs, as_, _d) in zip(w, rows):
            # hücum: atılan gol / (rakibin savunmasına göre beklenen)
            gf[h] = gf.get(h, 0) + wi * hs; ef[h] = ef.get(h, 0) + wi * base * home * dfn[a]
            gf[a] = gf.get(a, 0) + wi * as_; ef[a] = ef.get(a, 0) + wi * base * away * dfn[h]
            ga[h] = ga.get(h, 0) + wi * as_; ea[h] = ea.get(h, 0) + wi * base * away * att[a]
            ga[a] = ga.get(a, 0) + wi * hs; ea[a] = ea.get(a, 0) + wi * base * home * att[h]
        for t in att:
            att[t] = (gf.get(t, 0) + SHRINK * base) / (ef.get(t, 0) + SHRINK * base)
            dfn[t] = (ga.get(t, 0) + SHRINK * base) / (ea.get(t, 0) + SHRINK * base)
        # ortalama 1'de kalsın
        ma = sum(att.values()) / len(att); md = sum(dfn.values()) / len(dfn)
        for t in att:
            att[t] /= ma
            dfn[t] /= md
    n = {}
    for wi, r in zip(w, rows):
        n[r[0]] = n.get(r[0], 0) + 1
        n[r[1]] = n.get(r[1], 0) + 1
    return {"base": base, "home": home, "away": away, "att": att, "dfn": dfn, "n": n}


def lambdas(model, hid, aid):
    """İki takımın beklenen golleri; takım modelde yoksa None."""
    if not model or hid not in model["att"] or aid not in model["att"]:
        return None
    lh = model["base"] * model["home"] * model["att"][hid] * model["dfn"][aid]
    la = model["base"] * model["away"] * model["att"][aid] * model["dfn"][hid]
    return round(lh, 3), round(la, 3)


def own_score(lh, la):
    """Modelin kendi skor tahmini: en olası skor değil, beklenen gollere en yakın skor.
    Toplam gol beklenen toplamın yuvarlanmışı; fark beklenen farkın yuvarlanmışı (ikisi uyumsuzsa fark, beklenen farkın
    yönüne doğru bir artırılır). Böylece golcü takımların maçında 3-2, 4-1 gibi skorlar doğal olarak çıkar."""
    tot = max(0, int(lh + la + 0.5))
    diff = lh - la
    d = int(abs(diff) + 0.5) * (1 if diff >= 0 else -1)
    if (tot + d) % 2:
        d += 1 if diff >= 0 else -1
    if abs(d) > tot:
        d = tot if d > 0 else -tot
    h = (tot + d) // 2
    return f"{h}-{tot - h}"


def poisson(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)
