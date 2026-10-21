// Maç Analiz Merkezi — canlı veri köprüsü (Cloudflare Worker)
// Site, canlı bilgileri (skor, dakika, olaylar, resmi 11, canlı istatistik) bu köprü üzerinden FotMob'dan çeker.
// Erişim: X-Key başlığı, site şifresinden türetilen anahtar olmalı (ACCESS_KEY gizli değişkeni).
const FM = "https://www.fotmob.com/api/data";
const LEAGUES = new Set([71, 47, 87, 55, 54, 53, 57, 61, 40, 48, 64, 42, 73, 10216]);
const ORIGINS = ["https://swipeus.github.io", "http://127.0.0.1:8770", "http://localhost:8770", "http://localhost:8765"];
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
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
    return json({ error: "bulunamadı" }, 404, cors);
  },
};

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
