"""Bahis oranları: tek sağlayıcı, Unibet (Kambi altyapısı).

Kambi'nin herkese açık oran servisi maç başına 300-600 pazar verir: maç sonucu, alt/üst, handikaplar, yarılar,
korner/kart/şut/ofsayt toplamları, oyuncu pazarları (gol, asist, şut, isabetli şut, kart, faul) ve hazır
kombine bahisler (Bet Builder). Unibet maçı listelemiyorsa FotMob'daki en geniş tek sağlayıcıya düşülür.
"""
import asyncio
import difflib
import logging
import re
import time
import unicodedata
from datetime import datetime

from .sources import FOTMOB

log = logging.getLogger("odds")

KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub"
KAMBI_Q = "lang=en_GB&market=GB"
KAMBI_PATH = {
    71: "turkey/super_lig", 47: "england/premier_league", 87: "spain/la_liga", 55: "italy/serie_a",
    54: "germany/bundesliga", 53: "france/ligue_1", 57: "netherlands/eredivisie", 61: "portugal/primeira_liga",
    40: "belgium/jupiler_pro_league", 48: "england/the_championship", 64: "scotland/scottish_premiership",
    42: "champions_league/all", 73: "europa_league/all", 10216: "conference_league/all",
}
LIST_TTL = 10 * 60
ODDS_TTL = 5 * 60
PROVIDER = "Unibet"

# FotMob yedeği: bölgelere göre sağlayıcı değişir, en çok pazar veren tek sağlayıcı kullanılır
REGIONS = ["NOR", "ESP", "IND", "SWE", "KEN", "MEX"]

# Ekranda grupların sırası (static/app.js ile aynı)
GROUPS = ["Maç", "Goller", "Yarılar", "Skor", "Kombine", "Korner", "Kart ve penaltı", "Şut ve ofsayt", "Handikap",
          "Oyuncu: gol", "Oyuncu: şut ve asist", "Oyuncu: kart ve faul", "Zaman aralığı", "Diğer"]


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(fc|sc|afc|cf|ac|as|sk|fk|bk|if|cd|ud|sd|rc|rcd|ss|ssc|vfb|vfl|tsg|sv|1\.|club|de|calcio)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _sim(a, b):
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 0.95
    return difflib.SequenceMatcher(None, a, b).ratio()


def implied(market):
    """Pazar içindeki oranlardan marjı temizlenmiş olasılıklar (oyuncu/skor gibi çok seçenekli pazarlarda kullanılmaz)."""
    inv = [1 / s["odds"] for s in market["selections"]]
    tot = sum(inv) or 1
    return [x / tot for x in inv]


# ---------------------------------------------------------------- Kambi (Unibet)

def _line(v):
    return None if v is None else v / 1000


def _num(x):
    return f"{x:g}"


def _signed(x):
    return ("+" if x > 0 else "") + f"{x:g}"


SUFFIX = [(" - 1st Half", " · İlk yarı"), (" - 2nd Half", " · İkinci yarı")]
OPTA = re.compile(r"\s*\(Settled using Opta data\)", re.I)
INTERVAL = re.compile(r" ?(?:- |Interval - )(\d+):00-(\d+):59")


def _crit_tr(label, home, away):
    """Kambi pazar adını Türkçeye çevirir: (başlık, grup)."""
    l = OPTA.sub("", label).replace("’", "'").strip()
    sfx = ""
    for en, tr in SUFFIX:
        if en in l:
            l, sfx = l.replace(en, ""), tr
    iv = INTERVAL.search(l)
    if iv:
        l = INTERVAL.sub("", l).strip()
        sfx = f" · {int(iv.group(1))}-{int(iv.group(2)) + 1}. dakika"
    team = None
    for name in (home, away):
        if name and name in l:
            team, l = name, l.replace(name, "{T}")
    T = team or ""
    fixed = {
        "Full Time": ("Maç sonucu", "Maç"), "Half Time": ("İlk yarı sonucu", "Yarılar"), "2nd Half": ("İkinci yarı sonucu", "Yarılar"),
        "Double Chance": ("Çifte şans", "Maç"), "Draw No Bet": ("Beraberlikte iade", "Maç"),
        "First Goal (Draw: No Goals)": ("İlk golü atan takım", "Maç"), "Half Time/Full Time": ("İlk yarı / maç sonucu", "Yarılar"),
        "Both Teams To Score": ("Karşılıklı gol", "Goller"), "Total Goals": ("Toplam gol", "Goller"),
        "Goal in Both Halves": ("İki yarıda da gol olur mu?", "Yarılar"), "Own goal": ("Kendi kalesine gol olur mu?", "Goller"),
        "Correct Score": ("Skor", "Skor"), "Asian Total": ("Asya alt/üst", "Goller"),
        "Asian Handicap": ("Asya handikapı", "Handikap"), "Handicap": ("Handikap", "Handikap"),
        "3-Way Handicap": ("Handikaplı maç sonucu", "Handikap"), "Corners 3-Way Handicap": ("Korner handikapı", "Korner"),
        "Cards 3-Way Handicap": ("Kart handikapı", "Kart ve penaltı"),
        "Most Corners": ("En çok korner kullanan", "Korner"), "Total Corners": ("Toplam korner", "Korner"),
        "Next Corner, No Corner No Bet (1)": ("İlk korneri kullanan", "Korner"),
        "Most Cards": ("En çok kart gören", "Kart ve penaltı"), "Total Cards": ("Toplam kart", "Kart ve penaltı"),
        "Red Card given": ("Kırmızı kart çıkar mı?", "Kart ve penaltı"), "Penalty Kick awarded": ("Penaltı olur mu?", "Kart ve penaltı"),
        "Most Shots on Target": ("En çok isabetli şut", "Şut ve ofsayt"), "Total Shots": ("Toplam şut", "Şut ve ofsayt"),
        "Total Shots on Target": ("Toplam isabetli şut", "Şut ve ofsayt"), "Total Offsides": ("Toplam ofsayt", "Şut ve ofsayt"),
        "Total Fouls conceded": ("Toplam faul", "Şut ve ofsayt"),
        "Woodwork to be Hit in the Match": ("Direk/üst direk dönen top olur mu?", "Şut ve ofsayt"),
        "Interval Winner": ("Dakika aralığı sonucu", "Zaman aralığı"),
        "To Score": ("Gol atacak oyuncu", "Oyuncu: gol"), "Player To Score": ("Gol atacak oyuncu", "Oyuncu: gol"),
        "First Goal Scorer": ("İlk golü atacak oyuncu", "Oyuncu: gol"), "Last Goal Scorer": ("Son golü atacak oyuncu", "Oyuncu: gol"),
        "To score at least 2 goals": ("En az 2 gol atacak oyuncu", "Oyuncu: gol"),
        "To score at least 3 goals": ("Hat-trick yapacak oyuncu", "Oyuncu: gol"),
        "To score from a header": ("Kafayla gol atacak oyuncu", "Oyuncu: gol"),
        "To score from outside the penalty box": ("Ceza sahası dışından gol atacak oyuncu", "Oyuncu: gol"),
        "Either Player To Score": ("İki oyuncudan biri gol atar", "Oyuncu: gol"),
        "Either Player to Score First": ("İki oyuncudan biri ilk golü atar", "Oyuncu: gol"),
        "To score most goals": ("En çok gol atacak oyuncu", "Oyuncu: gol"),
        "To give an assist": ("Asist yapacak oyuncu", "Oyuncu: şut ve asist"),
        "To score or give an assist": ("Gol veya asist yapacak oyuncu", "Oyuncu: şut ve asist"),
        "Player's shots": ("Oyuncu şut sayısı", "Oyuncu: şut ve asist"),
        "Player's shots on target": ("Oyuncu isabetli şut sayısı", "Oyuncu: şut ve asist"),
        "Player's Shots on Target": ("Oyuncu isabetli şut sayısı", "Oyuncu: şut ve asist"),
        "To have most Shots on Target": ("En çok isabetli şut çekecek oyuncu", "Oyuncu: şut ve asist"),
        "To Get a Card": ("Kart görecek oyuncu", "Oyuncu: kart ve faul"),
        "To Get a Red Card": ("Kırmızı kart görecek oyuncu", "Oyuncu: kart ve faul"),
        "To Score or Get a Card": ("Gol atacak veya kart görecek oyuncu", "Oyuncu: kart ve faul"),
        "Player's fouls conceded": ("Oyuncu faul sayısı", "Oyuncu: kart ve faul"),
        # takım adlı pazarlar
        "{T} to Win and Both Teams To Score": (f"{T} kazanır ve karşılıklı gol", "Kombine"),
        "{T} to Win to Nil": (f"{T} gol yemeden kazanır", "Kombine"),
        "{T} to Win At Least One Half": (f"{T} en az bir yarıyı kazanır", "Yarılar"),
        "{T} given a Red Card": (f"{T} kırmızı kart görür mü?", "Kart ve penaltı"),
        "{T} to score from a penalty": (f"{T} penaltıdan gol atar mı?", "Kart ve penaltı"),
        "{T} to Hit the Woodwork in the Match": (f"{T} direkten döner mi?", "Şut ve ofsayt"),
        "Total Goals by {T}": (f"{T} toplam gol", "Goller"), "Total Goals By {T}": (f"{T} toplam gol", "Goller"),
        "Total Corners by {T}": (f"{T} toplam korner", "Korner"), "Total Corners By {T}": (f"{T} toplam korner", "Korner"),
        "Total Cards - {T}": (f"{T} toplam kart", "Kart ve penaltı"),
        "Total Shots by {T}": (f"{T} toplam şut", "Şut ve ofsayt"),
        "Total Shots on Target by {T}": (f"{T} isabetli şut", "Şut ve ofsayt"),
        "Total Offsides by {T}": (f"{T} ofsayt", "Şut ve ofsayt"),
        "Total Fouls conceded by {T}": (f"{T} faul", "Şut ve ofsayt"),
    }
    title, group = fixed.get(l, (OPTA.sub("", label), "Diğer"))
    if iv:
        group = "Zaman aralığı"
    elif sfx and group in ("Maç", "Goller"):
        group = "Yarılar"
    return title + sfx, group


OUT_TR = {"Over": "Üst", "Under": "Alt", "Yes": "Evet", "No": "Hayır", "No goal": "Gol yok",
          "Same amount of shots on target": "Eşit", "Same amount of goals": "Eşit"}
# modelin hesaplayabildiği pazarlar: (Kambi adı) -> iç anahtar (analiz bu anahtarlarla arar)
KEY = {"Full Time": "who_will_win", "Double Chance": "double_chance", "Both Teams To Score": "both_score",
       "Total Goals": "odds_goals_over_under", "Draw No Bet": "odds_draw_no_bet",
       "First Goal (Draw: No Goals)": "who_will_score_next", "Most Corners": "odds_most_corners",
       "Red Card given": "odds_red_card", "Correct Score": "odds_correct_score"}


def _code(key, o, line):
    lab = o.get("label") or ""
    if key == "who_will_win":
        return {"1": "1", "X": "X", "2": "2"}.get(lab)
    if key == "double_chance":
        return {"1X": "1X", "12": "12", "X2": "X2"}.get(lab)
    if key == "both_score":
        return {"Yes": "btts_yes", "No": "btts_no"}.get(lab)
    if key == "odds_goals_over_under" and line is not None:
        return {"Over": f"o{line:g}", "Under": f"u{line:g}"}.get(lab)
    if key == "odds_draw_no_bet":
        return {"1": "dnb1", "2": "dnb2"}.get(lab)
    if key == "who_will_score_next":
        return {"1": "fts1", "X": "fts0", "2": "fts2"}.get(lab)
    if key == "odds_most_corners":
        return {"1": "cm1", "X": "cmX", "2": "cm2"}.get(lab)
    if key == "odds_red_card":
        return {"Yes": "rc_yes", "No": "rc_no"}.get(lab)
    if key == "odds_correct_score" and re.fullmatch(r"\d+-\d+", lab):
        return "cs:" + lab
    return None


def _sel_label(o, bt, home, away, title):
    """Seçeneğin ekranda görünen adı."""
    lab, line, who = o.get("label") or "", _line(o.get("line")), o.get("participant")
    if bt in ("Player Occurrence Line",):
        if lab == "Over" and line is not None:
            return f"{who} · {int(line) + 1}+"
        return who or lab
    if bt == "Player Occurrence Number":
        return OUT_TR.get(lab, who or lab)
    if bt == "Head to Head":
        return OUT_TR.get(lab, lab.replace(" || ", " veya "))
    if bt in ("Over/Under", "Asian Over/Under"):
        return f"{OUT_TR.get(lab, lab)} {_num(line)}" if line is not None else OUT_TR.get(lab, lab)
    if bt in ("Asian Handicap", "Handicap"):
        return f"{lab} {_signed(line)}" if line is not None else lab
    if bt == "3-Way Handicap":
        return f"{lab} ({_signed(line)})" if line is not None and lab != "X" else (f"X ({_signed(line)})" if line is not None else lab)
    return OUT_TR.get(lab, lab)


def _leg(title, o, home, away):
    """Kombine bahiste tek ayağın kısa adı."""
    lab, line, who = o.get("label") or "", _line(o.get("line")), o.get("participant")
    team = {"1": home, "2": away}
    if title == "Maç sonucu":
        return {"1": "MS 1", "X": "MS X", "2": "MS 2"}.get(lab, lab)
    if title == "Çifte şans":
        return f"ÇŞ {lab}"
    if title == "Karşılıklı gol":
        return "KG " + ("Var" if lab == "Yes" else "Yok")
    if title == "İlk yarı / maç sonucu":
        return f"İY/MS {lab}"
    if title in ("En çok korner kullanan", "En çok kart gören", "En çok isabetli şut"):
        short = {"En çok korner kullanan": "En çok korner", "En çok kart gören": "En çok kart", "En çok isabetli şut": "En çok isabetli şut"}[title]
        return f"{short}: {team.get(lab, 'eşit')}"
    if line is not None and lab in ("Over", "Under") and not who:
        what = title.replace("Toplam gol", "").replace("Toplam ", "").strip()
        return f"{what + ' ' if what else ''}{_num(line)} {OUT_TR[lab]}".strip()
    if who:
        short = {"Gol atacak oyuncu": "gol atar", "İlk golü atacak oyuncu": "ilk golü atar",
                 "En az 2 gol atacak oyuncu": "2+ gol", "Hat-trick yapacak oyuncu": "hat-trick",
                 "Asist yapacak oyuncu": "asist yapar", "Gol veya asist yapacak oyuncu": "gol veya asist",
                 "Kart görecek oyuncu": "kart görür", "Kırmızı kart görecek oyuncu": "kırmızı kart görür",
                 "Kafayla gol atacak oyuncu": "kafayla gol", "Ceza sahası dışından gol atacak oyuncu": "ceza sahası dışından gol"}
        base = title.split(" · ")[0]
        if base in short:
            return f"{who} {short[base]}"
        if lab == "Over" and line is not None:
            what = {"Oyuncu şut sayısı": "şut", "Oyuncu isabetli şut sayısı": "isabetli şut",
                    "Oyuncu faul sayısı": "faul"}.get(base, base)
            return f"{who} {int(line) + 1}+ {what}"
        return f"{who} · {title}"
    return f"{title}: {OUT_TR.get(lab, lab)}"


def _total_code(crit, o, home, away):
    """Takım gol alt/üstü (ho/hu/ao/au) ve toplam korner alt/üstü (co/cu) için iç kod."""
    c = crit.replace(" By ", " by ")
    pref = {f"Total Goals by {home}": "h", f"Total Goals by {away}": "a", "Total Corners": "c"}.get(c)
    line = _line(o.get("line"))
    if not pref or line is None:
        return None
    return {"Over": f"{pref}o{line:g}", "Under": f"{pref}u{line:g}"}.get(o.get("label"))


def _leg_code(code):
    """Kombine ayağı olabilecek kodlar (beraberlikte iade gibi iadeli ayaklar kombine olasılığını bozar)."""
    return code if code and not code.startswith(("fts", "dnb")) else None


def parse_kambi(raw, home, away):
    if not raw or not raw.get("betOffers"):
        return None
    markets, by_title, outs = [], {}, {}
    for b in raw["betOffers"]:
        crit = b["criterion"]["label"]
        bt = b["betOfferType"]["name"]
        title, group = _crit_tr(crit, home, away)
        key = KEY.get(crit)
        line = None
        if key == "odds_goals_over_under":
            line = _line((b["outcomes"] or [{}])[0].get("line"))
        merge = key is None or key not in ("odds_goals_over_under",)
        mk = (title, line) if not merge else (title,)
        m = by_title.get(mk)
        if m is None:
            m = {"key": key or "k:" + crit, "line": line, "title": title if line is None else f"Alt/Üst {line:g} gol",
                 "group": group, "provider": PROVIDER, "selections": []}
            by_title[mk] = m
            markets.append(m)
        opn = [o for o in b["outcomes"] if o.get("status", "OPEN") == "OPEN" and o.get("odds")]
        # marjı temizlenmiş olasılık: yalnızca aynı teklif içindeki 2-3 seçenekli pazarlarda anlamlı
        inv = [1000 / o["odds"] for o in opn]
        tot = sum(inv)
        pairable = 2 <= len(opn) <= 3 and bt not in ("Player Occurrence Line", "Player Occurrence Number", "Head to Head")
        # oyuncu karşılaştırmaları ("A mı B mi daha çok gol atar") tek pazarda toplanınca hangi ikili olduğu yazılmalı
        duo = [o["label"] for o in opn if not o["label"].startswith("Same")] if bt == "Head to Head" and len(opn) > 1 else None
        for o, iv in zip(opn, inv):
            s = {"label": _sel_label(o, bt, home, away, title), "odds": round(o["odds"] / 1000, 2)}
            if duo:
                s["label"] = f"{' – '.join(duo)}: {s['label']}"
            c = _code(key, o, _line(o.get("line")) if key == "odds_goals_over_under" else line) if key else None
            c = c or _total_code(crit, o, home, away)
            if c:
                s["code"] = c
            if pairable and tot:
                s["ip"] = round(iv / tot, 4)
            m["selections"].append(s)
            outs[o["id"]] = (title, o, c)
    ou = re.compile(r"^(Üst|Alt) (\d+(?:\.\d+)?)$")
    for m in markets:
        sels = m["selections"]
        if all(ou.match(s["label"]) for s in sels):  # birleşik alt/üst pazarı: çizgiye göre sırala
            sels.sort(key=lambda s: (float(ou.match(s["label"]).group(2)), s["label"][0] != "Ü"))
        elif not any("ip" in s or " – " in s["label"] for s in sels) and (m["group"].startswith("Oyuncu") or len(sels) > 12):
            sels.sort(key=lambda s: s["odds"])
    markets = [m for m in markets if m["selections"]]

    # hazır kombine bahisler (Bet Builder)
    combos = []
    for p in raw.get("prePacks") or []:
        for ps in p.get("prePackSelections") or []:
            if ps.get("status", "OPEN") != "OPEN":
                continue
            for c in ps.get("combinations") or []:
                ids = [o["id"] for g in c.get("groups") or [] for gg in (g.get("groups") or [g]) for o in gg.get("outcomes") or []]
                legs = [outs.get(i) for i in ids]
                if not ids or any(x is None for x in legs):
                    continue
                odds = (c.get("odds") or {}).get("decimal")
                if not odds:
                    continue
                s = {"label": " + ".join(_leg(t, o, home, away) for t, o, _ in legs), "odds": round(odds / 1000, 2)}
                codes = [_leg_code(k) for _, o, k in legs]
                if all(codes):
                    s["code"] = "&".join(codes)
                combos.append(s)
    if combos:
        uniq = {}
        for s in combos:
            uniq.setdefault(s["label"], s)
        markets.append({"key": "prepack", "line": None, "title": "Hazır kombine bahisler", "group": "Kombine",
                        "provider": PROVIDER, "selections": sorted(uniq.values(), key=lambda s: s["odds"])})
    # "X kazanır ve karşılıklı gol" pazarlarına kod ver
    for m in markets:
        k = m["key"]
        side = "1" if home and home in k else "2"
        combo = {"to Win and Both Teams To Score": f"{side}&btts_yes",
                 "to Win to Nil": f"{side}&{'au' if side == '1' else 'hu'}0.5"}
        for end, code in combo.items():
            if k.startswith("k:") and k.endswith(end):
                for s in m["selections"]:
                    if s["label"] == "Evet":
                        s["code"] = code
    order = {g: i for i, g in enumerate(GROUPS)}
    markets.sort(key=lambda m: order.get(m["group"], 99))
    return markets


async def _kambi_event(src, league_id, kickoff, home, away):
    path = KAMBI_PATH.get(league_id)
    if not path:
        return None
    lst = await src._get(f"{KAMBI}/listView/football/{path}/all/matches.json?{KAMBI_Q}", LIST_TTL)
    try:
        ko = datetime.fromisoformat(kickoff.replace("Z", "+00:00")).timestamp() if kickoff else None
    except ValueError:
        ko = None
    best, best_s = None, 0.0
    for e in (lst or {}).get("events") or []:
        ev = e.get("event") or {}
        same_time = False
        if ko is not None:
            try:
                st = datetime.fromisoformat(ev["start"].replace("Z", "+00:00")).timestamp()
            except (KeyError, ValueError):
                continue
            if abs(st - ko) > 3 * 3600:
                continue
            same_time = abs(st - ko) <= 15 * 60
        sh, sa = _sim(home, ev.get("homeName")), _sim(away, ev.get("awayName"))
        # adlar farklı yazılabilir (Wolves / Wolverhampton Wanderers): saat tutuyorsa takımlardan biri yeter
        s = min(sh, sa) if min(sh, sa) >= 0.55 else (max(sh, sa) - 0.2 if same_time and max(sh, sa) >= 0.75 else 0)
        if s > best_s:
            best, best_s = ev.get("id"), s
    return best if best_s >= 0.55 else None


async def fetch_kambi(src, match_id, home, away, league_id, kickoff):
    key = f"kambi:{match_id}"
    hit = src.store.cache_get(key)
    if hit and time.time() - hit[0] < ODDS_TTL:
        return hit[1]
    eid = await _kambi_event(src, league_id, kickoff, home, away)
    if not eid:
        return None
    raw = await src.fetch_json(f"{KAMBI}/betoffer/event/{eid}.json?{KAMBI_Q}&includeParticipants=true")
    ev = ((raw or {}).get("events") or [{}])[0]  # pazar adlarında Unibet'in takım adları geçer
    markets = parse_kambi(raw, ev.get("homeName") or home, ev.get("awayName") or away)
    res = {"providers": [PROVIDER], "event": eid, "markets": markets} if markets else None
    if res:
        src.store.cache_put(key, res)
    return res


# ---------------------------------------------------------------- FotMob yedeği

FM_TR = {
    "who_will_win": ("Maç sonucu", "Maç"), "double_chance": ("Çifte şans", "Maç"),
    "odds_draw_no_bet": ("Beraberlikte iade", "Maç"), "odds_handicap_x_y": ("Handikaplı maç sonucu", "Handikap"),
    "odds_asian_handicap": ("Asya handikapı", "Handikap"), "who_will_score_next": ("İlk golü atan takım", "Maç"),
    "both_score": ("Karşılıklı gol", "Goller"), "odds_goals_over_under": ("Alt/Üst", "Goller"),
    "odds_total_goals_oddeven": ("Toplam gol tek/çift", "Goller"), "odds_correct_score": ("Skor", "Skor"),
    "odds_first_goal_method": ("İlk golün türü", "Goller"), "odds_hub_firsthalf": ("İlk yarı sonucu", "Yarılar"),
    "odds_both_team_scores_firsthalf": ("İlk yarıda karşılıklı gol", "Yarılar"),
    "odds_both_team_scores_secondhalf": ("İkinci yarıda karşılıklı gol", "Yarılar"),
    "odds_most_corners": ("En çok korner kullanan", "Korner"), "odds_time_of_first_corner": ("İlk korner zamanı", "Korner"),
    "odds_red_card": ("Kırmızı kart çıkar mı?", "Kart ve penaltı"),
    "odds_a_penalty_in_the_match": ("Maçta penaltı olur mu?", "Kart ve penaltı"),
    "odds_player_to_be_booked": ("Kart görecek oyuncu", "Oyuncu: kart ve faul"),
    "odds_scores_goal": ("Gol atacak oyuncu", "Oyuncu: gol"), "odds_scores_x_or_more_goals": ("2 veya daha fazla gol atacak oyuncu", "Oyuncu: gol"),
    "odds_scores_hattrick": ("Hat-trick yapacak oyuncu", "Oyuncu: gol"), "odds_nth_goalscorer": ("İlk golü atacak oyuncu", "Oyuncu: gol"),
    "odds_last_goalscorer": ("Son golü atacak oyuncu", "Oyuncu: gol"),
}
FM_SEL = {"x": "X", "yes": "Evet", "no": "Hayır", "over": "Üst", "under": "Alt", "odd": "Tek", "even": "Çift",
          "shot": "Şut", "header": "Kafa", "penalty": "Penaltı", "free kick": "Serbest vuruş", "own goal": "Kendi kalesine",
          "no goal": "Gol yok", "corner before 8:00": "8. dakikadan önce korner var",
          "no corner before 8:00": "8. dakikadan önce korner yok", "2x": "X2"}


def _fm_code(key, low, line, name, home, away):
    if key == "who_will_win":
        return {"1": "1", "x": "X", "2": "2"}.get(low)
    if key == "double_chance":
        return {"1x": "1X", "12": "12", "2x": "X2", "x2": "X2"}.get(low)
    if key == "both_score":
        return {"yes": "btts_yes", "no": "btts_no"}.get(low)
    if key == "odds_goals_over_under" and line is not None:
        return {"over": f"o{line:g}", "under": f"u{line:g}"}.get(low)
    if key == "odds_total_goals_oddeven":
        return {"odd": "odd", "even": "even"}.get(low)
    if key == "odds_draw_no_bet":
        return "dnb1" if name == home else "dnb2" if name == away else None
    if key == "who_will_score_next":
        return {"1": "fts1", "x": "fts0", "2": "fts2"}.get(low)
    if key == "odds_most_corners":
        return {"1": "cm1", "x": "cmX", "2": "cm2"}.get(low)
    if key == "odds_red_card":
        return {"yes": "rc_yes", "no": "rc_no"}.get(low)
    if key == "odds_time_of_first_corner":
        return {"corner before 8:00": "fc8_yes", "no corner before 8:00": "fc8_no"}.get(low)
    if key == "odds_correct_score" and re.fullmatch(r"\d+-\d+", name):
        return "cs:" + name
    return None


def parse_fotmob(raw, home, away):
    out = []
    if not raw or not raw.get("odds"):
        return out
    provider = (raw.get("persistentKey") or "").split("_")[0]
    for cat in raw["odds"].get("oddsTabMarkets") or []:
        for m in cat.get("markets") or []:
            key = m.get("headerTranslationKey") or m.get("header")
            header = m.get("header") or ""
            line = None
            if key == "odds_goals_over_under":
                mm = re.search(r"(\d+(?:\.\d+)?)", header)
                line = float(mm.group(1)) if mm else None
            title, group = FM_TR.get(key, (header, "Diğer"))
            if line is not None:
                title = f"Alt/Üst {line:g} gol"
            sels = []
            for s in m.get("selections") or []:
                odds = _f(s.get("oddsDecimal"))
                name = (s.get("name") or "").strip()
                if not odds or not name:
                    continue
                low = name.lower()
                label = FM_SEL.get(low, name)
                if key == "both_score":
                    label = {"yes": "Var", "no": "Yok"}.get(low, label)
                code = _fm_code(key, low, line, name, home, away)
                if key == "odds_correct_score" and not code:
                    continue
                sel = {"label": label, "odds": odds}
                if code:
                    sel["code"] = code
                sels.append(sel)
            if sels:
                out.append({"key": key, "line": line, "title": title, "group": group, "provider": provider, "selections": sels})
    return out


async def fetch_fotmob(src, match_id, home, away):
    async def one(cc):
        try:
            return await src._get(f"{FOTMOB}/matchOdds?matchId={match_id}&ccode3={cc}", ODDS_TTL)
        except Exception as e:  # noqa: BLE001
            log.debug("oran alınamadı %s %s: %s", match_id, cc, e)
            return None
    raws = await asyncio.gather(*[one(cc) for cc in REGIONS])
    best = max((parse_fotmob(r, home, away) for r in raws), key=len, default=[])
    if not best:
        return None
    return {"providers": [best[0]["provider"]], "markets": best}


async def fetch(src, match_id, home, away, league_id=None, kickoff=None):
    """Tek sağlayıcıdan tüm pazarlar: önce Unibet, maç orada yoksa FotMob'daki en geniş sağlayıcı."""
    try:
        res = await fetch_kambi(src, match_id, home, away, league_id, kickoff)
        if res:
            return res
    except Exception as e:  # noqa: BLE001
        log.warning("Unibet oranları alınamadı %s: %s", match_id, e)
    return await fetch_fotmob(src, match_id, home, away)
