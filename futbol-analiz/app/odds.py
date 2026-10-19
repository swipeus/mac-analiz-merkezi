"""Bahis oranları: FotMob'un farklı bölgelerdeki bahis şirketlerinden oranları toplar ve tek listede birleştirir.

Bölge -> sağlayıcı (FotMob ülkeye göre seçiyor):
  ESP -> bet365 (en geniş: ~22 pazar), MEX -> 1xBet (alt/üst 2.5-4.5, çifte şans, skor), SWE -> ComeOn (alt/üst 3.5-5.5)
Aynı pazar birden çok sağlayıcıda varsa listedeki ilk sağlayıcınınki kullanılır.
"""
import asyncio
import logging
import re

from .sources import FOTMOB

log = logging.getLogger("odds")

REGIONS = ["ESP", "MEX", "SWE"]
ODDS_TTL = 15 * 60

MARKET_TR = {
    "who_will_win": ("Maç sonucu", "Maç"), "double_chance": ("Çifte şans", "Maç"),
    "odds_draw_no_bet": ("Beraberlikte iade", "Maç"), "odds_handicap_x_y": ("Handikaplı maç sonucu", "Maç"),
    "odds_asian_handicap": ("Asya handikapı", "Maç"), "who_will_score_next": ("İlk golü atan takım", "Maç"),
    "both_score": ("Karşılıklı gol", "Goller"), "odds_goals_over_under": ("Alt/Üst", "Goller"),
    "odds_total_goals_oddeven": ("Toplam gol tek/çift", "Goller"), "odds_correct_score": ("Skor", "Skor"),
    "odds_first_goal_method": ("İlk golün türü", "Goller"),
    "odds_hub_firsthalf": ("İlk yarı sonucu", "Yarılar"),
    "odds_both_team_scores_firsthalf": ("İlk yarıda karşılıklı gol", "Yarılar"),
    "odds_both_team_scores_secondhalf": ("İkinci yarıda karşılıklı gol", "Yarılar"),
    "odds_most_corners": ("En çok korner kullanan", "Korner"), "odds_time_of_first_corner": ("İlk korner zamanı", "Korner"),
    "odds_red_card": ("Kırmızı kart çıkar mı?", "Kart ve penaltı"),
    "odds_a_penalty_in_the_match": ("Maçta penaltı olur mu?", "Kart ve penaltı"),
    "odds_player_to_be_booked": ("Kart görecek oyuncu", "Kart ve penaltı"),
    "odds_scores_goal": ("Gol atacak oyuncu", "Oyuncular"), "odds_scores_x_or_more_goals": ("2 veya daha fazla gol atacak oyuncu", "Oyuncular"),
    "odds_scores_hattrick": ("Hat-trick yapacak oyuncu", "Oyuncular"), "odds_nth_goalscorer": ("İlk golü atacak oyuncu", "Oyuncular"),
    "odds_last_goalscorer": ("Son golü atacak oyuncu", "Oyuncular"),
}
SEL_TR = {"x": "X", "yes": "Evet", "no": "Hayır", "over": "Üst", "under": "Alt", "odd": "Tek", "even": "Çift",
          "shot": "Şut", "header": "Kafa", "penalty": "Penaltı", "free kick": "Serbest vuruş", "own goal": "Kendi kalesine",
          "no goal": "Gol yok", "corner before 8:00": "8. dakikadan önce korner var",
          "no corner before 8:00": "8. dakikadan önce korner yok", "2x": "X2"}


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(raw, home, away):
    """FotMob matchOdds yanıtını [{key, line, title, group, provider, selections:[{name, label, odds, code}]}] yapar."""
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
            title, group = MARKET_TR.get(key, (header, "Diğer"))
            if line is not None:
                title = f"Alt/Üst {line:g} gol"
            sels = []
            for s in m.get("selections") or []:
                odds = _f(s.get("oddsDecimal"))
                name = (s.get("name") or "").strip()
                if not odds or not name:
                    continue
                low = name.lower()
                label = SEL_TR.get(low, name)
                if key == "both_score":
                    label = {"yes": "Var", "no": "Yok"}.get(low, label)
                code = _code(key, low, line, name, home, away)
                if key == "odds_correct_score" and not code:
                    continue  # bazı sağlayıcılar skor adlarını bozuk veriyor
                sels.append({"name": name, "label": label, "odds": odds, "code": code})
            if sels:
                out.append({"key": key, "line": line, "title": title, "group": group, "provider": provider, "selections": sels})
    return out


def _code(key, low, line, name, home, away):
    """Modelin olasılık hesaplayabildiği seçeneklere iç kod verir."""
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
        if name == home:
            return "dnb1"
        if name == away:
            return "dnb2"
    if key == "who_will_score_next":
        return {"1": "fts1", "x": "fts0", "2": "fts2"}.get(low)
    if key == "odds_most_corners":
        return {"1": "cm1", "x": "cmX", "2": "cm2"}.get(low)
    if key == "odds_correct_score" and re.fullmatch(r"\d+-\d+", name):
        return "cs:" + name
    return None


async def fetch(src, match_id, home, away):
    """Tüm bölgelerden oranları çeker ve birleştirir; hiç oran yoksa None."""
    async def one(cc):
        try:
            return await src._get(f"{FOTMOB}/matchOdds?matchId={match_id}&ccode3={cc}", ODDS_TTL)
        except Exception as e:  # noqa: BLE001
            log.debug("oran alınamadı %s %s: %s", match_id, cc, e)
            return None
    raws = await asyncio.gather(*[one(cc) for cc in REGIONS])
    merged, seen, providers = [], set(), []
    for raw in raws:
        mk = parse(raw, home, away)
        added = False
        for m in mk:
            k = (m["key"], m["line"])
            if k in seen:
                continue
            seen.add(k)
            merged.append(m)
            added = True
        if added:
            providers.append(mk[0]["provider"])
    if not merged:
        return None
    return {"providers": providers, "markets": merged}


def implied(market):
    """Pazar içindeki oranlardan marjı temizlenmiş olasılıklar (oyuncu/skor gibi çok seçenekli pazarlarda kullanılmaz)."""
    inv = [1 / s["odds"] for s in market["selections"]]
    tot = sum(inv) or 1
    return [x / tot for x in inv]
