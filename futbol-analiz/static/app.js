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
  player: null, // açık oyuncu id
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
  if (path === "/api/karne") {
    try { return await getData("karne.json"); }
    catch (e) { if (e.message === "NOTFOUND") return []; throw e; }
  }
  if ((m = path.match(/^\/api\/player\/(\d+)/))) {
    try { return await getData(`player-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu oyuncunun istatistikleri henüz hazırlanmadı, 15-20 dakika sonra tekrar bak."); throw e; }
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
  if (state.current || state.player || state.karne) return;
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
  if (typeof liveTick === "function") setTimeout(liveTick, 50);  // kartlara anlık skorları uygula
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
      ${p.safe ? `<span class="pill safe"><i>✅</i>${esc(p.safe.label.replace(/ \(.*\)$/, ""))}${p.safe.odds ? ` @${nf(p.safe.odds, 2)}` : ""}</span>` : ""}
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
  // t: hazır HTML (logolu takım adları)
  const tile = (cls, ic, k, m, t, s) => `<div class="hl ${cls}" data-id="${m.id}"><div class="ic">${ic}</div>
    <div class="hlb"><div class="k">${k}</div><div class="t">${t}</div><div class="s">${esc(s)}</div></div></div>`;
  const tl = (team) => `<span class="hlt"><img src="${teamLogo(team.id)}" alt="" onerror="this.remove()">${esc(team.name)}</span>`;
  const pair = (m) => `${tl(m.home)}<span class="hlv">-</span>${tl(m.away)}`;
  const opp = favSide === "home" ? favM.away : favM.home;
  return `<div class="highlights">
    ${tile("fav", "★", "En net favori", favM, tl(favM[favSide]), `Rakip: ${opp.name} · kazanma ${pc(favM.pred["p_" + favSide])}`)}
    ${tile("goal", "⚽", "En gollü maç beklentisi", goalM, pair(goalM), `2.5 Üst ${pc(goalM.pred.over25)} · KG ${pc(goalM.pred.btts)}`)}
    ${tile("even", "⚖", "En dengeli maç", evenM, pair(evenM), `1 ${pc(evenM.pred.p_home)} · X ${pc(evenM.pred.p_draw)} · 2 ${pc(evenM.pred.p_away)}`)}
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
  "mostly clear": "çoğunlukla açık", "partly sunny": "parçalı güneşli", "drizzle": "çiseleyen yağmur",
  "scattered thunderstorms": "yer yer gök gürültülü sağanak", "isolated thunderstorms": "yer yer gök gürültülü sağanak",
  "scattered showers": "yer yer sağanak", "light rain showers": "hafif sağanak", "rain showers": "sağanak", "light showers": "hafif sağanak",
  "thunderstorm": "gök gürültülü sağanak", "mist": "puslu", "haze": "puslu", "fair": "açık", "light snow": "hafif karlı",
  "rain and snow": "karla karışık yağmur", "freezing rain": "dondurucu yağmur", "mostly cloudy night": "çok bulutlu", "clear night": "açık" };
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
  if (matchTabId !== id) { matchTab = defaultMatchTab(b); matchTabId = id; }  // yeni maç: varsayılan sekme
  v.innerHTML = matchHtml(b);
  bindMatch();
  if (silent) window.scrollTo(0, y);
}
const REFRESH_LABEL = () => STATIC ? "Yeni veri var mı?" : "Şimdi yenile";
function bindMatch() {
  if (typeof liveTick === "function") setTimeout(liveTick, 50);  // canlı kutuyu hemen doldur
  $("#view").querySelectorAll("[data-mt]").forEach((t) => t.onclick = () => {
    matchTab = t.dataset.mt;
    $("#view").querySelectorAll("[data-mt]").forEach((x) => x.classList.toggle("on", x.dataset.mt === matchTab));
    $(".mtab-body").innerHTML = matchTabBody(lastB);
    // aşağı kaydırılmışsa yeni sekmenin başına dön (sekme çubuğu üstte sabit kalır)
    const bar = $(".mtabs"), body = $(".mtab-body");
    const target = body.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - 64;
    if (window.scrollY > target) window.scrollTo(0, target);
    t.scrollIntoView({ inline: "center", block: "nearest" });
    if (typeof liveTick === "function") setTimeout(liveTick, 50);
  });
  const btn = $("#refreshBtn");
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = STATIC ? "Kontrol ediliyor…" : "Yenileniyor…";
    try {
      if (STATIC) {
        // çevrimiçi sürümde analiz GitHub'da 6 dk'da bir üretilir; burada sadece yenisi yayınlanmış mı bakılır
        const m = await getData("meta.json");
        const fresh = !meta || m.updated !== meta.updated;
        meta = m; showUpdated();
        if (fresh) {
          await renderMatch(state.current, true);
          toast({ text: "Yeni veriler yüklendi", match_id: state.current });
          return;
        }
        const left = Math.round((m.updated + 6 * 60 - Date.now() / 1000) / 60);
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
  const fav = favoriteSide(P);
  const chips = [
    b.round && chip("🗓️", esc(b.round) + ". hafta"),
    b.venue && chip("🏟️", esc(b.venue)),
    b.referee && chip(WHISTLE, "Hakem: " + esc(b.referee)),
    w && chip(weatherIcon(w.description), `${w.temperature}°C · ${esc(cap(trWeather(w.description)))}${w.windSpeed != null ? ` · Rüzgar ${w.windSpeed} m/s` : ""}`),
  ].filter(Boolean).join("");
  const conf = { "Yüksek": "#3fb950", "Orta": "#d29922", "Düşük": "#f85149" }[P.confidence] || "#8b98a8";
  return `
  <div class="hero">
    <div class="hero-league"><img src="${leagueLogo(b.league_id)}" alt="" onerror="this.remove()"><b>${esc(b.league_name)}</b></div>
    <div class="teams">
      <div class="team">${crestHtml(b.home, fav === "home", P.p_home, 84)}<span>${esc(H)}</span>${formDots(b.recent.home.rows)}</div>
      <div class="score ${live ? "live" : ""}">${esc(scoreTxt)}<small>${esc(stTxt)}</small></div>
      <div class="team">${crestHtml(b.away, fav === "away", P.p_away, 84)}<span>${esc(W)}</span>${formDots(b.recent.away.rows)}</div>
    </div>
    <div class="chips">${chips}</div>
    <div class="updated">${b.status.finished ? "Maç sona erdi · tahminler maç öncesi hâliyle saklanıyor"
      : `Son güncelleme: ${ago(b.updated)}${STATIC ? " (analizler 6 dk'da bir, skorlar anlık yenilenir)" : ""} · <button id="refreshBtn">${REFRESH_LABEL()}</button>`}</div>
  </div>
  ${matchTabsHtml(b)}
  <div class="mtab-body">${matchTabBody(b)}</div>`;
}

/* ---------- maç sayfası sekmeleri ----------
   Başlamış maçlar Canlı (bittiyse Maç) sekmesinde, diğerleri Özet sekmesinde açılır. */
function defaultMatchTab(b) { return b.status && (b.status.started || b.status.finished) ? "live" : "ozet"; }
function matchTabList(b) {
  const st = b.status || {}, live = st.started && !st.finished;
  const nOdds = (b.odds && b.odds.markets || []).length;
  const nNews = ((b.news.home.tr || []).length + (b.news.away.tr || []).length);
  const t = [];
  if (st.started || st.finished) t.push(["live", live ? "🔴 Canlı" : "🏁 Maç", live ? (st.live || "") : ""]);
  t.push(["ozet", "📊 Özet", ""], ["kadro", "👥 Kadrolar", b.lineup ? lineupTypeShort(b.lineup.type) : ""],
    ["analiz", "🧠 Takım analizi", ""], ["istat", "📈 İstatistikler", ""],
    ["odds", "💰 Oranlar", nOdds ? nOdds + " pazar" : ""], ["haber", "📰 Haberler", nNews ? String(nNews) : ""]);
  return t;
}
const lineupTypeShort = (t) => ({ predicted: "olası", lastStarting11: "son 11" }[t] || (t ? "resmi" : ""));
function matchTabsHtml(b) {
  return `<div class="ptabs mtabs">${matchTabList(b).map(([k, l, sub]) =>
    `<button class="ptab ${matchTab === k ? "on" : ""} ${k === "live" && b.status.started && !b.status.finished ? "tlive" : ""}" data-mt="${k}">${l}${sub ? ` <small>${esc(sub)}</small>` : ""}</button>`).join("")}</div>`;
}
function matchTabBody(b) {
  const A = b.analysis, H = b.home.name, W = b.away.name;
  switch (matchTab) {
    case "live":
      return `<div id="liveBox"><div class="card"><p class="muted">Canlı veriler yükleniyor…</p></div></div>`;
    case "kadro":
      return `<div id="liveLineup"></div>${lineupHtml(b)}`;
    case "analiz":
      return `<div class="grid2">
        ${teamHtml(A.home, b.home, b.recent.home.rows, "var(--home)")}
        ${teamHtml(A.away, b.away, b.recent.away.rows, "var(--away)")}</div>`;
    case "istat":
      return `${compareHtml(b)}
        <div class="grid2">${recentHtml(b.recent.home, H, "home-c")}${recentHtml(b.recent.away, W, "away-c")}</div>
        ${seasonHtml(b)}`;
    case "odds":
      return oddsHtml(b);
    case "haber":
      return `<div class="grid2">${newsHtml(b.news.home, H, "home-c")}${newsHtml(b.news.away, W, "away-c")}</div>${extrasHtml(b)}`;
    default:
      return `${commentaryHtml(A)}${predictionHtml(b)}`;
  }
}
function predictionHtml(b) {
  const A = b.analysis, P = A.prediction, H = b.home.name, W = b.away.name;
  const conf = { "Yüksek": "#3fb950", "Orta": "#d29922", "Düşük": "#f85149" }[P.confidence] || "#8b98a8";
  return `
  <div class="card" style="--c:#a371f7">
    ${head("🎯", `Tahmin ve model özeti${A.frozen ? ` <span class="muted">· maç öncesi tahmin, başlama düdüğünde donduruldu 🔒</span>` : ""}`)}
    <div class="summary">${esc(A.summary)}</div>
    <div class="bigbar">
      <div style="flex:${P.p_home};background:var(--home)" title="${esc(H)} kazanır">1 ${pc(P.p_home)}</div>
      <div style="flex:${P.p_draw};background:var(--draw)" title="Beraberlik">X ${pc(P.p_draw)}</div>
      <div style="flex:${P.p_away};background:var(--away)" title="${esc(W)} kazanır">2 ${pc(P.p_away)}</div>
    </div>
    <div class="pred">
      ${P.best_pick ? kpi("✅", "#2ea043", "En garanti tercih", P.best_pick.label, `${P.best_pick.odds ? "Oran " + nf(P.best_pick.odds, 2) + " · " : ""}model ${pc(P.best_pick.p)}`) : ""}
      ${P.surprise ? kpi("⚡", "#e3b341", "Olası sürpriz", P.surprise.label, `${P.surprise.odds ? "Oran " + nf(P.surprise.odds, 2) + " · " : ""}model ${pc(P.surprise.p)}`) : ""}
      ${kpi("🎲", "#a371f7", "Skor tahmini", (P.score_pick || P.scores[0]).score, "Diğer olasılar: " + P.scores.filter((s) => s.score !== (P.score_pick || {}).score).slice(0, 3).map((s) => s.score).join(" · "))}
      ${kpi("⚽", "#f85149", "Beklenen gol (xG)", `${nf(P.lam_home, 2)} – ${nf(P.lam_away, 2)}`, P.uses_odds ? "İstatistik + bahis oranları" : "İstatistik modeli")}
      ${kpi("📈", "#3fb950", "Toplam gol", `2.5 Üst ${pc(P.over25)}`, `1.5Ü ${pc(P.over15)} · 3.5Ü ${pc(P.over35)}`)}
      ${kpi("🔁", "#58a6ff", "Karşılıklı gol", pc(P.btts), "KG Var olasılığı")}
      ${P.corners ? kpi("🚩", "#d29922", "Korner beklentisi", `${nf(P.corners.home)} – ${nf(P.corners.away)}`, `Toplam ${nf(P.corners.total)} · 9.5Ü ${pc(P.corners.over["9.5"])} · 10.5Ü ${pc(P.corners.over["10.5"])}`) : ""}
      ${P.shots.home != null ? kpi("🥅", "#f78166", "Şut beklentisi", `${nf(P.shots.home)} – ${nf(P.shots.away)}`, `İsabetli: ${nf(P.sot.home)} – ${nf(P.sot.away)}`) : ""}
      ${P.yellow.total != null ? kpi("🟨", "#e3b341", "Sarı kart ort.", nf(P.yellow.total), `${nf(P.yellow.home)} + ${nf(P.yellow.away)} (son maçlar)`) : ""}
      ${kpi("🧠", conf, "Model güveni", P.confidence, "Veri miktarına göre")}
    </div>
    <h3>Olası senaryolar</h3>
    <ul class="scen">${A.scenarios.map((s) => `<li><span class="si">${scenarioIcon(s)}</span><span>${esc(s)}</span></li>`).join("")}</ul>
  </div>`;
}
/* ---------- maç yorumu ---------- */
function commentaryHtml(A) {
  const c = A.commentary;
  if (!c || !c.paragraphs || !c.paragraphs.length) return "";
  const last = c.paragraphs.length - 1;
  return `<div class="card comm" style="--c:#39c5cf">${head("🗣️", `Maç yorumu <span class="muted">· kaynaklar, seriler, puan durumu ve oranlara göre</span>`)}
    ${c.tags && c.tags.length ? `<div class="ctags">${c.tags.map((t) => `<span class="ctag">${esc(t)}</span>`).join("")}</div>` : ""}
    ${c.paragraphs.map((p, i) => `<p class="${i === last ? "cconcl" : ""}">${esc(p)}</p>`).join("")}
  </div>`;
}

/* ---------- maç sayfası sekmeleri ve oranlar ---------- */
let matchTab = "ozet", matchTabId = null;
const ODDS_GROUPS = ["Maç", "Goller", "Yarılar", "Korner", "Kart ve penaltı", "Skor", "Oyuncular", "Diğer"];
const GROUP_IC = { "Maç": "⚽", "Goller": "🥅", "Yarılar": "⏱️", "Korner": "🚩", "Kart ve penaltı": "🟨", "Skor": "🎯", "Oyuncular": "🏃", "Diğer": "📋" };
function oddsHtml(b) {
  const P = b.analysis.prediction, o = b.odds;
  if (!o || !o.markets || !o.markets.length) return `<div class="card"><p class="muted">Bu maç için henüz bahis oranı bulunamadı. Oranlar genelde maçtan 1-3 gün önce açılır.</p></div>`;
  const probs = P.probs || {};
  const safe = P.best_pick && P.best_pick.code, sur = P.surprise && P.surprise.code;
  const pickCard = (cls, ic, title, x, note) => x ? `<div class="opick ${cls}"><div class="oi">${ic}</div><div>
      <div class="k">${title}</div><b>${esc(x.label)}</b>
      <div class="s">${x.odds ? `Oran <b>${nf(x.odds, 2)}</b> · ` : ""}Model olasılığı <b>${pc(x.p)}</b>${x.odds ? ` · Piyasa ${pc(1 / x.odds)}` : ""}</div>
      <small class="muted">${note}</small></div></div>` : "";
  const top = `<div class="card" style="--c:#e3b341">${head("💰", `Bahis oranları <span class="muted">· ${esc((o.providers || []).join(", "))}</span>`)}
    <div class="opicks">
      ${pickCard("safe", "✅", "En garanti tercih", P.best_pick, "Oranı 1.30 ve üstü seçenekler arasında modelin en yüksek olasılık verdiği tercih.")}
      ${pickCard("sur", "⚡", "Olası sürpriz", P.surprise, "Oranı yüksek ama modelin piyasadan daha olası gördüğü seçenek. Karnede yer almaz.")}
    </div>
    <p class="muted">Model gol beklentisini istatistiklerle bahis oranlarını harmanlayarak hesaplar${P.lam_market ? ` (piyasa: ${nf(P.lam_market[0], 2)} – ${nf(P.lam_market[1], 2)} gol, istatistik: ${nf(P.lam_model[0], 2)} – ${nf(P.lam_model[1], 2)})` : ""}. Tablolarda: oran, oranın ima ettiği olasılık (marjı temizlenmiş), modelin olasılığı ve <b>değer</b> (model olasılığı × oran − 1; yeşil = model piyasadan iyimser). 1.30 altındaki oranlar tercih dışıdır.</p></div>`;
  const groups = ODDS_GROUPS.map((g) => {
    const ms = o.markets.filter((m) => m.group === g);
    if (!ms.length) return "";
    return `<div class="card" style="--c:#58a6ff">${head(GROUP_IC[g], g)}<div class="omkts">${ms.map((m) => marketHtml(m, probs, safe, sur, b)).join("")}</div></div>`;
  }).join("");
  return top + groups;
}
function marketHtml(m, probs, safe, sur, b) {
  // "1" / "2" seçeneklerinin yanına takım adı
  const lab = (l) => l === "1" ? `1 · ${b.home.name}` : l === "2" ? `2 · ${b.away.name}` : l;
  const many = m.selections.length > 8;
  const inv = m.selections.map((s) => 1 / s.odds), tot = inv.reduce((a, x) => a + x, 0);
  const rows = m.selections.map((s, i) => {
    const mp = s.code != null ? probs[s.code] : null;
    const ip = !many && tot ? inv[i] / tot : null;
    const val = mp != null ? mp * s.odds - 1 : null;
    const cls = s.code && s.code === safe ? "safe" : s.code && s.code === sur ? "sur" : "";
    return `<div class="orow ${cls} ${s.odds < 1.3 ? "low" : ""}">
      <span class="ol">${esc(lab(s.label))}${cls === "safe" ? ` <i class="otag safe">Garanti</i>` : cls === "sur" ? ` <i class="otag sur">Sürpriz</i>` : ""}</span>
      <span class="oo">${nf(s.odds, 2)}</span>
      <span class="op">${ip != null ? pc(ip) : ""}</span>
      <span class="om">${mp != null ? pc(mp) : ""}</span>
      <span class="ov ${val == null ? "" : val > 0.05 ? "pos" : val < -0.1 ? "neg" : ""}">${val == null ? "" : (val > 0 ? "+" : "") + Math.round(val * 100) + "%"}</span></div>`;
  }).join("");
  return `<div class="omkt"><div class="omh"><b>${esc(m.title)}</b><small class="muted">${esc(m.provider || "")}</small></div>
    <div class="orow ohead"><span class="ol">Seçenek</span><span class="oo">Oran</span><span class="op">${many ? "" : "Piyasa"}</span><span class="om">Model</span><span class="ov">Değer</span></div>
    <div class="${many ? "oscroll" : ""}">${rows}</div></div>`;
}

const kpi = (ic, color, l, v, s) => `<div class="kpi" style="--k:${color}"><div class="l"><span class="ki">${ic}</span>${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || "")}</div></div>`;
const head = (ic, title, extra = "") => `<h2 class="ch"><span class="ci">${ic}</span><span class="ct">${title}</span>${extra}</h2>`;
// hakem düdüğü (emoji setinde düdük yok)
const WHISTLE = `<svg class="whistle" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 10.5a5.5 5.5 0 0 0 9.9 3.3H21V9.5h-8.4l-1.8-1.6A5.5 5.5 0 0 0 3 10.5z" fill="#c9d1d9"/><circle cx="8.5" cy="10.5" r="2.2" fill="#0d1117"/><rect x="14.5" y="7.2" width="3" height="2.6" rx=".8" fill="#c9d1d9"/><path d="M8.5 5V2.8" stroke="#e3b341" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const chip = (ic, html) => `<span class="mchip"><span>${ic}</span>${html}</span>`;
const cap = (s) => s ? s.charAt(0).toLocaleUpperCase("tr") + s.slice(1) : s;
function weatherIcon(d) {
  d = (d || "").toLowerCase();
  if (d.includes("thunder") || d.includes("storm")) return "⛈️";
  if (d.includes("snow")) return "❄️";
  if (d.includes("rain") || d.includes("shower") || d.includes("drizzle")) return "🌧️";
  if (d.includes("fog")) return "🌫️";
  if (d.includes("partly")) return "⛅";
  if (d.includes("cloud") || d.includes("overcast")) return "☁️";
  if (d.includes("sun") || d.includes("clear")) return "☀️";
  return "🌡️";
}
function scenarioIcon(s) {
  const t = s.toLowerCase();
  if (t.includes("erken gol")) return "⏱️";
  if (t.includes("korner")) return "🚩";
  if (t.includes("duran top")) return "🎯";
  if (t.includes("eksik") || t.includes("bu maçta yok")) return "🚑";
  if (t.includes("hava") || t.includes("yağış") || t.includes("rüzgar")) return "🌦️";
  if (t.includes("aralarındaki")) return "🤝";
  if (t.includes("gollü") || t.includes("az pozisyonlu")) return "⚽";
  if (t.includes("ceza sahası dışından")) return "💥";
  if (t.includes("topa sahip") || t.includes("kontrol")) return "🧭";
  if (t.includes("dengeli")) return "⚖️";
  return "💡";
}
// son maçların sonucu: yeşil G, gri B, kırmızı M (en yenisi solda)
function formDots(rows) {
  if (!rows || !rows.length) return "";
  return `<div class="form">${rows.slice(0, 5).map((r) =>
    `<span class="fd ${r.result || ""}" title="${esc(dateOf(r.date))} · ${esc(r.opponent)} ${r.gf}-${r.ga}">${r.result || "-"}</span>`).join("")}</div>`;
}

const SEC = {
  plan: ["🧭", "#58a6ff", "Oyun planı ve taktik"], attack: ["⚽", "#f85149", "Hücum: şut ve xG"],
  setpiece: ["🚩", "#d29922", "Korner ve duran top"], defence: ["🛡️", "#3fb950", "Savunma"],
  form: ["📈", "#a371f7", "Form ve puan durumu"], absent: ["🚑", "#f78166", "Eksikler"],
  players: ["⭐", "#e3b341", "Kilit oyuncular (sezon)"],
};
function teamHtml(p, team, rows, color) {
  return `<div class="card team-card" style="--c:${color}">
    <h2 class="ch">${crestHtml(team, false, 0, 40)}<span class="ct">${esc(p.name)} <span class="muted">analizi</span></span>${formDots(rows)}</h2>
    ${Object.entries(SEC).map(([k, [ic, c, t]]) => p.sections[k] && p.sections[k].length ? `
      <div class="sec" style="--sc:${c}"><h3><span class="si">${ic}</span>${t}</h3>
      <ul>${p.sections[k].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "").join("")}
  </div>`;
}

const ABSENT_TR = { injury: "Sakat", suspension: "Cezalı", "red card": "Cezalı", "yellow card": "Kart cezalı",
  "international duty": "Milli takımda", other: "Kadroda yok" };
// FotMob ülke adları İngilizce gelir
const COUNTRY_TR = {
  "Turkiye": "Türkiye", "Türkiye": "Türkiye", "Turkey": "Türkiye", "Germany": "Almanya", "France": "Fransa", "Spain": "İspanya",
  "Italy": "İtalya", "England": "İngiltere", "Netherlands": "Hollanda", "Portugal": "Portekiz", "Belgium": "Belçika",
  "Brazil": "Brezilya", "Argentina": "Arjantin", "Croatia": "Hırvatistan", "Serbia": "Sırbistan", "Cameroon": "Kamerun",
  "Nigeria": "Nijerya", "Ghana": "Gana", "Senegal": "Senegal", "Ivory Coast": "Fildişi Sahili", "Côte d'Ivoire": "Fildişi Sahili",
  "Morocco": "Fas", "Algeria": "Cezayir", "Tunisia": "Tunus", "Egypt": "Mısır", "Mali": "Mali", "Guinea": "Gine",
  "DR Congo": "Kongo DC", "Congo DR": "Kongo DC", "Congo": "Kongo", "Gabon": "Gabon", "Cape Verde": "Yeşil Burun Adaları",
  "Angola": "Angola", "South Africa": "Güney Afrika", "Zambia": "Zambiya", "Burkina Faso": "Burkina Faso", "Benin": "Benin",
  "Togo": "Togo", "Gambia": "Gambiya", "Sierra Leone": "Sierra Leone", "Kenya": "Kenya", "Zimbabwe": "Zimbabve",
  "Guinea-Bissau": "Gine-Bissau", "Equatorial Guinea": "Ekvator Ginesi", "Mozambique": "Mozambik", "Madagascar": "Madagaskar",
  "Comoros": "Komorlar", "Libya": "Libya", "Sudan": "Sudan", "Tanzania": "Tanzanya", "Uganda": "Uganda", "Liberia": "Liberya",
  "Mauritania": "Moritanya", "Central African Republic": "Orta Afrika Cumhuriyeti", "Chad": "Çad", "Niger": "Nijer",
  "Burundi": "Burundi", "Rwanda": "Ruanda", "Ethiopia": "Etiyopya",
  "USA": "ABD", "United States": "ABD", "Canada": "Kanada", "Mexico": "Meksika", "Colombia": "Kolombiya", "Uruguay": "Uruguay",
  "Chile": "Şili", "Peru": "Peru", "Paraguay": "Paraguay", "Ecuador": "Ekvador", "Venezuela": "Venezuela", "Bolivia": "Bolivya",
  "Costa Rica": "Kosta Rika", "Jamaica": "Jamaika", "Panama": "Panama", "Honduras": "Honduras", "Haiti": "Haiti",
  "Curacao": "Curaçao", "Curaçao": "Curaçao", "Suriname": "Surinam", "Trinidad and Tobago": "Trinidad ve Tobago",
  "El Salvador": "El Salvador", "Guatemala": "Guatemala", "Dominican Republic": "Dominik Cumhuriyeti", "Cuba": "Küba",
  "Japan": "Japonya", "South Korea": "Güney Kore", "Korea Republic": "Güney Kore", "China": "Çin", "Australia": "Avustralya",
  "New Zealand": "Yeni Zelanda", "Iran": "İran", "Saudi Arabia": "Suudi Arabistan", "Qatar": "Katar", "Iraq": "Irak",
  "Israel": "İsrail", "Lebanon": "Lübnan", "Jordan": "Ürdün", "Syria": "Suriye", "United Arab Emirates": "BAE", "UAE": "BAE",
  "Oman": "Umman", "Bahrain": "Bahreyn", "Kuwait": "Kuveyt", "Uzbekistan": "Özbekistan", "Kazakhstan": "Kazakistan",
  "Indonesia": "Endonezya", "Philippines": "Filipinler", "Thailand": "Tayland", "Vietnam": "Vietnam", "India": "Hindistan",
  "Georgia": "Gürcistan", "Armenia": "Ermenistan", "Azerbaijan": "Azerbaycan", "Ukraine": "Ukrayna", "Russia": "Rusya",
  "Poland": "Polonya", "Czechia": "Çekya", "Czech Republic": "Çekya", "Slovakia": "Slovakya", "Slovenia": "Slovenya",
  "Hungary": "Macaristan", "Austria": "Avusturya", "Switzerland": "İsviçre", "Denmark": "Danimarka", "Sweden": "İsveç",
  "Norway": "Norveç", "Finland": "Finlandiya", "Iceland": "İzlanda", "Scotland": "İskoçya", "Wales": "Galler",
  "Northern Ireland": "Kuzey İrlanda", "Ireland": "İrlanda", "Republic of Ireland": "İrlanda", "Greece": "Yunanistan",
  "Cyprus": "Kıbrıs", "Albania": "Arnavutluk", "Kosovo": "Kosova", "North Macedonia": "Kuzey Makedonya",
  "Montenegro": "Karadağ", "Bosnia and Herzegovina": "Bosna-Hersek", "Bosnia & Herzegovina": "Bosna-Hersek",
  "Bulgaria": "Bulgaristan", "Romania": "Romanya", "Moldova": "Moldova", "Belarus": "Belarus", "Lithuania": "Litvanya",
  "Latvia": "Letonya", "Estonia": "Estonya", "Luxembourg": "Lüksemburg", "Malta": "Malta", "Faroe Islands": "Faroe Adaları",
  "Andorra": "Andorra", "Liechtenstein": "Lihtenştayn", "San Marino": "San Marino", "Gibraltar": "Cebelitarık",
};
const countryTr = (c) => COUNTRY_TR[c] || c;
// FotMob ülke adı -> FIFA kodu (bayrak görseli için); kadrolarda kod doğrudan gelir
const COUNTRY_CODE = {"Albania":"ALB","Algeria":"ALG","Andorra":"AND","Angola":"ANG","Argentina":"ARG","Armenia":"ARM","Australia":"AUS","Austria":"AUT","Azerbaijan":"AZE","Bangladesh":"BAN","Barbados":"BRB","Belarus":"BLR","Belgium":"BEL","Benin":"BEN","Bolivia":"BOL","Bosnia and Herzegovina":"BIH","Botswana":"BOT","Brazil":"BRA","Bulgaria":"BUL","Burkina Faso":"BFA","Burundi":"BDI","Cameroon":"CMR","Canada":"CAN","Cape Verde":"CPV","Central African Rep.":"CTA","Chad":"CHA","Chile":"CHI","Colombia":"COL","Comoros":"COM","Congo":"CGO","Costa Rica":"CRC","Croatia":"CRO","Cuba":"CUB","Curacao":"CUW","Curaçao":"CUW","Cyprus":"CYP","Czechia":"CZE","Côte d'Ivoire":"CIV","DR Congo":"COD","Denmark":"DEN","Dominican Republic":"DOM","Ecuador":"ECU","Egypt":"EGY","England":"ENG","Equatorial Guinea":"EQG","Eritrea":"ERI","Estonia":"EST","Faroe Islands":"FRO","Finland":"FIN","France":"FRA","Gabon":"GAB","Gambia":"GAM","Georgia":"GEO","Germany":"GER","Ghana":"GHA","Gibraltar":"GIB","Greece":"GRE","Grenada":"GRN","Guadeloupe":"GLP","Guinea":"GUI","Guinea-Bissau":"GNB","Guyana":"GUY","Haiti":"HAI","Honduras":"HON","Hungary":"HUN","Iceland":"ISL","Indonesia":"IDN","Iran":"IRN","Iraq":"IRQ","Ireland":"IRL","Israel":"ISR","Italy":"ITA","Ivory Coast":"CIV","Jamaica":"JAM","Japan":"JPN","Jordan":"JOR","Kazakhstan":"KAZ","Kenya":"KEN","Korea Republic":"KOR","Kosovo":"KVX","Latvia":"LVA","Lebanon":"LIB","Liberia":"LBR","Liechtenstein":"LIE","Lithuania":"LTU","Luxembourg":"LUX","Madagascar":"MAD","Malaysia":"MAS","Mali":"MLI","Martinique":"MTQ","Mauritania":"MTN","Mexico":"MEX","Moldova":"MDA","Mongolia":"MGL","Montenegro":"MNE","Morocco":"MAR","Mozambique":"MOZ","Netherlands":"NED","Netherlands Antilles":"ANT","New Zealand":"NZL","Nicaragua":"NCA","Niger":"NIG","Nigeria":"NGA","North Macedonia":"MKD","Northern Ireland":"NIR","Norway":"NOR","Pakistan":"PAK","Palestine":"PLE","Panama":"PAN","Paraguay":"PAR","Peru":"PER","Philippines":"PHI","Poland":"POL","Portugal":"POR","Puerto Rico":"PUR","Republic of Ireland":"IRL","Romania":"ROU","Russia":"RUS","Rwanda":"RWA","Sao Tome and Principe":"STP","Saudi Arabia":"KSA","Scotland":"SCO","Senegal":"SEN","Serbia":"SRB","Sierra Leone":"SLE","Slovakia":"SVK","Slovenia":"SVN","Somalia":"SOM","South Africa":"RSA","South Korea":"KOR","Spain":"ESP","St. Kitts and Nevis":"SKN","Suriname":"SUR","Sweden":"SWE","Switzerland":"SUI","Syria":"SYR","Tajikistan":"TJK","Tanzania":"TAN","Thailand":"THA","The Gambia":"GAM","Togo":"TOG","Trinidad and Tobago":"TRI","Tunisia":"TUN","Turkiye":"TUR","USA":"USA","Uganda":"UGA","Ukraine":"UKR","Uruguay":"URU","Uzbekistan":"UZB","Venezuela":"VEN","Wales":"WAL","Zambia":"ZAM","Zimbabwe":"ZIM","Türkiye":"TUR","Turkey":"TUR","United States":"USA"};
function flagHtml(name, code) {
  const c = (code || COUNTRY_CODE[name] || "").toLowerCase();
  const label = esc(countryTr(name) || "");
  if (!c) return label;
  return `<img class="flag" src="https://images.fotmob.com/image_resources/logo/teamlogo/${c}.png" alt="${label}" title="${label}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${label.replace(/'/g, "")}'))">`;
}

// Oyuncu fotoğrafı (FotMob); yüklenemezse forma numarası ya da boş avatar gösterilir
function playerImg(id, shirt) {
  const fb = String(shirt || "").replace(/\D/g, "");
  return `<span class="pimg" data-fb="${fb}"><img src="https://images.fotmob.com/image_resources/playerimages/${Number(id) || 0}.png" alt="" loading="lazy"
    onerror="this.parentNode.classList.add('noimg');this.remove()"></span>`;
}

function lineupHtml(b) {
  const lu = b.lineup;
  if (!lu) return `<div class="card" style="--c:#2ea043">${head("👥", "Kadrolar")}<p class="muted">Kadro bilgisi henüz yok.</p></div>`;
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
    return `<div class="pl ${cls}" data-pid="${Number(p.id) || 0}" title="${esc(p.name)} · istatistikler" style="left:${left}%;top:${top}%">
      <div class="ph">${playerImg(p.id, p.shirt)}${p.shirt ? `<span class="no">${esc(p.shirt)}</span>` : ""}</div>
      <div class="nm">${esc(p.last)}</div>${p.rating ? `<div class="rt">${nf(p.rating, 1)}</div>` : ""}</div>`;
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
    return u.map((p) => {
      const t = (p.type || "").toLowerCase();
      const kind = t === "injury" ? "inj" : "sus";
      return `<li class="prow" data-pid="${Number(p.id) || 0}">${playerImg(p.id)}<div class="pinfo"><b>${esc(p.name)}</b>
        <small><span class="ptag ${kind}">${esc(ABSENT_TR[t] || cap(p.type) || "Kadroda yok")}</span>${p.return ? " Dönüş: " + esc(cap(p.return)) : ""}</small></div></li>`;
    }).join("");
  };
  const side = (s, cls, name) => `<div><h3 class="${cls}">${esc(name)} · ${esc(lu[s].formation || "")}</h3>
    <div class="muted">Teknik direktör: ${esc(lu[s].coach || "—")}${lu[s].avg_age ? " · İlk 11 yaş ort. " + nf(lu[s].avg_age, 1) : ""}</div>
    <ul class="plist">${(lu[s].starters || []).map((p) => `<li class="prow" data-pid="${Number(p.id) || 0}">${playerImg(p.id, p.shirt)}
      <div class="pinfo"><b>${p.shirt ? `<span class="shirt">${esc(p.shirt)}</span>` : ""}${esc(p.name)}</b>
        <small class="pmeta">${p.country ? flagHtml(p.country, p.cc) : ""}${p.age ? `<span>${p.age} yaş</span>` : ""}</small></div>
      ${p.rating ? `<span class="prt">${nf(p.rating, 2)}</span>` : ""}</li>`).join("")}</ul>
    <h3>Eksikler</h3><ul class="plist">${abs(s)}</ul></div>`;
  return `<div class="card" style="--c:#2ea043">${head("👥", "Kadrolar", tag)}
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
  const h = b.recent.home, a = b.recent.away, H = b.home.name, W = b.away.name;
  // karşılıklı çubuk: iki takımın değerinin toplam içindeki payı; kalın değer o kalemde daha iyi olan
  const rows = (src) => CMP.map(([k, l, d, hi]) => {
    const x = h[src][k], y = a[src][k];
    if (x == null && y == null) return "";
    let bx = "", by = "";
    if (hi !== null && x != null && y != null && x !== y) {
      const good = src === "avg_for" ? hi : !hi;
      if ((x > y) === good) bx = "win"; else by = "win";
    }
    const fx = Math.max(x || 0, 0), fy = Math.max(y || 0, 0), tot = fx + fy || 1;
    return `<div class="cmp-row" title="${esc(l)}: ${esc(H)} ${nf(x, d)} · ${esc(W)} ${nf(y, d)}">
      <span class="cv ${bx}">${nf(x, d)}</span>
      <div class="cmp-mid"><div class="cmp-l">${l}</div>
        <div class="cmp-bars"><span class="bh" style="flex:${fx / tot}"></span><span class="ba" style="flex:${fy / tot}"></span></div></div>
      <span class="cv r ${by}">${nf(y, d)}</span></div>`;
  }).join("");
  const legend = `<div class="legend"><span><i style="background:var(--home)"></i>${esc(H)}</span><span><i style="background:var(--away)"></i>${esc(W)}</span></div>`;
  return `<div class="card" style="--c:#58a6ff">${head("📊", `İstatistik karşılaştırması <span class="muted">· son ${h.n} / ${a.n} maç ortalaması</span>`)}
    ${legend}
    <div class="grid2">
      <div><h3>Ürettikleri (maç başı)</h3>${rows("avg_for")}</div>
      <div><h3>Rakibe izin verdikleri (maç başı)</h3>${rows("avg_against")}</div>
    </div><p class="muted">Kalın yazılan değer o kalemde daha iyi olan takımı gösterir.</p></div>`;
}

const RES_TR = { G: "Galibiyet", B: "Beraberlik", M: "Mağlubiyet" };
function recentHtml(r, name, cls) {
  const color = cls === "home-c" ? "var(--home)" : "var(--away)";
  if (!r.rows.length) return `<div class="card" style="--c:${color}">${head("📅", `${esc(name)}: son maçlar`)}<p class="muted">Veri yok</p></div>`;
  return `<div class="card" style="--c:${color}">${head("📅", `${esc(name)}: son maçlar`)}<div class="tbl-wrap"><table>
    <tr><th class="l">Tarih</th><th class="l">Rakip</th><th>Skor</th><th>xG</th><th>Şut (iç/dış)</th><th>İsab.</th><th>Korner</th><th>Top %</th></tr>
    ${r.rows.map((x) => `<tr>
      <td class="l">${dateOf(x.date)}</td>
      <td class="l">${x.home ? "" : "@ "}${esc(x.opponent)} <small class="muted">${esc(x.comp || "")}</small></td>
      <td><span class="rp ${x.result || ""}" title="${RES_TR[x.result] || ""}">${x.gf}-${x.ga}</span></td>
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
  return `<div class="card" style="--c:#3fb950">${head("🏆", `Sezon istatistikleri <span class="muted">· ${esc(b.season.league_name || b.league_name)}</span>`)}
    <p class="muted">Maç başı değer, parantez içinde sezon toplamı ve FotMob lig sıralaması (1 = ligin en iyisi; ör. yenilen xG'de en az yiyen).</p>
    <div class="tbl-wrap"><table><tr><th class="l">Kalem</th><th class="home-c">${esc(b.home.name)}</th><th class="away-c">${esc(b.away.name)}</th></tr>${rows}</table></div></div>`;
}

// haber kaynağına göre sabit renk (aynı kaynak hep aynı renkte)
function sourceColor(s) {
  const pal = ["#58a6ff", "#f78166", "#3fb950", "#d29922", "#a371f7", "#e3b341", "#39c5cf", "#db61a2"];
  let h = 0; for (const ch of s || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
}
function newsItem(x) {
  const thumb = x.image
    ? `<img class="nthumb" src="${esc(x.image)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<span class="nsrc" style="background:${sourceColor(x.source)}">${esc((x.source || "?").trim().charAt(0).toLocaleUpperCase("tr"))}</span>`;
  return `<a class="nitem" href="${esc(x.link)}" target="_blank" rel="noopener">${thumb}
    <div><b>${esc(x.title)}</b><small><span class="ntag" style="color:${sourceColor(x.source)}">${esc(x.source)}</span> · ${ago(x.time)}${x.lang === "en" ? " · EN" : ""}</small></div></a>`;
}
function newsHtml(n, name, cls) {
  const color = cls === "home-c" ? "var(--home)" : "var(--away)";
  return `<div class="card news" style="--c:${color}">${head("📰", `${esc(name)}: haberler`)}
    <h3>Türkçe basın (Google News)</h3><div class="nlist">${n.tr.length ? n.tr.map(newsItem).join("") : `<p class="muted">Son 3 günde haber bulunamadı</p>`}</div>
    ${n.fotmob.length ? `<h3>FotMob haber akışı</h3><div class="nlist">${n.fotmob.map(newsItem).join("")}</div>` : ""}</div>`;
}

function extrasHtml(b) {
  let h2h = "";
  if (b.h2h && b.h2h.matches.length) {
    const s = b.h2h.summary || [0, 0, 0], tot = (s[0] + s[1] + s[2]) || 1;
    h2h = `<h3>Aralarındaki maçlar</h3>
      ${s[0] + s[1] + s[2] ? `<div class="h2hbar">
        <div style="flex:${s[0] / tot};background:var(--home)">${s[0]}</div>
        <div style="flex:${s[1] / tot};background:var(--draw)">${s[1]}</div>
        <div style="flex:${s[2] / tot};background:var(--away)">${s[2]}</div></div>
        <div class="legend"><span><i style="background:var(--home)"></i>${esc(b.home.name)} galibiyeti</span><span><i style="background:var(--draw)"></i>Beraberlik</span><span><i style="background:var(--away)"></i>${esc(b.away.name)} galibiyeti</span></div>` : ""}
      <div class="tbl-wrap"><table>${b.h2h.matches.map((m) =>
      `<tr><td class="l">${dateOf(m.date)}</td><td class="l">${esc(m.home)}</td><td><span class="rp">${esc(m.score)}</span></td><td class="l">${esc(m.away)}</td><td class="l muted">${esc(m.league)}</td></tr>`).join("")}</table></div>`;
  }
  const ins = b.insights.length ? `<h3>FotMob içgörüleri (EN)</h3><ul class="scen">${b.insights.map((x) => `<li><span class="si">💡</span><span>${esc(x)}</span></li>`).join("")}</ul>` : "";
  const prev = b.preview.length ? `<h3>Maç önizlemesi</h3><div class="nlist">${b.preview.map((p) => newsItem({ ...p, source: "FotMob önizleme", lang: "en" })).join("")}</div>` : "";
  const prov = b.season.provider ? ` (veri sağlayıcı: ${esc(b.season.provider)})` : "";
  return `<div class="card" style="--c:#39c5cf">${head("🤝", "Rekabet, önizleme ve kaynaklar")}${h2h}${prev}${ins}
    <h3>Kaynaklar</h3><ul>
      <li><a href="${esc(b.links.fotmob)}" target="_blank" rel="noopener">FotMob maç sayfası</a>${prov}: kadrolar, eksikler, maç ve sezon istatistikleri</li>
      <li><a href="${esc(b.links.mackolik)}" target="_blank" rel="noopener">Maçkolik'te bu maç</a> · <a href="${esc(b.links.sofascore)}" target="_blank" rel="noopener">SofaScore'da bu maç</a> (karşılaştırma için)</li>
      <li>Türkçe haberler: Google News (son 3 gün). Analiz ve tahminler bu verilerden kural tabanlı model ile üretilir.</li>
    </ul></div>`;
}

/* ---------- model karnesi ---------- */
let karneRows = [], karneTab = "pick";
async function renderKarne(silent) {
  const v = $("#view");
  if (!silent) v.innerHTML = `<div class="loading">Model karnesi yükleniyor…</div>`;
  try { karneRows = await api("/api/karne"); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (!state.karne) return;
  drawKarne();
}
// karnede tercih türü (örn. "MS 1 (Liverpool)" -> "MS 1")
const pickType = (p) => {
  const c = p.code || "";
  if (["1", "X", "2"].includes(c)) return "Maç sonucu";
  if (["1X", "12", "X2"].includes(c)) return "Çifte şans";
  if (/^dnb/.test(c)) return "Beraberlikte iade";
  if (/^btts/.test(c)) return "Karşılıklı gol";
  if (/^[ou]\d/.test(c) || c === "o25" || c === "u25") return "Gol alt/üst";
  if (/^cm/.test(c)) return "En çok korner";
  if (/^rc/.test(c)) return "Kırmızı kart";
  if (/^cs:/.test(c)) return "Skor";
  return (p.label || "").replace(/ \(.*\)$/, "");
};
const STAKE = 100;
const rowProfit = (r) => r.pick_hit ? STAKE * (r.pick.odds - 1) : -STAKE;
const tl = (x, sign) => (sign && x > 0 ? "+" : "") + Math.round(x).toLocaleString("tr-TR") + " ₺";
// korner/kart tercihlerinde maç sonu korner ve kırmızı kart bilgisi
function cornerNote(r) {
  const fz = r.final; if (!fz || r.state !== "done") return "";
  if (/^cm/.test(r.pick.code) && fz.corners && fz.corners[0] != null) return ` · Korner ${fz.corners[0]}-${fz.corners[1]}`;
  if (/^rc/.test(r.pick.code) && fz.red) return ` · Kırmızı kart ${fz.red[0] + fz.red[1]}`;
  return "";
}
const rate = (h, n) => n ? `%${Math.round(h / n * 100)}` : "—";
function drawKarne() {
  const rows = karneRows || [];
  const done = rows.filter((r) => r.state === "done"), pending = rows.filter((r) => r.state === "pending");
  const n = done.length;
  const pdone = done.filter((r) => r.pick_hit === true || r.pick_hit === false);  // iade olanlar sayılmaz
  const pn = pdone.length;
  const ph = pdone.filter((r) => r.pick_hit).length, sh = done.filter((r) => r.score_hit).length, mh = done.filter((r) => r.ms_hit).length;
  // oranlı tercihlerde 1 birimlik sabit bahisle kâr/zarar
  // her tercihe ayrı ayrı 100 TL oynanmış gibi: tutarsa 100 × (oran − 1) kazanç, tutmazsa −100
  const withOdds = pdone.filter((r) => r.pick.odds);
  const profit = withOdds.reduce((a, r) => a + rowProfit(r), 0);
  const staked = withOdds.length * STAKE;
  const avgOdds = withOdds.length ? withOdds.reduce((a, r) => a + r.pick.odds, 0) / withOdds.length : null;
  const roi = staked ? profit / staked * 100 : null;
  // tercih türüne göre isabet
  const byType = {};
  pdone.forEach((r) => { const t = (byType[pickType(r.pick)] ||= { n: 0, h: 0 }); t.n++; if (r.pick_hit) t.h++; });
  const types = Object.entries(byType).sort((a, b) => b[1].n - a[1].n);
  const head1 = `<div class="card" style="--c:#58a6ff">${head("📒", `Model karnesi <span class="muted">· tüm zamanlar</span>`)}
    <div class="pred">
      ${kpi("✅", "#2ea043", "En garanti tercih", `${ph}/${pn}`, pn ? `${rate(ph, pn)} isabet` : "Henüz sonuç yok")}
      ${kpi("💰", profit >= 0 ? "#2ea043" : "#f85149", "Kâr / zarar", withOdds.length ? tl(profit, true) : "—", withOdds.length ? `Her tercihe 100 ₺ · ${withOdds.length} tercih` : "Oranlı tercih sonuçlanınca")}
      ${kpi("🏦", "#58a6ff", "Yatırılan → dönen", withOdds.length ? `${tl(staked)} → ${tl(staked + profit)}` : "—", withOdds.length ? `Getiri (ROI) ${roi < 0 ? "−" : ""}%${nf(Math.abs(roi), 1)} · ort. oran ${nf(avgOdds, 2)}` : "Oranlı tercih sonuçlanınca")}
      ${kpi("🎯", "#a371f7", "Skor tahmini", `${sh}/${n}`, n ? `${rate(sh, n)} tam isabet` : "Henüz sonuç yok")}
      ${kpi("⚖️", "#d29922", "Maç sonucu (1X2)", `${mh}/${n}`, n ? `${rate(mh, n)} isabet` : "Henüz sonuç yok")}
      ${kpi("⏳", "#8b98a8", "Bekleyen tahmin", String(pending.length), "Maçlar bittikçe sonuçlanır")}
    </div>
    ${types.length ? `<h3>Tercih türüne göre</h3>${types.map(([lab, t]) => { const v = Math.round(t.h / t.n * 100); return `<div class="srow">
      <div class="sl">${esc(lab)} <span class="muted">· ${t.h}/${t.n}</span></div><div class="sv">%${v}</div>
      <div class="spct"><span style="width:${Math.max(3, v)}%;background:${pctColor(v)}"></span><b>${v}</b></div></div>`; }).join("")}` : ""}
    <p class="muted">Model her maç için başlama düdüğünden önceki son tahminini kaydeder; maç bitince sonuçla karşılaştırılır. "En garanti tercih": maç sonucu, çifte şans, beraberlikte iade, karşılıklı gol, 1.5–3.5 alt/üst, en çok korner ve kırmızı kart seçenekleri içinde, oranı 1.30 ve üstü olanlardan modelin en yüksek olasılık verdiği tahmin. Kâr/zarar her tercihe ayrı ayrı 100 ₺ oynandığı varsayımıyla, o anki orana göre hesaplanır (tutarsa 100 × (oran − 1) kazanç, tutmazsa 100 ₺ kayıp); beraberlikte iade gibi iade olan sonuçlar sayılmaz. "Olası sürpriz" tahminleri karneye dahil değildir.</p>
  </div>`;
  const tabs = `<div class="ptabs">
    <button class="ptab ${karneTab === "pick" ? "on" : ""}" data-kt="pick">✅ En garanti tercihler <small>${ph}/${pn}</small></button>
    <button class="ptab ${karneTab === "score" ? "on" : ""}" data-kt="score">🎯 Skor tahminleri <small>${sh}/${n}</small></button></div>`;
  // günlere göre grupla (en yeni gün en üstte)
  const groups = new Map();
  rows.filter((r) => r.state !== "void").forEach((r) => {
    const k = new Date(r.utc).toLocaleDateString("sv-SE", { timeZone: TZ });
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const days = [...groups.keys()].sort().reverse();
  const list = days.length ? days.map((k) => {
    const g = groups.get(k).sort((a, b) => (a.utc || "").localeCompare(b.utc || ""));
    const d = g.filter((r) => r.state === "done" && (karneTab !== "pick" || r.pick_hit === true || r.pick_hit === false));
    const hits = d.filter((r) => karneTab === "pick" ? r.pick_hit : r.score_hit).length;
    const dayPl = karneTab === "pick" ? d.filter((r) => r.pick.odds).reduce((a, r) => a + rowProfit(r), 0) : null;
    const title = new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
    return `<div class="card kday" style="--c:#58a6ff">${head("🗓️", `${cap(title)} <span class="muted">· ${d.length ? `${hits}/${d.length} tuttu` : "sonuç bekleniyor"}</span>${dayPl != null && d.length ? `<span class="kpl ${dayPl >= 0 ? "pos" : "neg"}">${tl(dayPl, true)}</span>` : ""}`)}
      ${g.map(karneRow).join("")}</div>`;
  }).join("") : `<div class="card"><p class="muted">Henüz kayıtlı tahmin yok. Model, maçlar başlamadan önce tahminlerini kaydetmeye başladı; maçlar bittikçe karne dolacak.</p></div>`;
  $("#view").innerHTML = head1 + tabs + list;
  $("#view").querySelectorAll("[data-kt]").forEach((b) => b.onclick = () => { karneTab = b.dataset.kt; drawKarne(); });
}
function karneRow(r) {
  const done = r.state === "done";
  const hit = karneTab === "pick" ? r.pick_hit : r.score_hit;
  const rowCls = !done || hit == null ? "" : hit ? "hit" : "miss";
  const status = !done ? `<span class="kst wait">⏳ Bekliyor</span>` : hit == null ? `<span class="kst wait">↩ İade</span>`
    : hit ? `<span class="kst ok">✓ Tuttu</span>` : `<span class="kst no">✗ Tutmadı</span>`;
  const mid = done ? `<div class="sc">${r.result[0]} - ${r.result[1]}</div><div class="sub">maç sonu</div>` : `<div class="ko">${esc(timeOf(r.utc))}</div><div class="sub">başlama</div>`;
  const tip = karneTab === "pick"
    ? `<span class="kpick">${esc(r.pick.label)} <small>${r.pick.odds ? "@" + nf(r.pick.odds, 2) + " · " : ""}${pc(r.pick.p)}</small></span>`
    : `<span class="kpick">Skor ${esc(r.score.score)} <small>${pc(r.score.p)}</small></span>`;
  const linkable = !STATIC || (meta && meta.days && meta.days.includes(new Date(r.utc).toLocaleDateString("sv-SE", { timeZone: TZ })));
  return `<div class="krow ${rowCls}" ${linkable ? `data-mid="${r.id}"` : ""}>
    <div class="kteams">
      <span class="kt"><img src="${teamLogo(r.home.id)}" alt="" onerror="this.remove()">${esc(r.home.name)}</span>
      <div class="mid">${mid}</div>
      <span class="kt r">${esc(r.away.name)}<img src="${teamLogo(r.away.id)}" alt="" onerror="this.remove()"></span>
    </div>
    <div class="kfoot"><span class="muted kl">${esc(r.league || "")}${cornerNote(r)}</span>${tip}${karneTab === "pick" && r.pick.odds ? `<span class="kstake ${done && hit != null ? (hit ? "pos" : "neg") : ""}">100 ₺ → ${done && hit != null ? tl(rowProfit(r), true) : "@" + nf(r.pick.odds, 2)}</span>` : ""}${status}</div>
  </div>`;
}

/* ---------- oyuncu sayfası ---------- */
const STAT_TR = {
  // şut
  goals: "Gol", expected_goals: "xG (beklenen gol)", expected_goals_on_target: "xGOT (isabetli şut xG'si)",
  goals_subtitle: "Penaltı golü", non_penalty_xg: "Penaltısız xG", shots: "Şut", ShotsOnTarget: "İsabetli şut",
  headed_shots: "Kafa vuruşu", shot_accuracy: "Şut isabet oranı",
  // pas
  assists: "Asist", expected_assists: "xA (beklenen asist)", successful_passes: "İsabetli pas",
  successful_passes_accuracy: "Pas isabet oranı", long_balls_accurate: "İsabetli uzun top",
  long_ball_succeeeded_accuracy: "Uzun top isabet oranı", line_breaking_passes: "Hat kıran pas",
  chances_created: "Kilit pas (yaratılan şans)", big_chance_created_team_title: "Net pozisyon yaratma",
  crosses_succeeeded: "İsabetli orta", crosses_succeeeded_accuracy: "Orta isabet oranı",
  // top hakimiyeti
  dribbles_succeeded: "Başarılı çalım", won_contest_subtitle: "Çalım başarı oranı", duel_won: "Kazanılan ikili mücadele",
  duel_won_percent: "İkili mücadele başarı oranı", aerials_won: "Kazanılan hava topu", aerials_won_percent: "Hava topu başarı oranı",
  touches: "Topla buluşma", touches_opp_box: "Rakip ceza sahasında temas", dispossessed: "Top kaptırma", fouls_won: "Kazanılan faul",
  // savunma
  defensive_actions: "Savunma aksiyonu", "matchstats.headers.tackles": "Müdahale", interceptions: "Top kesme",
  fouls: "Yapılan faul", recoveries: "Top kazanma", poss_won_att_3rd_team_title: "Rakip yarı sahada top kazanma",
  clearances: "Uzaklaştırma", clean_sheet_team_title: "Gol yenmeyen maç", goals_conceded_while_on_pitch: "Sahadayken yenilen gol",
  expected_goals_against_while_on_pitch: "Sahadayken rakip xG",
  // disiplin
  yellow_cards: "Sarı kart", red_cards: "Kırmızı kart",
  // kaleci
  saves: "Kurtarış", save_percentage: "Kurtarış yüzdesi", goals_conceded: "Yenilen gol", goals_prevented: "Önlenen gol",
  penalty_saves: "Kurtarılan penaltı", penalty_goals_conceded: "Yenilen penaltı golü", penalty_save_percent: "Penaltı kurtarma oranı",
  error_led_to_goal: "Gole yol açan hata", keeper_sweeper: "Kale dışına çıkış (libero)", keeper_high_claim: "Yüksek top hakimiyeti",
  shots_faced: "Kaleye gelen şut", shots_on_target_faced: "Kaleye gelen isabetli şut", xg_faced: "Gelen şutların xG'si",
  xgot_faced: "İsabetli şutların xGOT'u",
  // üst kart
  rating: "Reyting", matches_uppercase: "Maç", minutes_played: "Dakika", clean_sheet_title: "Gol yemeden", saved_penalties: "Kurtarılan penaltı",
};
const TITLE_TR = { Started: "İlk 11", Minutes: "Dakika", Conceded: "Yenilen gol", "Penalties saved": "Kurtarılan penaltı",
  Matches: "Maç", Rating: "Reyting", Goals: "Gol", Assists: "Asist", "Clean sheets": "Gol yemeden" };
const SECTION_TR = { shooting: ["⚽", "#f85149", "Şut"], passing: ["🎯", "#58a6ff", "Pas ve oyun kurma"],
  possession: ["🏃", "#a371f7", "Top hakimiyeti ve ikili mücadele"], defending: ["🛡️", "#3fb950", "Savunma"],
  discipline: ["🟨", "#e3b341", "Disiplin"], goalkeeping: ["🧤", "#39c5cf", "Kalecilik"], distribution: ["🎯", "#58a6ff", "Oyun kurma (dağıtım)"] };
const TRAIT_TR = { chances_created: "Kilit pas", aerials_won: "Hava topu", defensive_actions: "Savunma aksiyonu", goals: "Gol",
  shot_attempts: "Şut denemesi", touches: "Topla buluşma", keeper_sweeper_actions: "Kale dışına çıkış", goals_conceded: "Az gol yeme",
  save_percentage: "Kurtarış yüzdesi", keeper_high_claim: "Yüksek top", clean_sheet: "Gol yemeden", long_ball_succeeeded_accuracy: "Uzun top isabeti" };
const POS_TR = { Keeper: "Kaleci", "Centre-Back": "Stoper", "Center Back": "Stoper", "Right-Back": "Sağ bek", "Right Back": "Sağ bek",
  "Left-Back": "Sol bek", "Left Back": "Sol bek", "Right Wing-Back": "Sağ kanat bek", "Left Wing-Back": "Sol kanat bek",
  "Defensive Midfielder": "Ön libero", "Central Midfielder": "Merkez orta saha", "Attacking Midfielder": "Ofansif orta saha",
  "Right Midfielder": "Sağ orta saha", "Left Midfielder": "Sol orta saha", "Right Winger": "Sağ kanat", "Left Winger": "Sol kanat",
  Striker: "Santrfor", "Centre-Forward": "Santrfor" };
const FOOT_TR = { Right: "Sağ", Left: "Sol", Both: "İki ayak" };
const statName = (i) => STAT_TR[i.key] || TITLE_TR[i.title] || i.title;
function statVal(i) {
  if (i.value == null) return i.raw ?? "—";
  if (i.fmt === "percent") return "%" + nf(i.value, 1);
  if (i.key === "rating") return nf(i.value, 2);
  return Number.isInteger(i.value) ? String(i.value) : nf(i.value, 2);
}
// FotMob yüzdelik dilimi (aynı pozisyondaki oyunculara göre): renk düşük/orta/yüksek
const pctColor = (p) => p >= 67 ? "#3fb950" : p >= 34 ? "#d29922" : "#f85149";
function ratingColor(r) {
  r = parseFloat(r);
  if (!r) return "#6e7781";
  return r >= 8 ? "#2ea043" : r >= 7 ? "#57ab5a" : r >= 6.5 ? "#d29922" : r >= 6 ? "#db6d28" : "#da3633";
}
let playerData = null, playerComp = 0;

async function renderPlayer(id, silent) {
  const v = $("#view");
  if (!silent) v.innerHTML = `<div class="loading">Oyuncu istatistikleri yükleniyor…</div>`;
  let p;
  try { p = await api(`/api/player/${id}`); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (state.player !== id) return;
  if (!playerData || playerData.id !== p.id) playerComp = 0;
  playerData = p;
  drawPlayer();
}
function playerComps(p) {
  return p.total ? [p.total, ...p.comps] : p.comps;
}
function drawPlayer() {
  const p = playerData, comps = playerComps(p);
  const c = comps[playerComp] || comps[0];
  const y = window.scrollY;
  $("#view").innerHTML = playerHero(p) + (c ? `
    <div class="ptabs">${comps.map((x, i) => `<button class="ptab ${i === playerComp ? "on" : ""}" data-ci="${i}">
      ${x.id ? `<img src="${leagueLogo(x.id)}" alt="" onerror="this.remove()">` : "🌍"}${esc(x.name === "Tüm kulvarlar" ? x.name : trComp(x.name))}
      <small>${x.matches ? x.matches + " maç" : ""}</small></button>`).join("")}</div>
    ${playerTop(p, c)}
    ${p.keeper ? keeperCard(c) : shotCard(c)}
    <div class="grid2">${c.sections.map((s) => sectionCard(s, c)).join("")}</div>
    ${traitsCard(p)}` : `<div class="card"><p class="muted">Bu sezon için istatistik yok.</p></div>`) + recentCard(p);
  $("#view").querySelectorAll(".ptab").forEach((b) => b.onclick = () => { playerComp = +b.dataset.ci; drawPlayer(); });
  window.scrollTo(0, y);
}
const trComp = (n) => (n || "").replace("Super Lig", "Süper Lig").replace("Champions League", "Şampiyonlar Ligi")
  .replace("Europa League", "Avrupa Ligi").replace("Conference League", "Konferans Ligi").replace("World Cup", "Dünya Kupası")
  .replace(" Qualification qualification", " eleme").replace("qualification", "eleme").replace("Qualification", "Eleme");

function playerHero(p) {
  const i = p.info || {};
  const color = p.team.color || "var(--accent)";
  const pos = POS_TR[p.position] || p.position;
  const chips = [
    i.shirt && chip("👕", "#" + esc(i.shirt)),
    i.age && chip("🎂", esc(i.age) + " yaş"),
    i.height && chip("📏", esc(i.height)),
    i.foot && chip("🦶", esc(FOOT_TR[i.foot] || i.foot) + " ayak"),
    i.country && chip(flagHtml(i.country), `<span class="sr">${esc(countryTr(i.country))}</span>`),
    i.value && chip("💶", esc(i.value)),
    p.contract && chip("📝", "Sözleşme: " + esc(new Date(p.contract).toLocaleDateString("tr-TR", { month: "long", year: "numeric" }))),
  ].filter(Boolean).join("");
  const inj = p.injury ? `<div class="pinj">🚑 Sakat${p.injury.expectedReturn ? " · Dönüş: " + esc(p.injury.expectedReturn) : ""}</div>` : "";
  return `<div class="phero" style="--tc:${esc(color)}">
    <div class="pphoto">${playerImg(p.id, i.shirt)}</div>
    <div class="pmain">
      <h1>${esc(p.name)}</h1>
      <div class="pteam"><img src="${teamLogo(p.team.id)}" alt="" onerror="this.remove()"><b>${esc(p.team.name || "")}</b>${p.team.loan ? `<span class="tag warn">Kiralık</span>` : ""}
        <span class="ppos">${esc(pos || "")}</span>${p.keeper ? `<span class="ppos gk">🧤 Kaleci</span>` : ""}</div>
      <div class="chips left">${chips}</div>${inj}
    </div></div>`;
}

function playerTop(p, c) {
  const get = (k) => [...c.top, ...c.sections.flatMap((s) => s.items), ...c.derived].find((i) => i.key === k);
  const tiles = p.keeper
    ? [["🧤", "#39c5cf", get("saves")], ["📊", "#3fb950", get("save_percentage")], ["🥅", "#f85149", get("goals_conceded")],
       ["🛡️", "#a371f7", get("goals_prevented")], ["🎯", "#d29922", get("shots_on_target_faced")], ["📐", "#58a6ff", get("xgot_faced")],
       ["🔒", "#2ea043", get("clean_sheet_title") || get("clean_sheet_team_title")], ["⭐", "#e3b341", get("rating")]]
    : [["⚽", "#f85149", get("goals")], ["🅰️", "#58a6ff", get("assists")], ["📈", "#a371f7", get("expected_goals")],
       ["🔑", "#d29922", get("chances_created")], ["🥅", "#f78166", get("shots")], ["🎯", "#3fb950", get("shot_accuracy")],
       ["📨", "#39c5cf", get("successful_passes_accuracy")], ["⭐", "#e3b341", get("rating")]];
  const mins = c.minutes ? `${nf(c.minutes, 0)} dk${c.minutes_est ? " (tahmini)" : ""}` : "";
  return `<div class="card" style="--c:var(--tc, #2ea043)">${head("📋", `${esc(c.name === "Tüm kulvarlar" ? "Tüm kulvarlar" : trComp(c.name))} <span class="muted">· ${esc(p.season || "")} sezonu${c.matches ? " · " + c.matches + " maç" : ""}${mins ? " · " + mins : ""}</span>`)}
    <div class="pred">${tiles.filter((t) => t[2]).map(([ic, col, i]) => kpi(ic, col, statName(i), statVal(i),
      i.per90 != null && i.fmt !== "percent" && i.key !== "rating" ? `90 dk başına ${nf(i.per90, 2)}` : i.pct != null ? `Pozisyonunda %${Math.round(i.pct)} dilimde` : "")).join("")}</div>
    ${c.name === "Tüm kulvarlar" ? `<p class="muted">Tüm kulvarlar: sayılar toplanır, yüzdeler ve reyting oynanan süreye göre ağırlıklı ortalamadır. Yüzdelik dilimler sadece tek turnuva sekmelerinde görünür.</p>` : ""}
  </div>`;
}

function sectionCard(s, c) {
  const [ic, col, title] = SECTION_TR[s.key] || ["📊", "#58a6ff", s.title];
  const extra = s.key === "shooting" ? c.derived.filter((d) => d.key === "shot_accuracy")
    : s.key === "goalkeeping" ? c.derived.filter((d) => d.key !== "shot_accuracy") : [];
  const rows = [...s.items, ...extra].map((i) => `<div class="srow">
      <div class="sl">${esc(statName(i))}</div>
      <div class="sv">${statVal(i)}${i.per90 != null && i.fmt !== "percent" && i.key !== "rating" ? `<small>${nf(i.per90, 2)} / 90 dk</small>` : ""}</div>
      ${i.pct != null ? `<div class="spct" title="Aynı pozisyondaki oyunculara göre yüzdelik dilim"><span style="width:${Math.max(3, i.pct)}%;background:${pctColor(i.pct)}"></span><b>${Math.round(i.pct)}</b></div>` : `<div class="spct empty"></div>`}
    </div>`).join("");
  return `<div class="card" style="--c:${col}">${head(ic, title)}${rows}</div>`;
}

// saha oyuncusu: yarı saha şut haritası (FotMob koordinatı: x kaleye doğru 0-105 m, y 0-68 m)
function shotCard(c) {
  const shots = c.shots || [];
  if (!shots.length) return "";
  const W = 68, H = 52.5;
  const goals = shots.filter((s) => s.ev === "Goal").length, on = shots.filter((s) => s.on).length;
  const xg = shots.reduce((a, s) => a + (s.xg || 0), 0);
  const dots = shots.map((s) => {
    const cx = (s.y ?? 34), cy = Math.max(0, 105 - (s.x ?? 90));
    const r = 0.55 + Math.sqrt(s.xg || 0.02) * 2.1;
    const kind = s.ev === "Goal" ? "g" : s.on ? "o" : "m";
    const opp = esc(`${s.home || ""} - ${s.away || ""}`);
    return `<circle class="sd ${kind}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}"><title>${s.min || ""}' · ${opp} · xG ${nf(s.xg || 0, 2)} · ${s.ev === "Goal" ? "Gol" : s.on ? "İsabetli" : "İsabetsiz/blok"}</title></circle>`;
  }).join("");
  const pitch = `<rect x="0" y="0" width="${W}" height="${H}" class="pf"/>
    <rect x="13.84" y="0" width="40.32" height="16.5" class="pl2"/><rect x="24.84" y="0" width="18.32" height="5.5" class="pl2"/>
    <rect x="30.34" y="-1.2" width="7.32" height="1.2" class="pg"/><circle cx="34" cy="11" r="0.4" class="pdot"/>
    <path d="M26.7 16.5 A9.15 9.15 0 0 0 41.3 16.5" class="pl2"/><path d="M24.85 ${H} A9.15 9.15 0 0 1 43.15 ${H}" class="pl2"/>`;
  return `<div class="card" style="--c:#f85149">${head("🎯", `Şut haritası <span class="muted">· ${shots.length} şut, ${on} isabetli, ${goals} gol, toplam xG ${nf(xg, 2)}</span>`)}
    <div class="shotwrap"><svg viewBox="-1 -2 70 55.5" class="shotmap" role="img" aria-label="Şut haritası">${pitch}${dots}</svg></div>
    <div class="legend center"><span><i class="lg g"></i>Gol</span><span><i class="lg o"></i>İsabetli (kurtarıldı)</span><span><i class="lg m"></i>İsabetsiz / blok</span><span>Daire büyüklüğü = xG</span></div></div>`;
}

// kaleci: kale ağzına gelen isabetli şutlar (FotMob onGoalShot: x 0-2 kale genişliği, y 0-0.67 yükseklik)
function keeperCard(c) {
  const f = (c.faced || []).filter((s) => s.on && s.gx != null);
  if (!f.length) return "";
  const goals = f.filter((s) => s.ev === "Goal").length;
  const xgot = f.reduce((a, s) => a + (s.xgot || 0), 0);
  const dots = f.map((s) => {
    const cx = s.gx, cy = 0.667 - Math.min(0.66, s.gy || 0);
    const r = 0.018 + Math.sqrt(s.xgot || 0.02) * 0.05;
    const g = s.ev === "Goal";
    return `<circle class="sd ${g ? "x" : "s"}" cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${r.toFixed(3)}"><title>${s.min || ""}' · ${esc(s.by || "")} (${esc(`${s.home || ""} - ${s.away || ""}`)}) · xGOT ${nf(s.xgot || 0, 2)} · ${g ? "Gol" : "Kurtarış"}</title></circle>`;
  }).join("");
  return `<div class="card" style="--c:#39c5cf">${head("🧤", `Kaleye gelen isabetli şutlar <span class="muted">· ${f.length} şut, ${f.length - goals} kurtarış, ${goals} gol, xGOT ${nf(xgot, 2)} (önlenen gol ${nf(xgot - goals, 2)})</span>`)}
    <div class="shotwrap"><svg viewBox="-0.15 -0.12 2.3 0.84" class="goalmap" role="img" aria-label="Kale ağzı haritası">
      <rect x="0" y="0" width="2" height="0.667" class="gnet"/><path d="M0 0.72 V0 H2 V0.72" class="gpost"/><line x1="-0.15" y1="0.667" x2="2.15" y2="0.667" class="gline"/>${dots}</svg></div>
    <div class="legend center"><span><i class="lg s"></i>Kurtarış</span><span><i class="lg x"></i>Gol</span><span>Daire büyüklüğü = xGOT</span></div></div>`;
}

function traitsCard(p) {
  if (!p.traits || !p.traits.length) return "";
  return `<div class="card" style="--c:#a371f7">${head("🧬", `Pozisyonundaki oyunculara göre <span class="muted">· ana lig, 90 dk başına</span>`)}
    ${p.traits.map((t) => { const v = Math.round((t.value || 0) * 100); return `<div class="srow">
      <div class="sl">${esc(TRAIT_TR[t.key] || t.title)}</div><div class="sv">%${v}</div>
      <div class="spct"><span style="width:${Math.max(3, v)}%;background:${pctColor(v)}"></span><b>${v}</b></div></div>`; }).join("")}</div>`;
}

function recentCard(p) {
  if (!p.recent || !p.recent.length) return "";
  const rows = p.recent.map((m) => {
    const my = m.home ? m.hs : m.as, op = m.home ? m.as : m.hs;
    const res = my == null || op == null ? "" : my > op ? "G" : my === op ? "B" : "M";
    return `<tr>
      <td class="l">${dateOf(m.date)}</td>
      <td class="l"><span class="opp"><img src="${teamLogo(m.oppId)}" alt="" onerror="this.remove()">${m.home ? "" : "@ "}${esc(m.opp)}</span><small class="muted">${esc(m.comp || "")}</small></td>
      <td><span class="rp ${res}">${m.hs ?? "-"}-${m.as ?? "-"}</span></td>
      <td>${m.bench ? `<span class="muted">Yedek</span>` : (m.min ?? "—") + "'"}</td>
      <td>${m.g ? `<b>${m.g}</b>` : "0"}</td><td>${m.a ? `<b>${m.a}</b>` : "0"}</td>
      <td>${m.yc ? "🟨".repeat(m.yc) : ""}${m.rc ? "🟥" : ""}</td>
      <td>${m.rating ? `<span class="rbadge" style="background:${ratingColor(m.rating)}">${esc(m.rating)}</span>` : "—"}${m.potm ? " ⭐" : ""}</td></tr>`;
  }).join("");
  return `<div class="card" style="--c:#58a6ff">${head("📅", "Son maçları <span class=\"muted\">· tüm kulvarlar</span>")}
    <div class="tbl-wrap"><table><tr><th class="l">Tarih</th><th class="l">Rakip</th><th>Skor</th><th>Süre</th><th>Gol</th><th>Asist</th><th>Kart</th><th>Reyting</th></tr>${rows}</table></div>
    <p class="muted">⭐ Maçın oyuncusu</p></div>`;
}

/* ---------- canlı güncelleme (SSE) ---------- */
function connect() {
  const es = new EventSource("/api/events");
  let pending = null;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.text) { toast(ev); addFeed(ev, true); }
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (state.current && ev.match_id === state.current) renderMatch(state.current, true);
      else if (!state.current && !state.player && !state.karne) renderDay(true);
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
// uygulama içi gezinme yığını: Geri butonu sitenin dışına çıkmadan bir önceki sayfaya döner
const navStack = [];
function route() {
  const mm = location.hash.match(/^#\/mac\/(\d+)/);
  const pm = location.hash.match(/^#\/oyuncu\/(\d+)/);
  const km = location.hash.startsWith("#/karne");
  const h = location.hash || "#/";
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
  // maç, oyuncu ve karne sayfalarında üst barda yalnızca Geri butonu görünür
  document.body.classList.toggle("in-match", !!(mm || pm || km));
  state.player = pm ? +pm[1] : null;
  state.karne = km;
  if (km) { state.current = null; window.scrollTo(0, 0); renderKarne(); }
  else if (mm) { state.current = +mm[1]; window.scrollTo(0, 0); renderMatch(state.current); }
  else if (pm) { state.current = null; window.scrollTo(0, 0); renderPlayer(state.player); }
  else { state.current = null; renderDay(); }
}
$("#backBtn").onclick = () => {
  if (navStack.length > 1) history.back();
  else { navStack.length = 0; location.hash = "#/"; }
};
// kadrodaki oyunculara tıklayınca oyuncu sayfası
$("#view").addEventListener("click", (e) => {
  const el = e.target.closest("[data-pid]");
  if (el && el.dataset.pid !== "0") { location.hash = "#/oyuncu/" + el.dataset.pid; return; }
  const km = e.target.closest("[data-mid]");
  if (km) location.hash = "#/mac/" + km.dataset.mid;
});
function shiftDay(n) {
  const d = new Date(state.date + "T12:00:00"); d.setDate(d.getDate() + n);
  setDate(d.toLocaleDateString("sv-SE"));
}
function setDate(s) {
  state.date = s; $("#date").value = s; updateCalLabel(); openCal(false);
  if (location.hash.startsWith("#/mac") || location.hash.startsWith("#/oyuncu") || location.hash.startsWith("#/karne")) location.hash = "#/"; else renderDay();
}
// takvim butonu: seçili günü kısa yazar (Dün / Bugün / Yarın / 22 Eki)
function updateCalLabel() {
  const t = todayStr();
  const diff = Math.round((new Date(state.date + "T12:00:00") - new Date(t + "T12:00:00")) / 86400000);
  $("#calLabel").textContent = { "-1": "Dün", "0": "Bugün", "1": "Yarın" }[diff] ??
    new Date(state.date + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
}
function openCal(open) { $("#calPop").classList.toggle("hidden", !open); }
$("#calBtn").onclick = (e) => { e.stopPropagation(); openCal($("#calPop").classList.contains("hidden")); };
document.addEventListener("click", (e) => { if (!e.target.closest(".calwrap")) openCal(false); });

/* ---------- statik mod (GitHub Pages): şifre ve yoklama ---------- */
async function showLogin(err) {
  $("#toolbar").classList.add("hidden");
  document.body.classList.add("locked");
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
let RAW_KEY = null;  // canlı köprü anahtarı bundan türetilir (canli.js)
async function unlockWith(raw) {
  RAW_KEY = raw;
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
      state.karne ? renderKarne(true) : state.player ? renderPlayer(state.player, true) : state.current ? renderMatch(state.current, true) : renderDay(true);
    } catch { /* bir sonraki turda tekrar dener */ }
  };

  setInterval(tick, 60000);
}

/* ---------- yenilikler penceresi ----------
   Her güncellemede RELEASES'e yeni bir kayıt eklenir (id bir artar). Kişi o cihazda daha önce görmediği
   kayıtları bir kez görür; "Tamam" ile en son id kaydedilir ve pencere tekrar çıkmaz. */
const RELEASES = [
  {
    id: 1, date: "19 Ekim 2026", title: "Maç Analiz Merkezi'ne hoş geldin!",
    sub: "Şimdiye kadar eklenen bütün özellikler",
    items: [
      ["📅", "Günün maçları", "Süper Lig, top 5 lig, Avrupa kupaları dahil 14 ligin dün, bugün ve yarın oynanan maçları; logolu kartlar ve canlı skorlar."],
      ["⭐", "Favori yıldızı", "Kazanma olasılığı daha yüksek olan takımın logosunun üstünde altın yıldız."],
      ["🔥", "Öne çıkanlar", "Günün en net favorisi, en gollü maç beklentisi ve en dengeli maçı en üstte."],
      ["🔎", "Lig filtresi", "Filtre butonuyla sadece görmek istediğin ligleri seç; seçimin hatırlanır."],
      ["🎯", "Tahmin modeli", "1X2 olasılıkları, en olası skorlar, alt/üst, karşılıklı gol, korner, şut ve kart beklentisi."],
      ["🧭", "Senaryolar", "Erken gol, duran top, eksikler, hava durumu gibi maçın gidişatını değiştirebilecek olasılıklar."],
      ["🧠", "Takım analizleri", "Oyun planı ve taktik, hücum, duran top, savunma, form, eksikler ve kilit oyuncular."],
      ["👥", "Kadrolar", "Olası ve resmi 11'ler, saha üzerinde diziliş, oyuncu fotoğrafları, sakat ve cezalılar."],
      ["📊", "İstatistik karşılaştırması", "Son 5 maçın şut, xG, korner, savunma istatistikleri karşılıklı çubuklarla; sezon istatistikleri ve lig sıralamaları."],
      ["🏃", "Oyuncu sayfaları", "Oyuncuya dokun: tüm kulvarlarda gol, asist, xG, kilit pas, şut ve pas isabeti, yüzdelik dilimler, şut haritası."],
      ["🧤", "Kaleci istatistikleri", "Kurtarış, kurtarış yüzdesi, yenilen gol, önlenen gol, kaleye gelen xG/xGOT ve kale ağzı haritası."],
      ["📰", "Haberler", "Türkçe basından ve FotMob'dan takımlarla ilgili son haberler."],
      ["🔔", "Bildirimler", "Resmi 11 açıklandığında, yeni eksik ya da haber çıktığında ve gol olduğunda bildirim; veriler 15 dakikada bir güncellenir."],
      ["🔒", "Şifreli ve gizli", "Site şifreyle korunur; telefonun şifreyi hatırlar."],
      ["📱", "Mobil uyumlu", "Telefonda dikey saha, alttan açılan filtre ve rahat okunan kartlar."],
      ["❤️", "Sayfanın en altında", "Küçük ama önemli bir not 🙂"],
    ],
  },
  {
    id: 2, date: "19 Ekim 2026", title: "Yeni: Model karnesi", sub: "Bu güncellemede gelenler",
    items: [
      ["📒", "Model karnesi", "Sağ üstteki defter simgesi: modelin bütün zamanlardaki tahminleri kaçta kaç tuttu, gün gün listelenir."],
      ["✅", "En garanti tercih", "Her maç için modelin en emin olduğu tercih (örn. KG Var, 2.5 Üst, MS 1) ve tutup tutmadığı."],
      ["🎯", "Skor tahminleri", "Karnede ayrı bölüm: her maçın skor tahmini ve tam isabet sayısı."],
      ["📊", "Tercih türüne göre isabet", "KG Var, 2.5 Üst, MS 1 gibi her tercih türünün ayrı başarı oranı."],
      ["🖼️", "Öne çıkanlarda logolar", "En net favori, en gollü ve en dengeli maç kutularında takım logoları."],
    ],
  },
  {
    id: 3, date: "20 Ekim 2026", title: "Yeni: Bahis oranları", sub: "Bu güncellemede gelenler",
    items: [
      ["💰", "Oranlar sekmesi", "Maç sayfasında yeni sekme: bet365 ve diğer şirketlerin maç sonucu, alt/üst, KG, handikap, ilk yarı, skor, korner, kart ve golcü oranları."],
      ["🧮", "Model oranları okuyor", "Gol beklentisi artık istatistiklerle bahis oranları harmanlanarak hesaplanıyor; her seçenek için model olasılığı ve değer gösteriliyor."],
      ["✅", "Daha akıllı garanti tercih", "Çifte şans, alt/üst, beraberlikte iade dahil tüm pazarlardan seçiliyor; 1.30 altı oranlar elenir."],
      ["⚡", "Olası sürpriz", "Her maç için oranı yüksek ama modelin olası gördüğü bir sürpriz tahmin (karneye girmez)."],
      ["🎲", "Gelişmiş skor tahmini", "Skor tahmini beklenen sonuç ve gol sayısıyla tutarlı seçiliyor: 3-1, 0-2, 2-2 gibi tahminler de var."],
      ["📒", "Karnede kâr/zarar", "Garanti tercihlerin oranlarıyla 1 birimlik sabit bahiste kâr/zarar ve ortalama oran."],
    ],
  },
  {
    id: 4, date: "20 Ekim 2026", title: "Yeni: Maç yorumu", sub: "Bu güncellemede gelenler",
    items: [
      ["🗣️", "Maç yorumu", "Her maçta modelin yorumu: seriler (örn. 13 maçtır kazanıyor), puan durumu ve yarış, eksikler, rekabet geçmişi ve bahis piyasasının beklentisi."],
      ["🔥", "Seri etiketleri", "Galibiyet, yenilmezlik, mağlubiyet ve gol serileri maç yorumunun üstünde etiket olarak."],
      ["🚩", "Korner ve kart tercihleri", "En garanti tercih artık 'daha çok korner kullanan takım' ve 'kırmızı kart çıkar mı' pazarlarından da seçilebiliyor."],
      ["💰", "100 ₺ ile kâr/zarar", "Karnede her tercihe ayrı ayrı 100 ₺ oynansaydı ne kazanılır/kaybedilirdi; yatırılan, dönen ve getiri oranı. Gün gün kâr/zarar."],
    ],
  },
  {
    id: 5, date: "20 Ekim 2026", title: "Yeni: Model asistanı", sub: "Bu güncellemede gelenler",
    items: [
      ["🤖", "Model asistanı", "Sağ üstteki robota dokun ve sor: \"Bugün Fenerbahçe maçı ne olur?\" Sitedeki analiz, oran ve tahminlerle cevap verir; ne oynayacağını ve riskini söyler."],
      ["🎟️", "Garanti tercihler ve kupon", "\"Günün en garanti tercihleri\" ya da \"kupon\" yaz: en güvenilen tercihler, toplam oran ve tutma ihtimali."],
      ["🏃", "Oyuncu soruları", "\"Salah kaç gol attı?\" gibi sorulara oyuncu istatistikleriyle cevap."],
      ["📅", "Takvim simgesi", "Tarih çubuğu kalktı; Filtre butonunun yanındaki takvimden gün değiştirebilirsin."],
    ],
  },
  {
    id: 6, date: "21 Ekim 2026", title: "Yeni: Canlı veriler", sub: "Bu güncellemede gelenler",
    items: [
      ["🔴", "Anlık skor ve dakika", "Canlı maçların skoru ve dakikası artık saniyeler içinde geliyor; sayfa açıkken 30 saniyede bir yenilenir."],
      ["⚽", "Gol bildirimi", "Açık sayfada gol olunca anında \"GOL!\" bildirimi çıkar."],
      ["📜", "Maç olayları ve canlı istatistik", "Maç sayfasında goller, kartlar, oyuncu değişiklikleri ve canlı topla oynama, xG, şut, korner."],
      ["📋", "Resmi 11 anında", "Resmi ilk 11'ler açıklandığı an maç sayfasında görünür."],
      ["⏱️", "Analizler 6 dakikada bir", "Tahminler, oranlar ve haberler artık 30-45 dakika yerine 6 dakikada bir yenileniyor."],
    ],
  },
  {
    id: 7, date: "21 Ekim 2026", title: "Yeni: Maç sekmeleri", sub: "Bu güncellemede gelenler",
    items: [
      ["🗂️", "Sekmeli maç sayfası", "Maç sayfası artık sekmelere ayrıldı: Özet, Kadrolar, Takım analizi, İstatistikler, Oranlar, Haberler."],
      ["🔴", "Canlı sekmesi", "Maç başladıysa sayfa doğrudan Canlı sekmesinde açılır: olaylar ve maç istatistikleri anlık. Maç bitince sekmenin adı 🏁 Maç olur."],
      ["📌", "Sabit sekme çubuğu", "Aşağı kaydırsan da sekmeler üstte kalır; tek dokunuşla geçiş."],
      ["🔒", "Donmuş tahminler", "Maç başlayınca tahminler maç öncesi hâliyle kilitlenir; karne ile maç sayfası her zaman aynı."],
    ],
  },
];
function showWhatsNew() {
  const seen = +(safeGet("seenRelease") || 0);
  const fresh = RELEASES.filter((r) => r.id > seen);
  if (!fresh.length) return;
  const latest = fresh[fresh.length - 1];
  $("#wnTitle").textContent = fresh.length === 1 ? latest.title : "Yenilikler";
  $("#wnSub").textContent = fresh.length === 1 ? `${latest.sub} · ${latest.date}` : `${fresh.length} güncelleme`;
  $("#wnList").innerHTML = fresh.slice().reverse().flatMap((r) => r.items).map(([ic, t, d]) =>
    `<div class="wn-item"><span class="wn-ii">${ic}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></div>`).join("");
  $("#newsModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("#wnOk").focus();
  $("#wnOk").onclick = () => {
    safeSet("seenRelease", String(RELEASES[RELEASES.length - 1].id));
    $("#newsModal").classList.add("hidden");
    document.body.classList.remove("modal-open");
  };
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
  document.body.classList.remove("locked");
  await initLeagues();
  route();
  showWhatsNew();
  loadFeed();
  STATIC ? startPolling() : connect();
}

$("#date").value = state.date;
updateCalLabel();
$("#date").onchange = (e) => setDate(e.target.value);
$("#prevDay").onclick = () => shiftDay(-1);
$("#nextDay").onclick = () => shiftDay(1);
$("#today").onclick = () => setDate(todayStr());
$("#bell").onclick = () => { $("#feed").classList.toggle("hidden"); state.unread = 0; $("#bellCount").textContent = ""; };
window.addEventListener("hashchange", () => { if (ready) route(); });
// liste görünümünü 60 sn'de bir sessizce tazele (canlı skorlar için)
if (!STATIC) setInterval(() => { if (ready && !state.current) renderDay(true); }, 60000);

boot();
