"""Dış veri kaynakları: FotMob (Opta verisi) ve Google News (Türkçe haberler)."""
import asyncio
import email.utils
import logging
import time
import urllib.parse
import xml.etree.ElementTree as ET

import httpx

log = logging.getLogger("sources")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "application/json, text/xml, */*",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
}
FOTMOB = "https://www.fotmob.com/api/data"

# Sezon istatistiklerinden çekilecek takım ve oyuncu listeleri
TEAM_STATS = [
    "expected_goals_team", "expected_goals_conceded_team", "goals_team_match",
    "goals_conceded_team_match", "possession_percentage_team", "corner_taken_team",
    "ontarget_scoring_att_team", "big_chance_team", "touches_in_opp_box_team",
    "poss_won_att_3rd_team", "total_tackle_team", "interception_team",
    "effective_clearance_team", "clean_sheet_team", "accurate_long_balls_team",
    "accurate_cross_team", "_set_piece_goals_team", "_set_piece_goals_conceded_team",
    "saves_team", "fk_foul_lost_team", "total_yel_card_team", "total_red_card_team", "rating_team",
]
PLAYER_STATS = [
    "goals", "expected_goals", "total_scoring_att", "ontarget_scoring_att",
    "big_chance_created", "expected_assists", "defensive_contributions", "rating",
]


class Sources:
    def __init__(self, store):
        self.store = store
        self.client = httpx.AsyncClient(headers=HEADERS, timeout=30, follow_redirects=True)
        self.sem = asyncio.Semaphore(4)

    async def close(self):
        await self.client.aclose()

    async def _get(self, url, ttl, kind="json", key=None):
        """ttl=None -> kalıcı (bitmiş maçlar). Hata olursa eski kopya döner."""
        key = key or url
        hit = self.store.cache_get(key)
        if hit and (ttl is None or time.time() - hit[0] < ttl):
            return hit[1]
        try:
            async with self.sem:
                r = await self.client.get(url)
                r.raise_for_status()
                data = r.json() if kind == "json" else r.text
                await asyncio.sleep(0.2)
            self.store.cache_put(key, data)
            return data
        except Exception as e:  # noqa: BLE001
            log.warning("istek başarısız %s: %s", url, e)
            if hit:
                return hit[1]
            raise

    async def fetch_json(self, url):
        """Önbelleğe yazmadan tek istek (büyük ham oyuncu verisi için; özet ayrıca saklanır)."""
        async with self.sem:
            r = await self.client.get(url)
            r.raise_for_status()
            data = r.json()
            await asyncio.sleep(0.2)
        return data

    # --- FotMob ---
    async def day_matches(self, yyyymmdd, ttl):
        url = f"{FOTMOB}/matches?date={yyyymmdd}&timezone=Europe%2FIstanbul&ccode3=TUR"
        return await self._get(url, ttl)

    async def match_details(self, match_id, ttl):
        return await self._get(f"{FOTMOB}/matchDetails?matchId={match_id}", ttl)

    async def league(self, league_id, ttl):
        data = await self._get(f"{FOTMOB}/leagues?id={league_id}", ttl, key=f"league:{league_id}")
        return data

    async def stat_file(self, url, ttl):
        return await self._get(url, ttl)

    async def fotmob_team_news(self, team_id, ttl):
        url = f"{FOTMOB}/tlnews?id={team_id}&type=team&language=tr&startIndex=0"
        try:
            data = await self._get(url, ttl)
        except Exception:  # noqa: BLE001
            return []
        out = []
        for n in (data or {}).get("data", [])[:6]:
            link = n.get("page", {}).get("url") or n.get("shareUrl") or ""
            if link.startswith("/"):
                link = "https://www.fotmob.com" + link
            out.append({
                "title": n.get("title"),
                "link": link,
                "source": (n.get("sourceStr") or "FotMob"),
                "time": n.get("gmtTime"),
                "image": n.get("imageUrl"),
                "lang": n.get("lang") or "en",
            })
        return out

    # --- Google News (Türkçe) ---
    async def google_news(self, query, ttl, limit=8):
        q = urllib.parse.quote(f"{query} when:3d")
        url = f"https://news.google.com/rss/search?q={q}&hl=tr&gl=TR&ceid=TR:tr"
        try:
            xml = await self._get(url, ttl, kind="text")
            root = ET.fromstring(xml)
        except Exception:  # noqa: BLE001
            return []
        items = []
        for it in root.iter("item"):
            title = it.findtext("title") or ""
            src = it.find("source")
            source = src.text if src is not None else ""
            if source and title.endswith(" - " + source):
                title = title[: -len(source) - 3]
            pub = it.findtext("pubDate")
            iso = None
            if pub:
                try:
                    iso = email.utils.parsedate_to_datetime(pub).isoformat()
                except Exception:  # noqa: BLE001
                    pass
            items.append({
                "title": title, "link": it.findtext("link"), "source": source or "Google News",
                "time": iso, "lang": "tr",
            })
        items.sort(key=lambda x: x["time"] or "", reverse=True)
        return items[:limit]
