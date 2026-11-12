// Maç Analiz Merkezi — canlı veri köprüsü (Cloudflare Worker)
// Site, canlı bilgileri (skor, dakika, olaylar, resmi 11, canlı istatistik) bu köprü üzerinden FotMob'dan çeker.
// Erişim: X-Key başlığı, site şifresinden türetilen anahtar olmalı (ACCESS_KEY gizli değişkeni).
const FM = "https://www.fotmob.com/api/data";
const LEAGUES = new Set([71, 47, 87, 55, 54, 53, 57, 61, 40, 48, 64, 42, 73, 10216, 9806, 9807, 9808, 9809, 50, 10607, 77, 10195]);
const ORIGINS = ["https://swipeus.github.io", "http://127.0.0.1:8770", "http://localhost:8770", "http://localhost:8765"];
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const EL_GAMES = "https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/E2026/games?limit=500";
const LOGO_HOSTS = ["a.espncdn.com", "media-cdn.incrowdsports.com", "media-cdn.cortextech.io"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Headers": "X-Key",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/") return json({ ok: true, service: "mac-analiz-canli" }, 200, cors);
    // logo köprüsü: FotMob görselleri CORS vermediği için paylaşım görseli (canvas) bunlardan geçer
    if (url.pathname === "/logo") {
      const u = logoUrl(url.searchParams);
      if (!u) return json({ error: "logo" }, 400, cors);
      const r = await fetch(u, { cf: { cacheTtl: 604800, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*" } });
    }
    const expected = (env.ACCESS_KEY || "").trim();  // gizli değişkene satır sonu karışabiliyor
    if (!expected || (req.headers.get("X-Key") || "").trim() !== expected) return json({ error: "yetkisiz" }, 401, cors);
    try {
      if (url.pathname === "/day") {
        const date = (url.searchParams.get("date") || "").replace(/\D/g, "");
        if (date.length !== 8) return json({ error: "tarih" }, 400, cors);
        const d = await fm(`/matches?date=${date}&timezone=Europe%2FIstanbul&ccode3=TUR`, 30);
        return json({ ts: Date.now(), matches: compactDay(d) }, 200, cors, 20);
      }
      if (url.pathname === "/match") {
        const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
        if (!id) return json({ error: "id" }, 400, cors);
        const d = await fm(`/matchDetails?matchId=${id}`, 20);
        return json({ ts: Date.now(), ...compactMatch(d) }, 200, cors, 15);
      }
      if (url.pathname === "/bk") {
        const date = (url.searchParams.get("date") || "").replace(/\D/g, "");
        if (date.length !== 8) return json({ error: "tarih" }, 400, cors);
        const [nba, el] = await Promise.allSettled([getJson(`${ESPN}/scoreboard?dates=${date}`, 20), getJson(EL_GAMES, 20)]);
        const games = [...(nba.status === "fulfilled" ? (nba.value.events || []).map(nbaGame) : []),
          ...(el.status === "fulfilled" ? elGames(el.value.data || [], date) : [])];
        return json({ ts: Date.now(), games }, 200, cors, 15);
      }
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
    return json({ error: "bulunamadı" }, 404, cors);
  },
};

// FotMob takım/lig logosu ya da basketbol kaynaklarının logo adresi; başka adrese gidilmez
function logoUrl(q) {
  const id = (q.get("id") || "").replace(/\D/g, "");
  if (id) return `https://images.fotmob.com/image_resources/logo/${q.get("t") === "league" ? "leaguelogo/dark" : "teamlogo"}/${id}.png`;
  try {
    const u = new URL(q.get("u") || "");
    return u.protocol === "https:" && LOGO_HOSTS.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

async function getJson(u, ttl) {
  const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error("kaynak " + r.status);
  return r.json();
}

// app/basket.py _espn_game ile aynı durum ve süre metni
function nbaGame(e) {
  const c = e.competitions[0], t = c.status.type, period = c.status.period || 0;
  let state = { pre: "pre", in: "live", post: "post" }[t.state] || "pre";
  if (["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_SUSPENDED"].includes(t.name)) state = "off";
  let clock = null;
  if (state === "live") clock = t.name === "STATUS_HALFTIME" ? "Devre arası" : period <= 4 ? `${period}. çeyrek ${c.status.displayClock || ""}` : `Uzatma ${c.status.displayClock || ""}`;
  const h = c.competitors.find((x) => x.homeAway === "home"), a = c.competitors.find((x) => x.homeAway === "away");
  const lines = (x) => (x.linescores || []).map((y) => Math.trunc(y.value ?? 0));
  return { id: `nba-${e.id}`, state, clock, hs: state === "pre" ? null : Number(h.score) || 0, as: state === "pre" ? null : Number(a.score) || 0, q: h.linescores ? [lines(h), lines(a)] : null };
}

// app/basket.py _el_game ile aynı durum ve süre metni; yalnızca o güne yakın maçlar
function elGames(rows, date) {
  const mid = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T12:00:00Z`);
  const names = ["q1", "q2", "q3", "q4", "ot1", "ot2", "ot3", "ot4", "ot5"];
  return rows.filter((g) => g.home && g.away && Math.abs(Date.parse(g.date) - mid) < 36 * 3600e3).map((g) => {
    const st = (g.status || "").toLowerCase();
    const state = st === "result" ? "post" : ["postponed", "cancelled", "canceled"].includes(st) ? "off" : ["confirmed", "scheduled", ""].includes(st) && !g.quarter ? "pre" : "live";
    let q = null;
    if (state !== "pre") {
      const r = [g.home, g.away].map((x) => names.map((k) => (x.quarters || {})[k] ?? null));
      const keep = names.map((_, i) => i).filter((i) => r[0][i] != null || r[1][i] != null);
      q = r.map((x) => keep.map((i) => x[i]));
    }
    const clock = state === "live" ? (g.quarter ? `${g.quarter}. çeyrek ${g.quarterMinute || ""}`.trim() : "Canlı") : null;
    return { id: `el-${g.code}`, state, clock, hs: state === "pre" ? null : g.home.score, as: state === "pre" ? null : g.away.score, q };
  });
}

async function fm(path, ttl) {
  const r = await fetch(FM + path, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok) throw new Error("FotMob " + r.status);
  return r.json();
}

function json(obj, status, cors, maxAge) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `private, max-age=${maxAge || 0}`, ...cors },
  });
}

function st(s) {
  s = s || {};
  return {
    started: !!s.started, finished: !!s.finished, cancelled: !!s.cancelled,
    live: (s.liveTime || {}).short || null, score: s.scoreStr || null, utc: s.utcTime || null,
    reason: (s.reason || {}).short || null,
  };
}

function compactDay(d) {
  const out = [];
  for (const lg of (d && d.leagues) || []) {
    if (!LEAGUES.has(lg.primaryId)) continue;
    for (const m of lg.matches || []) {
      out.push({ id: m.id, hs: m.home.score, as: m.away.score, ...st(m.status) });
    }
  }
  return out;
}

const STATS = { "Ball possession": "possession", "Expected goals (xG)": "xg", "Total shots": "shots", "Shots on target": "sot",
  "Corners": "corners", "Big chances": "big", "Yellow cards": "yellow", "Red cards": "red", "Fouls committed": "fouls", "Offsides": "offsides" };

function compactMatch(d) {
  const header = d.header || {}, content = d.content || {};
  const teams = header.teams || [{}, {}];
  // olaylar: gol, kart, oyuncu değişikliği
  const evs = [];
  for (const e of ((content.matchFacts || {}).events || {}).events || []) {
    const type = e.type;
    if (!["Goal", "Card", "Substitution"].includes(type)) continue;
    evs.push({
      type, min: e.time, plus: e.overloadTime || null, home: !!e.isHome,
      player: (e.player || {}).name || e.nameStr || (e.swap && e.swap[0] && e.swap[0].name) || null,
      out: type === "Substitution" && e.swap && e.swap[1] ? e.swap[1].name : null,
      assist: e.assistStr || null, card: e.card || null,
      score: e.newScore ? e.newScore.join("-") : (e.homeScore != null ? `${e.homeScore}-${e.awayScore}` : null),
      own: !!e.ownGoal, pen: /pen/i.test(e.goalDescription || ""),
    });
  }
  // canlı istatistik (üst grup)
  const stats = {};
  try {
    for (const g of content.stats.Periods.All.stats) {
      for (const s of g.stats || []) {
        const k = STATS[s.title];
        if (k && !(k in stats) && s.stats && s.stats.length === 2 && s.stats[0] !== null && s.stats[0] !== "") stats[k] = s.stats;
      }
    }
  } catch { /* maç başlamadıysa istatistik yok */ }
  // kadro: resmi 11 açıklandıysa ilk 11 isimleri
  const lu = content.lineup || {};
  const side = (t) => t ? {
    formation: t.formation || null,
    starters: (t.starters || []).map((p) => ({ id: p.id, name: p.name, shirt: p.shirtNumber })),
    unavailable: (t.unavailable || []).map((p) => p.name),
  } : null;
  return {
    status: st(header.status),
    home: { id: teams[0].id, name: teams[0].name, score: teams[0].score },
    away: { id: teams[1].id, name: teams[1].name, score: teams[1].score },
    red: [((header.status || {}).numberOfHomeRedCards) || 0, ((header.status || {}).numberOfAwayRedCards) || 0],
    events: evs, stats,
    lineup: { type: lu.lineupType || null, home: side(lu.homeTeam), away: side(lu.awayTeam) },
  };
}
