"""FotMob ham verisinden maç paketi (bundle) oluşturur."""
import asyncio
import re
import hashlib
import json
import logging
import time
import urllib.parse
from datetime import datetime, timezone

from . import analysis
from . import odds as odds_mod
from .config import NEWS_TTL, SEASON_TTL
from .sources import FOTMOB, PLAYER_STATS, TEAM_STATS

log = logging.getLogger("collect")

# FotMob maç istatistiği başlığı -> iç anahtar
STAT_KEYS = {
    "Ball possession": "possession",
    "Expected goals (xG)": "xg",
    "Total shots": "shots",
    "Shots on target": "sot",
    "Shots off target": "shots_off",
    "Blocked shots": "shots_blocked",
    "Shots inside box": "shots_in",
    "Shots outside box": "shots_out",
    "Big chances": "big_chances",
    "Big chances missed": "big_missed",
    "Corners": "corners",
    "xG open play": "xg_open",
    "xG set play": "xg_set",
    "xG on target (xGOT)": "xgot",
    "Touches in opposition box": "box_touches",
    "Passes": "passes",
    "Accurate passes": "passes_acc",
    "Accurate long balls": "long_balls",
    "Accurate crosses": "crosses",
    "Offsides": "offsides",
    "Tackles": "tackles",
    "Interceptions": "interceptions",
    "Blocks": "blocks",
    "Clearances": "clearances",
    "Keeper saves": "saves",
    "Duels won": "duels",
    "Ground duels won": "ground_duels",
    "Aerial duels won": "aerials",
    "Successful dribbles": "dribbles",
    "Fouls committed": "fouls",
    "Yellow cards": "yellow",
    "Red cards": "red",
    "Distance covered": "distance",
    "Number of sprints": "sprints",
}

_season_memo = {}

# Analiz/paket biçimi değişince artırılır; eski sürümle üretilmiş paketler yeniden oluşturulur
BUNDLE_VERSION = 11


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().split(" ")[0].replace("%", "")
    try:
        return float(s)
    except ValueError:
        return None


def match_team_stats(md):
    home, away = {}, {}
    try:
        groups = md["content"]["stats"]["Periods"]["All"]["stats"]
    except (KeyError, TypeError):
        return home, away
    for g in groups or []:
        for st in g.get("stats") or []:
            key = STAT_KEYS.get(st.get("title"))
            vals = st.get("stats") or []
            if not key or len(vals) < 2:
                continue
            h, a = _num(vals[0]), _num(vals[1])
            if h is None and a is None:
                continue
            home.setdefault(key, h)
            away.setdefault(key, a)
    return home, away


def _mean(values):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


async def team_recent(src, team_id, form_items):
    """Takımın son maçlarının (FotMob form listesi) detaylı istatistikleri."""
    ids = []
    for it in form_items or []:
        link = it.get("linkToMatch") or ""
        if "#" in link:
            try:
                ids.append(int(link.split("#")[1]))
            except ValueError:
                pass
    results = await asyncio.gather(
        *[src.match_details(i, None) for i in ids], return_exceptions=True
    )
    rows = []
    for mid, md in zip(ids, results):
        if isinstance(md, Exception) or not md:
            continue
        gen = md.get("general", {})
        teams = md.get("header", {}).get("teams") or [{}, {}]
        is_home = gen.get("homeTeam", {}).get("id") == team_id
        hs, as_ = match_team_stats(md)
        me, opp = (hs, as_) if is_home else (as_, hs)
        my_t, op_t = (teams[0], teams[1]) if is_home else (teams[1], teams[0])
        gf, ga = my_t.get("score"), op_t.get("score")
        res = None
        if gf is not None and ga is not None:
            res = "G" if gf > ga else ("B" if gf == ga else "M")
        rows.append({
            "match_id": mid,
            "date": gen.get("matchTimeUTCDate"),
            "comp": gen.get("leagueName"),
            "opponent": op_t.get("name"),
            "home": is_home,
            "gf": gf, "ga": ga, "result": res,
            "for": me, "against": opp,
        })
    rows.sort(key=lambda r: r["date"] or "", reverse=True)
    keys = set()
    for r in rows:
        keys |= set(r["for"]) | set(r["against"])
    avg_for = {k: _mean([r["for"].get(k) for r in rows]) for k in keys}
    avg_against = {k: _mean([r["against"].get(k) for r in rows]) for k in keys}
    avg_for["goals"] = _mean([r["gf"] for r in rows])
    avg_against["goals"] = _mean([r["ga"] for r in rows])
    return {
        "rows": rows,
        "n": len(rows),
        "n_stats": sum(1 for r in rows if r["for"]),
        "avg_for": avg_for,
        "avg_against": avg_against,
        "form": "".join(r["result"] or "-" for r in rows),
        "points": sum({"G": 3, "B": 1}.get(r["result"], 0) for r in rows),
    }


def _per_match(title, value, matches):
    t = (title or "").lower()
    if any(w in t for w in ("per match", "average", "rating", "possession", "value")):
        return value
    return round(value / matches, 2) if matches else value


async def season_stats(src, league_id):
    memo = _season_memo.get(league_id)
    if memo and time.time() - memo[0] < 600:
        return memo[1]
    lg = await src.league(league_id, SEASON_TTL)
    stats = lg.get("stats") or {}
    team_urls = {t["name"]: t["fetchAllUrl"] for t in stats.get("teams") or [] if t.get("name") in TEAM_STATS}
    player_urls = {p["name"]: p["fetchAllUrl"] for p in stats.get("players") or [] if p.get("name") in PLAYER_STATS}
    names = list(team_urls) + list(player_urls)
    files = await asyncio.gather(
        *[src.stat_file((team_urls | player_urls)[n], SEASON_TTL) for n in names],
        return_exceptions=True,
    )
    teams, players = {}, {}
    for name, data in zip(names, files):
        if isinstance(data, Exception) or not data:
            continue
        try:
            tl = data["TopLists"][0]
        except (KeyError, IndexError, TypeError):
            continue
        lst = tl.get("StatList") or []
        if name in team_urls:
            for e in lst:
                tid = e.get("TeamId")
                teams.setdefault(tid, {})[name] = {
                    "title": tl.get("Title"),
                    "value": e.get("StatValue"),
                    "per_match": _per_match(tl.get("Title"), e.get("StatValue") or 0, e.get("MatchesPlayed")),
                    "rank": e.get("Rank"),
                    "of": len(lst),
                    "matches": e.get("MatchesPlayed"),
                }
        else:
            for e in lst:
                tid = e.get("TeamId")
                bucket = players.setdefault(tid, {}).setdefault(name, {"title": tl.get("Title"), "list": []})
                if len(bucket["list"]) < 3:
                    bucket["list"].append({
                        "name": e.get("ParticipantName"),
                        "id": e.get("ParticiantId"),
                        "value": e.get("StatValue"),
                        "sub": e.get("SubStatValue"),
                        "matches": e.get("MatchesPlayed"),
                        "minutes": e.get("MinutesPlayed"),
                        "rank": e.get("Rank"),
                    })
    table = {}
    try:
        for block in lg.get("table") or []:
            data = block.get("data", {})
            tbl = data.get("table", {}).get("all") or []
            if not tbl:
                continue
            # puan durumu bölgeleri (ŞL, Avrupa, küme düşme) ve yarış bağlamı
            zones = {}
            for z in data.get("legend") or []:
                for i in z.get("indices") or []:
                    zones[i] = z.get("tKey") or z.get("title")
            by_pos = sorted(tbl, key=lambda r: r.get("idx") or 99)
            leader_pts = by_pos[0].get("pts")
            second_pts = by_pos[1].get("pts") if len(by_pos) > 1 else None
            rel = sorted(i for i, z in zones.items() if z == "relegation")
            safe_pts = by_pos[rel[0] - 1].get("pts") if rel and rel[0] >= 1 else None   # düşme hattının hemen üstü
            first_rel_pts = by_pos[rel[0]].get("pts") if rel else None
            for row in tbl:
                idx = (row.get("idx") or 0) - 1
                table[row["id"]] = {
                    "pos": row.get("idx"), "played": row.get("played"), "pts": row.get("pts"),
                    "w": row.get("wins"), "d": row.get("draws"), "l": row.get("losses"),
                    "goals": row.get("scoresStr"), "of": len(tbl),
                    "zone": zones.get(idx), "leader_pts": leader_pts, "second_pts": second_pts,
                    "safe_pts": safe_pts, "first_rel_pts": first_rel_pts, "league_id": data.get("leagueId"),
                }
    except (AttributeError, KeyError, TypeError):
        pass
    result = {
        "teams": teams, "players": players, "table": table,
        "provider": (lg.get("details") or {}).get("dataProvider"),
        "league_name": (lg.get("details") or {}).get("name"),
    }
    _season_memo[league_id] = (time.time(), result)
    return result


def parse_lineup(lu):
    if not lu or not lu.get("homeTeam"):
        return None

    def player(p):
        lay = p.get("verticalLayout") or {}
        un = p.get("unavailability") or {}
        return {
            "id": p.get("id"),
            "name": p.get("name"),
            "last": p.get("lastName") or p.get("name"),
            "shirt": p.get("shirtNumber"),
            "x": lay.get("x"), "y": lay.get("y"),
            "rating": (p.get("performance") or {}).get("seasonRating"),
            "value": p.get("marketValue"),
            "age": p.get("age"),
            "country": p.get("countryName"),
            "cc": p.get("countryCode"),
            "type": un.get("type"),
            "return": analysis.tr_return(un.get("expectedReturn")),
        }

    def side(t):
        return {
            "name": t.get("name"),
            "formation": t.get("formation"),
            "coach": (t.get("coach") or {}).get("name"),
            "starters": [player(p) for p in t.get("starters") or []],
            "subs": [player(p) for p in t.get("subs") or []],
            "unavailable": [player(p) for p in t.get("unavailable") or []],
            "avg_age": t.get("averageStarterAge"),
            "value": t.get("totalStarterMarketValue"),
        }

    t = lu.get("lineupType")
    return {
        "type": t,
        "confirmed": t not in ("predicted", "lastStarting11", None),
        "home": side(lu["homeTeam"]),
        "away": side(lu["awayTeam"]),
    }


def parse_h2h(h2h):
    if not h2h:
        return None
    out = []
    for m in h2h.get("matches") or []:
        st = m.get("status") or {}
        if not st.get("finished"):
            continue
        out.append({
            "date": (m.get("time") or {}).get("utcTime"),
            "home": (m.get("home") or {}).get("name"),
            "away": (m.get("away") or {}).get("name"),
            "score": st.get("scoreStr"),
            "league": (m.get("league") or {}).get("name"),
        })
    return {"summary": h2h.get("summary"), "matches": out[:6]}


async def team_streaks(src, team_id, before_utc):
    """Takımın tüm kulvarlardaki son maçları (en yenisi önce) ve serileri. FotMob takım fikstürü kullanılır."""
    key = f"teamfx:{team_id}"
    hit = src.store.cache_get(key)
    if hit and time.time() - hit[0] < SEASON_TTL:
        allres = hit[1]
    else:
        try:  # ham takım verisi çok büyük: önbelleğe sadece bitmiş maçların özeti yazılır
            data = await src.fetch_json(f"{FOTMOB}/teams?id={team_id}")
        except Exception as e:  # noqa: BLE001
            log.warning("takım fikstürü alınamadı %s: %s", team_id, e)
            if not hit:
                return None
            data = None
        if data is not None:
            fx = ((data.get("fixtures") or {}).get("allFixtures") or {}).get("fixtures") or []
            allres = []
            for f in fx:
                st = f.get("status") or {}
                if not st.get("finished") or st.get("cancelled"):
                    continue
                home, away = f.get("home") or {}, f.get("away") or {}
                mine, opp = (home, away) if home.get("id") == team_id else (away, home)
                gf, ga = mine.get("score"), opp.get("score")
                if gf is None or ga is None:
                    continue
                allres.append({"date": st.get("utcTime"), "opp": opp.get("name"), "gf": gf, "ga": ga,
                               "r": "G" if gf > ga else ("B" if gf == ga else "M"),
                               "comp": (f.get("tournament") or {}).get("name")})
            src.store.cache_put(key, allres)
        else:
            allres = hit[1]
    res = [r for r in allres if not before_utc or (r["date"] or "") < before_utc]
    res.sort(key=lambda r: r["date"] or "", reverse=True)

    def run(cond):
        n = 0
        for r in res:
            if not cond(r):
                break
            n += 1
        return n

    return {
        "last": res[:10],
        "unbeaten": run(lambda r: r["r"] != "M"), "wins": run(lambda r: r["r"] == "G"),
        "losses": run(lambda r: r["r"] == "M"), "winless": run(lambda r: r["r"] != "G"),
        "scoring": run(lambda r: r["gf"] > 0), "conceding": run(lambda r: r["ga"] > 0),
        "clean_last5": sum(1 for r in res[:5] if r["ga"] == 0),
        "home_away": None,
    }


OTHER_SPORTS = re.compile(r"basketbol|basket|voleybol|hentbol|euroleague|eurocup|potada|file[nl]|smaç|ribaund|"
                          r"kadın (futbol|voleybol|basketbol)|e-?spor|futsal|plaj futbolu", re.I)


def _about(title, name):
    """Başlık takımla ilgili mi: takım adı ya da adın ayırt edici bir parçası geçmeli."""
    t = (title or "").lower()
    parts = [w for w in re.split(r"[\s.\-]+", (name or "").lower()) if len(w) >= 4 and w not in ("united", "city", "club")]
    return (name or "").lower() in t or any(w in t for w in parts)


async def team_news(src, team_id, name):
    fm, tr = await asyncio.gather(
        src.fotmob_team_news(team_id, NEWS_TTL),
        src.google_news(f'"{name}" -basketbol -voleybol -hentbol', NEWS_TTL),
    )
    # başka branşların (basketbol, voleybol...) haberleri ve takımla ilgisi olmayan genel FotMob haberleri ayıklanır
    tr = [n for n in tr if not OTHER_SPORTS.search(n.get("title") or "")]
    fm = [n for n in fm if _about(n.get("title"), name) and not OTHER_SPORTS.search(n.get("title") or "")]
    return {"tr": tr, "fotmob": fm}


def referee_stats(ref):
    """Hakemin bu ligdeki sezon istatistikleri (FotMob): maç, maç başı sarı kart (lig ortalamasıyla), kırmızı, penaltı, faul."""
    out = {}
    for s in (ref or {}).get("stats") or []:
        t = s.get("type")
        if t == "matches":
            out["matches"] = s.get("value")
        elif t == "yellowCards":
            out["yellow_pm"], out["yellow_avg"] = s.get("value"), s.get("average")
        elif t == "redCards":
            out["red"] = s.get("value")
        elif t == "penalties":
            out["pens"] = s.get("value")
        elif t == "fouls":
            out["fouls_pm"], out["fouls_avg"] = s.get("value"), s.get("average")
    if out.get("matches") and out.get("pens") is not None:
        out["pens_pm"] = round(out["pens"] / out["matches"], 2)
    return out or None


def carry_open_odds(new, prev):
    """Oran hareketi için her seçeneğin ilk görülen (açılış) oranı "o0" olarak taşınır."""
    if not new:
        return new
    old = {}
    for m in (prev or {}).get("markets") or []:
        for s in m["selections"]:
            old[(m["key"], m.get("line"), s["label"])] = s.get("o0") or s["odds"]
    for m in new.get("markets") or []:
        for s in m["selections"]:
            s["o0"] = old.get((m["key"], m.get("line"), s["label"]), s["odds"])
    return new


async def build_bundle(src, match_id, prev_odds=None):
    md = await src.match_details(match_id, 30)
    gen = md.get("general") or {}
    header = md.get("header") or {}
    content = md.get("content") or {}
    facts = content.get("matchFacts") or {}
    teams = header.get("teams") or [{}, {}]
    home, away = teams[0], teams[1]
    hid, aid = home.get("id"), away.get("id")
    form = facts.get("teamForm") or [[], []]
    league_id = gen.get("parentLeagueId") or gen.get("leagueId")

    async def safe_season():
        try:
            return await season_stats(src, league_id)
        except Exception as e:  # noqa: BLE001
            log.warning("sezon istatistiği alınamadı %s: %s", league_id, e)
            return {"teams": {}, "players": {}, "table": {}}

    started = (header.get("status") or {}).get("started")

    async def safe_odds():
        # maç başlayınca canlı oranlar değil, maç öncesi son oranlar kullanılır
        if started:
            return prev_odds
        try:
            return carry_open_odds(await odds_mod.fetch(src, match_id, home.get("name"), away.get("name"), league_id, kickoff), prev_odds)
        except Exception as e:  # noqa: BLE001
            log.warning("oranlar alınamadı %s: %s", match_id, e)
            return prev_odds

    kickoff = gen.get("matchTimeUTCDate") or (header.get("status") or {}).get("utcTime")
    rec_h, rec_a, season, news_h, news_a, odds, str_h, str_a = await asyncio.gather(
        team_recent(src, hid, form[0] if len(form) > 0 else []),
        team_recent(src, aid, form[1] if len(form) > 1 else []),
        safe_season(),
        team_news(src, hid, home.get("name")),
        team_news(src, aid, away.get("name")),
        safe_odds(),
        team_streaks(src, hid, kickoff),
        team_streaks(src, aid, kickoff),
    )
    # maç bittiyse / sürüyorsa: karnedeki korner ve kart tercihlerini değerlendirmek için maç istatistikleri
    fin_h, fin_a = match_team_stats(md)
    hs_ = header.get("status") or {}
    final = {
        "corners": [fin_h.get("corners"), fin_a.get("corners")],
        "yellow": [fin_h.get("yellow"), fin_a.get("yellow")],
        "red": [hs_.get("numberOfHomeRedCards") or 0, hs_.get("numberOfAwayRedCards") or 0],
    } if hs_.get("started") else None
    info = facts.get("infoBox") or {}
    status = header.get("status") or {}
    stadium = info.get("Stadium") or {}
    q = urllib.parse.quote_plus(f"{home.get('name')} {away.get('name')}")
    b = {
        "v": BUNDLE_VERSION,
        "id": match_id,
        "league_id": league_id,
        "league_name": gen.get("leagueName"),
        "round": gen.get("leagueRoundName"),
        "utc": gen.get("matchTimeUTCDate") or status.get("utcTime"),
        "status": {
            "started": status.get("started"),
            "finished": status.get("finished"),
            "cancelled": status.get("cancelled"),
            "live": (status.get("liveTime") or {}).get("short"),
            "score": status.get("scoreStr"),
            "reason": (status.get("reason") or {}).get("short"),
        },
        "home": {"id": hid, "name": home.get("name"), "score": home.get("score"), "logo": home.get("imageUrl")},
        "away": {"id": aid, "name": away.get("name"), "score": away.get("score"), "logo": away.get("imageUrl")},
        "venue": ", ".join(x for x in [stadium.get("name"), stadium.get("city")] if x),
        "referee": (info.get("Referee") or {}).get("text"),
        "referee_stats": referee_stats(info.get("Referee")),
        # maç sayfası üst bölümünün arka planı için takım renkleri (karanlık tema)
        "colors": ((gen.get("teamColors") or {}).get("darkMode") or None),
        "weather": content.get("weather"),
        "lineup": parse_lineup(content.get("lineup")),
        "recent": {"home": rec_h, "away": rec_a},
        "season": {
            "home": season["teams"].get(hid, {}),
            "away": season["teams"].get(aid, {}),
            "players_home": season["players"].get(hid, {}),
            "players_away": season["players"].get(aid, {}),
            "table_home": season["table"].get(hid),
            "table_away": season["table"].get(aid),
            "provider": season.get("provider"),
            "league_name": season.get("league_name"),
        },
        "h2h": parse_h2h(content.get("h2h")),
        "insights": [i.get("text") for i in (facts.get("insights") or []) if i.get("text")][:10],
        "preview": [
            {"title": p.get("title"), "description": p.get("description"),
             "link": ("https://www.fotmob.com" + p["page"]["url"]) if (p.get("page") or {}).get("url", "").startswith("/") else (p.get("page") or {}).get("url"),
             "time": p.get("dateUpdated")}
            for p in (facts.get("preReview") or [])
        ],
        "news": {"home": news_h, "away": news_a},
        "odds": odds,
        "streaks": {"home": str_h, "away": str_a},
        "final": final,
        "links": {
            "fotmob": f"https://www.fotmob.com/match/{match_id}",
            "mackolik": f"https://www.google.com/search?q=site%3Amackolik.com+{q}",
            "sofascore": f"https://www.google.com/search?q=site%3Asofascore.com+{q}",
        },
        "updated": datetime.now(timezone.utc).isoformat(),
    }
    b["analysis"] = analysis.build(b)
    return b


def signature(b):
    lu = b.get("lineup") or {}
    parts = {
        "type": lu.get("type"),
        "st": [[p["id"] for p in (lu.get(s) or {}).get("starters", [])] for s in ("home", "away")],
        "un": [[p["name"] for p in (lu.get(s) or {}).get("unavailable", [])] for s in ("home", "away")],
        "news": [n["title"] for s in ("home", "away") for n in b["news"][s]["tr"][:3]],
        "score": [b["home"]["score"], b["away"]["score"]],
        "status": b["status"],
    }
    return hashlib.sha1(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
