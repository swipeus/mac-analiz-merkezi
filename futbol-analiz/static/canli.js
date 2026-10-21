"use strict";
/* Canlı katman: Cloudflare köprüsü üzerinden (meta.live.url) skor, dakika, olaylar, canlı istatistik ve resmi 11'i
   saniyeler içinde getirir; GitHub'daki 6 dakikalık analiz yayınını beklemez. Köprü yoksa sessizce devre dışı kalır. */

const LIVE = { key: null, last: {}, timer: null, busy: false };
const liveUrl = () => (STATIC && meta && meta.live && meta.live.url) || null;

async function liveKey() {
  if (LIVE.key || !RAW_KEY) return LIVE.key;
  const data = new Uint8Array([...RAW_KEY, ...new TextEncoder().encode("canli")]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  LIVE.key = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return LIVE.key;
}
async function liveGet(path) {
  const base = liveUrl(), key = await liveKey();
  if (!base || !key) return null;
  const r = await fetch(base.replace(/\/$/, "") + path, { headers: { "X-Key": key }, cache: "no-store" });
  if (!r.ok) throw new Error("canlı " + r.status);
  return r.json();
}

// skor değişince gol bildirimi
function noteScore(id, hs, as, home, away, minute) {
  const k = `${hs}-${as}`, prev = LIVE.last[id];
  LIVE.last[id] = k;
  if (prev && prev !== k && home) {
    const ev = { id: Date.now(), ts: Date.now() / 1000, match_id: id, kind: "goal", text: `⚽ GOL! ${home} ${hs}-${as} ${away}${minute ? ` (${minute})` : ""}` };
    toast(ev); addFeed(ev, true);
  }
}

/* --- liste sayfası: kartlardaki skor/dakika --- */
async function liveDay() {
  const d = await liveGet(`/day?date=${state.date.replace(/-/g, "")}`);
  if (!d || state.current || state.player || state.karne) return;
  for (const m of d.matches) {
    const card = document.querySelector(`.mcard[data-id="${m.id}"]`);
    if (!card) continue;
    const live = m.started && !m.finished;
    const names = card.querySelectorAll(".tm .nm");
    if (m.started) noteScore(m.id, m.hs, m.as, names[0] && names[0].textContent, names[1] && names[1].textContent, m.live);
    card.classList.toggle("is-live", live);
    const mid = card.querySelector(".mid");
    if (mid && (m.started || m.finished)) mid.innerHTML = `<div class="sc">${m.hs ?? 0} - ${m.as ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`;
    const top = card.querySelector(".mtop > :first-child");
    if (top) {
      if (m.cancelled) top.outerHTML = `<span class="when">İptal</span>`;
      else if (live) top.outerHTML = `<span class="badge-live">CANLI ${esc(m.live || "")}</span>`;
      else if (m.finished) top.outerHTML = `<span class="when">Maç sonu</span>`;
    }
  }
}

/* --- maç sayfası: skor, olaylar, canlı istatistik, resmi 11 --- */
const EV_IC = { Goal: "⚽", Substitution: "🔁" };
async function liveMatch(id) {
  const d = await liveGet(`/match?id=${id}`);
  if (!d || state.current !== id) return;
  const st = d.status, live = st.started && !st.finished;
  if (st.started) noteScore(id, d.home.score, d.away.score, d.home.name, d.away.name, st.live);
  const sc = document.querySelector(".hero .score");
  if (sc && (st.started || st.finished)) {
    sc.classList.toggle("live", live);
    sc.innerHTML = `${d.home.score ?? 0} - ${d.away.score ?? 0}<small>${esc(live ? (st.live || "Canlı") : st.finished ? "Maç sonu" : "")}</small>`;
  }
  const box = document.getElementById("liveBox"), lbox = document.getElementById("liveLineup");
  if (!box && !lbox) return;
  const parts = [], lineupParts = [];
  if (st.started) {
    const evs = d.events.slice().sort((a, b) => (b.min + (b.plus || 0) / 100) - (a.min + (a.plus || 0) / 100));
    const evHtml = evs.length ? evs.map((e) => {
      const ic = e.type === "Card" ? (e.card === "Red" || e.card === "YellowRed" ? "🟥" : "🟨") : EV_IC[e.type] || "•";
      const txt = e.type === "Substitution" ? `${esc(e.player || "")} <span class="muted">↔ ${esc(e.out || "")}</span>`
        : `${esc(e.player || "")}${e.own ? " (k.k.)" : ""}${e.pen ? " (pen.)" : ""}${e.assist ? ` <span class="muted">${esc(e.assist)}</span>` : ""}`;
      return `<div class="lev ${e.home ? "h" : "a"} ${e.type === "Goal" ? "goal" : ""}"><span class="lmin">${e.min}'${e.plus ? "+" + e.plus : ""}</span><span class="lic">${ic}</span><span class="ltx">${txt}</span>${e.type === "Goal" && e.score ? `<b class="lsc">${esc(e.score)}</b>` : ""}</div>`;
    }).join("") : `<p class="muted">Henüz olay yok.</p>`;
    const LAB = { possession: "Topla oynama %", xg: "xG", shots: "Şut", sot: "İsabetli şut", big: "Net pozisyon", corners: "Korner", yellow: "Sarı kart", red: "Kırmızı kart", fouls: "Faul", offsides: "Ofsayt" };
    const stHtml = Object.entries(LAB).filter(([k]) => d.stats[k]).map(([k, l]) => {
      const [x, y] = d.stats[k].map((v) => parseFloat(String(v).replace("%", "")) || 0);
      const tot = x + y || 1;
      return `<div class="cmp-row"><span class="cv">${esc(String(d.stats[k][0]))}</span>
        <div class="cmp-mid"><div class="cmp-l">${l}</div><div class="cmp-bars"><span class="bh" style="flex:${x / tot}"></span><span class="ba" style="flex:${y / tot}"></span></div></div>
        <span class="cv r">${esc(String(d.stats[k][1]))}</span></div>`;
    }).join("");
    parts.push(`<div class="card live-card" style="--c:#f85149">${head(live ? "🔴" : "🏁", `${live ? `Canlı · ${esc(st.live || "")}` : "Maç sonu"} <span class="muted">· ${esc(d.home.name)} ${d.home.score}-${d.away.score} ${esc(d.away.name)}</span>`, `<span class="muted lupd">anlık</span>`)}
      <div class="grid2"><div><h3>Maç olayları</h3><div class="levs">${evHtml}</div></div>
      <div><h3>Canlı istatistik</h3>${stHtml || `<p class="muted">İstatistik henüz yok.</p>`}</div></div></div>`);
  }
  // resmi 11 analiz yayınından önce açıklandıysa
  const lu = d.lineup || {};
  const staticType = (lastB && lastB.lineup && lastB.lineup.type) || null;
  if (lu.type && !["predicted", "lastStarting11"].includes(lu.type) && staticType !== lu.type && lu.home && lu.away && !st.finished) {
    const side = (t, name) => `<div><h3>${esc(name)} · ${esc(t.formation || "")}</h3><div class="muted">${t.starters.map((p) => `${esc(p.shirt || "")} ${esc(p.name)}`).join(" · ")}</div></div>`;
    lineupParts.push(`<div class="card" style="--c:#2ea043">${head("📋", `Resmi ilk 11'ler açıklandı <span class="muted">· analiz birkaç dakika içinde güncellenecek</span>`)}
      <div class="grid2">${side(lu.home, d.home.name)}${side(lu.away, d.away.name)}</div></div>`);
  }
  if (box) box.innerHTML = parts.join("") || `<div class="card"><p class="muted">Maç henüz başlamadı.</p></div>`;
  if (lbox) lbox.innerHTML = lineupParts.join("");
}

async function liveTick() {
  if (LIVE.busy || document.hidden || !liveUrl() || !ready) return;
  LIVE.busy = true;
  try {
    if (state.current) await liveMatch(state.current);
    else if (!state.player && !state.karne) await liveDay();
  } catch (e) {
    const box = document.getElementById("liveBox");
    if (box && !box.querySelector(".live-card")) box.innerHTML = `<div class="card"><p class="muted">Canlı verilere şu an ulaşılamıyor; 30 saniye içinde tekrar denenecek.</p></div>`;
  }
  LIVE.busy = false;
}
// sayfa değişince ve görünür olunca hemen, sonra 30 sn'de bir
window.addEventListener("hashchange", () => setTimeout(liveTick, 1500));
document.addEventListener("visibilitychange", () => { if (!document.hidden) liveTick(); });
setInterval(liveTick, 30000);
setTimeout(liveTick, 3000);
