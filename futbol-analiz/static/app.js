"use strict";
const $ = (s, el = document) => el.querySelector(s);

// Tarayıcı önbellekten eski sayfayı getirdiyse (bu kodla uyuşmaz) bir kez taze yükle
if (!$("#filterBtn")) {
  let tried = false;
  try { tried = sessionStorage.getItem("reloadedForUpdate") === "1"; sessionStorage.setItem("reloadedForUpdate", "1"); } catch { }
  if (!tried) location.reload();
  throw new Error("Sayfa sürümü eski, yenileniyor");
}
try { sessionStorage.removeItem("reloadedForUpdate"); } catch { }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)) ? "—" : Number(x).toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pc = (x) => (x === null || x === undefined) ? "—" : "%" + Math.round(x * 100);
const TZ = "Europe/Istanbul";
const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";
const dateOf = (iso) => iso ? new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: TZ }) : "";
const ago = (iso) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "az önce"; if (m < 60) return m + " dk önce";
  const h = Math.round(m / 60); return h < 48 ? h + " sa önce" : Math.round(h / 24) + " gün önce";
};
const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

const state = {
  date: todayStr(),
  leagues: [],
  off: new Set(JSON.parse(safeGet("offLeagues") || "[]")),
  unread: 0,
  current: null, // açık maç id
};
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { } }

/* ---------- statik mod: şifreli JSON dosyaları ---------- */
const STATIC = !!window.STATIC_SITE;
let KEY = null, meta = null;
const SALT = new TextEncoder().encode("mac-analiz-merkezi:v1");
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u) => btoa(String.fromCharCode(...u));
async function deriveKeyBytes(pw) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: SALT, iterations: 150000, hash: "SHA-256" }, base, 256);
  return new Uint8Array(bits);
}
const importAesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
async function getData(name) {
  const r = await fetch("data/" + name + "?t=" + Date.now(), { cache: "no-store" });
  if (r.status === 404) throw new Error("NOTFOUND");
  if (!r.ok) throw new Error(r.statusText);
  const box = await r.json();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(box.iv) }, KEY, b64d(box.ct));
  const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
async function staticApi(path) {
  if (!KEY) throw new Error("Giriş gerekli");
  let m;
  if (path === "/api/leagues") return meta.leagues;
  if (path === "/api/events/recent") return getData("events.json");
  if ((m = path.match(/^\/api\/day\?date=([\d-]+)/))) {
    try { return await getData(`day-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu tarih için veri yok. Site dünün, bugünün ve yarının maçlarını gösterir."); throw e; }
  }
  if ((m = path.match(/^\/api\/match\/(\d+)/))) {
    try { return await getData(`match-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu maçın analizi henüz hazırlanmadı, birkaç dakika sonra tekrar bak."); throw e; }
  }
  throw new Error("Bilinmeyen istek");
}

async function api(path) {
  if (STATIC) return staticApi(path);
  const r = await fetch(path);
  if (r.status === 401) { location.href = "/giris"; throw new Error("Giriş gerekli"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

/* ---------- ligler ---------- */
async function initLeagues() {
  state.leagues = await api("/api/leagues");
  renderLeagues();
}
function renderLeagues() {
  // o günkü maç sayıları (gün listesi yüklendiyse)
  const counts = {};
  (dayCache?.matches || []).forEach((m) => counts[m.league_id] = (counts[m.league_id] || 0) + 1);
  $("#leagues").innerHTML = state.leagues.map((l) => `
    <label class="lg-opt">
      <input type="checkbox" data-id="${l.id}" ${state.off.has(l.id) ? "" : "checked"}>
      <img src="${leagueLogo(l.id)}" alt="" onerror="this.style.visibility='hidden'">
      <span class="nm">${esc(l.name)}</span>
      <span class="cnt">${counts[l.id] ? counts[l.id] + " maç" : ""}</span>
    </label>`).join("");
  $("#leagues").querySelectorAll("input").forEach((cb) => cb.onchange = () => {
    const id = +cb.dataset.id;
    cb.checked ? state.off.delete(id) : state.off.add(id);
    applyFilter();
  });
  updateFilterBtn();
}
function updateFilterBtn() {
  const on = state.leagues.filter((l) => !state.off.has(l.id));
  const all = on.length === state.leagues.length;
  $("#filterCount").textContent = all ? "" : `${on.length}/${state.leagues.length}`;
  $("#filterBtn").classList.toggle("active", !all);
  $("#filterSummary").textContent = all ? "Tüm ligler gösteriliyor"
    : !on.length ? "Hiç lig seçilmedi"
    : on.length <= 3 ? on.map((l) => l.name).join(", ") : `${on.length} lig seçili`;
}
function applyFilter() {
  safeSet("offLeagues", JSON.stringify([...state.off]));
  updateFilterBtn();
  if (!state.current) renderDay(true);
}
function openFilter(open) {
  $("#filterSheet").classList.toggle("hidden", !open);
  $("#filterBackdrop").classList.toggle("hidden", !open);
  if (open) { renderLeagues(); $("#filterDone").focus(); }
}
$("#filterBtn").onclick = () => openFilter(true);
$("#filterClose").onclick = $("#filterDone").onclick = $("#filterBackdrop").onclick = () => openFilter(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openFilter(false); });
$("#filterAll").onclick = () => { state.off.clear(); renderLeagues(); applyFilter(); };
$("#filterNone").onclick = () => { state.leagues.forEach((l) => state.off.add(l.id)); renderLeagues(); applyFilter(); };

/* ---------- gün listesi ---------- */
let dayCache = null;
async function renderDay(silent) {
  const v = $("#view");
  if (!silent) v.innerHTML = `<div class="loading">Maçlar yükleniyor…</div>`;
  try {
    dayCache = await api("/api/day?date=" + state.date);
  } catch (e) {
    v.innerHTML = `<div class="loading">Hata: ${esc(e.message)}</div>`; return;
  }
  if (state.current) return;
  const ms = dayCache.matches.filter((m) => !state.off.has(m.league_id));
  if (!ms.length) { v.innerHTML = `<div class="loading">Bu tarihte seçili liglerde maç yok.</div>`; return; }
  // Map: sunucunun lig sırasını korur (sayısal anahtarlı nesne sırayı bozar)
  const groups = new Map();
  ms.forEach((m) => { if (!groups.has(m.league_id)) groups.set(m.league_id, []); groups.get(m.league_id).push(m); });
  v.innerHTML = highlightsHtml(ms) + [...groups.values()].map((list) => `
    <section class="lg-block">
      <div class="lg-title"><img src="${leagueLogo(list[0].league_id)}" alt="" onerror="this.remove()"><b>${esc(list[0].league)}</b><span>${list.length} maç</span></div>
      <div class="mgrid">${list.map(cardHtml).join("")}</div>
    </section>`).join("");
  v.querySelectorAll("[data-id]").forEach((r) => r.onclick = () => location.hash = "#/mac/" + r.dataset.id);
}

const teamLogo = (id) => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`;
const leagueLogo = (id) => `https://images.fotmob.com/image_resources/logo/leaguelogo/dark/${id}.png`;
// Favori: kazanma olasılığı daha yüksek olan taraf (gösterilen yüzdeler eşitse favori yok)
function favoriteSide(p) {
  if (!p) return null;
  const h = Math.round(p.p_home * 100), a = Math.round(p.p_away * 100);
  return h === a ? null : h > a ? "home" : "away";
}
function crestHtml(team, isFav, pct, size) {
  const initials = (team.name || "?").split(" ").map((w) => w[0]).join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3);
  return `<div class="crest ${isFav ? "fav" : ""}"${size ? ` style="width:${size}px;height:${size}px"` : ""}>
    ${isFav ? `<span class="star" title="Favori · kazanma olasılığı ${pc(pct)}">★</span>` : ""}
    <img src="${teamLogo(team.id)}" alt="" loading="lazy"${size ? ` style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px"` : ""}
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fb',textContent:'${initials}'}))">
  </div>`;
}
function cardHtml(m) {
  const live = m.started && !m.finished;
  const p = m.pred;
  const fav = favoriteSide(p);
  let top = m.cancelled ? `<span class="when">İptal</span>`
    : live ? `<span class="badge-live">CANLI ${esc(m.live || "")}</span>`
    : m.finished ? `<span class="when">Maç sonu</span>` : `<span class="when">${esc(dateOf(m.utc))}</span>`;
  const tags = p ? [lineupTag(m.lineup_type, false),
    m.absent && (m.absent[0] + m.absent[1]) ? `<span class="tag warn">${m.absent[0]}+${m.absent[1]} eksik</span>` : ""].join("") : "";
  const mid = (m.started || m.finished)
    ? `<div class="sc">${m.home.score ?? 0} - ${m.away.score ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`
    : `<div class="ko">${esc(timeOf(m.utc))}</div><div class="sub">başlama</div>`;
  const bottom = p ? `
    <div class="probs"><span class="ph">${pc(p.p_home)}</span>
      <div class="probbar"><span style="width:${p.p_home * 100}%"></span><span style="width:${p.p_draw * 100}%"></span><span style="width:${p.p_away * 100}%"></span></div>
      <span class="pa">${pc(p.p_away)}</span></div>
    <div class="pills">
      <span class="pill"><i>Beraberlik</i>${pc(p.p_draw)}</span>
      <span class="pill"><i>Skor</i>${esc(p.score)}</span>
      <span class="pill"><i>2.5 Üst</i>${pc(p.over25)}</span>
      <span class="pill"><i>KG</i>${pc(p.btts)}</span>
    </div>` : `<div class="pending">Analiz hazırlanıyor…</div>`;
  return `<div class="mcard ${live ? "is-live" : ""}" data-id="${m.id}">
    <div class="mtop">${top}<div class="mtags">${tags}</div></div>
    <div class="mteams">
      <div class="tm">${crestHtml(m.home, fav === "home", p && p.p_home)}<div class="nm">${esc(m.home.name)}</div></div>
      <div class="mid">${mid}</div>
      <div class="tm">${crestHtml(m.away, fav === "away", p && p.p_away)}<div class="nm">${esc(m.away.name)}</div></div>
    </div>
    ${bottom}
  </div>`;
}

function highlightsHtml(ms) {
  const open = ms.filter((m) => m.pred && !m.finished && !m.cancelled);
  if (open.length < 2) return "";
  const pick = (score) => open.reduce((a, b) => (score(b) > score(a) ? b : a));
  const favM = pick((m) => Math.max(m.pred.p_home, m.pred.p_away));
  const goalM = pick((m) => m.pred.over25);
  const evenM = pick((m) => -Math.abs(m.pred.p_home - m.pred.p_away));
  const favSide = favoriteSide(favM.pred) || "home";
  const tile = (cls, ic, k, m, t, s) => `<div class="hl ${cls}" data-id="${m.id}"><div class="ic">${ic}</div>
    <div><div class="k">${k}</div><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></div></div>`;
  return `<div class="highlights">
    ${tile("fav", "★", "En net favori", favM, favM[favSide].name, `${favM.home.name} - ${favM.away.name} · kazanma ${pc(favM.pred["p_" + favSide])}`)}
    ${tile("goal", "⚽", "En gollü maç beklentisi", goalM, `${goalM.home.name} - ${goalM.away.name}`, `2.5 Üst ${pc(goalM.pred.over25)} · KG ${pc(goalM.pred.btts)}`)}
    ${tile("even", "⚖", "En dengeli maç", evenM, `${evenM.home.name} - ${evenM.away.name}`, `1 ${pc(evenM.pred.p_home)} · X ${pc(evenM.pred.p_draw)} · 2 ${pc(evenM.pred.p_away)}`)}
  </div>`;
}

const isNarrow = () => window.matchMedia("(max-width: 700px)").matches;
let lastB = null;
let wasNarrow = isNarrow();
window.addEventListener("resize", () => {
  if (isNarrow() !== wasNarrow) {
    wasNarrow = isNarrow();
    if (state.current && lastB) { const y = window.scrollY; $("#view").innerHTML = matchHtml(lastB); bindMatch(); window.scrollTo(0, y); }
  }
});

function lineupTag(t, long) {
  if (!t) return "";
  if (t === "predicted") return `<span class="tag">${long ? "Olası 11 (FotMob tahmini)" : "Olası 11"}</span>`;
  if (t === "lastStarting11") return `<span class="tag">${long ? "Son maçın ilk 11'i (olası 11 henüz yayınlanmadı)" : "Son maçın 11'i"}</span>`;
  return `<span class="tag ok">${long ? "Resmi ilk 11" : "Resmi 11"}</span>`;
}
const WEATHER = { "clear": "açık", "sunny": "güneşli", "mostly sunny": "çoğunlukla güneşli", "partly cloudy": "parçalı bulutlu",
  "mostly cloudy": "çok bulutlu", "cloudy": "bulutlu", "overcast": "kapalı", "fog": "sisli", "light rain": "hafif yağmurlu",
  "rain": "yağmurlu", "showers": "sağanak", "heavy rain": "şiddetli yağmur", "thunderstorms": "fırtınalı", "snow": "karlı", "windy": "rüzgarlı",
  "mostly clear": "çoğunlukla açık", "partly sunny": "parçalı güneşli", "drizzle": "çiseleyen yağmur" };
const trWeather = (d) => WEATHER[(d || "").toLowerCase()] || d || "";

/* ---------- maç detayı ---------- */
async function renderMatch(id, silent, refresh) {
  const v = $("#view");
  if (!silent) v.innerHTML = `<div class="loading">Maç verileri toplanıyor ve analiz ediliyor… (ilk açılışta 10-20 sn sürebilir)</div>`;
  let b;
  try { b = await api(`/api/match/${id}${refresh ? "?refresh=true" : ""}`); }
  catch (e) { v.innerHTML = `<div class="loading">Hata: ${esc(e.message)}</div>`; return; }
  if (state.current !== id) return;
  const y = window.scrollY;
  lastB = b;
  v.innerHTML = matchHtml(b);
  bindMatch();
  if (silent) window.scrollTo(0, y);
}
const REFRESH_LABEL = () => STATIC ? "Yeni veri var mı?" : "Şimdi yenile";
function bindMatch() {
  const btn = $("#refreshBtn");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = STATIC ? "Kontrol ediliyor…" : "Yenileniyor…";
    try {
      if (STATIC) {
        // çevrimiçi sürümde veri GitHub'da 15 dk'da bir üretilir; burada sadece yenisi yayınlanmış mı bakılır
        const m = await getData("meta.json");
        const fresh = !meta || m.updated !== meta.updated;
        meta = m; showUpdated();
        if (fresh) {
          await renderMatch(state.current, true);
          toast({ text: "Yeni veriler yüklendi", match_id: state.current });
          return;
        }
        const left = Math.round((m.updated + 15 * 60 - Date.now() / 1000) / 60);
        btn.textContent = "Güncel ✓ · yeni veri " + (left > 0 ? `~${left} dk içinde` : "birkaç dk içinde");
      } else {
        await renderMatch(state.current, true, true);
        toast({ text: "Maç verileri yenilendi", match_id: state.current });
        return;
      }
    } catch (e) {
      btn.textContent = "Hata: " + e.message;
    }
    setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = REFRESH_LABEL(); } }, 6000);
  };
}

function matchHtml(b) {
  const A = b.analysis, P = A.prediction, H = b.home.name, W = b.away.name;
  const st = b.status;
  const live = st.started && !st.finished;
  const scoreTxt = (st.started || st.finished) ? `${b.home.score ?? 0} - ${b.away.score ?? 0}` : timeOf(b.utc);
  const stTxt = st.cancelled ? "İptal" : live ? (st.live || "Canlı") : st.finished ? "Maç sonu" : dateOf(b.utc);
  const w = b.weather;
  const meta = [
    `${esc(b.league_name)}${b.round ? " · " + esc(b.round) + ". hafta" : ""}`,
    b.venue && esc(b.venue),
    b.referee && "Hakem: " + esc(b.referee),
    w && `Hava: ${w.temperature}°C, ${esc(trWeather(w.description))}${w.windSpeed != null ? `, rüzgar ${w.windSpeed} m/s` : ""}`,
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
  return `
  <a class="back" href="#/">‹ Günün maçları</a>
  <div class="hero">
    <div class="meta">${meta}</div>
    <div class="teams">
      <div class="team">${crestHtml(b.home, favoriteSide(P) === "home", P.p_home, 84)}${esc(H)}</div>
      <div class="score">${esc(scoreTxt)}<small>${esc(stTxt)}</small></div>
      <div class="team">${crestHtml(b.away, favoriteSide(P) === "away", P.p_away, 84)}${esc(W)}</div>
    </div>
    <div class="updated">Son güncelleme: ${ago(b.updated)}${STATIC ? " (veriler 15 dk'da bir yenilenir)" : ""} · <button id="refreshBtn">${REFRESH_LABEL()}</button></div>
  </div>

  <div class="card">
    <h2>Tahmin ve model özeti</h2>
    <div class="summary">${esc(A.summary)}</div>
    <div class="bigbar">
      <div style="width:${P.p_home * 100}%;background:var(--home)">1 ${pc(P.p_home)}</div>
      <div style="width:${P.p_draw * 100}%;background:var(--draw)">X ${pc(P.p_draw)}</div>
      <div style="width:${P.p_away * 100}%;background:var(--away)">2 ${pc(P.p_away)}</div>
    </div>
    <div class="pred">
      ${kpi("Beklenen gol (xG)", `${nf(P.lam_home, 2)} – ${nf(P.lam_away, 2)}`, "Poisson modeli")}
      ${kpi("En olası skorlar", P.scores.slice(0, 3).map((s) => `${s.score}`).join(" · "), P.scores.slice(0, 3).map((s) => pc(s.p)).join(" · "))}
      ${kpi("Toplam gol", `2.5 Üst ${pc(P.over25)}`, `1.5Ü ${pc(P.over15)} · 3.5Ü ${pc(P.over35)}`)}
      ${kpi("Karşılıklı gol", pc(P.btts), "KG Var olasılığı")}
      ${P.corners ? kpi("Korner beklentisi", `${nf(P.corners.home)} – ${nf(P.corners.away)}`, `Toplam ${nf(P.corners.total)} · 9.5Ü ${pc(P.corners.over["9.5"])} · 10.5Ü ${pc(P.corners.over["10.5"])}`) : ""}
      ${P.shots.home != null ? kpi("Şut beklentisi", `${nf(P.shots.home)} – ${nf(P.shots.away)}`, `İsabetli: ${nf(P.sot.home)} – ${nf(P.sot.away)}`) : ""}
      ${P.yellow.total != null ? kpi("Sarı kart ort.", nf(P.yellow.total), `${nf(P.yellow.home)} + ${nf(P.yellow.away)} (son maçlar)`) : ""}
      ${kpi("Model güveni", P.confidence, "Veri miktarına göre")}
    </div>
    <h3>Olası senaryolar</h3>
    <ul>${A.scenarios.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
  </div>

  ${lineupHtml(b)}

  <div class="grid2">
    ${teamHtml(A.home, "home-c")}
    ${teamHtml(A.away, "away-c")}
  </div>

  ${compareHtml(b)}
  <div class="grid2">
    ${recentHtml(b.recent.home, H, "home-c")}
    ${recentHtml(b.recent.away, W, "away-c")}
  </div>
  ${seasonHtml(b)}
  <div class="grid2">
    ${newsHtml(b.news.home, H, "home-c")}
    ${newsHtml(b.news.away, W, "away-c")}
  </div>
  ${extrasHtml(b)}
  `;
}
const kpi = (l, v, s) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || "")}</div></div>`;

const SEC = { plan: "Oyun planı ve taktik", attack: "Hücum: şut ve xG", setpiece: "Korner ve duran top", defence: "Savunma", form: "Form ve puan durumu", absent: "Eksikler", players: "Kilit oyuncular (sezon)" };
function teamHtml(p, cls) {
  return `<div class="card"><h2 class="${cls}">${esc(p.name)} analizi</h2>
    ${Object.entries(SEC).map(([k, t]) => p.sections[k] && p.sections[k].length ?
      `<h3>${t}</h3><ul>${p.sections[k].map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "").join("")}
  </div>`;
}

function lineupHtml(b) {
  const lu = b.lineup;
  if (!lu) return `<div class="card"><h2>Kadrolar</h2><p class="muted">Kadro bilgisi henüz yok.</p></div>`;
  const tag = lineupTag(lu.type, true);
  // dar ekranda saha dikey çizilir: ev sahibi altta, deplasman üstte
  const vert = isNarrow();
  const dots = (side, cls) => (lu[side].starters || []).filter((p) => p.x != null).map((p) => {
    // FotMob dikey düzeni: x = genişlik, y = kendi kalesinden ileri (0..1)
    let left, top;
    if (vert) {
      left = side === "home" ? p.x * 100 : (1 - p.x) * 100;
      top = side === "home" ? 100 - p.y * 50 : p.y * 50;
    } else {
      left = side === "home" ? p.y * 50 : 100 - p.y * 50;
      top = side === "home" ? p.x * 100 : (1 - p.x) * 100;
    }
    return `<div class="pl ${cls}" style="left:${left}%;top:${top}%"><div class="n">${esc(p.shirt || "")}</div><div class="nm">${esc(p.last)}</div>${p.rating ? `<div class="rt">${nf(p.rating, 1)}</div>` : ""}</div>`;
  }).join("");
  const lines = vert
    ? `<div class="ln" style="top:50%;left:0;right:0;border-width:2px 0 0 0"></div>
    <div class="ln" style="top:calc(50% - 9%);left:calc(50% - 13.5%);height:18%;width:27%;border-radius:50%"></div>
    <div class="ln" style="top:0;left:20%;height:16%;width:60%;border-top:0"></div>
    <div class="ln" style="bottom:0;left:20%;height:16%;width:60%;border-bottom:0"></div>`
    : `<div class="ln" style="left:50%;top:0;bottom:0;border-width:0 0 0 2px"></div>
    <div class="ln" style="left:calc(50% - 9%);top:calc(50% - 13.5%);width:18%;height:27%;border-radius:50%"></div>
    <div class="ln" style="left:0;top:20%;width:16%;height:60%;border-left:0"></div>
    <div class="ln" style="right:0;top:20%;width:16%;height:60%;border-right:0"></div>`;
  const abs = (side) => {
    const u = lu[side].unavailable || [];
    if (!u.length) return `<li class="muted">Bilinen eksik yok</li>`;
    const TR = { injury: "sakat", suspension: "cezalı", "red card": "cezalı", "yellow card": "kart cezalı", "international duty": "milli takımda" };
    return u.map((p) => `<li>${esc(p.name)} <small class="muted">(${esc(TR[(p.type || "").toLowerCase()] || p.type || "yok")}${p.return ? ", dönüş: " + esc(p.return) : ""})</small></li>`).join("");
  };
  const side = (s, cls, name) => `<div><h3 class="${cls}">${esc(name)} · ${esc(lu[s].formation || "")}</h3>
    <div class="muted">Teknik direktör: ${esc(lu[s].coach || "—")}${lu[s].avg_age ? " · İlk 11 yaş ort. " + nf(lu[s].avg_age, 1) : ""}</div>
    <ul>${(lu[s].starters || []).map((p) => `<li>${esc(p.shirt || "")} ${esc(p.name)}${p.rating ? ` <small class="muted">${nf(p.rating, 2)}</small>` : ""}</li>`).join("")}</ul>
    <h3>Eksikler</h3><ul>${abs(s)}</ul></div>`;
  return `<div class="card"><h2>Kadrolar ${tag}</h2>
    <div class="pitch ${vert ? "v" : ""}">${lines}${dots("home", "h")}${dots("away", "a")}</div>
    <div class="grid2">${side("home", "home-c", b.home.name)}${side("away", "away-c", b.away.name)}</div></div>`;
}

const CMP = [
  ["goals", "Gol", 1, true], ["xg", "xG", 2, true], ["shots", "Şut", 1, true], ["sot", "İsabetli şut", 1, true],
  ["shots_in", "Ceza sahası içi şut", 1, true], ["shots_out", "Ceza sahası dışı şut", 1, null],
  ["big_chances", "Net pozisyon", 1, true], ["xg_open", "xG (akan oyun)", 2, true], ["xg_set", "xG (duran top)", 2, true],
  ["corners", "Korner", 1, true], ["possession", "Topla oynama %", 0, null], ["box_touches", "Rakip ceza sahasında temas", 1, true],
  ["passes_acc", "İsabetli pas", 0, null], ["long_balls", "İsabetli uzun top", 1, null], ["crosses", "İsabetli orta", 1, null],
  ["tackles", "Müdahale", 1, null], ["interceptions", "Top kesme", 1, null], ["clearances", "Uzaklaştırma", 1, null],
  ["blocks", "Blok", 1, null], ["aerials", "Kazanılan hava topu", 1, true], ["duels", "Kazanılan ikili mücadele", 1, true],
  ["saves", "Kaleci kurtarışı", 1, null], ["fouls", "Faul", 1, null], ["yellow", "Sarı kart", 1, null],
];
function compareHtml(b) {
  const h = b.recent.home, a = b.recent.away;
  const rows = (src) => CMP.map(([k, l, d, hi]) => {
    const x = h[src][k], y = a[src][k];
    if (x == null && y == null) return "";
    let bx = "", by = "";
    if (hi !== null && x != null && y != null && x !== y) {
      const good = src === "avg_for" ? hi : !hi;
      if ((x > y) === good) bx = "better"; else by = "better";
    }
    return `<tr><td class="${bx}">${nf(x, d)}</td><td>${l}</td><td class="${by}">${nf(y, d)}</td></tr>`;
  }).join("");
  return `<div class="card"><h2>İstatistik karşılaştırması (son ${h.n} / ${a.n} maç ortalaması)</h2>
    <div class="grid2">
      <div class="tbl-wrap"><h3>Ürettikleri (maç başı)</h3><table class="cmp"><tr><th class="home-c">${esc(b.home.name)}</th><th></th><th class="away-c">${esc(b.away.name)}</th></tr>${rows("avg_for")}</table></div>
      <div class="tbl-wrap"><h3>Rakibe izin verdikleri (maç başı)</h3><table class="cmp"><tr><th class="home-c">${esc(b.home.name)}</th><th></th><th class="away-c">${esc(b.away.name)}</th></tr>${rows("avg_against")}</table></div>
    </div><p class="muted">Altı çizili değer o kalemde daha iyi olan takımı gösterir.</p></div>`;
}

function recentHtml(r, name, cls) {
  if (!r.rows.length) return `<div class="card"><h2 class="${cls}">${esc(name)}: son maçlar</h2><p class="muted">Veri yok</p></div>`;
  return `<div class="card"><h2 class="${cls}">${esc(name)}: son maçlar</h2><div class="tbl-wrap"><table>
    <tr><th class="l">Tarih</th><th class="l">Rakip</th><th>Skor</th><th>xG</th><th>Şut (iç/dış)</th><th>İsab.</th><th>Korner</th><th>Top %</th></tr>
    ${r.rows.map((x) => `<tr>
      <td class="l">${dateOf(x.date)}</td>
      <td class="l">${x.home ? "" : "@ "}${esc(x.opponent)} <small class="muted">${esc(x.comp || "")}</small></td>
      <td class="res-${x.result}">${x.gf}-${x.ga}</td>
      <td>${nf(x.for.xg, 2)} – ${nf(x.against.xg, 2)}</td>
      <td>${nf(x.for.shots, 0)} (${nf(x.for.shots_in, 0)}/${nf(x.for.shots_out, 0)})</td>
      <td>${nf(x.for.sot, 0)}</td>
      <td>${nf(x.for.corners, 0)} – ${nf(x.against.corners, 0)}</td>
      <td>${nf(x.for.possession, 0)}</td></tr>`).join("")}
  </table></div></div>`;
}

const SEASON = [
  ["goals_team_match", "Maç başı gol"], ["expected_goals_team", "xG"], ["goals_conceded_team_match", "Maç başı yenilen gol"],
  ["expected_goals_conceded_team", "Yenilen xG"], ["possession_percentage_team", "Topla oynama %"],
  ["ontarget_scoring_att_team", "Maç başı isabetli şut"], ["big_chance_team", "Net pozisyon"],
  ["touches_in_opp_box_team", "Rakip ceza sahasında temas"], ["corner_taken_team", "Korner"],
  ["poss_won_att_3rd_team", "Rakip yarı sahada top kazanma"], ["total_tackle_team", "Müdahale"],
  ["interception_team", "Top kesme"], ["effective_clearance_team", "Uzaklaştırma"], ["clean_sheet_team", "Gol yemediği maç"],
  ["accurate_long_balls_team", "İsabetli uzun top"], ["accurate_cross_team", "İsabetli orta"],
  ["_set_piece_goals_team", "Duran toptan gol"], ["_set_piece_goals_conceded_team", "Duran toptan yenilen gol"],
  ["saves_team", "Kurtarış"], ["fk_foul_lost_team", "Faul"], ["total_yel_card_team", "Sarı kart"], ["rating_team", "FotMob reytingi"],
];
function seasonHtml(b) {
  const h = b.season.home || {}, a = b.season.away || {};
  if (!Object.keys(h).length && !Object.keys(a).length) return "";
  const cell = (v) => v ? `${nf(v.per_match, 2)} <small class="muted">(${nf(v.value, v.value % 1 ? 1 : 0)} top. · ${v.rank}./${v.of})</small>` : "—";
  const rows = SEASON.map(([k, l]) => (h[k] || a[k]) ? `<tr><td class="l">${l}</td><td>${cell(h[k])}</td><td>${cell(a[k])}</td></tr>` : "").join("");
  return `<div class="card"><h2>Sezon istatistikleri: ${esc(b.season.league_name || b.league_name)}</h2>
    <p class="muted">Maç başı değer, parantez içinde sezon toplamı ve FotMob lig sıralaması (1 = ligin en iyisi; ör. yenilen xG'de en az yiyen).</p>
    <div class="tbl-wrap"><table><tr><th class="l">Kalem</th><th class="home-c">${esc(b.home.name)}</th><th class="away-c">${esc(b.away.name)}</th></tr>${rows}</table></div></div>`;
}

function newsHtml(n, name, cls) {
  const li = (x) => `<li><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a><br><small>${esc(x.source)} · ${ago(x.time)}${x.lang === "en" ? " · EN" : ""}</small></li>`;
  return `<div class="card news"><h2 class="${cls}">${esc(name)}: haberler</h2>
    <h3>Türkçe basın (Google News)</h3><ul>${n.tr.length ? n.tr.map(li).join("") : `<li class="muted">Son 3 günde haber bulunamadı</li>`}</ul>
    ${n.fotmob.length ? `<h3>FotMob haber akışı</h3><ul>${n.fotmob.map(li).join("")}</ul>` : ""}</div>`;
}

function extrasHtml(b) {
  const h2h = b.h2h && b.h2h.matches.length ? `<h3>Aralarındaki son maçlar</h3><div class="tbl-wrap"><table>${b.h2h.matches.map((m) =>
    `<tr><td class="l">${dateOf(m.date)}</td><td class="l">${esc(m.home)}</td><td>${esc(m.score)}</td><td class="l">${esc(m.away)}</td><td class="l muted">${esc(m.league)}</td></tr>`).join("")}</table></div>` : "";
  const ins = b.insights.length ? `<h3>FotMob içgörüleri (EN)</h3><ul>${b.insights.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const prev = b.preview.length ? `<h3>Maç önizlemesi</h3><ul>${b.preview.map((p) => `<li><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a><br><small class="muted">${esc(p.description || "")}</small></li>`).join("")}</ul>` : "";
  const prov = b.season.provider ? ` (veri sağlayıcı: ${esc(b.season.provider)})` : "";
  return `<div class="card">${h2h}${prev}${ins}
    <h3>Kaynaklar</h3><ul>
      <li><a href="${esc(b.links.fotmob)}" target="_blank" rel="noopener">FotMob maç sayfası</a>${prov}: kadrolar, eksikler, maç ve sezon istatistikleri</li>
      <li><a href="${esc(b.links.mackolik)}" target="_blank" rel="noopener">Maçkolik'te bu maç</a> · <a href="${esc(b.links.sofascore)}" target="_blank" rel="noopener">SofaScore'da bu maç</a> (karşılaştırma için)</li>
      <li>Türkçe haberler: Google News (son 3 gün). Analiz ve tahminler bu verilerden kural tabanlı model ile üretilir.</li>
    </ul></div>`;
}

/* ---------- canlı güncelleme (SSE) ---------- */
function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => $("#liveDot").classList.add("on");
  es.onerror = () => $("#liveDot").classList.remove("on");
  let pending = null;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.text) { toast(ev); addFeed(ev, true); }
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (state.current && ev.match_id === state.current) renderMatch(state.current, true);
      else if (!state.current) renderDay(true);
    }, 800);
  };
}
function toast(ev) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = ev.text;
  t.onclick = () => { location.hash = "#/mac/" + ev.match_id; t.remove(); };
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 9000);
}
function addFeed(ev, fresh) {
  const li = document.createElement("li");
  li.innerHTML = `${esc(ev.text)}<small>${new Date(ev.ts * 1000).toLocaleString("tr-TR", { timeZone: TZ })}</small>`;
  li.onclick = () => { location.hash = "#/mac/" + ev.match_id; $("#feed").classList.add("hidden"); };
  const list = $("#feedList");
  fresh ? list.prepend(li) : list.append(li);
  if (fresh) { state.unread++; $("#bellCount").textContent = state.unread; }
}
async function loadFeed() {
  try { (await api("/api/events/recent")).forEach((ev) => addFeed(ev, false)); } catch { }
  if (!$("#feedList").children.length) $("#feedList").innerHTML = `<li class="muted">Henüz gelişme yok. Yeni kadro, eksik, haber ve goller burada görünecek.</li>`;
}

/* ---------- yönlendirme ---------- */
function route() {
  const m = location.hash.match(/^#\/mac\/(\d+)/);
  if (m) { state.current = +m[1]; window.scrollTo(0, 0); renderMatch(state.current); }
  else { state.current = null; renderDay(); }
}
function shiftDay(n) {
  const d = new Date(state.date + "T12:00:00"); d.setDate(d.getDate() + n);
  setDate(d.toLocaleDateString("sv-SE"));
}
function setDate(s) { state.date = s; $("#date").value = s; if (location.hash.startsWith("#/mac")) location.hash = "#/"; else renderDay(); }

/* ---------- statik mod (GitHub Pages): şifre ve yoklama ---------- */
async function showLogin(err) {
  $("#toolbar").classList.add("hidden");
  $("#view").innerHTML = `<form id="login" class="card" style="max-width:360px;margin:40px auto">
    <h2>Giriş</h2><p class="muted">Siteyi görmek için şifreyi gir. Bu cihaz şifreyi hatırlar.</p>
    <input id="pw" type="password" autocomplete="current-password" placeholder="Şifre" required
      style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font:inherit">
    <button type="submit" style="width:100%;margin-top:10px;background:var(--accent);border-color:var(--accent);font-weight:600">Giriş</button>
    <div id="loginErr" style="color:var(--bad);margin-top:8px">${esc(err || "")}</div></form>`;
  $("#pw").focus();
  $("#login").onsubmit = async (e) => {
    e.preventDefault();
    $("#loginErr").textContent = "Kontrol ediliyor…";
    try {
      const raw = await deriveKeyBytes($("#pw").value);
      if (await unlockWith(raw)) { safeSet("siteKey", b64e(raw)); boot(); }
      else $("#loginErr").textContent = "Şifre yanlış";
    } catch (ex) { $("#loginErr").textContent = "Hata: " + ex.message; }
  };
}
async function unlockWith(raw) {
  KEY = await importAesKey(raw);
  try { meta = await getData("meta.json"); return true; }
  catch (e) { KEY = null; if (e.message === "NOTFOUND") throw new Error("Site verisi henüz yayınlanmadı"); return false; }
}
function showUpdated() {
  if (meta) $("#updatedAt").textContent = "Son güncelleme: " + ago(new Date(meta.updated * 1000).toISOString()) + " ·";
}
function startPolling() {
  let lastEv = +(safeGet("lastEventId") || 0);
  const tick = async () => {
    try {
      const m = await getData("meta.json");
      if (meta && m.updated === meta.updated) { showUpdated(); return; }
      meta = m; showUpdated();
      const evs = await getData("events.json");
      evs.filter((e) => e.id > lastEv).reverse().forEach((ev) => { toast(ev); addFeed(ev, true); });
      if (evs.length) { lastEv = Math.max(lastEv, evs[0].id); safeSet("lastEventId", String(lastEv)); }
      state.current ? renderMatch(state.current, true) : renderDay(true);
    } catch { /* bir sonraki turda tekrar dener */ }
  };
  $("#liveDot").classList.add("on");
  setInterval(tick, 60000);
}

let ready = false;
async function boot() {
  if (STATIC) {
    if (!KEY) {
      const saved = safeGet("siteKey");
      let ok = false;
      if (saved) { try { ok = await unlockWith(b64d(saved)); } catch (e) { return showLogin(e.message); } }
      if (!ok) return showLogin();
    }
    if (!safeGet("lastEventId")) {
      // ilk girişte eski olayları "yeni" saymamak için
      try { const evs = await getData("events.json"); safeSet("lastEventId", String(evs.length ? evs[0].id : 0)); } catch { }
    }
    showUpdated();
  }
  ready = true;
  $("#toolbar").classList.remove("hidden");
  await initLeagues();
  route();
  loadFeed();
  STATIC ? startPolling() : connect();
}

$("#date").value = state.date;
$("#date").onchange = (e) => setDate(e.target.value);
$("#prevDay").onclick = () => shiftDay(-1);
$("#nextDay").onclick = () => shiftDay(1);
$("#today").onclick = () => setDate(todayStr());
$("#bell").onclick = () => { $("#feed").classList.toggle("hidden"); state.unread = 0; $("#bellCount").textContent = ""; };
window.addEventListener("hashchange", () => { if (ready) route(); });
// liste görünümünü 60 sn'de bir sessizce tazele (canlı skorlar için)
if (!STATIC) setInterval(() => { if (ready && !state.current) renderDay(true); }, 60000);

boot();
