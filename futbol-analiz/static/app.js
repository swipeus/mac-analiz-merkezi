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
  if ((m = path.match(/^\/api\/league\/(\d+)/))) {
    try { return await getData(`league-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu ligin sayfası henüz hazırlanmadı, birkaç dakika sonra tekrar bak."); throw e; }
  }
  if (path === "/api/oddsmoves") {
    try { return await getData("odds-moves.json"); }
    catch (e) { if (e.message === "NOTFOUND") return { moves: [] }; throw e; }
  }
  if ((m = path.match(/^\/api\/day\?date=([\d-]+)/))) {
    try { return await getData(`day-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu tarih için veri yok. Site dünün, bugünün ve yarının maçlarını gösterir."); throw e; }
  }
  if (path === "/api/karne") {
    try { return await getData("karne.json"); }
    catch (e) { if (e.message === "NOTFOUND") return []; throw e; }
  }
  if (path === "/api/katlama") {
    try { return await getData("katlama.json"); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Katlama serisi bir sonraki güncellemede başlayacak."); throw e; }
  }
  if (path === "/api/teams") {
    try { return await getData("teams.json"); }
    catch (e) { if (e.message === "NOTFOUND") return []; throw e; }
  }
  if ((m = path.match(/^\/api\/team\/(\d+)/))) {
    try { return await getData(`team-${m[1]}.json`); }
    catch (e) { if (e.message === "NOTFOUND") throw new Error("Bu takımın sayfası yok. Takım sayfaları dünün, bugünün ve yarının maçlarındaki takımlar için hazırlanır."); throw e; }
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

/* ---------- sıralama ---------- */
// her seçenek: [etiket, kısa ad, maçın değeri (yüksekten düşüğe sıralanır)]
const SORTS = {
  league: ["Lig sırası", "Sırala", null],
  time: ["Başlama saati", "Saat", (m) => -new Date(m.utc).getTime()],
  fav: ["Favori (kazanma %)", "Favori", (m) => m.pred && Math.max(m.pred.p_home, m.pred.p_away)],
  btts: ["Karşılıklı gol (KG Var %)", "KG Var", (m) => m.pred && m.pred.btts],
  over: ["2.5 Üst %", "2.5 Üst", (m) => m.pred && m.pred.over25],
  under: ["2.5 Alt %", "2.5 Alt", (m) => m.pred && 1 - m.pred.over25],
  draw: ["Beraberlik %", "Beraberlik", (m) => m.pred && m.pred.p_draw],
};
state.sort = SORTS[safeGet("sortBy")] ? safeGet("sortBy") : "league";
// sıralı listede kartın üstünde sıralama ölçütünün yüzdesi
function sortBadge(m) {
  if (!m.pred || state.sort === "league" || state.sort === "time") return "";
  const v = SORTS[state.sort][2](m);
  const who = state.sort === "fav" ? (m.pred.p_home >= m.pred.p_away ? m.home.name : m.away.name) + " " : "";
  return `<span class="tag sortv">${esc(SORTS[state.sort][1])}: ${esc(who)}${pc(v)}</span>`;
}
function renderSortMenu() {
  $("#sortBtn").classList.toggle("active", state.sort !== "league");
  $("#sortPop").innerHTML = Object.entries(SORTS).map(([k, [lab]]) =>
    `<button role="menuitemradio" aria-checked="${k === state.sort}" class="sortopt ${k === state.sort ? "on" : ""}" data-sort="${k}">${esc(lab)}</button>`).join("");
  $("#sortPop").querySelectorAll("[data-sort]").forEach((b) => b.onclick = () => {
    state.sort = b.dataset.sort; safeSet("sortBy", state.sort);
    renderSortMenu(); openSort(false); renderDay(true);
  });
}
function openSort(open) { $("#sortPop").classList.toggle("hidden", !open); }
$("#sortBtn").onclick = (e) => { e.stopPropagation(); openSort($("#sortPop").classList.contains("hidden")); };
document.addEventListener("click", (e) => { if (!e.target.closest(".sortwrap")) openSort(false); });
renderSortMenu();

/* ---------- iskelet yükleme ekranı ---------- */
function skel(kind) {
  const line = (w) => `<span class="sk" style="width:${w}"></span>`;
  if (kind === "cards") return `<div class="skwrap">
    <div class="mgrid">${`<div class="mcard skc"><div class="skrow">${line("30%")}${line("20%")}</div><div class="skteams"><span class="skb"></span>${line("18%")}<span class="skb"></span></div>${line("100%")}${line("70%")}</div>`.repeat(6)}</div></div>`;
  if (kind === "list") return `<div class="skwrap">${`<div class="card skc">${line("40%")}${line("90%")}${line("75%")}</div>`.repeat(4)}</div>`;
  return `<div class="skwrap"><div class="card skc skhero"><span class="skb"></span>${line("25%")}<span class="skb"></span></div>${`<div class="card skc">${line("35%")}${line("95%")}${line("80%")}${line("60%")}</div>`.repeat(3)}</div>`;
}

/* ---------- gün listesi ---------- */
let dayCache = null;
async function renderDay(silent) {
  const v = $("#view");
  if (!silent) v.innerHTML = skel("cards");
  try {
    dayCache = await api("/api/day?date=" + state.date);
  } catch (e) {
    v.innerHTML = `<div class="loading">Hata: ${esc(e.message)}</div>`; return;
  }
  if (state.current || state.player || state.karne || state.kombine || state.lig || state.oranlar) return;
  const all = dayCache.matches.filter((m) => !state.off.has(m.league_id));
  if (!all.length) { v.innerHTML = `<div class="loading">Bu tarihte seçili liglerde maç yok.</div>`; return; }
  if (lgOf(quick) && !all.some((m) => m.league_id === lgOf(quick))) quick = "all";  // seçili lig bu gün oynamıyorsa
  const ms = all.filter(lgOf(quick) ? (m) => m.league_id === lgOf(quick) : QUICK[quick][2]);
  // Map: sunucunun lig sırasını korur (sayısal anahtarlı nesne sırayı bozar)
  const groups = new Map();
  ms.forEach((m) => { if (!groups.has(m.league_id)) groups.set(m.league_id, []); groups.get(m.league_id).push(m); });
  const key = SORTS[state.sort][2];
  let body;
  if (key) {  // sıralı görünüm: lig grupları yerine tek liste, en yüksekten aşağı (analizi olmayanlar sonda)
    const val = (m) => { const v = key(m); return v == null || Number.isNaN(v) ? -Infinity : v; };
    const sorted = [...ms].sort((a, b) => val(b) - val(a));
    body = `<section class="lg-block">
      <div class="lg-title"><span class="sorticon">⇅</span><b>${esc(SORTS[state.sort][0])}</b><span>${sorted.length} maç · yüksekten düşüğe</span></div>
      <div class="mgrid">${sorted.map((m) => cardHtml(m, true)).join("")}</div>
    </section>`;
  } else {
    body = [...groups.values()].map((list) => `
    <section class="lg-block">
      <a class="lg-title" href="#/lig/${list[0].league_id}" title="Puan durumu"><img src="${leagueLogo(list[0].league_id)}" alt="" onerror="this.remove()"><b>${esc(list[0].league)}</b><span>${list.length} maç</span><small class="lgt-link">Puan durumu ›</small></a>
      <div class="mgrid">${list.map((m) => cardHtml(m)).join("")}</div>
    </section>`).join("");
  }
  const mine = ms.filter((m) => isMine(m.home.id) || isMine(m.away.id));
  const mineHtml = mine.length ? `<section class="lg-block mine-block">
      <div class="lg-title"><span class="sorticon">★</span><b>Takımlarım</b><span>${mine.length} maç</span></div>
      <div class="mgrid">${mine.map((m) => cardHtml(m, true)).join("")}</div></section>` : "";
  v.innerHTML = quickBar(all) + (ms.length ? mineHtml + body : `<div class="card"><p class="muted">Bu filtreye uyan maç yok.</p></div>`);
  v.querySelectorAll("[data-quick]").forEach((x) => x.onclick = () => { quick = x.dataset.quick; safeSet("quick", quick); renderDay(true); });
  v.querySelectorAll("[data-id]").forEach((r) => r.onclick = () => location.hash = "#/mac/" + r.dataset.id);
  if (typeof liveTick === "function") setTimeout(liveTick, 50);  // kartlara anlık skorları uygula
}

// lig adı: sitenin Türkçe lig listesinden (FotMob'un adı "Super Lig" gibi İngilizce gelebiliyor)
const lgName = (id, fallback) => ((state.leagues || []).find((l) => l.id === id) || {}).name || fallback || "";
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
// en garanti tercihin altındaki 4 olasılık kutusu; en yüksek olasılıklı kutunun etrafı parlar
// korner ve kart kutusunda yazı yerine en olası tahmin (simge zaten neyin kutusu olduğunu söylüyor)
// "7.5 Üst" -> co7.5, "4.5 Alt" -> ku4.5 (oranlar sekmesindeki seçeneğin iç kodu)
const pickCode = (pref, pk) => { const m = pk && pk.label.match(/^([\d.]+) (Üst|Alt)$/); return m ? `${pref}${m[2] === "Üst" ? "o" : "u"}${m[1]}` : null; };
const boxItems = (o25, btts, cpick, kpick, bodds) => [["⚽", "2.5 Üst", o25, "o2.5", (bodds || {})["o2.5"]], ["🔁", "KG Var", btts, "btts_yes", (bodds || {}).btts_yes],
  ["🚩", cpick ? cpick.label : "Korner", cpick ? cpick.p : null, pickCode("c", cpick), cpick && cpick.odds], ["🟨", kpick ? kpick.label : "Kart", kpick ? kpick.p : null, pickCode("k", kpick), kpick && kpick.odds]];
// kutulardaki korner ve kart simgeleri dolu ve renkli: kırmızı bayrak, sarı kart
const BOX_ICON = {
  "🚩": `<svg class="svgi bxi" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V3" stroke="#c9d1d9" stroke-width="2" stroke-linecap="round"/><path d="M5 4h13l-3 4.5 3 4.5H5z" fill="#f85149" stroke="#f85149" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  "🟨": `<svg class="svgi bxi" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="3" width="11" height="18" rx="2" transform="rotate(8 12 12)" fill="#f5c518" stroke="#d9a400" stroke-width="1"/></svg>`,
};
const boxCodes = (P) => new Set(boxItems(0, 0, P.corner_pick, P.card_pick).map((x) => x[3]).filter(Boolean));
// kutuya dokununca o maçın Oranlar sekmesi açılır ve ilgili seçenek vurgulanır
let oddsFocus = null, pendingTab = null;
function openOddsAt(mid, code) {
  oddsFocus = code;
  if (state.current === mid) {
    const t = document.querySelector('[data-mt="odds"]');
    if (t) t.click();
  } else { pendingTab = "odds"; location.hash = "#/mac/" + mid; }
}
function focusOdds() {
  if (!oddsFocus) return;
  const row = document.querySelector(".otile.focus");
  oddsFocus = null;
  if (!row) return;
  const g = row.closest("details"); if (g) g.open = true;
  // sayfa çizimi ve başa kaydırma bittikten sonra seçeneğe in
  const go = () => { const r = document.querySelector(".orow.focus"); if (r) window.scrollTo(0, r.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3); };
  setTimeout(go, 250); setTimeout(go, 700);
}
function probBoxes(items, mid) {
  const vals = items.filter((x) => x[2] != null);
  if (!vals.length) return "";
  const top = Math.max(...vals.map((x) => x[2]));
  return `<div class="pboxes">${items.map(([ic, l, v, code, odds]) => `<div class="pbox ${v != null && v === top ? "best" : ""} ${v != null && v >= 0.6 ? "hi" : ""}" ${mid && code ? `data-ocode="${code}" data-omid="${mid}" title="Oranlarda göster"` : ""}>
    <span class="pbl">${BOX_ICON[ic] || ico(ic)} ${esc(l)}</span><b>${v != null ? pc(v) : "—"}</b>${odds ? `<small class="pbo">${nf(odds, 2)}</small>` : ""}
    <span class="pbb"><span style="width:${v != null ? Math.round(v * 100) : 0}%"></span></span></div>`).join("")}</div>`;
}
// maç listesinde tek dokunuşla filtre
const QUICK = {
  all: ["Tümü", "", () => true],
  final: ["Kesinleşenler", "✅", (m) => m.pred && m.pred.safe && m.pred.safe.final && !m.finished],
  value: ["Değerli oranlı", "💎", (m) => m.pred && m.pred.value],
  live: ["Canlı", "🔴", (m) => m.started && !m.finished],
  mine: ["Takımlarım", "★", (m) => isMine(m.home.id) || isMine(m.away.id)],
  done: ["Bitenler", "🏁", (m) => m.finished],
};
const lgOf = (k) => (/^lg\d+$/.test(k) ? +k.slice(2) : null);
let quick = safeGet("quick") || "all";
if (!QUICK[quick] && !lgOf(quick)) quick = "all";
// şerit: Tümü, o günün ligleri, sonra diğer filtreler
function quickBar(ms) {
  const btn = (k, html, n) => `<button class="chipbtn ${quick === k ? "on" : ""}" data-quick="${k}">${html} <small>${n}</small></button>`;
  const lgs = new Map();
  ms.forEach((m) => { if (!lgs.has(m.league_id)) lgs.set(m.league_id, m.league); });
  const rest = Object.entries(QUICK).filter(([k]) => k !== "all").map(([k, [l, ic, f]]) => {
    const n = ms.filter(f).length;
    return !n && quick !== k ? "" : btn(k, `${ic} ${l}`, n);
  }).join("");
  return `<div class="chiprow quickbar fbchips">${btn("all", "Tümü", ms.length)}${[...lgs].map(([id, name]) =>
    btn("lg" + id, `<img src="${leagueLogo(id)}" alt="" onerror="this.remove()">${esc(name)}`, ms.filter((m) => m.league_id === id).length)).join("")}${rest}</div>`;
}
// maç kartının sol kenar rengi: maçın ve tahminin durumu
const STATE_LABEL = { live: "Canlı", done: "Maç bitti", final: "Resmi 11'ler açıklandı · tercih kesinleşti", open: "Resmi 11'ler bekleniyor · tercih değişebilir", wait: "Analiz hazırlanıyor", off: "İptal" };
function matchState(m) {
  if (m.cancelled) return "off";
  if (m.started && !m.finished) return "live";
  if (m.finished) return "done";
  if (!m.pred) return "wait";
  return m.lineup_type && !["predicted", "lastStarting11"].includes(m.lineup_type) ? "final" : "open";
}
function cardHtml(m, sorted) {
  const live = m.started && !m.finished;
  const p = m.pred;
  const fav = favoriteSide(p);
  let top = m.cancelled ? `<span class="when">İptal</span>`
    : live ? `<span class="badge-live">CANLI ${esc(m.live || "")}</span>`
    : m.finished ? `<span class="when">Maç sonu</span>` : `<span></span>`;
  const tags = p ? [m.lineup_type && !["predicted", "lastStarting11"].includes(m.lineup_type) ? lineupTag(m.lineup_type, false) : "",
    ""].join("") : "";
  const mid = (m.started || m.finished)
    ? `<div class="sc">${m.home.score ?? 0} - ${m.away.score ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`
    : `<div class="ko">${esc(timeOf(m.utc))}</div><div class="sub">başlama</div>`;
  const s = p && p.safe;
  const safe = s ? `<div class="bksafe ${s.hit === true ? "won" : s.hit === false ? "lost" : ""}" title="${s.hit === true ? "Tuttu" : s.hit === false ? "Tutmadı" : s.final ? "Son tercih (resmi 11'ler sonrası)" : "Resmi 11'ler açıklanınca kesinleşir, değişebilir"}"><span>${s.hit === true ? "✓" : s.hit === false ? "✗" : s.final ? "✅" : "!"} ${esc(s.label.replace(/ \(.*\)$/, ""))}</span><b>${[s.p != null ? pc(s.p) : "", s.odds ? nf(s.odds, 2) : ""].filter(Boolean).join(" · ")}</b></div>` : "";
  const bottom = p ? `
    <div class="probs"><span class="ph">${pc(p.p_home)}</span>
      <div class="probbar"><span style="width:${p.p_home * 100}%"></span><span style="width:${p.p_draw * 100}%"></span><span style="width:${p.p_away * 100}%"></span></div>
      <span class="pa">${pc(p.p_away)}</span></div>
    ${safe}
    ${probBoxes(boxItems(p.over25, p.btts, p.cpick, p.kpick, p.bodds), m.id)}` : `<div class="pending">Analiz hazırlanıyor…</div>`;
  const stc = matchState(m);
  return `<div class="mcard ${live ? "is-live" : ""} st-${stc}" data-id="${m.id}" title="${STATE_LABEL[stc]}">
    <div class="mtop">${top}<div class="mtags">${sorted ? `<span class="tag lgt"><img src="${leagueLogo(m.league_id)}" alt="" onerror="this.remove()">${esc(m.league)}</span>${sortBadge(m)}` : tags}</div></div>
    <div class="mteams">
      <div class="tm">${crestHtml(m.home, fav === "home", p && p.p_home)}<div class="nm">${esc(m.home.name)}</div></div>
      <div class="mid">${mid}</div>
      <div class="tm">${crestHtml(m.away, fav === "away", p && p.p_away)}<div class="nm">${esc(m.away.name)}</div></div>
    </div>
    ${bottom}
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
  if (!silent) v.innerHTML = skel("page");
  let b;
  try { b = await api(`/api/match/${id}${refresh ? "?refresh=true" : ""}`); }
  catch (e) { v.innerHTML = `<div class="loading">Hata: ${esc(e.message)}</div>`; return; }
  if (state.current !== id) return;
  const y = window.scrollY;
  lastB = b;
  if (matchTabId !== id) { matchTab = pendingTab || defaultMatchTab(b); matchTabId = id; }
  pendingTab = null;  // yeni maç: varsayılan sekme
  v.innerHTML = matchHtml(b);
  bindMatch();
  if (silent) window.scrollTo(0, y);
  // başlamış maçta kupon ayaklarının durumu için maçın gününün kuponları (liste açılmadan gelindiyse)
  const dk = trDay(b.utc);
  if (b.status && b.status.started && !(dayCache && dayCache.date === dk) && !(couponDay && couponDay.date === dk)) {
    api("/api/day?date=" + dk).then((d) => {
      couponDay = d;
      if (state.current === id && matchTab === "ozet") { $(".mtab-body").innerHTML = matchTabBody(lastB); bindOdds(); }
    }).catch(() => {});
  }
}
const REFRESH_LABEL = () => STATIC ? "Yeni veri var mı?" : "Şimdi yenile";
function bindMatch() {
  if (typeof liveTick === "function") setTimeout(liveTick, 50);  // canlı kutuyu hemen doldur
  bindOdds();
  $("#view").querySelectorAll("[data-mt]").forEach((t) => t.onclick = () => {
    matchTab = t.dataset.mt;
    $("#view").querySelectorAll("[data-mt]").forEach((x) => x.classList.toggle("on", x.dataset.mt === matchTab));
    $(".mtab-body").innerHTML = matchTabBody(lastB);
    bindOdds();
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
        meta = m;
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
    b.referee && chip(WHISTLE, `<a class="tlink" href="#/hakem/${b.id}" title="Hakem sayfası">Hakem: ${esc(b.referee)}</a>`),
    w && chip(weatherIcon(w.description), `${w.temperature}°C · ${esc(cap(trWeather(w.description)))}${w.windSpeed != null ? ` · Rüzgar ${w.windSpeed} m/s` : ""}`),
  ].filter(Boolean).join("");
  const conf = { "Yüksek": "#3fb950", "Orta": "#d29922", "Düşük": "#f85149" }[P.confidence] || "#8b98a8";
  return `
  <div class="hero" ${b.colors ? `style="--home:${esc(b.colors.home)};--away:${esc(b.colors.away)}"` : ""}>
    <a class="hero-league" href="#/lig/${b.league_id}" title="Puan durumu"><img src="${leagueLogo(b.league_id)}" alt="" onerror="this.remove()"><b>${esc(lgName(b.league_id, b.league_name))}</b><small>· puan durumu ›</small></a>
    <div class="teams">
      <div class="team">${crestHtml(b.home, fav === "home", P.p_home, 84)}<span><a class="tlink" href="#/takim/${b.home.id}" title="Takım sayfası">${esc(H)}</a> ${starBtn(b.home.id, H)}</span>${formDots(b.recent.home.rows)}</div>
      <div class="score ${live ? "live" : ""}">${esc(scoreTxt)}<small>${esc(stTxt)}</small></div>
      <div class="team">${crestHtml(b.away, fav === "away", P.p_away, 84)}<span><a class="tlink" href="#/takim/${b.away.id}" title="Takım sayfası">${esc(W)}</a> ${starBtn(b.away.id, W)}</span>${formDots(b.recent.away.rows)}</div>
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
  const nNews = cleanNews(b.news.home.tr, b.home.name).length + cleanNews(b.news.away.tr, b.away.name).length;
  const t = [];
  if (st.started || st.finished) t.push(["live", live ? "🔴 Canlı" : "🏁 Maç", live ? (st.live || "") : ""]);
  t.push(["ozet", ico("📊") + " Özet", ""], ["kadro", ico("👥") + " Kadrolar", b.lineup ? lineupTypeShort(b.lineup.type) : ""],
    ["analiz", ico("🧠") + " Takım analizi", ""], ["istat", ico("📈") + " İstatistikler", ""],
    ["odds", ico("💰") + " Oranlar", nOdds ? nOdds + " pazar" : ""], ["haber", ico("📰") + " Haberler", nNews ? String(nNews) : ""]);
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
      return `<div class="tcmpbar"><a class="kbtn" href="#/karsilastir/${b.home.id}/${b.away.id}">⚖️ Takımları ayrıntılı karşılaştır</a></div>${compareHtml(b)}
        <div class="grid2">${recentHtml(b.recent.home, H, "home-c")}${recentHtml(b.recent.away, W, "away-c")}</div>
        ${seasonHtml(b)}`;
    case "odds":
      return oddsHtml(b);
    case "haber":
      return `${newsFilterBar()}<div class="grid2">${newsHtml(b.news.home, H, "home-c")}${newsHtml(b.news.away, W, "away-c")}</div>${extrasHtml(b)}`;
    default:
      return `${b.status && b.status.finished ? trackHtml(b, finalCtx(b), "Maç sonu değerlendirmesi") : ""}${newsAlertsHtml(b)}${commentaryHtml(A, b)}${predictionHtml(b)}${refereeHtml(b)}`;
  }
}
function predictionHtml(b) {
  const A = b.analysis, P = A.prediction, H = b.home.name, W = b.away.name;
  const conf = { "Yüksek": "#3fb950", "Orta": "#d29922", "Düşük": "#f85149" }[P.confidence] || "#8b98a8";
  return `
  <div class="card" style="--c:#a371f7">
    ${head("🎯", `Tahmin ve model özeti${A.frozen ? ` <span class="muted">· maç öncesi tahmin, başlama düdüğünde donduruldu 🔒</span>` : ""}`)}
    <div class="summary">${esc(A.summary)}</div>
    <div class="kshare">${shareBtn("m:" + b.id, `⚽ Maç özeti · ${H} – ${W}`, matchShareText(b))}</div>
    ${outcomeBars(b)}
    ${scoreHero(b)}
    <div class="pbwide">${probBoxes(boxItems(P.over25, P.btts, P.corner_pick, P.card_pick, P.box_odds), b.id)}</div>
    ${P.best_pick || P.surprise ? `<div class="bigpicks">${bigPick("safe", "✅", "En garanti tercih", P.best_pick, finalBadge(bestFinal(b)))}${bigPick("val", "💎", "Değerli oran", P.value_pick, `<span class="vbadge" title="Model olasılığı × oran − 1: oranın, modelin gördüğü olasılığa göre ne kadar yüksek olduğu">+%${Math.round(((P.value_pick || {}).edge || 0) * 100)} değer</span>`)}${bigPick("sur", "⚡", "Olası sürpriz", P.surprise, "")}</div>` : ""}
    <div class="pred">
      ${goalCard(P)}
      ${P.corners ? kpi("🚩", "#d29922", "Korner beklentisi", `${nf(P.corners.home)} – ${nf(P.corners.away)}`, `Toplam ${nf(P.corners.total)} · 9.5Ü ${pc((P.probs || {})["co9.5"] ?? P.corners.over["9.5"])} · 10.5Ü ${pc((P.probs || {})["co10.5"] ?? P.corners.over["10.5"])}`) : ""}
      ${P.shots.home != null ? kpi("🥅", "#f78166", "Şut beklentisi", `${nf(P.shots.home)} – ${nf(P.shots.away)}`, `İsabetli: ${nf(P.sot.home)} – ${nf(P.sot.away)}`) : ""}
      ${P.yellow.total != null ? kpi("🟨", "#e3b341", "Sarı kart ort.", nf(P.yellow.total), `${nf(P.yellow.home)} + ${nf(P.yellow.away)} (son maçlar)`) : ""}
      ${kpi("🧠", conf, "Model güveni", P.confidence, "Veri miktarına göre")}
    </div>
    <h3>Olası senaryolar</h3>
    <ul class="scen">${A.scenarios.map((s) => `<li><span class="si">${scenarioIcon(s)}</span><span>${esc(s)}</span></li>`).join("")}</ul>
  </div>`;
}
// maç sonucu: modelin 1-X-2 çubuğu, altında piyasanın (marjı temizlenmiş oranların) ince çubuğu
function market1x2(b) {
  const m = ((b.odds && b.odds.markets) || []).find((x) => x.key === "who_will_win");
  if (!m) return null;
  const o = Object.fromEntries(m.selections.map((x) => [x.code, x.odds]));
  if (!(o["1"] && o.X && o["2"])) return null;
  const t = 1 / o["1"] + 1 / o.X + 1 / o["2"];
  return [1 / o["1"] / t, 1 / o.X / t, 1 / o["2"] / t];
}
function outcomeBars(b) {
  const P = b.analysis.prediction, H = b.home.name, W = b.away.name, mk = market1x2(b);
  const seg = (v, c, t, txt) => `<div style="flex:${v};background:${c}" title="${esc(t)}">${txt}</div>`;
  return `<div class="obars"><div class="obl"><span>Model</span></div><div class="bigbar">
      ${seg(P.p_home, "var(--home)", H + " kazanır", "1 " + pc(P.p_home))}${seg(P.p_draw, "var(--draw)", "Beraberlik", "X " + pc(P.p_draw))}${seg(P.p_away, "var(--away)", W + " kazanır", "2 " + pc(P.p_away))}</div>
    ${mk ? `<div class="obl"><span>Piyasa</span></div><div class="bigbar mkbar">
      ${seg(mk[0], "var(--home)", "Piyasa: " + H + " " + pc(mk[0]), pc(mk[0]))}${seg(mk[1], "var(--draw)", "Piyasa: beraberlik " + pc(mk[1]), pc(mk[1]))}${seg(mk[2], "var(--away)", "Piyasa: " + W + " " + pc(mk[2]), pc(mk[2]))}</div>` : ""}</div>`;
}
// skor tahmini: iki logo arasında büyük skor, altında diğer olası skorlar
function scoreHero(b) {
  const P = b.analysis.prediction, sp = P.score_pick || P.scores[0];
  const [h, a] = sp.score.split("-");
  const others = P.scores.filter((s) => s.score !== sp.score).slice(0, 3);
  const side = (t) => `<div class="shs"><img src="${teamLogo(t.id)}" alt="" onerror="this.remove()"><span>${esc(t.name)}</span></div>`;
  return `<div class="shero"><div class="shk">${ico("🎲")} Skor tahmini</div>
    <div class="shrow">${side(b.home)}<div class="shsc"><b>${esc(h)}</b><i>-</i><b>${esc(a)}</b></div>${side(b.away)}</div>
    <div class="shsub">
      ${others.length ? `<span class="shalt"><span class="muted">Diğer olasılar</span>${others.map((s) => `<span class="schip">${esc(s.score)}</span>`).join("")}</span>` : ""}</div></div>`;
}
// en garanti tercih / olası sürpriz: büyük kart, oran sağda iri
function bigPick(cls, ic, title, x, badge) {
  if (!x) return "";
  return `<div class="bpick ${cls}"><div class="bpt"><span class="bpi">${ico(ic)}</span>${title}${badge ? " " + badge : ""}</div>
    <div class="bpm"><b class="bpl">${esc(x.label)}</b>${x.odds ? `<span class="bpo">${nf(x.odds, 2)}</span>` : ""}</div>
    <div class="bps">Model ${pc(x.p)}${x.odds ? ` · Piyasa ${pc(1 / x.odds)}` : ""}</div></div>`;
}
// gol özeti: beklenen goller, alt/üst ve KG tek kartta
function goalCard(P) {
  const bar = (l, v) => `<div class="gcr"><span>${l}</span><span class="gcb"><span style="width:${Math.round(v * 100)}%"></span></span><b>${pc(v)}</b></div>`;
  return `<div class="kpi gcard" style="--k:#3fb950"><div class="l"><span class="ki">${ico("⚽")}</span>Gol beklentisi</div>
    <div class="v">${nf(P.lam_home, 2)} – ${nf(P.lam_away, 2)} <small class="muted">xG · toplam ${nf(P.lam_home + P.lam_away, 1)}</small></div>
    <div class="gcrs">${bar("1.5 Üst", P.over15)}${bar("2.5 Üst", P.over25)}${bar("3.5 Üst", P.over35)}${bar("KG Var", P.btts)}</div>
    <div class="s">${P.uses_odds ? "İstatistik + bahis oranları" : "İstatistik modeli"}</div></div>`;
}
/* ---------- maç yorumu ---------- */
function commentaryHtml(A, b) {
  const c = A.commentary;
  if (!c || !c.paragraphs || !c.paragraphs.length) return "";
  const last = c.paragraphs.length - 1;
  return `<div class="card comm" style="--c:#39c5cf">${head("🗣️", `Maç yorumu <span class="muted">· kaynaklar, seriler, puan durumu ve oranlara göre</span>`)}
    ${c.tags && c.tags.length ? `<div class="ctags">${c.tags.map((t) => `<span class="ctag">${esc(t)}</span>`).join("")}</div>` : ""}
    ${c.paragraphs.map((p, i) => `<p class="${i === last ? "cconcl" : ""}">${esc(p)}</p>`).join("")}
    ${b ? `<div class="kshare">${shareBtn("y:" + b.id, `🗣️ Yorum · ${b.home.name} – ${b.away.name}`, `🗣️ MAÇ YORUMU\n${matchLine(b.home.name, b.away.name, b.utc)}\n${SH_LINE}\n💬 ${c.paragraphs[last]}`)}</div>` : ""}
  </div>`;
}

/* ---------- maç sayfası sekmeleri ve oranlar ---------- */
let matchTab = "ozet", matchTabId = null;
const ODDS_GROUPS = ["Maç", "Goller", "Yarılar", "Skor", "Kombine", "Korner", "Kart ve penaltı", "Şut ve ofsayt", "Handikap",
  "Oyuncu: gol", "Oyuncu: şut ve asist", "Oyuncu: kart ve faul", "Zaman aralığı", "Diğer", "Oyuncular"];
const GROUP_IC = { "Maç": "⚽", "Goller": "🥅", "Yarılar": "⏱️", "Skor": "🎯", "Kombine": "🧩", "Korner": "🚩", "Kart ve penaltı": "🟨",
  "Şut ve ofsayt": "👟", "Handikap": "⚖️", "Oyuncu: gol": "🏃", "Oyuncu: şut ve asist": "🎯", "Oyuncu: kart ve faul": "🟥",
  "Zaman aralığı": "⏲️", "Diğer": "📋", "Oyuncular": "🏃" };
const OPEN_GROUPS = new Set(["Maç", "Goller", "Kombine"]);
function oddsHtml(b) {
  const P = b.analysis.prediction, o = b.odds;
  if (!o || !o.markets || !o.markets.length) return `<div class="card"><p class="muted">Bu maç için henüz bahis oranı bulunamadı. Oranlar genelde maçtan 1-3 gün önce açılır.</p></div>`;
  const probs = P.probs || {};
  const safe = P.best_pick && P.best_pick.code, sur = P.surprise && P.surprise.code, val = P.value_pick && P.value_pick.code;
  BOX = boxCodes(P);
  const nSel = o.markets.reduce((a, m) => a + m.selections.length, 0);
  const pickCard = (cls, ic, title, x, note) => x ? `<div class="opick ${cls}"><div class="oi">${ic}</div><div>
      <div class="k">${title}</div><b>${esc(x.label)}</b>
      <div class="s">${x.odds ? `Oran <b>${nf(x.odds, 2)}</b> · ` : ""}Model olasılığı <b>${pc(x.p)}</b>${x.odds ? ` · Piyasa ${pc(1 / x.odds)}` : ""}</div>
      <small class="muted">${note}</small></div></div>` : "";
  const top = `<div class="card" style="--c:#e3b341">${head("💰", `Bahis oranları <span class="muted">· ${esc((o.providers || []).join(", "))} · ${o.markets.length} pazar, ${nSel} seçenek</span>`)}
    <div class="opicks">
      ${pickCard("safe", "✅", "En garanti tercih " + finalBadge(bestFinal(b)), P.best_pick, "Oranı 1.30 ve üstü seçenekler (kombineler dahil) arasında modelin en yüksek olasılık verdiği tercih. Resmi ilk 11'ler açıklanınca son kontrol yapılır ve tercih kesinleşir.")}
      ${pickCard("val", "💎", "Değerli oran", P.value_pick, "Oranı 1.60-3.20 arasında, modelin piyasadan en az %5 daha olası gördüğü ve türü karnede kendini kanıtlamış tercih. Karnede ayrı izlenir.")}
      ${pickCard("sur", "⚡", "Olası sürpriz", P.surprise, "Oranı yüksek ama modelin piyasadan daha olası gördüğü seçenek. Karnede yer almaz.")}
    </div>
    <p class="muted">Model gol beklentisini istatistiklerle bahis oranlarını harmanlayarak hesaplar${P.lam_market ? ` (piyasa: ${nf(P.lam_market[0], 2)} – ${nf(P.lam_market[1], 2)} gol, istatistik: ${nf(P.lam_model[0], 2)} – ${nf(P.lam_model[1], 2)})` : ""}. Kutularda oran, açılıştan beri yönü (<b class="up">▲</b> yükseldi, <b class="down">▼</b> düştü) ve altında modelin olasılığı; yeşil <em>+%</em> model piyasadan iyimser demek (değer = model olasılığı × oran − 1). Kutuya dokununca/üzerine gelince piyasa olasılığı ve açılış oranı. Garanti tercih yeşil, değerli oran turkuaz, sürpriz sarı çerçeveli. Kombinelerde model olasılığı, ayakların aynı anda tutma ihtimalidir. 1.30 altındaki oranlar tercih dışıdır.</p>
    <input id="oddsSearch" class="osearch" type="search" placeholder="Pazar, oyuncu veya seçenek ara (ör. Gibbs-White, korner, KG)" autocomplete="off"></div>`;
  const groups = ODDS_GROUPS.map((g) => {
    const ms = o.markets.filter((m) => m.group === g);
    if (!ms.length) return "";
    const n = ms.reduce((a, m) => a + m.selections.length, 0);
    return `<details class="card ogrp" style="--c:#58a6ff" ${OPEN_GROUPS.has(g) ? "open" : ""}><summary>${head(GROUP_IC[g] || "📋", `${esc(g)} <span class="muted">· ${ms.length} pazar · ${n} seçenek</span>`)}</summary><div class="omkts">${ms.map((m) => marketHtml(m, probs, safe, sur, b)).join("")}</div></details>`;
  }).join("");
  return top + groups;
}
function bindOdds() {
  focusOdds();
  const q = $("#oddsSearch");
  if (!q) return;
  q.oninput = () => {
    const t = q.value.trim().toLocaleLowerCase("tr");
    document.querySelectorAll(".ogrp").forEach((g) => {
      let any = false;
      g.querySelectorAll(".omkt").forEach((m) => {
        const title = m.querySelector(".omh b").textContent.toLocaleLowerCase("tr");
        let hit = 0;
        m.querySelectorAll(".otile").forEach((r) => {
          const ok = !t || title.includes(t) || r.textContent.toLocaleLowerCase("tr").includes(t);
          r.style.display = ok ? "" : "none"; hit += ok;
        });
        m.style.display = hit ? "" : "none"; any = any || hit > 0;
      });
      g.style.display = any ? "" : "none";
      if (t && any) g.open = true;
    });
  };
}
let BOX = new Set();  // o an açık maçın kutu tercihleri (oranlar sekmesinde kalın yazılır)
function marketHtml(m, probs, safe, sur, b) {
  // pazar = başlık + seçenek kutuları (oran, açılıştan beri yön oku, altında modelin olasılığı)
  const val = (b.analysis.prediction.value_pick || {}).code;
  const n = m.selections.length;
  const sub = (l) => l === "1" ? b.home.name : l === "2" ? b.away.name : l === "X" ? "Beraberlik" : "";
  // eski kayıtlarda "ip" yok: küçük pazarlarda burada hesaplanır
  const inv = m.selections.map((s) => 1 / s.odds), tot = inv.reduce((a, x) => a + x, 0);
  const old = n >= 2 && !/^(k:|prepack)/.test(m.key) && !m.selections.some((s) => s.ip != null);
  const longest = Math.max(...m.selections.map((s) => (s.label || "").length));
  // Üst/Alt çiftleri (Üst 0.5, Alt 0.5, Üst 1.5...) iki sütunda yan yana kalsın
  const pairs = n % 2 === 0 && m.selections.every((s, i) => /^(Üst|Alt|Over|Under|Evet|Hayır|Yes|No)(\s|$)/i.test(s.label || "") && (i % 2 === 0 || (s.label || "").split(" ")[0] !== (m.selections[i - 1].label || "").split(" ")[0]));
  const cols = n === 2 || pairs ? 2 : n === 3 ? 3 : longest > 16 ? 2 : longest > 8 ? 3 : 4;
  const tiles = m.selections.map((s, i) => {
    const mp = s.code != null ? probs[s.code] : null;
    const ip = s.ip != null ? s.ip : old && n <= 8 && tot ? inv[i] / tot : null;
    const v = mp != null ? mp * s.odds - 1 : null;
    const tag = s.code && s.code === safe ? "safe" : s.code && s.code === val ? "val" : s.code && s.code === sur ? "sur" : "";
    const cls = [tag, s.code && BOX.has(s.code) ? "bx" : "", s.code && s.code === oddsFocus ? "focus" : "", s.odds < 1.3 ? "low" : ""].join(" ");
    const mv = s.o0 && Math.abs(s.o0 - s.odds) >= 0.01 ? `<i class="omv ${s.odds > s.o0 ? "up" : "down"}" title="Açılış ${nf(s.o0, 2)}">${s.odds > s.o0 ? "▲" : "▼"}</i>` : "";
    const tip = [ip != null ? `Piyasa ${pc(ip)}` : "", mp != null ? `Model ${pc(mp)}` : "", v != null ? `Değer ${v > 0 ? "+" : ""}${Math.round(v * 100)}%` : "", s.o0 ? `Açılış ${nf(s.o0, 2)}` : ""].filter(Boolean).join(" · ");
    return `<div class="otile ${cls}" title="${esc(tip)}">
      ${tag ? `<i class="otk ${tag}">${{ safe: "✅ Garanti", val: "💎 Değerli", sur: "⚡ Sürpriz" }[tag]}</i>` : ""}
      <span class="otl">${esc(s.label)}${sub(s.label) ? `<small>${esc(sub(s.label))}</small>` : ""}</span>
      <b class="oto">${mv}${nf(s.odds, 2)}</b>
      <span class="otm">${mp != null ? `model ${pc(mp)}${v != null && v > 0.05 ? ` <em>+${Math.round(v * 100)}%</em>` : ""}` : ip != null ? `piyasa ${pc(ip)}` : ""}</span></div>`;
  }).join("");
  return `<div class="omkt"><div class="omh"><b>${esc(m.title)}</b><small class="muted">${n > 3 ? n + " seçenek" : ""}</small></div>
    <div class="otiles ${n > 12 ? "oscroll" : ""}" style="--cols:${cols}">${tiles}</div></div>`;
}

const ICON_PATHS = {
  "📊": `<path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/>`,
  "📈": `<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>`,
  "📉": `<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>`,
  "🧠": `<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>`,
  "💰": `<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/><path d="M6 7l3-4h6l3 4"/>`,
  "📰": `<path d="M4 4h13v16H6a2 2 0 0 1-2-2z"/><path d="M17 8h3v10a2 2 0 0 1-2 2"/><path d="M8 8h5M8 12h5M8 16h3"/>`,
  "🎯": `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  "📒": `<path d="M5 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5z"/><path d="M9 3v18M12 8h4M12 12h4"/>`,
  "🧩": `<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>`,
  "🏆": `<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>`,
  "🗓️": `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  "📅": `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  "📆": `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  "🚩": `<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>`,
  "🟨": `<rect x="7" y="3" width="10" height="18" rx="2"/>`,
  "🟥": `<rect x="7" y="3" width="10" height="18" rx="2"/>`,
  "⚽": `<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/>`,
  "🧭": `<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>`,
  "🗣️": `<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>`,
  "👥": `<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6"/>`,
  "📋": `<path d="M9 3h6v3H9z"/><path d="M7 5H5v16h14V5h-2"/><path d="M9 11h6M9 15h6"/>`,
  "✅": `<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>`,
  "⚡": `<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>`,
  "🔒": `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  "💎": `<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3l3 6 3-6"/>`,
  "🏃": `<path d="M3 12h4l3-8 4 16 3-8h4"/>`,
  "🛡️": `<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>`,
  "⏳": `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  "⏱️": `<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M10 2h4"/>`,
  "🏦": `<path d="M3 10l9-6 9 6"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>`,
  "⭐": `<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z"/>`,
  "🔥": `<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 1.5 1 2.5 2 3-3z"/>`,
  "🚑": `<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>`,
  "🥅": `<path d="M3 20V6h18v14"/><path d="M3 6l3 3h12l3-3M7 9v11M12 9v11M17 9v11"/>`,
  "👟": `<path d="M3 16h18v3H3z"/><path d="M3 16l2-7 5 2 3-4 4 4 4 1v4"/>`,
  "🤝": `<path d="M3 11l4-4 5 2 5-2 4 4-9 9z"/><path d="M8 12l3 3 2-2"/>`,
  "📐": `<path d="M3 21L21 3v18z"/><path d="M8 21v-3M12 21v-5M16 21v-7"/>`,
  "🔁": `<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>`,
  "🧤": `<path d="M7 21V10l-2-3 1-1 3 2V4a1.5 1.5 0 0 1 3 0v5-6a1.5 1.5 0 0 1 3 0v6-4a1.5 1.5 0 0 1 3 0v9c0 4-2 7-6 7z"/>`,
  "📏": `<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>`,
  "🦶": `<path d="M7 3c2 0 3 2 3 5s-1 5 1 8 2 5-1 5-6-3-6-8 1-10 3-10z"/>`,
  "💶": `<circle cx="12" cy="12" r="9"/><path d="M15 8.5a4 4 0 1 0 0 7M7 11h6M7 13h6"/>`,
  "🎲": `<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="12" cy="12" r="1"/>`,
  "🔍": `<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>`,
  "📤": `<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3L10 13"/>`,
  "👁️": `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
};
// başlık ve özet kartlarındaki emojiler tek tip çizgi simgelere çevrilir (her telefonda aynı görünsün)
const ico = (ic) => ICON_PATHS[ic] ? `<svg class="svgi" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[ic]}</svg>` : ic;
// garanti tercih kesinleşti mi: resmi 11'ler açıklandıktan sonraki son kontrol yapıldıysa ya da maç başladıysa
const bestFinal = (b) => !!(b.analysis.prediction.best_final || b.analysis.frozen || (b.status || {}).started);
const finalBadge = (fin) => fin
  ? `<span class="fbadge ok" title="Resmi ilk 11'ler açıklandıktan sonra son kontrol yapıldı; bu tercih artık değişmez.">✓ Son tercih</span>`
  : `<span class="fbadge wait" title="Resmi ilk 11'ler açıklanınca son kontrol yapılır ve tercih kesinleşir; o zamana kadar değişebilir.">! Değişebilir</span>`;
const kpi = (ic, color, l, v, s) => `<div class="kpi" style="--k:${color}"><div class="l"><span class="ki">${ico(ic)}</span>${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || "")}</div></div>`;
const head = (ic, title, extra = "") => `<h2 class="ch"><span class="ci">${ico(ic)}</span><span class="ct">${title}</span>${extra}</h2>`;
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
// ---- haber filtresi: alakasız, tekrar eden ve canlı skor haberleri ayıklanır; kalanlar konuya göre ayrılır ----
const NEWS_CATS = [["all", "Tümü"], ["kadro", "🩹 Kadro & sakatlık"], ["mac", "🗣️ Maç önü"], ["transfer", "🔁 Transfer"], ["diger", "📰 Diğer"]];
// başlıklar Türkçe küçük harfe çevrilip aranır (CANLI -> canlı)
const NEWS_RX = {
  kadro: /sakat|yaralan|kadro|ilk 11|muhtemel 11|ceza|forma giy|yetiş|ameliyat|kas yırt|eksik|sahalara dön|injur|absence|lineup|line-up|team news|doubt|suspen|fitness|ruled out|ban /,
  mac: /maç öncesi|maçı öncesi|önizleme|basın toplantı|açıklama|derbi|karşı karşıya|preview|press conference|predict|ahead of|clash/,
  transfer: /transfer|sözleşme|imza|teklif|takipte|ilgileniyor|kiralık|bonservis|ayrılık|ocak ayında|devre arası|sign|contract|loan|bid|target|deal|move for|january|searching|in hunt|race to/,
};
const NEWS_JUNK = /(^|[\s|])canlı([\s:|]|$)|canlı anlatım|canlı gol|skor\s*:|sona erdi|maç sonucu:|dakika tamamlandı|maçında gol:|podcast|le pagelle|player ratings|kimdir\?|burç|hava durumu|(^|\s)live(\s|:|$)|as it happened|primavera|\bu1[79]\b|\bu2[013]\b|kadın takım|women|turist|kruvaziyer|iddaa programı|saat kaçta|hangi kanalda|canlı izle|borsa|kardashian|kırmızı halı|fahişe|ihanet|aldat|sevgilisi|partneri|magazin|elbise|bikini|düğün|boşan|ünlü oyuncu|dizi /;
let newsCat = (() => { try { return localStorage.getItem("newsCat") || "all"; } catch { return "all"; } })();
const newsWords = (t) => new Set((t || "").toLocaleLowerCase("tr").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
function newsAbout(t, name) {
  const s_ = (t || "").toLocaleLowerCase("tr"), n = (name || "").toLocaleLowerCase("tr");
  return s_.includes(n) || n.split(/[\s.\-]+/).some((w) => w.length >= 4 && !["united", "city", "club"].includes(w) && s_.includes(w));
}
function cleanNews(list, name) {
  const out = [], seen = [];
  for (const x of list || []) {
    const lt = (x.title || "").toLocaleLowerCase("tr");
    if (!newsAbout(x.title, name) || NEWS_JUNK.test(lt)) continue;
    const w = newsWords(x.title);
    // başlıkların kelimelerinin %60'ı ortaksa aynı haberin kopyası sayılır
    if (seen.some((v) => { let c = 0; w.forEach((k) => { if (v.has(k)) c++; }); return c / Math.max(1, Math.min(w.size, v.size)) >= 0.6; })) continue;
    seen.push(w);
    out.push({ ...x, cat: ["kadro", "mac", "transfer"].find((k) => NEWS_RX[k].test(lt)) || "diger" });
  }
  return out;
}
function newsHtml(n, name, cls) {
  const color = cls === "home-c" ? "var(--home)" : "var(--away)";
  const tr = cleanNews(n.tr, name), fm = cleanNews(n.fotmob, name);
  const item = (x) => `<div class="nwrap" data-ncat="${x.cat}" ${newsCat !== "all" && x.cat !== newsCat ? "hidden" : ""}>${newsItem(x)}</div>`;
  const empty = `<p class="muted nempty" ${tr.some((x) => newsCat === "all" || x.cat === newsCat) ? "hidden" : ""}>${tr.length ? "Bu konuda haber yok" : "Son 3 günde haber bulunamadı"}</p>`;
  return `<div class="card news" style="--c:${color}">${head("📰", `${esc(name)}: haberler`)}
    <h3>Türkçe basın (Google News)</h3><div class="nlist">${tr.map(item).join("")}${empty}</div>
    ${fm.length ? `<h3>FotMob haber akışı</h3><div class="nlist">${fm.map(item).join("")}<p class="muted nempty" ${fm.some((x) => newsCat === "all" || x.cat === newsCat) ? "hidden" : ""}>Bu konuda haber yok</p></div>` : ""}</div>`;
}
// haberlerden uyarı: takımla ilgili sakatlık, ceza, kadro dışı, teknik direktör değişikliği gibi başlıklar
// (tahmini değiştirmez; maç özetinde kontrol edilmesi gerekenler olarak gösterilir)
const ALERT_RX = /(sakat|sakatl|kadro dışı|kadrodan çıkar|cezalı|forma giyemeye|oynamayaca|oynayamaya|yok mu|ameliyat|görevden alın|istifa|kovuldu|yollar ayrıl|yeni teknik direktör|kriz|antrenmana çıkmad|maç kadrosunda yok|şok)/;
const ALERT_SKIP = /(muhtemel 11|hangi kanalda|ne zaman|saat kaçta|son durum ve istatistik|hapis|para ceza|maç öncesi:|kimdir|nereli)/;
// takım adının başlıktaki ilk geçtiği yer (tam ad ya da adın en uzun kelimesi)
function namePos(lt, name) {
  const n = name.toLocaleLowerCase("tr"), w = n.split(/\s+/).filter((x) => x.length >= 4).sort((a, c) => c.length - a.length)[0];
  const ps = [lt.indexOf(n), w ? lt.indexOf(w) : -1].filter((x) => x >= 0);
  return ps.length ? Math.min(...ps) : -1;
}
function newsAlerts(b) {
  const out = [], seen = new Set();
  const teams = [b.home, b.away];
  for (const [side, t] of [["home", b.home], ["away", b.away]]) {
    const list = cleanNews((b.news[side] || {}).tr, t.name).concat(cleanNews((b.news[side] || {}).fotmob, t.name));
    list.sort((a, c) => (c.time || 0) - (a.time || 0)).forEach((x) => {
      const lt = (x.title || "").toLocaleLowerCase("tr"), k = lt.search(ALERT_RX);
      if (k < 0 || ALERT_SKIP.test(lt) || seen.has(lt)) return;
      // haber, adı konudan (sakatlık, görevden alma...) önce geçen takımla ilgilidir; başka takımı anlatan haber elenir
      const owner = teams.map((tm) => [tm, namePos(lt, tm.name)]).filter(([, p]) => p >= 0 && p < k).sort((a, c) => a[1] - c[1])[0];
      if (!owner || out.filter((y) => y.team.id === owner[0].id).length >= 2) return;
      seen.add(lt);
      out.push({ ...x, team: owner[0] });
    });
  }
  return out;
}
function newsAlertsHtml(b) {
  const al = newsAlerts(b);
  if (!al.length) return "";
  return `<div class="card nalert" style="--c:#e3b341">${head("⚠️", `Haberlerden dikkat <span class="muted">· tahmini değiştirmez, kontrol için</span>`)}
    ${al.map((x) => `<a class="nal" href="${esc(x.link)}" target="_blank" rel="noopener"><img src="${teamLogo(x.team.id)}" alt="" onerror="this.remove()">
      <span><b>${esc(x.title)}</b><small class="muted">${esc(x.source || "")} · ${ago(x.time)}</small></span></a>`).join("")}</div>`;
}
function newsFilterBar() {
  return `<div class="chiprow newsbar">${NEWS_CATS.map(([k, l]) => `<button class="chipbtn ${newsCat === k ? "on" : ""}" data-ncf="${k}">${l}</button>`).join("")}</div>`;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-ncf]");
  if (!c) return;
  newsCat = c.dataset.ncf;
  try { localStorage.setItem("newsCat", newsCat); } catch { /* yok say */ }
  document.querySelectorAll("[data-ncf]").forEach((x) => x.classList.toggle("on", x.dataset.ncf === newsCat));
  document.querySelectorAll(".news .nlist").forEach((l) => {
    let vis = 0;
    l.querySelectorAll("[data-ncat]").forEach((x) => { const on = newsCat === "all" || x.dataset.ncat === newsCat; x.hidden = !on; if (on) vis++; });
    const em = l.querySelector(".nempty");
    if (em) { em.hidden = vis > 0; if (l.querySelector("[data-ncat]")) em.textContent = "Bu konuda haber yok"; }
  });
});

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

/* ---------- günün kombineleri ---------- */
const COUPON_STAKE = 5000;
const MOVES_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 17l5-5 4 3 7-8" fill="none" stroke="#39c5cf" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h4v4" fill="none" stroke="#39c5cf" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21h18" stroke="#8b98a8" stroke-width="1.6" stroke-linecap="round"/></svg>`;
// kâr/zarar her zaman güncel tutarla hesaplanır (eski kayıtlarda saklanan tutar farklı olabilir)
const couponProfit = (c) => c.won ? COUPON_STAKE * ((c.paid_odds || c.odds) - 1) : -COUPON_STAKE;
const THEME_COLOR = { banko: "#2ea043", gol: "#f85149", korner: "#58a6ff", kart: "#e3b341", deger: "#a371f7", diger: "#8b98a8" };
const COUPON_THEMES = [["banko", "✅", "Banko"], ["gol", "⚽", "Gol şöleni"], ["korner", "🚩", "Kornerler"], ["kart", "🟨", "Kartlar"], ["deger", "💎", "Değerli oranlar"]];
const OLD_THEME = { "Banko": "banko", "En garantiler": "banko", "Gol şöleni": "gol", "Korner kombinesi": "korner", "Değerli oranlar": "deger" };
// eski "En garantiler" teması Banko ile birleşti: geçmiş kuponları da Banko sayılır
const themeOf = (c) => (c.theme === "garanti" ? "banko" : c.theme) || OLD_THEME[(c.name || "").replace(/ \d+$/, "")] || "diger";
// eski En garantiler kuponları Banko adıyla (numarası Banko'ların ardından) ve tema simgesiyle gösterilir
function normCoupon(c) {
  const t = themeOf(c), th = COUPON_THEMES.find((x) => x[0] === t);
  if (!th) return c;
  const old = c.theme === "garanti" || /^En garantiler/.test(c.name || "");
  const n = +((c.name || "").match(/(\d+)$/) || [0, 1])[1];
  return { ...c, icon: th[1], name: old ? `${th[2]} ${n + 3}` : c.name };
}
// karnedeki kuponlar; temalardan önceki eski düzenin kuponları (örn. "Günün favorileri") gösterilmez ve sayılmaz
const karneCouponList = (k) => (k.coupons || []).flatMap((d) => d.coupons.map((c) => normCoupon({ ...c, draft: !d.locked }))).filter((c) => themeOf(c) !== "diger");
let couponTab = "banko";
const legStatus = (l) => l.void ? `<span class="kst wait">↩ İade</span>` : l.hit === true ? `<span class="kst ok">✓</span>`
  : l.hit === false ? `<span class="kst no">✗</span>` : "";
// kuponun ilerlemesi: tutan, tutmayan, canlı ve bekleyen ayaklar tek çubukta
function couponBar(c) {
  const n = c.legs.length, k = (s) => c.legs.filter((l) => legState(l) === s).length;
  const hit = k("hit"), miss = k("miss"), live = k("live"), vd = k("void");
  if (!hit && !miss && !live) return "";
  const seg = (x, cls) => x ? `<span class="${cls}" style="flex:${x}"></span>` : "";
  return `<div class="kprog" title="${hit} tuttu · ${miss} tutmadı · ${live} canlı · ${n - hit - miss - live - vd} bekliyor">
    <div class="kpb">${seg(hit, "h")}${seg(miss, "m")}${seg(live, "l")}${seg(vd, "v")}${seg(n - hit - miss - live - vd, "w")}</div>
    <small>${hit}/${n} tuttu${miss ? ` · ${miss} tutmadı` : ""}${live ? ` · ${live} canlı` : ""}</small></div>`;
}
// zaman çizelgesindeki nokta: bekliyor, canlı, tuttu, tutmadı, iade
const legState = (l) => l.void ? "void" : l.hit === true ? "hit" : l.hit === false ? "miss" : l.live ? "live" : "wait";
// paylaşım için kuponlar id ile saklanır
const COUPON_BY_ID = new Map();
const SH_LINE = "━━━━━━━━━━━━━━";
const NUM_EMO = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
function couponText(c) {
  const day = new Date(c.date + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long" });
  const legs = c.legs.map((l, i) => `${NUM_EMO[i] || "▪️"} ${l.home.name} 🆚 ${l.away.name}\n🕘 ${timeOf(l.utc)} · 👉 ${l.label} · 💰 ${nf(l.odds, 2)}`).join("\n\n");
  return `${c.icon || "🧩"} ${c.name.toLocaleUpperCase("tr")} 🧾\n📅 ${day}\n${SH_LINE}\n${legs}\n${SH_LINE}\n🎯 Toplam oran: ${nf(c.odds, 2)}\n📊 Tutma ihtimali: ${pc(c.p)}`;
}
async function copyCoupon(id, btn) {
  const c = COUPON_BY_ID.get(id);
  if (!c) return;
  const text = couponText(c) + `\n\n${SH_LINE}\n${SHARE_SIGN} · ⚠️ Tahminler kesinlik içermez`;
  try { await navigator.clipboard.writeText(text); }
  catch {  // eski tarayıcılar: gizli metin kutusuyla kopyala
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  const old = btn.innerHTML;
  btn.innerHTML = "✓ Kopyalandı"; btn.classList.add("ok");
  setTimeout(() => { btn.innerHTML = old; btn.classList.remove("ok"); }, 1800);
}
// open: açık başlasın mı; kd: karnede açık/kapalı durumu hatırlamak için anahtar
function couponCard(c, draft, open = true, kd = "") {
  COUPON_BY_ID.set(c.id, c);
  const done = c.state === "done";
  const stake = c.kstake !== undefined ? c.kstake : COUPON_STAKE;  // katlamada o günün kasası (null: henüz belli değil)
  const ret = (stake || 0) * (done && c.won ? c.paid_odds || c.odds : c.odds);
  const color = THEME_COLOR[themeOf(c)] || "#e3b341";
  const status = done ? (c.won ? `<span class="kst ok">✓ Kazandı</span>` : `<span class="kst no">✗ Kaybetti</span>`)
    : draft ? `<span class="kst wait tbd" title="Kupondaki maçlardan ilkinin resmi 11'i açıklanınca son kontrol yapılır ve kupon kesinleşir.">! Değişebilir</span>`
    : `<span class="kst wait fin" title="Resmi 11'ler açıklandıktan sonra son kontrol yapıldı; kupon artık değişmez.">✓ Son hali · ⏳ Bekliyor</span>`;
  // kapalı kartta da görünen özet: tutma ihtimali ve durum
  const mini = done ? `<span class="kpl ${c.won ? "pos" : "neg"}">${c.won ? "✓" : "✗"} ${tl(couponProfit(c), true)}</span>`
    : `<span class="kmini kp" title="Tutma ihtimali">%${Math.round(c.p * 100)}</span><span class="kmini ks ${draft ? "tbd" : "fin"}" title="${draft ? "Değişebilir" : "Son hali"}">${draft ? "!" : "✓"}</span>`;
  return `<details class="card kupon ogrp ${done ? (c.won ? "won" : "lost") : ""}" style="--c:${color}" ${kd ? `data-kd="${esc(kd)}"` : ""} ${open ? "open" : ""}>
    <summary>${head(c.icon || "🧩", `${esc(c.name)} <span class="muted">· ${c.legs.length} maç</span><span class="kodds">${nf(c.odds, 2)}</span>${mini}`)}</summary>
    <p class="muted kdesc">${esc(c.desc || "")}</p>
    <div class="klegs ktl">${c.legs.map((l) => `<div class="ktr ${legState(l)}"><div class="ktime">${esc(timeOf(l.utc))}</div><span class="kdot"></span><div class="kleg ${l.hit === true ? "hit" : l.hit === false ? "miss" : ""}" data-mid="${l.mid}">
      <div class="klt"><img src="${teamLogo(l.home.id)}" alt="" onerror="this.remove()"><span>${esc(l.home.name)} – ${esc(l.away.name)}</span>
        ${l.result ? `<b class="kres">${l.result[0]}-${l.result[1]}</b>` : l.live ? `<b class="kres live">● ${esc(l.live.min || "")} ${l.live.score[0]}-${l.live.score[1]}</b>` : ""}</div>
      ${l.live && l.hit == null ? (() => { const p = pickProgress(l.code, trackCtx(l.live.score[0], l.live.score[1], false, null), l.home.name, l.away.name); return p ? `<div class="klive">📡 ${esc(p.txt)}</div>` : ""; })() : ""}
      <div class="klp"><span class="kpick">${esc(l.label)}</span><small>${pc(l.p)}</small><b>${nf(l.odds, 2)}</b>${legStatus(l)}</div>
      <div class="kpbar"><span style="width:${Math.round(l.p * 100)}%"></span></div>
    </div></div>`).join("")}</div>
    ${couponBar(c)}
    <div class="kfoot ksum"><span>Tutma ihtimali <b>${pc(c.p)}</b></span>
      ${stake == null ? `<span class="kstake">Tutar önceki kupon sonuçlanınca belli olur</span>` : `<span class="kstake ${done ? (c.won ? "pos" : "neg") : ""}">${tl(stake)} → ${done ? (c.won ? tl(ret) + ` (${tl(ret - stake, true)})` : `0 ₺ (${tl(-stake, true)})`) : tl(ret)}</span>`}${status}</div>
    <div class="kshare"><button class="kbtn" data-share="copy" data-cid="${esc(c.id)}">📋 Kopyala</button>${shareBtn("k:" + c.id, `${c.icon || "🧩"} ${c.name} · ${nf(c.odds, 2)}`, couponText(c))}</div>
  </details>`;
}
async function renderCoupons() {
  const v = $("#view");
  v.innerHTML = skel("list");
  try { if (!dayCache || dayCache.date !== state.date) dayCache = await api("/api/day?date=" + state.date); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (!state.kombine) return;
  if (!karneCoupons.length) {  // tema performansı notu için karne (bir kez)
    try { const k = await api("/api/karne"); karneCoupons = Array.isArray(k) ? [] : karneCouponList(k); } catch { }
  }
  drawCoupons();
}
function drawCoupons() {
  const v = $("#view");
  const cs = (dayCache.coupons || []).map(normCoupon).filter((c) => themeOf(c) !== "diger");
  const title = new Date(state.date + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
  const intro = `<div class="card" style="--c:#a371f7">${head("🧩", `Günün kombineleri <span class="muted">· ${cap(title)}</span>`)}
    <details class="kinfo"><summary>Kuponlar nasıl hazırlanıyor? ›</summary><p class="muted">Model her gün beş temada kupon hazırlar: Banko 5, Gol şöleni, Kornerler, Kartlar ve Değerli oranlar üçer kupon. Her kupon 2-5 maçtan oluşur ve her maçtan tek tercih içerir. Banko'daki bir tercih başka hiçbir kupona girmez; diğer temalarda aynı tercih en fazla iki kuponda olur. Çifte şans 12 ve en çok korner güvenli kuponlara alınmaz. Az maçlı günlerde tema başına daha az kupon çıkar; tutma ihtimali %20'nin altındaki kupon kurulmaz (Banko'da %35). Toplam oranlar: Banko 2-3.5, Kartlar 2-6 (yalnızca kart tercihleri), Gol şöleni ve Kornerler 2.5-6, Değerli oranlar 3-6 (tercih başına en az %58, kupon en az %25). Kuponlar en güncel verilerle yenilenir; bu sürede kuponda <b>! Değişebilir</b> yazar. Kuponlardaki maçlardan ilkinin resmi ilk 11'i açıklanınca model son kontrolü yapar ve kuponları kilitler (<b>✓ Son hali</b>); karneye bu hâliyle kupon başına 5.000 ₺ ile yazılır.</p></details></div>`;
  const tabs = COUPON_THEMES.concat([["katlama", "🔁", "Katlama"]]);
  const hot = hotTheme();
  if (!tabs.some(([k]) => k === couponTab)) couponTab = "banko";
  const list = cs.filter((c) => themeOf(c) === couponTab);
  const bar = `<div class="ptabs ctabs">${tabs.map(([k, ic, name]) => {
    const n = cs.filter((c) => themeOf(c) === k).length;
    return `<button class="ptab ${couponTab === k ? "on" : ""}" style="--tc:${THEME_COLOR[k] || "var(--accent)"}" data-ct="${k}">${ic} ${name}${hot && hot.k === k ? " 🔥" : ""}${n ? ` <small>${n}</small>` : ""}</button>`; }).join("")}</div>
  ${hot ? `<div class="hotnote">🔥 Son 14 günde en çok kazandıran tema: <b>${hot.ic} ${esc(hot.name)}</b> · ${hot.h}/${hot.n} kupon tuttu, <span class="kpl ${hot.pl >= 0 ? "pos" : "neg"}">${tl(hot.pl, true)}</span></div>` : ""}`;
  const empty = cs.length ? `<div class="card"><p class="muted">Bu temada bugün kupon çıkmadı: kurallara (oran aralığı, tercih başına yüksek olasılık, aynı tercihin en fazla iki kuponda olması) uyan yeterli maç yok.</p></div>`
    : `<div class="card"><p class="muted">Bu gün için henüz kombine yok. Kombineler, oranları açıklanmış ve başlamamış en az 2 maç olduğunda hazırlanır.</p></div>`;
  v.innerHTML = intro + bar + (couponTab === "katlama" ? `<div id="katBox">${skel("list")}</div>` : list.length ? list.map((c) => couponCard(c, !dayCache.coupons_locked)).join("") : empty);
  v.querySelectorAll("[data-ct]").forEach((b) => b.onclick = () => { couponTab = b.dataset.ct; drawCoupons(); });
  if (couponTab === "katlama") drawKatlama();
}
/* ---------- katlama serisi: günde tek kupon, kazanınca dönen paranın tamamı ertesi güne ---------- */
async function drawKatlama() {
  const box = $("#katBox");
  let K;
  try { K = await api("/api/katlama"); } catch (e) { box.innerHTML = `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (!$("#katBox")) return;
  const fmt = (d) => new Date(d + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long" });
  const open = (K.days || []).filter((d) => d.coupon.state !== "done");
  const done = (K.days || []).filter((d) => d.coupon.state === "done");
  const won = done.filter((d) => d.coupon.won).length;
  const path = [K.series_start || K.start_stake].concat(done.filter((d) => d.series === K.series && d.coupon.won).slice().reverse().map((d) => d.ret));
  const R = K.rules || {}, goal = R.close_after || 3;
  const summary = `<div class="card katsum" style="--c:#a371f7">${head("🔁", `Katlama serisi <span class="muted">· ${new Date(K.start + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long" })}'den beri</span>`)}
    <div class="katk">
      <div class="big"><span>Kasa (bu seride)</span><b>${tl(K.bank)}</b><small>${K.series}. seri · ${K.streak}/${goal} gün · hedefe ${goal - K.streak} kazanç kaldı</small>
        <div class="katgoal">${Array.from({ length: goal }, (_, i) => `<i class="${i < K.streak ? "on" : ""}"></i>`).join("")}</div></div>
      <div><span>Kenarda</span><b class="pos">${tl(K.saved || 0)}</b><small>kapanan serilerden alınan</small></div>
      <div><span>Toplam</span><b class="${K.net >= 0 ? "pos" : "neg"}">${tl(K.net, true)}</b><small>cepten konan ${tl(K.invested)}</small></div>
      <div><span>Kupon</span><b>${won}/${done.length}</b><small>tuttu</small></div>
      <div><span>Seriler</span><b>${(K.closed || []).filter((x) => x.result === "hedef").length} hedef · ${(K.closed || []).filter((x) => x.result === "kayıp").length} kayıp</b><small>en uzun ${K.best} gün</small></div>
    </div>
    ${path.length > 1 ? `<div class="katpath">${path.map((x, i) => `<span class="${i === path.length - 1 ? "now" : ""}">${shortTl(x).replace(/^\+/, "")} ₺</span>`).join("<i>→</i>")}</div>` : ""}
    <p class="muted">Her gün tek kupon: toplam oran 1.90-3.00, her tercihin model olasılığı en az %65. ${tl(K.start_stake)} ile başlar; kazanınca dönen paranın tamamı ertesi günün kuponuna yatırılır (1.000 → 2.000 → 4.000 gibi). <b>${goal} gün üst üste kazanınca seri kapanır:</b> kârın %${Math.round((R.reinvest || 0.5) * 100)}'si ile yeni seri başlar, ana para ve kârın kalanı kenara alınır (örnek: 1.000 → 8.000 olunca 4.500 kenara, yeni seri 3.500 ile). Kaybedince seri biter, ertesi gün cepten ${tl(K.start_stake)} ile yeni seri başlar. Diğer kuponlardan bağımsızdır (aynı tercih başka kuponlarda da olabilir) ve karnenin kâr/zararına eklenmez. Kupon, maçlarından birinin resmi 11'i açıklanınca kilitlenir.</p></div>`;
  const cards = open.map((d) => `<h3 class="kath">${esc(cap(fmt(d.date)))}</h3>` + couponCard({ ...d.coupon, kstake: d.stake, name: `Katlama · ${d.series}. seri` }, !d.locked)).join("");
  const hist = done.length ? `<div class="card" style="--c:#58a6ff">${head("📜", "Geçmiş")}${done.map((d) => {
    const c = d.coupon;
    return `<details class="kathist"><summary><span class="kst ${c.won ? "ok" : "no"}">${c.won ? "✓" : "✗"}</span>
      <span>${esc(cap(fmt(d.date)))} <small class="muted">· ${d.series}. seri · oran ${nf(c.paid_odds || c.odds, 2)}</small></span>
      <b class="${c.won ? "pos" : "neg"}">${d.stake != null ? `${shortTl(d.stake).replace(/^\+/, "")} → ${shortTl(d.ret || 0).replace(/^\+/, "")} ₺` : ""}</b></summary>
      ${d.closed ? `<div class="katclose">🏁 Seri hedefe ulaştı: ${tl(d.closed.saved)} kenara alındı, yeni seri ${tl(d.closed.next)} ile başladı.</div>` : ""}
      ${couponCard({ ...c, kstake: d.stake, name: `Katlama · ${d.series}. seri` }, false)}</details>`;
  }).join("")}</div>` : "";
  box.innerHTML = summary + (cards || `<div class="card"><p class="muted">Bugün için katlama kuponu henüz yok. Kurallara uyan (oran 1.90-3.00, tercih başına %65+) yeterli maç olunca hazırlanır.</p></div>`) + hist;
}
// son 14 günde en çok kazandıran tema (en az 3 sonuçlanmış kupon)
function hotTheme() {
  const since = new Date(todayStr() + "T12:00:00"); since.setDate(since.getDate() - 14);
  const from = since.toLocaleDateString("sv-SE");
  const best = COUPON_THEMES.map(([k, ic, name]) => {
    const d = karneCoupons.filter((c) => c.state === "done" && c.date >= from && themeOf(c) === k);
    return { k, ic, name, n: d.length, h: d.filter((c) => c.won).length, pl: d.reduce((a, c) => a + couponProfit(c), 0) };
  }).filter((t) => t.n >= 3).sort((a, b) => b.pl - a.pl)[0];
  return best && best.pl > 0 ? best : null;
}
// karnede temalara göre kupon isabeti ve kâr/zarar
function themeStats() {
  const done = karneCoupons.filter((c) => c.state === "done");
  if (!done.length) return "";
  const items = COUPON_THEMES.map(([k, ic, name]) => {
    const d = done.filter((c) => themeOf(c) === k);
    return d.length ? [`${ic} ${name}`, d.filter((c) => c.won).length, d.length, d.reduce((a, c) => a + couponProfit(c), 0)] : null;
  }).filter(Boolean);
  return `<h3>Temaya göre</h3>${ringsHtml(items)}`;
}

/* ---------- model karnesi ---------- */
let karneRows = [], karneCoupons = [], karneStart = null, karneTab = "pick", calMonth = null, karneLessons = null, karneLeagueLessons = null;
const karneOpen = new Set();  // açılan gün kartları (yenilemede kapanmasın)
async function renderKarne(silent) {
  const v = $("#view");
  if (!silent) v.innerHTML = skel("page");
  let k;
  try { k = await api("/api/karne"); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (!state.karne) return;
  karneRows = Array.isArray(k) ? k : k.singles || [];
  karneLessons = Array.isArray(k) ? null : k.lessons || null;
  karneLeagueLessons = Array.isArray(k) ? null : k.league_lessons || null;
  karneCache = k;
  karneStart = Array.isArray(k) ? null : k.start;
  karneCoupons = Array.isArray(k) ? [] : karneCouponList(k);
  drawKarne();
}
// karnede tercih türü (örn. "MS 1 (Liverpool)" -> "Maç sonucu")
const pickType = (p) => {
  const c = p.code || "";
  if (c.includes("&")) return "Kombine";
  if (["1", "X", "2"].includes(c)) return "Maç sonucu";
  if (["1X", "12", "X2"].includes(c)) return "Çifte şans";
  if (/^dnb/.test(c)) return "Beraberlikte iade";
  if (/^btts/.test(c)) return "Karşılıklı gol";
  if (/^[ou]\d/.test(c)) return "Gol alt/üst";
  if (/^[ha][ou]\d/.test(c)) return "Takım golü alt/üst";
  if (/^c[ou]\d/.test(c)) return "Toplam korner";
  if (/^cm/.test(c)) return "En çok korner";
  if (/^rc/.test(c)) return "Kırmızı kart";
  if (/^cs:/.test(c)) return "Skor";
  // kart, şut ve isabetli şut: takım (Cagliari kart 2.5 Alt) ve toplam ayrı türler
  const st = c.match(/^([kst])([ha]?)[ou]\d/);
  if (st) return `${st[2] ? "Takım" : "Toplam"} ${{ k: "kart", s: "şut", t: "isabetli şut" }[st[1]]} alt/üst`;
  return (p.label || "").replace(/ \(.*\)$/, "");
};
const STAKE = 1000;
const rowProfit = (r) => r.pick_hit ? STAKE * (r.pick.odds - 1) : -STAKE;
const tl = (x, sign) => (sign && x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(Math.round(x)).toLocaleString("tr-TR") + " ₺";
const trDay = (utc) => new Date(utc).toLocaleDateString("sv-SE", { timeZone: TZ });
// korner/kart tercihlerinde maç sonu korner ve kırmızı kart bilgisi
function cornerNote(r) {
  const fz = r.final; if (!fz || r.state !== "done") return "";
  if (/^(cm|c[ou]\d)/.test(r.pick.code) && fz.corners && fz.corners[0] != null) return ` · Korner ${fz.corners[0]}-${fz.corners[1]}`;
  if (/^rc/.test(r.pick.code) && fz.red) return ` · Kırmızı kart ${fz.red[0] + fz.red[1]}`;
  return "";
}
const rate = (h, n) => n ? `%${Math.round(h / n * 100)}` : "—";
// tek tercih sonuçlandı mı: maç bitti ya da maç sürerken kesinleşti (KG Var, üstler...)
const pickDecided = (r) => (r.state === "done" || r.pick_early) && (r.pick_hit === true || r.pick_hit === false);
const liveMid = (lv) => `<div class="sc live">${lv.score[0]} - ${lv.score[1]}</div><div class="sub live">● ${esc(lv.min || "canlı")}</div>`;
// karne özetleri: tek tercihler (1000 ₺), kombineler (5000 ₺), skorlar (yalnızca isabet, bahis yok)
function karneStats() {
  const rows = karneRows || [];
  const done = rows.filter((r) => r.state === "done");
  const pdone = rows.filter(pickDecided);  // iade olanlar sayılmaz
  const pOdds = pdone.filter((r) => r.pick.odds);
  const sOdds = done.filter((r) => r.score && r.score.odds);
  const cdone = karneCoupons.filter((c) => c.state === "done");
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
  const pending = rows.filter((r) => r.state === "pending").length;
  return {
    pick: { n: pdone.length, h: pdone.filter((r) => r.pick_hit).length, nOdds: pOdds.length, pl: sum(pOdds, rowProfit), staked: pOdds.length * STAKE,
      avgOdds: pOdds.length ? sum(pOdds, (r) => r.pick.odds) / pOdds.length : null, pending },
    kupon: { n: cdone.length, h: cdone.filter((c) => c.won).length, nOdds: cdone.length, pl: sum(cdone, couponProfit), staked: cdone.length * COUPON_STAKE,
      avgOdds: cdone.length ? sum(cdone, (c) => c.odds) / cdone.length : null, pending: karneCoupons.filter((c) => c.state !== "done").length },
    score: { n: done.length, h: done.filter((r) => r.score_hit).length, nOdds: 0, pl: 0, staked: 0,
      avgOdds: sOdds.length ? sum(sOdds, (r) => r.score.odds) / sOdds.length : null, pending },
  };
}
const KARNE_TABS = { pick: ["✅", "Tek tercihler", STAKE, "tercih"], kupon: ["🧩", "Kombineler", COUPON_STAKE, "kupon"], score: ["🎯", "Skorlar", 0, "skor tahmini"] };
function drawKarne() {
  const S = karneStats();
  const total = S.pick.pl + S.kupon.pl;
  const since = karneStart ? new Date(karneStart + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long" }) + " itibarıyla" : "tüm zamanlar";
  const head1 = `<div class="card" style="--c:#58a6ff">${head("📒", `Model karnesi <span class="muted">· ${since}</span>`)}
    <div class="pred">
      ${kpi("💰", total >= 0 ? "#2ea043" : "#f85149", "Toplam kâr / zarar", tl(total, true), "Tek tercih + kombine")}
      ${Object.entries(KARNE_TABS).map(([k, [ic, name, stake, unit]]) => k === "score"
        ? kpi(ic, "#a371f7", name, `${S[k].h}/${S[k].n}`, S[k].n ? `${rate(S[k].h, S[k].n)} tam isabet` : "Henüz sonuç yok")
        : kpi(ic, S[k].pl >= 0 ? "#2ea043" : "#f85149", name,
        S[k].nOdds ? tl(S[k].pl, true) : "—", `${S[k].h}/${S[k].n} tuttu${S[k].n ? " · " + rate(S[k].h, S[k].n) : ""} · ${stake.toLocaleString("tr-TR")} ₺/${unit}`)).join("")}
    </div>${weeklySummary()}</div>`;
  const tabs = `<div class="ptabs">${Object.entries(KARNE_TABS).map(([k, [ic, name]]) =>
    `<button class="ptab ${karneTab === k ? "on" : ""}" data-kt="${k}">${ic} ${name} <small>${S[k].h}/${S[k].n}</small></button>`).join("")}</div>`;
  const body = karneTab === "kupon" ? couponKarneHtml(S.kupon) : singlesKarneHtml(S[karneTab]);
  $("#view").innerHTML = head1 + tabs + body + `<div id="plCal">${calendarHtml()}</div>`;
  $("#view").querySelectorAll("[data-kt]").forEach((b) => b.onclick = () => { karneTab = b.dataset.kt; drawKarne(); });
  $("#view").querySelectorAll("[data-kd]").forEach((d) => d.ontoggle = () => { d.open ? karneOpen.add(d.dataset.kd) : karneOpen.delete(d.dataset.kd); });
  $("#view").querySelectorAll("[data-wk]").forEach((b) => b.onclick = () => { karneWeek += +b.dataset.wk; drawKarne(); });
  bindCalendar();
}
// bu haftanın özeti: tek tercih + kombine isabeti, kâr/zarar, en iyi gün
function weeklySummary() {
  const [a, b] = weekRange(0);
  const inW = (k) => k >= a && k <= b;
  const singles = (karneRows || []).filter((r) => pickDecided(r) && inW(trDay(r.utc)));
  const cps = karneCoupons.filter((c) => c.state === "done" && inW(c.date));
  if (!singles.length && !cps.length) return "";
  const spl = singles.filter((r) => r.pick.odds).reduce((x, r) => x + rowProfit(r), 0);
  const cpl = cps.reduce((x, c) => x + couponProfit(c), 0);
  const days = Object.entries(dailyPl()).filter(([k]) => inW(k)).sort((x, y) => y[1] - x[1]);
  const best = days.length && days[0][1] > 0 ? days[0] : null;
  const dn = (k) => new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long" });
  return `<div class="wsum">📆 <b>Bu hafta:</b> tek tercih ${singles.filter((r) => r.pick_hit).length}/${singles.length}
    <span class="kpl ${spl >= 0 ? "pos" : "neg"}">${tl(spl, true)}</span> · kupon ${cps.filter((c) => c.won).length}/${cps.length}
    <span class="kpl ${cpl >= 0 ? "pos" : "neg"}">${tl(cpl, true)}</span>${best ? ` · en iyi gün <b>${esc(cap(dn(best[0])))}</b> (${tl(best[1], true)})` : ""}</div>`;
}
// modelin dürüstlüğü: verdiği olasılık aralığına göre gerçekten tutma oranı
function calibrationHtml(rows) {
  const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
  const data = bins.map(([lo, hi]) => {
    const g = rows.filter((r) => r.pick.p >= lo && r.pick.p < hi);
    return { lo, hi, n: g.length, h: g.filter((r) => r.pick_hit).length, p: g.length ? g.reduce((x, r) => x + r.pick.p, 0) / g.length : null };
  }).filter((d) => d.n);
  if (!data.length) return "";
  return `<h3>Model ne kadar isabetli? <span class="muted">· verdiği olasılık ↔ gerçekleşen</span></h3>
    ${data.map((d) => { const act = Math.round(d.h / d.n * 100), exp = Math.round(d.p * 100), diff = act - exp; return `<div class="calrow">
      <span class="cl">%${Math.round(d.lo * 100)}–${Math.min(100, Math.round(d.hi * 100))} <small class="muted">· ${d.n} tercih</small></span>
      <span class="cb"><span class="cbar" style="width:${act}%"></span><i class="cexp" style="left:${exp}%" title="Model ortalaması %${exp}"></i></span>
      <span class="cv">%${act} <small class="${diff >= 0 ? "pos" : "neg"}">${diff >= 0 ? "+" : ""}${diff}</small></span></div>`; }).join("")}
    <p class="muted">Çubuk gerçekleşen isabet oranı, ince çizgi modelin o tercihlere verdiği ortalama olasılık. Çubuk çizgiyi geçiyorsa model temkinli, geride kalıyorsa iyimser.</p>`;
}
// kapanış oranı farkı: tercihin oranı maç başlayana kadar düştüyse (piyasa da o tarafa geldiyse) olumlu.
// pairs: [alınan/ilk oran, kapanış oranı]. Kazanma oranından çok daha hızlı sinyal verir.
function clvHtml(pairs, what) {
  const ok = pairs.filter(([a, c]) => a && c);
  if (ok.length < 3) return `<h3>Kapanış oranı farkı</h3><p class="muted">Yeni eklendi; ${what} biriktikçe burada görünecek (en az 3).</p>`;
  const diffs = ok.map(([a, c]) => a / c - 1);
  const avg = diffs.reduce((x, y) => x + y, 0) / diffs.length * 100;
  const beat = diffs.filter((d) => d > 0.001).length, worse = diffs.filter((d) => d < -0.001).length;
  return `<h3>Kapanış oranı farkı <span class="muted">· ${ok.length} ${what}</span></h3>
    <div class="srow"><div class="sl">Ortalama <span class="muted">· ${beat} lehimize, ${worse} aleyhimize, ${ok.length - beat - worse} aynı</span></div>
      <div class="sv"><span class="kpl ${avg >= 0 ? "pos" : "neg"}">${avg >= 0 ? "+" : "−"}%${nf(Math.abs(avg), 1)}</span></div></div>
    <p class="muted">Tercihin oranı maç başlayana kadar düştüyse piyasa da bizim tarafa gelmiş demektir (lehimize). Uzun vadede ortalamanın artıda olması modelin doğru tarafı bulduğunun en hızlı göstergesidir.</p>`;
}
// lige göre isabet ve kâr/zarar (tek tercihler)
function byLeagueHtml(rows) {
  const g = {};
  rows.forEach((r) => {
    const k = lgName(r.league_id, r.league) || "Diğer";
    const t = (g[k] ||= { n: 0, h: 0, pl: 0 });
    t.n++; if (r.pick_hit) t.h++; if (r.pick.odds) t.pl += rowProfit(r);
  });
  const list = Object.entries(g).sort((a, b) => b[1].pl - a[1].pl);
  if (!list.length) return "";
  return `<h3>Lige göre</h3>${list.map(([lab, t]) => { const v = Math.round(t.h / t.n * 100); return `<div class="srow">
      <div class="sl">${esc(lab)} <span class="muted">· ${t.h}/${t.n}</span></div><div class="sv"><span class="kpl ${t.pl >= 0 ? "pos" : "neg"}">${tl(t.pl, true)}</span></div>
      <div class="spct"><span style="width:${Math.max(3, v)}%;background:${pctColor(v)}"></span><b>${v}</b></div></div>`; }).join("")}`;
}
function statKpis(s, stake, unit) {
  const roi = s.staked ? s.pl / s.staked * 100 : null;
  if (!stake) return `<div class="pred">
    ${kpi("🎯", "#58a6ff", "İsabet", `${s.h}/${s.n}`, s.n ? `${rate(s.h, s.n)} tam isabet` : "Henüz sonuç yok")}
    ${kpi("⏳", "#8b98a8", "Bekleyen", String(s.pending), "Maçlar bittikçe sonuçlanır")}
  </div>`;
  return `<div class="pred">
    ${kpi("🎯", "#58a6ff", "İsabet", `${s.h}/${s.n}`, s.n ? `${rate(s.h, s.n)} tuttu` : "Henüz sonuç yok")}
    ${kpi("💰", s.pl >= 0 ? "#2ea043" : "#f85149", "Kâr / zarar", s.nOdds ? tl(s.pl, true) : "—", s.nOdds ? `Her ${unit} için ${stake.toLocaleString("tr-TR")} ₺ · ${s.nOdds} ${unit}` : "Sonuçlandıkça hesaplanır")}
    ${kpi("🏦", "#a371f7", "Yatırılan → dönen", s.nOdds ? `${tl(s.staked)} → ${tl(s.staked + s.pl)}` : "—", s.nOdds ? `Getiri (ROI) ${roi < 0 ? "−" : ""}%${nf(Math.abs(roi), 1)} · ort. oran ${nf(s.avgOdds, 2)}` : "Sonuçlandıkça hesaplanır")}
    ${kpi("⏳", "#8b98a8", "Bekleyen", String(s.pending), "Maçlar bittikçe sonuçlanır")}
  </div>`;
}
function singlesKarneHtml(s) {
  const pick = karneTab === "pick";
  const rows = karneRows || [];
  let extra = "";
  if (pick) {
    const byType = {};
    rows.filter((r) => r.state === "done" && (r.pick_hit === true || r.pick_hit === false))
      .forEach((r) => { const t = (byType[pickType(r.pick)] ||= { n: 0, h: 0 }); t.n++; if (r.pick_hit) t.h++; });
    const types = Object.entries(byType).sort((a, b) => b[1].n - a[1].n);
    const series = {};
    rows.filter((r) => pickDecided(r) && r.pick.odds).forEach((r) => { const k = trDay(r.utc); series[k] = (series[k] || 0) + rowProfit(r); });
    extra = plChart(series, "Tercih başına 1.000 ₺") + (types.length ? `<h3>Tercih türüne göre</h3>${ringsHtml(types.map(([lab, t]) => [lab, t.h, t.n]))}` : "");
    const decided = rows.filter(pickDecided);
    extra += valueKarneHtml(rows) + lessonsHtml() + byLeagueHtml(decided) + calibrationHtml(decided)
      + clvHtml(rows.filter((r) => r.state === "done" || r.live).map((r) => [r.pick.o0, r.pick.odds]), "tercih");
  }
  const note = pick
    ? `Model her maç için başlama düdüğünden önceki son "en garanti tercihini" kaydeder. Tercihler maç sonucu, çifte şans, karşılıklı gol, gol alt/üst, takım golleri, toplam korner, en çok korner, kırmızı kart ve kombine pazarlardan; oranı 1.30 ve üstü olanlar arasından seçilir. Her tercihe 1.000 ₺: tutarsa 1.000 × (oran − 1) kazanç, tutmazsa 1.000 ₺ kayıp; iade olanlar sayılmaz.`
    : `Skor tahmini, modelin skor dağılımı ile piyasanın skor oranları harmanlanarak beklenen sonuç ve gol sayısıyla tutarlı skorlar arasından seçilir. Skor tahminlerine bahis yapılmaz; yalnızca isabet takip edilir.`;
  const top = `<div class="card" style="--c:${pick ? "#2ea043" : "#a371f7"}">${statKpis(s, pick ? STAKE : 0, pick ? "tercih" : "skor tahmini")}${extra}<p class="muted">${note}</p></div>`;
  const groups = new Map();
  rows.filter((r) => r.state !== "void").forEach((r) => {
    const k = trDay(r.utc);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const days = [...groups.keys()].filter(inWeek).sort().reverse();  // pazar en üstte, pazartesi en altta
  let wh = 0, wn = 0, wpl = 0;
  days.forEach((k) => groups.get(k).forEach((r) => {
    if (pick ? pickDecided(r) : r.state === "done") { wn++; if (pick ? r.pick_hit : r.score_hit) wh++; if (pick && r.pick.odds) wpl += rowProfit(r); }
  }));
  const list = days.length ? days.map((k) => {
    const g = groups.get(k).sort((a, b) => (a.utc || "").localeCompare(b.utc || ""));
    const d = g.filter((r) => pick ? pickDecided(r) : r.state === "done");
    const hits = d.filter((r) => pick ? r.pick_hit : r.score_hit).length;
    const dayPl = pick ? d.filter((r) => r.pick.odds).reduce((a, r) => a + rowProfit(r), 0)
      : null;
    const title = new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
    return `<details class="card kday ogrp" style="--c:#58a6ff" data-kd="${karneTab}:${k}" ${karneOpen.has(karneTab + ":" + k) ? "open" : ""}><summary>${head("🗓️", `${cap(title)} <span class="muted">· ${g.length} maç · ${d.length ? `${hits}/${d.length} tuttu` : "sonuç bekleniyor"}</span>${d.length && dayPl != null ? `<span class="kpl ${dayPl >= 0 ? "pos" : "neg"}">${tl(dayPl, true)}</span>` : ""}`)}</summary>
      ${g.map(karneRow).join("")}</details>`;
  }).join("") : `<div class="card"><p class="muted">Bu hafta için kayıtlı tahmin yok. Oklarla diğer haftalara bakabilirsin.</p></div>`;
  return top + weekBar(wh, wn, pick ? wpl : null) + weekReport() + list;
}
// isabet halkaları: [etiket, tutan, toplam, (kâr/zarar)]
function ringsHtml(items) {
  const R = 22, C = 2 * Math.PI * R;
  return `<div class="rings">${items.map(([lab, h, n, pl]) => {
    const v = Math.round(h / n * 100);
    return `<div class="ring" title="${esc(lab)}: ${h}/${n} tuttu (%${v})"><svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
      <circle cx="28" cy="28" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="6"/>
      <circle cx="28" cy="28" r="${R}" fill="none" stroke="${pctColor(v)}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${(C * v / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 28 28)"/>
      <text x="28" y="32" text-anchor="middle">%${v}</text></svg>
      <div class="rl">${esc(lab)}</div><div class="rn muted">${h}/${n}${pl != null ? ` · <span class="${pl >= 0 ? "pos" : "neg"}">${tl(pl, true)}</span>` : ""}</div></div>`;
  }).join("")}</div>`;
}
// değerli oran tercihleri: garanti tercihten ayrı izlenir (1000 ₺ sabit)
function valueKarneHtml(rows) {
  const v = rows.filter((r) => r.value && r.state === "done" && (r.value_hit === true || r.value_hit === false));
  const pend = rows.filter((r) => r.value && r.state !== "done" && r.state !== "void").length;
  if (!v.length && !pend) return "";
  const h = v.filter((r) => r.value_hit).length;
  const pl = v.reduce((a, r) => a + (r.value_hit ? STAKE * (r.value.odds - 1) : -STAKE), 0);
  const avg = v.length ? v.reduce((a, r) => a + r.value.odds, 0) / v.length : 0;
  return `<h3>💎 Değerli oran tercihleri</h3><div class="vkarne">
    <div><b>${v.length ? `${h}/${v.length}` : "—"}</b><small>tuttu${v.length ? ` · %${Math.round(h / v.length * 100)}` : ""}</small></div>
    <div><b class="${pl >= 0 ? "pos" : "neg"}">${v.length ? tl(pl, true) : "—"}</b><small>kâr / zarar (1.000 ₺)</small></div>
    <div><b>${v.length ? nf(avg, 2) : "—"}</b><small>ortalama oran</small></div>
    <div><b>${pend}</b><small>bekleyen</small></div></div>
    <p class="muted">Garanti tercihten ayrı izlenir. Oranlar daha yüksek olduğu için isabet daha düşük beklenir; ölçü kâr/zarardır.</p>`;
}
// modelin karneden öğrendikleri: tür bazında model olasılığı ve gerçek tutma oranı
function lessonsHtml() {
  const L = karneLessons;
  if (!L) return "";
  const rows = Object.entries(L).filter(([, r]) => r.n >= 8).sort((a, b) => b[1].n - a[1].n);
  if (!rows.length) return "";
  return `<h3>🧠 Modelin karneden öğrendikleri</h3><div class="lessons">${rows.map(([t, r]) => {
    const d = Math.round((r.hit - r.model) * 100);
    const tag = r.lesson ? `<span class="ltag neg">geri alınıyor</span>` : r.proven ? `<span class="ltag pos">kanıtlandı</span>` : `<span class="ltag">izleniyor</span>`;
    return `<div class="lsrow"><span class="lst">${esc(cap(t))} <small class="muted">· ${r.n} sonuç</small></span>
      <span class="lsv">model %${Math.round(r.model * 100)} → gerçek %${Math.round(r.hit * 100)} <b class="${d >= 0 ? "pos" : "neg"}">${d >= 0 ? "+" : ""}${d}</b></span>${tag}</div>`;
  }).join("")}</div>
  ${(() => { const ll = Object.values(karneLeagueLessons || {}).filter((x) => x.lesson); return ll.length ? `<p class="muted">Ligler: ${ll.map((x) => `<b>${esc(x.name)}</b> (model %${Math.round(x.model * 100)} → gerçek %${Math.round(x.hit * 100)})`).join(", ")} garanti tercih seçiminde geri alınıyor.</p>` : ""; })()}
  <p class="muted">Garanti tercih ve kupon ayaklarının sonuçlarından. Modelin sandığından zayıf çıkan türler garanti tercih seçiminde geri alınır; olasılıkları tutan (en az 15 sonuç) türler "kanıtlandı" sayılır ve değerli oran tercihi yalnızca bunlardan seçilir.</p>`;
}
// gün gün birikimli kâr/zarar çizgisi (tek seri); üzerine gelince o günün değeri
function plChart(byDay, note) {
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return "";
  let cum = 0;
  const pts = days.map((d) => { cum += byDay[d]; return [d, cum, byDay[d]]; });
  const W = 600, Hh = 170, pl = 8, pr = 8, pt = 14, pb = 22;
  const vals = pts.map((p) => p[1]).concat(0);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i) => pl + i * (W - pl - pr) / (pts.length - 1);
  const y = (v) => pt + (hi - v) * (Hh - pt - pb) / span;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const last = pts[pts.length - 1][1], col = last >= 0 ? "#3fb950" : "#f85149";
  const fmt = (d) => new Date(d + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  PL_DATA = pts.map((p, i) => ({ x: x(i), y: y(p[1]), d: fmt(p[0]), cum: p[1], day: p[2] }));
  return `<div class="plc"><div class="plh"><b>Birikimli kâr / zarar</b><span class="kpl ${last >= 0 ? "pos" : "neg"}">${tl(last, true)}</span><small class="muted">${esc(note)} · ${days.length} gün</small></div>
    <div class="plw"><svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" class="plsvg" role="img" aria-label="Birikimli kâr zarar, son değer ${tl(last, true)}">
      <line x1="${pl}" x2="${W - pr}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="plzero"/>
      <path d="${line}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z" fill="${col}" opacity=".10"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg><span class="pldot" style="--c:${col}"></span><div class="pltip"></div></div>
    <div class="plx muted"><span>${fmt(days[0])}</span><span>${fmt(days[days.length - 1])}</span></div></div>`;
}
let PL_DATA = [];
document.addEventListener("pointermove", (e) => {
  const w = e.target.closest && e.target.closest(".plw");
  document.querySelectorAll(".plw.hov").forEach((x) => { if (x !== w) x.classList.remove("hov"); });
  if (!w || !PL_DATA.length) return;
  const r = w.getBoundingClientRect(), sx = r.width / 600, sy = r.height / 170;
  const px = (e.clientX - r.left) / sx;
  const p = PL_DATA.reduce((a, b) => Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a);
  const dot = w.querySelector(".pldot"), tip = w.querySelector(".pltip");
  dot.style.left = p.x * sx + "px"; dot.style.top = p.y * sy + "px";
  tip.innerHTML = `<b>${p.d}</b><span>Gün: ${tl(p.day, true)}</span><span>Toplam: ${tl(p.cum, true)}</span>`;
  tip.style.left = Math.min(Math.max(p.x * sx, 70), r.width - 70) + "px";
  w.classList.add("hov");
});
// karnede haftalık görünüm: pazartesi-pazar, 0 = bu hafta
let karneWeek = 0;
function weekRange(off) {
  const t = new Date(todayStr() + "T12:00:00");
  const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7) + off * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toLocaleDateString("sv-SE"), sun.toLocaleDateString("sv-SE"), mon, sun];
}
function weekBar(hits, n, pl) {
  const [mon, , m, su] = weekRange(karneWeek);
  const fmt = (d, y) => d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", ...(y ? { year: "numeric" } : {}) });
  const canPrev = !karneStart || mon > karneStart;
  const title = karneWeek === 0 ? "Bu hafta" : karneWeek === -1 ? "Geçen hafta" : karneWeek === 1 ? "Gelecek hafta" : `${fmt(m)} haftası`;
  return `<div class="card wkbar" style="--c:#58a6ff">
    <button class="calbtn" data-wk="-1" ${canPrev ? "" : "disabled"} aria-label="Önceki hafta">‹</button>
    <div class="wkt"><b>${title}</b><small class="muted">${fmt(m)} – ${fmt(su, true)}</small></div>
    <button class="calbtn" data-wk="1" ${karneWeek >= 1 ? "disabled" : ""} aria-label="Sonraki hafta">›</button>
    <span class="wks">${n ? `${hits}/${n} tuttu` : "sonuç yok"}${pl != null && n ? ` <span class="kpl ${pl >= 0 ? "pos" : "neg"}">${tl(pl, true)}</span>` : ""}</span></div>`;
}
const inWeek = (k) => { const [a, b] = weekRange(karneWeek); return k >= a && k <= b; };
function couponKarneHtml(s) {
  const series = {};
  karneCoupons.filter((c) => c.state === "done").forEach((c) => { series[c.date] = (series[c.date] || 0) + couponProfit(c); });
  const top = `<div class="card" style="--c:#e3b341">${statKpis(s, COUPON_STAKE, "kupon")}
    ${plChart(series, "Kupon başına 5.000 ₺")}
    ${themeStats()}
    ${clvHtml(karneCoupons.flatMap((c) => c.legs.filter((l) => !l.void).map((l) => [l.odds, l.close])), "kupon ayağı")}
    <p class="muted">Günün kombineleri: model her gün beş temada kupon hazırlar (Banko 5, diğerleri üçer; 2-5 maç). Kuponlardaki maçlardan ilkinin resmi ilk 11'i açıklanınca o günün kuponları kilitlenir. Her kupona 5.000 ₺: bütün tercihler tutarsa 5.000 × toplam oran döner, biri bile tutmazsa 5.000 ₺ kayıp. İade olan ya da ertelenen maç kupondan düşer (oranı 1 sayılır). Tutarlar geçmiş kuponlar için de bu tutarla hesaplanır.</p></div>`;
  const byDay = new Map();
  karneCoupons.forEach((c) => { if (!byDay.has(c.date)) byDay.set(c.date, []); byDay.get(c.date).push(c); });
  const days = [...byDay.keys()].filter(inWeek).sort().reverse();
  const wd = days.flatMap((k) => byDay.get(k)).filter((c) => c.state === "done");
  const list = days.length ? days.map((k) => {
    const g = byDay.get(k), d = g.filter((c) => c.state === "done");
    const pl = d.reduce((a, c) => a + couponProfit(c), 0);
    const title = new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
    return `<details class="kdgrp" data-kd="kupon:${k}" ${karneOpen.has("kupon:" + k) ? "open" : ""}><summary class="kdayh">🗓️ ${cap(title)} <span class="muted">· ${g.length} kupon · ${d.length ? `${d.filter((c) => c.won).length}/${d.length} tuttu` : "sonuç bekleniyor"}</span>${d.length ? `<span class="kpl ${pl >= 0 ? "pos" : "neg"}">${tl(pl, true)}</span>` : ""}</summary>
      ${g.map((c) => couponCard(c, c.draft, karneOpen.has("c:" + c.id), "c:" + c.id)).join("")}</details>`;
  }).join("") : `<div class="card"><p class="muted">Bu hafta için kupon yok. Oklarla diğer haftalara bakabilirsin.</p></div>`;
  return top + weekBar(wd.filter((c) => c.won).length, wd.length, wd.reduce((a, c) => a + couponProfit(c), 0)) + weekReport() + list;
}
// gün gün toplam kâr/zarar (üç karne birlikte)
function dailyPl() {
  const m = {};
  const add = (k, v) => { m[k] = (m[k] || 0) + v; };
  (karneRows || []).forEach((r) => {
    if (pickDecided(r) && r.pick.odds) add(trDay(r.utc), rowProfit(r));
  });
  karneCoupons.forEach((c) => { if (c.state === "done") add(c.date, couponProfit(c)); });
  return m;
}
// takvim kutusu için kısa tutar: 1720 -> +1.7k, -250 -> −250
function shortTl(v) {
  const a = Math.abs(v), sign = v > 0 ? "+" : v < 0 ? "−" : "";
  if (a >= 1000) return sign + (a >= 10000 ? Math.round(a / 1000) : Math.round(a / 100) / 10) + "k";
  return sign + Math.round(a);
}
function calendarHtml() {
  const today = todayStr();
  const ym = calMonth || today.slice(0, 7);
  const [y, mo] = ym.split("-").map(Number);
  const first = new Date(y, mo - 1, 1), nDays = new Date(y, mo, 0).getDate();
  const lead = (first.getDay() + 6) % 7;  // pazartesi başlangıçlı
  const pl = dailyPl();
  let tot = 0, cells = "";
  // ayın en çok kazandıran günü altın renkte
  const best = Math.max(...Object.entries(pl).filter(([k]) => k.startsWith(ym)).map(([, v]) => v), -Infinity);
  for (let i = 0; i < lead; i++) cells += `<div class="cd empty"></div>`;
  for (let d = 1; d <= nDays; d++) {
    const k = `${ym}-${String(d).padStart(2, "0")}`;
    const v = pl[k];
    if (v != null) tot += v;
    const cls = v == null ? (k > today ? "future" : "none") : v > 0 ? "pos" : v < 0 ? "neg" : "zero";
    cells += `<div class="cd ${cls} ${k === today ? "today" : ""} ${v != null && v > 0 && v === best ? "gold" : ""}" ${v != null ? `title="${tl(v, true)}"` : ""}><span class="dn">${d}</span>${v != null ? `<b>${shortTl(v)}</b>` : ""}</div>`;
  }
  const name = cap(first.toLocaleDateString("tr-TR", { month: "long", year: "numeric" }));
  return `<div class="card" style="--c:#39c5cf">${head("📅", `Günlük kâr / zarar <span class="muted">· tek tercih + kombine</span>`)}
    <div class="calnav"><button class="calbtn" data-cm="-1" aria-label="Önceki ay">‹</button><b>${name}</b><button class="calbtn" data-cm="1" aria-label="Sonraki ay">›</button>
      <span class="kpl ${tot >= 0 ? "pos" : "neg"}">Ay toplamı ${tl(tot, true)}</span></div>
    <div class="calgrid">${["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"].map((w) => `<div class="cw">${w}</div>`).join("")}${cells}</div>
    <p class="muted">Kutulardaki tutar o gün sonuçlanan bütün tahminlerin toplamıdır (₺, k = bin): yeşil kâr, kırmızı zarar, altın 👑 ayın en çok kazandıran günü. Kutunun üstüne gelince tam tutar görünür.</p></div>`;
}
function bindCalendar() {
  $("#plCal").querySelectorAll("[data-cm]").forEach((b) => b.onclick = () => {
    const [y, m] = (calMonth || todayStr().slice(0, 7)).split("-").map(Number);
    const d = new Date(y, m - 1 + +b.dataset.cm, 1);
    calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    $("#plCal").innerHTML = calendarHtml();
    bindCalendar();
  });
}
function karneRow(r) {
  const pick = karneTab === "pick";
  const done = r.state === "done" || (pick && pickDecided(r));
  const hit = pick ? r.pick_hit : r.score_hit;
  const rowCls = !done || hit == null ? "" : hit ? "hit" : "miss";
  const early = r.state !== "done" && done;
  const status = !done ? `<span class="kst wait">${r.live ? "● Canlı" : "⏳ Bekliyor"}</span>` : hit == null ? `<span class="kst wait">↩ İade</span>`
    : hit ? `<span class="kst ok">✓ ${early ? "Kazandı" : "Tuttu"}</span>` : `<span class="kst no">✗ ${early ? "Kaybetti" : "Tutmadı"}</span>`;
  const mid = r.state === "done" ? `<div class="sc">${r.result[0]} - ${r.result[1]}</div><div class="sub">maç sonu</div>`
    : r.live ? liveMid(r.live) : `<div class="ko">${esc(timeOf(r.utc))}</div><div class="sub">başlama</div>`;
  const tip = pick
    ? `<span class="kpick">${esc(r.pick.label)} <small>${r.pick.odds ? "@" + nf(r.pick.odds, 2) + " · " : ""}${pc(r.pick.p)}</small></span>`
    : `<span class="kpick">Skor ${esc(r.score.score)} <small>${pc(r.score.p)}</small></span>`;
  const odds = pick ? r.pick.odds : null;
  const stake = STAKE;
  const prof = pick && done && hit != null && odds ? rowProfit(r) : null;
  const linkable = !STATIC || (meta && meta.days && meta.days.includes(trDay(r.utc)));
  return `<div class="krow ${rowCls}" ${linkable ? `data-mid="${r.id}"` : ""}>
    <div class="kteams">
      <span class="kt"><img src="${teamLogo(r.home.id)}" alt="" onerror="this.remove()">${esc(r.home.name)}</span>
      <div class="mid">${mid}</div>
      <span class="kt r">${esc(r.away.name)}<img src="${teamLogo(r.away.id)}" alt="" onerror="this.remove()"></span>
    </div>
    ${pick && done && hit === false && r.final ? (() => { const w = lossReason(r.pick.code, finalCtx({ final: r.final, home: { score: r.result[0] }, away: { score: r.result[1] }, status: { finished: true } }), r.home.name, r.away.name); return w ? `<div class="why ${w.kind}">${REASON_TAG[w.kind]} · ${esc(w.txt.replace(/^[^:]+: /, ""))}</div>` : ""; })() : ""}
    <div class="kfoot"><span class="muted kl">${esc(lgName(r.league_id, r.league))}${pick ? cornerNote(r) : ""}</span>${tip}${odds ? `<span class="kstake ${prof != null ? (prof >= 0 ? "pos" : "neg") : ""}">${stake} ₺ → ${prof != null ? tl(prof, true) : "@" + nf(odds, 2)}</span>` : ""}${status}</div>
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
  if (!silent) v.innerHTML = skel("page");
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

// "€13.5m" / "€800k" -> "13,5 milyon €" / "800 bin €"
function moneyTr(v) {
  const m = String(v).match(/^€?\s*([\d.,]+)\s*([mk])?$/i);
  if (!m) return v;
  const n = parseFloat(m[1].replace(",", "."));
  const unit = (m[2] || "").toLowerCase();
  return unit === "m" ? `${nf(n, n % 1 ? 1 : 0)} milyon €` : unit === "k" ? `${Math.round(n)} bin €` : `${nf(n, 0)} €`;
}
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
    i.value && chip("💶", esc(moneyTr(i.value))),
    p.contract && chip("📝", "Sözleşme: " + esc(new Date(p.contract).toLocaleDateString("tr-TR", { month: "long", year: "numeric" }))),
  ].filter(Boolean).join("");
  const inj = p.injury ? `<div class="pinj">🚑 Sakat${p.injury.expectedReturn ? " · Dönüş: " + esc(p.injury.expectedReturn) : ""}</div>` : "";
  return `<div class="phero" style="--tc:${esc(color)}">
    <div class="pphoto">${playerImg(p.id, i.shirt)}</div>
    <div class="pmain">
      <h1>${esc(p.name)}</h1>
      <div class="pteam"><img src="${teamLogo(p.team.id)}" alt="" onerror="this.remove()"><b>${esc(p.team.name || "")}</b>${p.team.loan ? `<span class="tag warn">Kiralık</span>` : ""}
        ${p.keeper ? `<span class="ppos gk">🧤 Kaleci</span>` : `<span class="ppos">${esc(pos || "")}</span>`}</div>
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
    if (ev.text) addFeed(ev, true);
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (state.current && ev.match_id === state.current) renderMatch(state.current, true);
      else if (!state.current && !state.player && !state.karne && !state.kombine && !state.lig && !state.oranlar) renderDay(true);
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
}
async function loadFeed() {
  try { (await api("/api/events/recent")).forEach((ev) => addFeed(ev, false)); } catch { }
  if (!$("#feedList").children.length) $("#feedList").innerHTML = `<li class="muted">Henüz gelişme yok. Yeni kadro, eksik, haber ve goller burada görünecek.</li>`;
}

/* ---------- takımlarım (favori takımlar) ---------- */
const myTeams = new Map(JSON.parse(safeGet("myTeams") || "[]"));  // id -> ad
const isMine = (id) => myTeams.has(id);
function toggleTeam(id, name) {
  myTeams.has(id) ? myTeams.delete(id) : myTeams.set(id, name);
  safeSet("myTeams", JSON.stringify([...myTeams]));
}
const starBtn = (id, name) => `<button class="tstar ${isMine(id) ? "on" : ""}" data-team="${id}" data-tname="${esc(name)}" title="${isMine(id) ? "Takımlarımdan çıkar" : "Takımlarıma ekle"}" aria-label="Takımlarım">${isMine(id) ? "★" : "☆"}</button>`;
// yıldız butonları sayfanın her yerinde çalışır (lig tablosu, maç sayfası, arama)
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-team]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  toggleTeam(+b.dataset.team, b.dataset.tname);
  document.querySelectorAll(`[data-team="${b.dataset.team}"]`).forEach((x) => {
    const on = isMine(+x.dataset.team);
    x.classList.toggle("on", on); x.textContent = on ? "★" : "☆";
  });
  if (!state.current && !state.player && !state.karne && !state.kombine && !state.lig && !state.oranlar) renderDay(true);
}, true);

/* ---------- takım arama ---------- */
const normTr = (s) => (s || "").toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
let searchDays = null;
async function searchTeams(q) {
  if (!searchDays) {
    searchDays = {};
    for (const k of (STATIC && meta ? meta.days : [todayStr()])) {
      try { searchDays[k] = (await api("/api/day?date=" + k)).matches || []; } catch { searchDays[k] = []; }
    }
  }
  const t = normTr(q.trim());
  if (t.length < 2) return [];
  const out = [];
  Object.entries(searchDays).forEach(([day, ms]) => ms.forEach((m) => {
    if (normTr(m.home.name).includes(t) || normTr(m.away.name).includes(t)) out.push({ day, m });
  }));
  return out.sort((a, b) => (a.m.utc || "").localeCompare(b.m.utc || ""));
}
function openSearch(open) {
  $("#searchPop").classList.toggle("hidden", !open);
  if (open) { $("#searchInput").value = ""; $("#searchRes").innerHTML = `<p class="muted">Takım adı yaz (en az 2 harf). Dün, bugün ve yarının maçlarında arar.</p>`; setTimeout(() => $("#searchInput").focus(), 30); }
}
$("#searchBtn").onclick = (e) => { e.stopPropagation(); openSort(false); openSearch($("#searchPop").classList.contains("hidden")); };
document.addEventListener("click", (e) => { if (!e.target.closest(".searchwrap")) openSearch(false); });
$("#searchInput").oninput = async () => {
  const res = await searchTeams($("#searchInput").value);
  const rel = (k) => ({ [todayStr()]: "Bugün" }[k] || new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" }));
  $("#searchRes").innerHTML = res.length ? res.slice(0, 12).map(({ day, m }) => `<a class="sres" href="#/mac/${m.id}">
      <span class="sday">${esc(rel(day))} ${esc(timeOf(m.utc))}</span>
      <span class="steams"><img src="${teamLogo(m.home.id)}" alt="" onerror="this.remove()">${esc(m.home.name)} – ${esc(m.away.name)}<img src="${teamLogo(m.away.id)}" alt="" onerror="this.remove()"></span>
      <span class="slg">${esc(m.league)}${m.started || m.finished ? ` · ${m.home.score ?? 0}-${m.away.score ?? 0}` : ""}</span></a>`).join("")
    : `<p class="muted">${$("#searchInput").value.trim().length < 2 ? "Takım adı yaz (en az 2 harf)." : "Dün, bugün ve yarın bu takımın maçı yok."}</p>`;
  $("#searchRes").querySelectorAll(".sres").forEach((a) => a.onclick = () => openSearch(false));
};

/* ---------- lig sayfası: puan durumu, gol ve asist krallığı ---------- */
let ligTab = "table";
async function renderLeague(id) {
  const v = $("#view");
  v.innerHTML = skel("list");
  let L;
  try { L = await api("/api/league/" + id); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (state.lig !== id) return;
  drawLeague(L);
}
function drawLeague(L) {
  const v = $("#view");
  const today = new Set((dayCache && dayCache.date === todayStr() ? dayCache.matches : []).flatMap((m) => [m.home.id, m.away.id]));
  const hero = `<div class="card lghero" style="--c:#58a6ff"><img src="${leagueLogo(L.id)}" alt="" onerror="this.remove()">
    <div><h1>${esc(L.name)}</h1><small class="muted">${esc(L.season || "")} sezonu</small></div></div>`;
  const tabs = `<div class="ptabs">${[["table", "📊 Puan durumu"], ["goals", "⚽ Gol krallığı"], ["assists", "🎯 Asist krallığı"]].map(([k, t]) =>
    `<button class="ptab ${ligTab === k ? "on" : ""}" data-lt="${k}">${t}</button>`).join("")}</div>`;
  let body;
  if (ligTab === "table") {
    body = L.tables.length ? L.tables.map((T) => `<div class="card" style="--c:#2ea043">${T.name ? head("📋", esc(T.name)) : ""}
      <div class="ltable"><div class="lrow lhead"><span>#</span><span>Takım</span><span>O</span><span>G</span><span>B</span><span>M</span><span class="lgf">Gol</span><span>A</span><span>P</span><span class="l5" title="Son 5 maçta alınan puan">Son 5</span></div>
      ${T.rows.map((r) => `<div class="lrow ${isMine(r.id) ? "mine" : ""}" style="--zc:${r.color || "transparent"}">
        <span class="lpos">${r.pos}</span>
        <span class="lteam"><img src="${teamLogo(r.id)}" alt="" onerror="this.remove()"><b>${esc(r.name)}</b>${today.has(r.id) ? `<i class="ltoday" title="Bugün maçı var">●</i>` : ""}${starBtn(r.id, r.name)}</span>
        <span>${r.played}</span><span>${r.w}</span><span>${r.d}</span><span>${r.l}</span><span class="lgf">${esc(r.goals || "")}</span>
        <span class="${r.gd > 0 ? "pos" : r.gd < 0 ? "neg" : ""}">${r.gd > 0 ? "+" : ""}${r.gd}</span><span class="lpts">${r.pts}</span>
        <span class="l5">${r.pts5 ?? "—"}</span></div>`).join("")}</div>
      ${T.legend.length ? `<div class="llegend">${T.legend.map((z) => `<span><i style="background:${z.color}"></i>${esc(z.title)}</span>`).join("")}</div>` : ""}
      <p class="muted">O: oynanan · G/B/M: galibiyet/beraberlik/mağlubiyet · A: averaj · P: puan · Son 5: son 5 maçta alınan puan. ☆ ile takımı Takımlarım'a ekle.</p></div>`).join("")
      : `<div class="card"><p class="muted">Puan durumu henüz yok.</p></div>`;
  } else {
    const list = ligTab === "goals" ? L.scorers : L.assists;
    const unit = ligTab === "goals" ? "gol" : "asist";
    body = `<div class="card" style="--c:#e3b341">${list.length ? `<div class="ktable">${list.map((p, i) => `<div class="krowp" data-pid="${p.id}">
        <span class="kpos">${i + 1}</span><img class="kph" src="https://images.fotmob.com/image_resources/playerimages/${p.id}.png" alt="" onerror="this.style.visibility='hidden'">
        <span class="kname"><b>${esc(p.name)}</b><small class="muted"><img src="${teamLogo(p.team_id)}" alt="" onerror="this.remove()">${esc(p.team || "")} · ${p.matches || "?"} maç</small></span>
        <span class="kval">${nf(p.value, 0)} <small>${unit}</small></span></div>`).join("")}</div>`
      : `<p class="muted">Liste henüz yok.</p>`}<p class="muted">Kaynak: FotMob sezon istatistikleri. Oyuncuya dokununca sayfası açılır (bugünün ya da yarının kadrolarındaysa).</p></div>`;
  }
  v.innerHTML = hero + tabs + body;
  v.querySelectorAll("[data-lt]").forEach((b) => b.onclick = () => { ligTab = b.dataset.lt; drawLeague(L); });
}

/* ---------- oran hareketleri ---------- */
let movesSort = "drop", movesDay = "all", movesGroup = "all";
const MOVE_GROUPS = [["all", "Hepsi"], ["Maç", "Maç sonucu"], ["Goller", "Gol"], ["Korner", "Korner"], ["Kombine", "Kombine"], ["other", "Diğer"]];
async function renderMoves() {
  const v = $("#view");
  v.innerHTML = skel("list");
  let D;
  try { D = await api("/api/oddsmoves"); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (!state.oranlar) return;
  drawMoves(D);
}
function drawMoves(D) {
  const v = $("#view");
  const t = todayStr();
  let ms = (D.moves || []).filter((x) => movesSort === "drop" ? x.chg < 0 : x.chg > 0);
  if (movesDay !== "all") ms = ms.filter((x) => (trDay(x.utc) === t) === (movesDay === "today"));
  if (movesGroup !== "all") ms = ms.filter((x) => movesGroup === "other" ? !["Maç", "Goller", "Korner", "Kombine"].includes(x.group) : x.group === movesGroup);
  ms.sort((a, b) => movesSort === "drop" ? a.chg - b.chg : b.chg - a.chg);
  const chips = (arr, cur, attr) => arr.map(([k, l]) => `<button class="chipbtn ${cur === k ? "on" : ""}" data-${attr}="${k}">${l}</button>`).join("");
  const top = `<div class="card" style="--c:#39c5cf">${head(MOVES_ICON, `Oran hareketleri <span class="muted">· başlamamış maçlar</span>`)}
    <p class="muted">Bir seçeneğin oranı ilk görüldüğü andan (açılış) bu yana ne kadar değişti. Düşen oran: piyasa o sonuca daha çok inanıyor (para oraya akıyor). Yükselen oran: piyasa güvenini kaybediyor. Oranlar 6 dakikada bir güncellenir.</p>
    <div class="ptabs"><button class="ptab ${movesSort === "drop" ? "on" : ""}" data-ms="drop">📉 En çok düşen</button><button class="ptab ${movesSort === "rise" ? "on" : ""}" data-ms="rise">📈 En çok yükselen</button></div>
    <div class="chiprow">${chips([["all", "Bugün + yarın"], ["today", "Bugün"], ["tomorrow", "Yarın"]], movesDay, "md")}</div>
    <div class="chiprow">${chips(MOVE_GROUPS, movesGroup, "mg")}</div></div>`;
  // aynı maçın hareketleri tek başlık altında; maçlar en büyük hareketlerine göre sıralı
  const groups = new Map();
  ms.slice(0, 120).forEach((x) => { if (!groups.has(x.mid)) groups.set(x.mid, []); groups.get(x.mid).push(x); });
  const rows = [...groups.values()].slice(0, 40).map((g) => {
    const x = g[0];
    return `<div class="mvgrp" data-mid="${x.mid}">
      <div class="mvt"><img src="${teamLogo(x.home.id)}" alt="" onerror="this.remove()"><span>${esc(x.home.name)} – ${esc(x.away.name)}</span><img src="${teamLogo(x.away.id)}" alt="" onerror="this.remove()"><small class="muted">${esc(trDay(x.utc) === t ? "Bugün" : "Yarın")} ${esc(timeOf(x.utc))} · ${esc(lgName(x.league_id, ""))}</small></div>
      ${g.slice(0, 5).map((y) => `<div class="mvp"><span class="mvl">${esc(y.market)}: <b>${esc(y.label)}</b></span>
        <span class="mvo"><s>${nf(y.open, 2)}</s> → <b>${nf(y.now, 2)}</b></span><span class="mvc ${y.chg < 0 ? "down" : "up"}">${y.chg < 0 ? "▼" : "▲"} ${(y.chg > 0 ? "+" : "−") + nf(Math.abs(y.chg) * 100, 1)}%</span>
        ${shareBtn(`o:${y.mid}:${y.code}`, `${y.chg < 0 ? "📉" : "📈"} ${y.home.name} – ${y.away.name} · ${y.label}`, `${y.chg < 0 ? "📉 ORAN DÜŞÜYOR 🚨" : "📈 ORAN YÜKSELİYOR"}\n${matchLine(y.home.name, y.away.name, y.utc)}\n${SH_LINE}\n👉 ${y.market}: ${y.label}\n💰 ${nf(y.open, 2)} ➜ ${nf(y.now, 2)} (${y.chg < 0 ? "🔻" : "🔺"} ${(y.chg > 0 ? "+" : "−") + nf(Math.abs(y.chg) * 100, 1)}%)`)}</div>`).join("")}
      ${g.length > 5 ? `<small class="muted mvmore">+${g.length - 5} hareket daha · maça dokun</small>` : ""}</div>`;
  }).join("");
  const empty = `<div class="card"><p class="muted">${(D.moves || []).length ? "Bu filtrede hareket yok." : "Henüz oran hareketi yok. Takip yeni başladı; oranlar değiştikçe burada listelenecek."}</p></div>`;
  v.innerHTML = top + (ms.length ? `<div class="card mvlist" style="--c:${movesSort === "drop" ? "#3fb950" : "#f85149"}">${rows}</div>` : empty);
  v.querySelectorAll("[data-ms]").forEach((b) => b.onclick = () => { movesSort = b.dataset.ms; drawMoves(D); });
  v.querySelectorAll("[data-md]").forEach((b) => b.onclick = () => { movesDay = b.dataset.md; drawMoves(D); });
  v.querySelectorAll("[data-mg]").forEach((b) => b.onclick = () => { movesGroup = b.dataset.mg; drawMoves(D); });
}

/* ---------- hakem kartı (maç sayfası özet sekmesi) ---------- */
function refereeHtml(b) {
  const r = b.referee_stats;
  if (!b.referee || !r || !r.matches) return "";
  const cmp = (v, avg) => avg ? (v >= avg * 1.15 ? `<span class="neg">ortalamanın üstünde</span>` : v <= avg * 0.85 ? `<span class="pos">ortalamanın altında</span>` : "lig ortalamasında") : "";
  return `<div class="card" style="--c:#d29922">${head(WHISTLE, `Hakem: <a class="tlink" href="#/hakem/${b.id}">${esc(b.referee)}</a> <span class="muted">· bu sezon ${r.matches} maç</span>`, `<a class="muted rflink" href="#/hakem/${b.id}">hakem sayfası ›</a>`)}
    <div class="pred">
      ${r.yellow_pm != null ? kpi("🟨", "#d29922", "Maç başı sarı kart", nf(r.yellow_pm, 2), r.yellow_avg ? `Lig ort. ${nf(r.yellow_avg, 2)}` : "") : ""}
      ${r.red != null ? kpi("🟥", "#f85149", "Kırmızı kart", String(r.red), `${r.matches} maçta toplam`) : ""}
      ${r.pens != null ? kpi("🎯", "#58a6ff", "Penaltı", String(r.pens), r.pens_pm != null ? `Maç başı ${nf(r.pens_pm, 2)}` : "") : ""}
      ${r.fouls_pm != null ? kpi("🦶", "#a371f7", "Maç başı faul", nf(r.fouls_pm, 1), r.fouls_avg ? `Lig ort. ${nf(r.fouls_avg, 1)}` : "") : ""}
    </div>${r.yellow_pm && r.yellow_avg ? `<p class="muted">Kart sıklığı ${cmp(r.yellow_pm, r.yellow_avg)}. Kart ve penaltı tercihlerinde dikkate alınabilir.</p>` : ""}</div>`;
}


/* ---------- tercih takibi: canlıda durum, maç sonunda tuttu mu ve neden ---------- */
const num = (v) => { const x = parseFloat(String(v ?? "").replace("%", "")); return Number.isFinite(x) ? x : null; };
// canlı/maç sonu bağlamı: skor ve korner, kart, şut istatistikleri ([ev, dep])
function trackCtx(hs, as, fin, stats) {
  const pair = (k) => stats && stats[k] ? [num(stats[k][0]), num(stats[k][1])] : null;
  const y = pair("yellow"), r = pair("red") || [0, 0];
  return { hs: hs ?? 0, as: as ?? 0, fin, corners: pair("corners"), shots: pair("shots"), sot: pair("sot"), red: r,
    cards: y ? [y[0] + (r[0] || 0), y[1] + (r[1] || 0)] : null, xg: pair("xg") };
}
// maç sonu paketindeki "final" alanından bağlam
const finalCtx = (b) => {
  const f = b.final || {};
  const st = {};
  ["corners", "shots", "sot", "red", "xg"].forEach((k) => { if (f[k]) st[k] = f[k]; });
  if (f.yellow) st.yellow = f.yellow;
  return trackCtx(b.home.score, b.away.score, !!(b.status || {}).finished, st);
};
const ST_NAME = { k: "kart", s: "şut", t: "isabetli şut" };
// bir tercihin o anki durumu: {st: "hit" | "lost" | "open" | "void", txt}
function pickProgress(code, c, H, W) {
  if (!code) return null;
  if (code.includes("&")) {
    const parts = code.split("&").map((x) => pickProgress(x, c, H, W));
    if (parts.some((p) => !p)) return null;
    if (parts.some((p) => p.st === "lost")) return { st: "lost", txt: parts.filter((p) => p.st === "lost").map((p) => p.txt).join(" · ") };
    if (parts.every((p) => p.st === "hit")) return { st: "hit", txt: "Bütün ayaklar tuttu" };
    return { st: "open", txt: parts.filter((p) => p.st !== "hit").map((p) => p.txt).join(" · ") };
  }
  const t = c.hs + c.as, sc = `${c.hs}-${c.as}`;
  const res = { "1": c.hs > c.as, "X": c.hs === c.as, "2": c.hs < c.as, "1X": c.hs >= c.as, "X2": c.hs <= c.as, "12": c.hs !== c.as };
  if (code in res) return c.fin ? { st: res[code] ? "hit" : "lost", txt: `Skor ${sc}` } : { st: "open", txt: `Şu an ${res[code] ? "tutuyor" : "tutmuyor"} (${sc})` };
  if (code === "dnb1" || code === "dnb2") {
    if (c.fin && c.hs === c.as) return { st: "void", txt: "Berabere, iade" };
    const ok = code === "dnb1" ? c.hs > c.as : c.as > c.hs;
    return c.fin ? { st: ok ? "hit" : "lost", txt: `Skor ${sc}` } : { st: "open", txt: `Şu an ${ok ? "tutuyor" : c.hs === c.as ? "berabere (iade)" : "tutmuyor"} (${sc})` };
  }
  if (code === "btts_yes") {
    if (c.hs > 0 && c.as > 0) return { st: "hit", txt: `İki takım da gol attı (${sc})` };
    if (c.fin) return { st: "lost", txt: `Skor ${sc}` };
    return { st: "open", txt: `${c.hs === 0 && c.as === 0 ? "İki takımın da" : c.hs === 0 ? H + " takımının" : W + " takımının"} golü lazım (${sc})` };
  }
  if (code === "btts_no") {
    if (c.hs > 0 && c.as > 0) return { st: "lost", txt: `İki takım da gol attı (${sc})` };
    if (c.fin) return { st: "hit", txt: `Skor ${sc}` };
    return { st: "open", txt: `Şu an tutuyor (${sc})` };
  }
  // alt/üst: toplam gol, takım golü, toplam korner, kart/şut/isabetli şut
  let m = code.match(/^([ou])(\d+(?:\.\d+)?)$/), v = null, what = "gol", line, ou;
  if (m) { v = t; ou = m[1]; line = +m[2]; }
  else if ((m = code.match(/^([ha])([ou])(\d+(?:\.\d+)?)$/))) { v = m[1] === "h" ? c.hs : c.as; what = `${m[1] === "h" ? H : W} golü`; ou = m[2]; line = +m[3]; }
  else if ((m = code.match(/^c([ou])(\d+(?:\.\d+)?)$/))) { if (!c.corners) return null; v = c.corners[0] + c.corners[1]; what = "korner"; ou = m[1]; line = +m[2]; }
  else if ((m = code.match(/^([kst])([ha]?)([ou])(\d+(?:\.\d+)?)$/))) {
    const arr = m[1] === "k" ? c.cards : m[1] === "s" ? c.shots : c.sot;
    if (!arr) return null;
    v = m[2] === "h" ? arr[0] : m[2] === "a" ? arr[1] : arr[0] + arr[1];
    what = m[2] ? `${m[2] === "h" ? H : W} ${{ k: "kartı", s: "şutu", t: "isabetli şutu" }[m[1]]}` : ST_NAME[m[1]]; ou = m[3]; line = +m[4];
  }
  if (v != null) {
    const need = Math.floor(line) + 1 - v;  // üst için kaç tane daha
    if (ou === "o") return v > line ? { st: "hit", txt: `${cap(what)} ${v}, çizgi geçildi` }
      : c.fin ? { st: "lost", txt: `${cap(what)} ${v}, çizgi ${line}` } : { st: "open", txt: `${need} ${what} daha lazım (şu an ${v})` };
    return v > line ? { st: "lost", txt: `${cap(what)} ${v}, çizgi ${line} aşıldı` }
      : c.fin ? { st: "hit", txt: `${cap(what)} ${v}, çizgi ${line}` } : { st: "open", txt: `Tutuyor; ${need} ${what} daha olursa yanar (şu an ${v})` };
  }
  if (/^cm[12X]$/.test(code)) {
    if (!c.corners) return null;
    const [x, y] = c.corners, ok = code === "cm1" ? x > y : code === "cm2" ? y > x : x === y;
    return c.fin ? { st: ok ? "hit" : "lost", txt: `Korner ${x}-${y}` } : { st: "open", txt: `Şu an ${ok ? "tutuyor" : "tutmuyor"} (korner ${x}-${y})` };
  }
  if (code === "rc_yes" || code === "rc_no") {
    const red = c.red[0] + c.red[1];
    if (code === "rc_yes") return red ? { st: "hit", txt: "Kırmızı kart çıktı" } : c.fin ? { st: "lost", txt: "Kırmızı kart çıkmadı" } : { st: "open", txt: "Henüz kırmızı kart yok" };
    return red ? { st: "lost", txt: "Kırmızı kart çıktı" } : c.fin ? { st: "hit", txt: "Kırmızı kart çıkmadı" } : { st: "open", txt: "Şu an tutuyor" };
  }
  return null;
}
// tutmayan tercihin nedeni: şanssızlık (oyun tercihi destekledi), kıl payı ya da model yanıldı
function lossReason(code, c, H, W) {
  if (!code || code.includes("&")) return null;
  const red = (c.red || [0, 0])[0] + (c.red || [0, 0])[1];
  const redTxt = red ? ` Maçta ${red} kırmızı kart çıktı.` : "";
  const goalish = /^(1|X|2|1X|X2|12|dnb[12]|btts_(yes|no)|[ou]\d|[ha][ou]\d)/.test(code);
  if (goalish && c.xg && c.xg[0] != null) {
    // oyunun "hak ettiği" skor: xG; maç sonucunda 0.35 xG'den küçük fark beraberlik sayılır
    const [x, y] = c.xg, d = x - y;
    const fair = { hs: x, as: y };
    const res = { "1": d > 0.35, "X": Math.abs(d) <= 0.35, "2": d < -0.35, "1X": d >= -0.35, "X2": d <= 0.35, "12": Math.abs(d) > 0.35, dnb1: d > 0.35, dnb2: d < -0.35,
      btts_yes: x >= 0.8 && y >= 0.8, btts_no: x < 0.8 || y < 0.8 };
    let ok = res[code];
    let m;
    if (ok === undefined && (m = code.match(/^([ou])(\d+(?:\.\d+)?)$/))) ok = m[1] === "o" ? x + y > +m[2] : x + y < +m[2];
    if (ok === undefined && (m = code.match(/^([ha])([ou])(\d+(?:\.\d+)?)$/))) { const v = m[1] === "h" ? fair.hs : fair.as; ok = m[2] === "o" ? v > +m[3] : v < +m[3]; }
    const xgt = `xG ${nf(x, 1)}-${nf(y, 1)}`;
    if (ok) return { kind: "luck", txt: `Şanssız: oyun tercihi destekledi (${xgt}) ama skor ${c.hs}-${c.as}.${redTxt}`, short: `oyun tercihi destekledi (${xgt}).${redTxt}` };
    return { kind: "miss", txt: `Model yanıldı: oyun da tercihin tersine gitti (${xgt}).${redTxt}`, short: `oyun da tersine gitti (${xgt}).${redTxt}` };
  }
  const p = pickProgress(code, { ...c, fin: true }, H, W);
  const m = code.match(/(\d+(?:\.\d+)?)$/);
  if (p && m) {
    const v = +(p.txt.match(/(\d+)(?=,)/) || [])[1];
    if (Number.isFinite(v) && Math.abs(v - +m[1]) <= 1) return { kind: "close", txt: `Kıl payı: ${p.txt}.${redTxt}`, short: redTxt.trim() };
    return { kind: "miss", txt: `Model yanıldı: ${p.txt}.${redTxt}`, short: redTxt.trim() };
  }
  return redTxt ? { kind: "miss", txt: redTxt.trim(), short: redTxt.trim() } : null;
}
const REASON_TAG = { luck: "🍀 Şanssız", close: "🤏 Kıl payı", miss: "❌ Model yanıldı" };
// maç sayfasında tercihlerin durumu (canlıda anlık, bitince sonuç ve neden)
function trackHtml(b, c, title) {
  const P = b.analysis.prediction, H = b.home.name, W = b.away.name;
  const rows = [];
  const add = (ic, name, x) => {
    if (!x) return;
    const p = pickProgress(x.code, c, H, W);
    if (!p) return;
    const why = p.st === "lost" && c.fin ? lossReason(x.code, c, H, W) : null;
    rows.push(`<div class="trk ${p.st}"><span class="tri">${p.st === "hit" ? "✓" : p.st === "lost" ? "✗" : p.st === "void" ? "↩" : "⏳"}</span>
      <div><b>${ic} ${name}: ${esc(x.label)}</b>${x.odds ? ` <small class="muted">@${nf(x.odds, 2)}</small>` : ""}<small>${esc(p.txt)}</small>
      ${why ? `<small class="why ${why.kind}">${REASON_TAG[why.kind]}${why.short ? " · " + esc(why.short) : ""}</small>` : ""}</div></div>`);
  };
  add("✅", "Garanti", P.best_pick);
  add("💎", "Değerli", P.value_pick);
  add("⚡", "Sürpriz", P.surprise);
  const sp = (P.score_pick || {}).score;
  if (sp) {
    const [a, d] = sp.split("-").map(Number), exact = a === c.hs && d === c.as;
    const sameRes = Math.sign(a - d) === Math.sign(c.hs - c.as);
    rows.push(`<div class="trk ${c.fin ? (exact ? "hit" : "lost") : "open"}"><span class="tri">${c.fin ? (exact ? "✓" : "✗") : "⏳"}</span>
      <div><b>🎲 Skor tahmini: ${esc(sp)}</b><small>${c.fin ? (exact ? "Tam isabet" : `Sonuç ${c.hs}-${c.as}${sameRes ? " · maç sonucu doğru" : ""}`) : `Şu an ${c.hs}-${c.as}`}</small></div></div>`);
  }
  // bu maçın kupon ayakları (maçın gününün kuponları)
  const dk = trDay(b.utc), dc = dayCache && dayCache.date === dk ? dayCache : couponDay && couponDay.date === dk ? couponDay : null;
  ((dc && dc.coupons) || []).map(normCoupon).forEach((cp) => cp.legs.filter((l) => l.mid === b.id).forEach((l) => {
    const p = pickProgress(l.code, c, H, W);
    if (p) rows.push(`<div class="trk ${p.st}"><span class="tri">${p.st === "hit" ? "✓" : p.st === "lost" ? "✗" : "⏳"}</span><div><b>${cp.icon || "🧩"} ${esc(cp.name)} ayağı: ${esc(l.label)}</b><small>${esc(p.txt)}</small></div></div>`);
  }));
  if (!rows.length) return "";
  return `<div class="card trkcard" style="--c:${c.fin ? "#a371f7" : "#f85149"}">${head(c.fin ? "🏁" : "📡", title)}${c.xg && c.xg[0] != null ? `<p class="muted trkxg">xG ${nf(c.xg[0], 2)} – ${nf(c.xg[1], 2)}</p>` : ""}<div class="trks">${rows.join("")}</div></div>`;
}

/* ---------- hakem sayfası ---------- */
let karneCache = null;
let couponDay = null;  // maç sayfası doğrudan açıldığında maçın gününün kuponları
async function getKarne() { if (!karneCache) { try { karneCache = await api("/api/karne"); } catch { karneCache = {}; } } return karneCache; }
async function renderReferee(mid) {
  const v = $("#view");
  v.innerHTML = skel("page");
  let b, k;
  try { [b, k] = await Promise.all([api(`/api/match/${mid}`), getKarne()]); } catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (state.hakem !== mid) return;
  const r = b.referee_stats || {}, name = b.referee;
  const rows = (Array.isArray(k) ? k : k.singles || []).filter((x) => x.referee === name && x.state === "done").sort((a, c) => (c.utc || "").localeCompare(a.utc || ""));
  const cards = rows.filter((x) => x.final && x.final.yellow && x.final.yellow[0] != null).map((x) => x.final.yellow[0] + x.final.yellow[1] + (x.final.red || [0, 0]).reduce((a, c) => a + c, 0));
  const bar = (val, avg, max) => `<div class="rfbar"><span style="width:${Math.min(100, val / max * 100)}%"></span><i style="left:${Math.min(100, avg / max * 100)}%" title="Lig ortalaması"></i></div>`;
  const tone = r.yellow_pm && r.yellow_avg ? (r.yellow_pm >= r.yellow_avg * 1.15 ? ["sert", "neg", "Kart çıkarmaya eğilimli: kart üst tercihleri için olumlu."] : r.yellow_pm <= r.yellow_avg * 0.85 ? ["yumuşak", "pos", "Az kart gösteriyor: kart alt tercihleri için olumlu."] : ["dengeli", "", "Lig ortalamasına yakın."]) : null;
  v.innerHTML = `<div class="card" style="--c:#d29922">${head(WHISTLE, `${esc(name)} <span class="muted">· hakem</span>`)}
      ${tone ? `<p><span class="ltag ${tone[1]}">${tone[0]}</span> <span class="muted">${tone[2]}</span></p>` : ""}
      <div class="rfstats">
        ${r.yellow_pm != null ? `<div><span>Maç başı sarı kart</span><b>${nf(r.yellow_pm, 2)}</b>${r.yellow_avg ? `${bar(r.yellow_pm, r.yellow_avg, Math.max(r.yellow_pm, r.yellow_avg) * 1.4)}<small class="muted">lig ortalaması ${nf(r.yellow_avg, 2)}</small>` : ""}</div>` : ""}
        ${r.fouls_pm != null ? `<div><span>Maç başı faul</span><b>${nf(r.fouls_pm, 1)}</b>${r.fouls_avg ? `${bar(r.fouls_pm, r.fouls_avg, Math.max(r.fouls_pm, r.fouls_avg) * 1.4)}<small class="muted">lig ortalaması ${nf(r.fouls_avg, 1)}</small>` : ""}</div>` : ""}
        <div><span>Maç</span><b>${r.matches ?? "—"}</b><small class="muted">bu sezon</small></div>
        <div><span>Kırmızı kart</span><b>${r.red ?? "—"}</b><small class="muted">${r.matches && r.red != null ? `maç başı ${nf(r.red / r.matches, 2)}` : ""}</small></div>
        <div><span>Penaltı</span><b>${r.pens ?? "—"}</b><small class="muted">${r.pens_pm != null ? `maç başı ${nf(r.pens_pm, 2)}` : ""}</small></div>
      </div></div>
    <div class="card" style="--c:#58a6ff">${head("📅", `Sitede kayıtlı maçları <span class="muted">· ${rows.length} maç${cards.length ? ` · ortalama ${nf(cards.reduce((a, c) => a + c, 0) / cards.length, 1)} kart` : ""}</span>`)}
      ${rows.length ? rows.map((x) => {
        const f = x.final || {}, y = f.yellow || [], rd = f.red || [0, 0];
        return `<div class="rfrow"><span class="muted">${dateOf(x.utc)}</span><span>${esc(x.home.name)} <b>${x.result[0]}-${x.result[1]}</b> ${esc(x.away.name)}</span>
          <span class="rfk">${y[0] != null ? `🟨 ${y[0] + y[1]}${rd[0] + rd[1] ? ` 🟥 ${rd[0] + rd[1]}` : ""}` : ""}</span>
          <span class="kst ${x.pick_hit ? "ok" : x.pick_hit === false ? "no" : "wait"}" title="Garanti tercih: ${esc(x.pick.label)}">${x.pick_hit ? "✓" : x.pick_hit === false ? "✗" : "↩"}</span></div>`;
      }).join("") : `<p class="muted">Bu hakemin yönettiği maçlar karneye kaydedildikçe burada listelenir.</p>`}</div>
    <div class="card"><a class="kbtn" href="#/mac/${mid}">‹ Maça dön: ${esc(b.home.name)} – ${esc(b.away.name)}</a></div>`;
}

/* ---------- haftalık rapor (karne) ---------- */
function weekReport() {
  const [a, z, mon, sun] = weekRange(karneWeek);
  const inW = (k) => k >= a && k <= z;
  const rows = (karneRows || []).filter((r) => inW(trDay(r.utc)));
  const sg = rows.filter(pickDecided), cps = karneCoupons.filter((c) => c.state === "done" && inW(c.date));
  if (!sg.length && !cps.length) return "";
  const spl = sg.filter((r) => r.pick.odds).reduce((x, r) => x + rowProfit(r), 0), cpl = cps.reduce((x, c) => x + couponProfit(c), 0);
  const sc = rows.filter((r) => r.state === "done"), exact = sc.filter((r) => r.score_hit).length;
  const val = rows.filter((r) => r.value && r.state === "done" && r.value_hit != null);
  const vpl = val.reduce((x, r) => x + (r.value_hit ? STAKE * (r.value.odds - 1) : -STAKE), 0);
  const group = (key) => { const g = {}; sg.forEach((r) => { const k = key(r); (g[k] ||= { n: 0, h: 0 }); g[k].n++; if (r.pick_hit) g[k].h++; }); return Object.entries(g).filter(([, x]) => x.n >= 2).sort((p, q) => q[1].h / q[1].n - p[1].h / p[1].n || q[1].n - p[1].n); };
  const types = group((r) => pickType(r.pick)), lgs = group((r) => lgName(r.league_id, r.league));
  const best = types[0], worst = types.length > 1 ? types[types.length - 1] : null, bestL = lgs[0];
  const why = sg.filter((r) => r.pick_hit === false && r.final).map((r) => lossReason(r.pick.code, { ...finalCtx({ final: r.final, home: { score: r.result[0] }, away: { score: r.result[1] }, status: { finished: true } }) }, r.home.name, r.away.name)).filter(Boolean);
  const luck = why.filter((w) => w.kind === "luck").length, close = why.filter((w) => w.kind === "close").length, miss = why.filter((w) => w.kind === "miss").length;
  const fmt = (d) => d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  const rate = (x) => `${x.h}/${x.n} (%${Math.round(x.h / x.n * 100)})`;
  const lines = [
    sg.length ? `✅ Garanti tercih: ${sg.filter((r) => r.pick_hit).length}/${sg.length} · ${tl(spl, true)}` : "",
    cps.length ? `🧩 Kupon: ${cps.filter((c) => c.won).length}/${cps.length} · ${tl(cpl, true)}` : "",
    sc.length ? `🎲 Skor tam isabet: ${exact}/${sc.length}` : "",
    val.length ? `💎 Değerli oran: ${val.filter((r) => r.value_hit).length}/${val.length} · ${tl(vpl, true)}` : "",
    best ? `📈 En iyi tür: ${best[0]} ${rate(best[1])}` : "",
    worst && worst[0] !== best[0] ? `📉 En zayıf tür: ${worst[0]} ${rate(worst[1])}` : "",
    bestL ? `🏆 En iyi lig: ${bestL[0]} ${rate(bestL[1])}` : "",
    why.length ? `🔎 Tutmayanlar: ${luck} şanssız, ${close} kıl payı, ${miss} model hatası` : "",
  ].filter(Boolean);
  const text = [`📊 HAFTALIK KARNE`, `🗓️ ${fmt(mon)} – ${fmt(sun)}`, SH_LINE, ...lines].join("\n");
  return `<div class="card wrep" style="--c:#39c5cf">${head("📊", `Haftanın raporu <span class="muted">· ${fmt(mon)} – ${fmt(sun)}</span>`)}
    <ul class="wlines">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <div class="kshare">${shareBtn("w:" + a, `📊 Haftalık karne · ${fmt(mon)}`, text)}</div></div>`;
}

/* ---------- takım sayfası ve karşılaştırma ---------- */
const teamCache = new Map();
async function getTeam(id) {
  if (!teamCache.has(id)) teamCache.set(id, await api(`/api/team/${id}`));
  return teamCache.get(id);
}
let teamList = null;
async function getTeams() { if (!teamList) { try { teamList = await api("/api/teams"); } catch { teamList = []; } } return teamList; }
// güç puanı geçmişi: tek seri çizgi, üzerine gelince tarih ve puan
function eloChart(hist) {
  if (!hist || hist.length < 3) return "";
  const W = 600, Hh = 150, p = 10;
  const vs = hist.map((h) => h[1]), lo = Math.min(...vs) - 10, hi = Math.max(...vs) + 10;
  const x = (i) => p + i * (W - 2 * p) / (hist.length - 1), y = (v) => p + (hi - v) * (Hh - 2 * p) / (hi - lo);
  const d = hist.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h[1]).toFixed(1)}`).join("");
  const up = vs[vs.length - 1] >= vs[0], col = up ? "#3fb950" : "#f85149";
  const fmt = (s) => new Date(s + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "2-digit" });
  const pts = esc(JSON.stringify(hist.map((h, i) => [x(i), y(h[1]), fmt(h[0]), h[1]])));
  return `<div class="elochart" data-pts="${pts}">
    <div class="plw"><svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" class="plsvg" role="img" aria-label="Güç puanı geçmişi">
      <path d="${d}L${x(hist.length - 1)},${Hh}L${x(0)},${Hh}Z" fill="${col}" opacity=".08"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
      <span class="pldot" style="--c:${col}"></span><div class="pltip"></div></div>
    <div class="plx muted"><span>${fmt(hist[0][0])} · ${vs[0]}</span><span>${fmt(hist[hist.length - 1][0])} · ${vs[vs.length - 1]}</span></div></div>`;
}
document.addEventListener("pointermove", (e) => {
  const c = e.target.closest && e.target.closest(".elochart");
  document.querySelectorAll(".elochart .plw.hov").forEach((w) => { if (!c || !c.contains(w)) w.classList.remove("hov"); });
  if (!c) return;
  const w = c.querySelector(".plw"), r = w.getBoundingClientRect(), pts = JSON.parse(c.dataset.pts);
  const sx = r.width / 600, sy = r.height / 150, px = (e.clientX - r.left) / sx;
  const q = pts.reduce((a, b) => Math.abs(b[0] - px) < Math.abs(a[0] - px) ? b : a);
  const dot = w.querySelector(".pldot");
  dot.style.left = q[0] * sx + "px"; dot.style.top = q[1] * sy + "px";
  const tip = w.querySelector(".pltip");
  tip.innerHTML = `<b>${q[2]}</b><span>Güç puanı ${q[3]}</span>`;
  tip.style.left = Math.min(Math.max(q[0] * sx, 60), r.width - 60) + "px";
  w.classList.add("hov");
});
const TEAM_AVG = [["goals", "Gol", 1], ["xg", "xG", 2], ["shots", "Şut", 1], ["sot", "İsabetli şut", 1], ["big_chances", "Net pozisyon", 1],
  ["corners", "Korner", 1], ["possession", "Topla oynama %", 0], ["yellow", "Sarı kart", 1]];
// istatistik başlıklarının Türkçesi (oyuncu listeleri)
const trStat = (t) => ({ "FotMob rating": "Reyting", "Expected goals (xG)": "Beklenen gol (xG)", "Goals": "Gol", "Assists": "Asist",
  "Top scorer": "Gol", "Expected assist (xA)": "Beklenen asist (xA)", "Goals + Assists": "Gol + asist" }[t] || t || "");
async function renderTeam(id) {
  const v = $("#view");
  v.innerHTML = skel("page");
  let t;
  try { t = await getTeam(id); } catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (state.takim !== id) return;
  const tb = t.table || {}, r = t.recent || {}, af = r.avg_for || {}, aa = r.avg_against || {};
  const rows = t.rows || [];
  const pts = rows.slice(0, 5).reduce((a, x) => a + ({ G: 3, B: 1 }[x.result] || 0), 0);
  const res = (x) => `<span class="fd ${x.result || ""}">${x.result || "-"}</span>`;
  const playersHtml = Object.entries(t.players || {}).slice(0, 4).map(([, c]) => `<div class="tpcat"><h4>${esc(trStat(c.title))}</h4>
    ${c.list.map((p) => `<a class="tprow" href="#/oyuncu/${p.id}"><span>${esc(p.name)}</span><b>${nf(p.value, Number.isInteger(p.value) ? 0 : 2)}</b></a>`).join("")}</div>`).join("");
  const season = (t.season || []).map((x) => {
    const pct = x.of ? Math.round((x.of - x.rank + 1) / x.of * 100) : 0;
    return `<div class="srow"><div class="sl">${esc(x.label)} <span class="muted">· ${nf(x.value, Number.isInteger(x.value) ? 0 : 2)}</span></div><div class="sv">${x.rank}/${x.of}</div>
      <div class="spct"><span style="width:${Math.max(3, pct)}%;background:${pctColor(pct)}"></span><b>${x.rank}.</b></div></div>`;
  }).join("");
  const next = (t.next || []).map((m) => {
    const op = m.home.id === t.id ? m.away : m.home;
    return `<a class="tnext" href="#/mac/${m.id}"><span class="muted">${dateOf(m.utc)} · ${timeOf(m.utc)}</span>
      <span>${m.home.id === t.id ? "" : "@ "}<img src="${teamLogo(op.id)}" alt="" onerror="this.remove()">${esc(op.name)}</span></a>`;
  }).join("");
  v.innerHTML = `<div class="card thero" style="--c:#58a6ff">
      <div class="thead"><img src="${teamLogo(t.id)}" alt="" onerror="this.remove()"><div><h1>${esc(t.name)} ${starBtn(t.id, t.name)}</h1>
        <a class="muted" href="#/lig/${t.league_id}">${esc(lgName(t.league_id, t.league))} ›</a></div></div>
      <div class="tkpis">
        ${tb.pos ? `<div><b>${tb.pos}.</b><small>sıra · ${tb.played} maç, ${tb.pts} puan</small></div>` : ""}
        ${t.elo ? `<div><b>${Math.round(t.elo)}</b><small>güç puanı (Elo)</small></div>` : ""}
        <div><b>${pts}/15</b><small>son 5 maç puanı</small></div>
        ${af.xg != null ? `<div><b>${nf(af.xg, 2)} – ${nf(aa.xg, 2)}</b><small>xG ürettiği – verdiği</small></div>` : ""}
      </div>
      <div class="tcmpbar"><button class="kbtn" id="tcmpBtn">⚖️ Başka bir takımla karşılaştır</button></div>
      <div id="tcmpPick"></div></div>
    ${t.elo_hist && t.elo_hist.length > 2 ? `<div class="card" style="--c:#a371f7">${head("📈", `Güç puanı (Elo) <span class="muted">· son ${t.elo_hist.length} maç, Avrupa kupaları dahil</span>`)}${eloChart(t.elo_hist)}</div>` : ""}
    <div class="card" style="--c:#3fb950">${head("📅", "Son maçlar")}
      <div class="tform">${rows.map((x) => `<div class="tfr">${res(x)}<span class="tfd muted">${dateOf(x.date)}</span>
        <span class="tfo">${x.home ? "" : "@ "}${x.opp_id ? `<a href="#/takim/${x.opp_id}">${esc(x.opponent)}</a>` : esc(x.opponent)} <small class="muted">${esc(x.comp || "")}</small></span>
        <b class="tfs">${x.gf ?? "-"}-${x.ga ?? "-"}</b><small class="tfx muted">${x.xg != null ? `xG ${nf(x.xg, 1)}-${nf(x.xga, 1)}` : ""}</small></div>`).join("") || `<p class="muted">Veri yok</p>`}</div></div>
    <div class="card" style="--c:#58a6ff">${head("📊", `Maç başı ortalamalar <span class="muted">· son ${r.n || 0} maç</span>`)}
      <div class="tavg"><div class="tavr tavh"><span></span><b>Üretti</b><b>İzin verdi</b></div>
      ${TEAM_AVG.filter(([k]) => af[k] != null || aa[k] != null).map(([k, l, d]) => `<div class="tavr"><span>${l}</span><b>${nf(af[k], d)}</b><b>${nf(aa[k], d)}</b></div>`).join("")}</div></div>
    ${season ? `<div class="card" style="--c:#d29922">${head("🏆", `Sezon sıralamaları <span class="muted">· ligdeki yeri</span>`)}${season}</div>` : ""}
    ${playersHtml ? `<div class="card" style="--c:#f78166">${head("⭐", `Öne çıkan oyuncular <span class="muted">· sezon</span>`)}<div class="tplayers">${playersHtml}</div></div>` : ""}
    ${next ? `<div class="card" style="--c:#39c5cf">${head("🗓️", "Sıradaki maçlar")}${next}</div>` : ""}`;
  $("#tcmpBtn").onclick = async () => {
    const same = (x) => (x.league_id === t.league_id ? 0 : 1);
    const list = (await getTeams()).filter((x) => x.id !== t.id).sort((a, b) => same(a) - same(b) || a.name.localeCompare(b.name, "tr"));
    $("#tcmpPick").innerHTML = `<input class="osearch" id="tcmpQ" type="search" placeholder="Takım ara" autocomplete="off"><div class="tcmplist">${list.map((x) =>
      `<a href="#/karsilastir/${t.id}/${x.id}" data-n="${esc(x.name.toLocaleLowerCase("tr"))}"><img src="${teamLogo(x.id)}" alt="" onerror="this.remove()">${esc(x.name)}</a>`).join("")}</div>`;
    $("#tcmpQ").oninput = (e) => { const q = e.target.value.toLocaleLowerCase("tr"); document.querySelectorAll(".tcmplist a").forEach((a) => a.hidden = !!q && !a.dataset.n.includes(q)); };
    $("#tcmpQ").focus();
  };
}
async function renderCompare(a, b) {
  const v = $("#view");
  v.innerHTML = skel("page");
  let A, B;
  try { [A, B] = await Promise.all([getTeam(a), getTeam(b)]); } catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (!state.cmp || state.cmp[0] !== a || state.cmp[1] !== b) return;
  const ppg = (t) => t.table && t.table.played ? t.table.pts / t.table.played : null;
  const l5 = (t) => (t.rows || []).slice(0, 5).reduce((s, x) => s + ({ G: 3, B: 1 }[x.result] || 0), 0);
  const sv = (t, k) => ((t.season || []).find((x) => x.key === k) || {}).value;
  const f = (t, k) => ((t.recent || {}).avg_for || {})[k], g = (t, k) => ((t.recent || {}).avg_against || {})[k];
  const cm = (k) => CMP.find((x) => x[0] === k);
  // (ad, A değeri, B değeri, ondalık, yüksek mi iyi; null = iyi/kötü yok)
  const groups = [
    ["Genel", [["Güç puanı (Elo)", A.elo, B.elo, 0, true], ["Ligde maç başı puan", ppg(A), ppg(B), 2, true],
      ["Son 5 maç puanı", l5(A), l5(B), 0, true], ["Sezon reytingi", sv(A, "rating_team"), sv(B, "rating_team"), 2, true]]],
    ["Hücum · son maçlar, maç başı", ["goals", "xg", "shots", "sot", "big_chances", "box_touches", "corners"].map((k) => [cm(k)[1], f(A, k), f(B, k), cm(k)[2], true])],
    ["Savunma · rakibe izin verdikleri", ["goals", "xg", "shots", "sot", "big_chances"].map((k) => [cm(k)[1], g(A, k), g(B, k), cm(k)[2], false])],
    ["Oyun tarzı", [["Topla oynama %", f(A, "possession"), f(B, "possession"), 0, null], ["İsabetli pas", f(A, "passes_acc"), f(B, "passes_acc"), 0, null],
      ["Faul", f(A, "fouls"), f(B, "fouls"), 1, null], ["Sarı kart", f(A, "yellow"), f(B, "yellow"), 1, null]]],
  ];
  let wa = 0, wb = 0;
  const row = ([l, x, y, d, hi]) => {
    if (x == null && y == null) return "";
    let bx = "", by = "";
    if (hi !== null && x != null && y != null && x !== y) { if ((x > y) === hi) { bx = "win"; wa++; } else { by = "win"; wb++; } }
    const fx = Math.max(x || 0, 0), fy = Math.max(y || 0, 0), tot = fx + fy || 1;
    return `<div class="cmp-row"><span class="cv ${bx}">${x == null ? "—" : nf(x, d)}</span>
      <div class="cmp-mid"><div class="cmp-l">${l}</div><div class="cmp-bars"><span class="bh" style="flex:${fx / tot}"></span><span class="ba" style="flex:${fy / tot}"></span></div></div>
      <span class="cv r ${by}">${y == null ? "—" : nf(y, d)}</span></div>`;
  };
  const body = groups.map(([gname, rs]) => `<h3>${gname}</h3>${rs.map(row).join("")}`).join("");
  const side = (t) => `<a class="xside" href="#/takim/${t.id}"><img src="${teamLogo(t.id)}" alt="" onerror="this.remove()"><b>${esc(t.name)}</b><small class="muted">${esc(lgName(t.league_id, t.league))}</small></a>`;
  v.innerHTML = `<div class="card xcmp" style="--c:#58a6ff">${head("⚖️", "Takım karşılaştırması")}
    <div class="xhead">${side(A)}<div class="xscore"><span><b>${wa}</b><i>-</i><b>${wb}</b></span><small class="muted">üstün olduğu kalem</small></div>${side(B)}</div>
    <div class="legend"><span><i style="background:var(--home)"></i>${esc(A.name)}</span><span><i style="background:var(--away)"></i>${esc(B.name)}</span></div>
    ${body}<p class="muted">Kalın yazılan değer o kalemde daha iyi olanı gösterir. Son maç ortalamaları rakip gücüne göre düzeltilmemiştir; farklı liglerdeki takımlar için güç puanı daha doğru bir kıyastır.</p></div>`;
}

/* ---------- paylaşım sepeti (Telegram için elle seçilen analizler) ----------
   Metinlerde site adı, linki ve veri/oran kaynağı geçmez; sonuna sadece kanal imzası eklenir. */
const SHARE_SIGN = "📊 Timy Analiz";
let shareItems = JSON.parse(safeGet("shareItems") || "[]");
let shareNote = safeGet("shareNote") || "";
const SHARE_SRC = new Map();  // ekrandaki "Paylaşıma ekle" butonlarının içeriği: anahtar -> {title, text}
const saveShare = () => { safeSet("shareItems", JSON.stringify(shareItems)); updateShareCount(); };
function updateShareCount() { const b = $("#shareCount"); if (b) b.textContent = shareItems.length || ""; }
const inShare = (key) => shareItems.some((x) => x.key === key);
// key: tekrar eklenmesin diye benzersiz anahtar; title: listede görünen kısa ad; text: paylaşılacak metin
function shareBtn(key, title, text) {
  SHARE_SRC.set(key, { title, text });
  return `<button class="kbtn sadd ${inShare(key) ? "ok" : ""}" data-sadd="${esc(key)}">${inShare(key) ? "✓ Paylaşımda" : "➕ Paylaşıma ekle"}</button>`;
}
function toggleShare(key, btn) {
  if (inShare(key)) shareItems = shareItems.filter((x) => x.key !== key);
  else { const s = SHARE_SRC.get(key); if (!s) return; shareItems.push({ key, ...s, added: Date.now() }); }
  saveShare();
  const on = inShare(key);
  document.querySelectorAll(`[data-sadd="${CSS.escape(key)}"]`).forEach((b) => { b.classList.toggle("ok", on); b.textContent = on ? "✓ Paylaşımda" : "➕ Paylaşıma ekle"; });
}
const matchLine = (home, away, utc) => `⚽ ${home} 🆚 ${away}${utc ? `\n🗓️ ${new Date(utc).toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long", timeZone: TZ })} · 🕘 ${timeOf(utc)}` : ""}`;
// maç özeti: olasılıklar, skor, gol beklentisi ve en garanti tercih
function matchShareText(b) {
  const P = b.analysis.prediction;
  const bp = P.best_pick, sp = P.score_pick || {};
  const fav = P.p_home >= P.p_away ? b.home.name : b.away.name;
  return [`📋 MAÇ ANALİZİ`, matchLine(b.home.name, b.away.name, b.utc), SH_LINE,
    `🏠 1: ${pc(P.p_home)} · 🤝 X: ${pc(P.p_draw)} · ✈️ 2: ${pc(P.p_away)}`,
    `⭐ Favori: ${fav}`,
    `🎯 Skor tahmini: ${sp.score || (P.scores[0] || {}).score || "—"}`,
    `🔥 2.5 Üst: ${pc(P.over25)} · ⚡ KG Var: ${pc(P.btts)}`,
    P.corners ? `🚩 Korner beklentisi: ${nf(P.corners.total, 1)}` : "",
    SH_LINE,
    bp ? `✅ En garanti: ${bp.label}${bp.odds ? ` · 💰 ${nf(bp.odds, 2)}` : ""} (📊 %${Math.round(bp.p * 100)})${bestFinal(b) ? "" : " · değişebilir"}` : ""].filter(Boolean).join("\n");
}
// bugünün kesinleşen (resmi 11 sonrası kilitlenen) garanti tercihleri: tek paylaşım öğesi, basınca güncellenir
async function addFinalPicks() {
  const note = $("#shareFinalNote");
  let d;
  try { d = await api("/api/day?date=" + todayStr()); } catch (e) { note.textContent = e.message; return; }
  const ms = (d.matches || []).filter((m) => m.pred && m.pred.safe && m.pred.safe.final && !m.started && !m.finished && !m.cancelled)
    .sort((a, b) => (a.utc || "").localeCompare(b.utc || ""));
  if (!ms.length) { note.textContent = "Şu an kesinleşmiş ve başlamamış tercih yok. Resmi 11'ler genelde maçtan 1 saat önce açıklanır."; return; }
  const day = new Date(todayStr() + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long" });
  const text = [`✅ GÜNÜN SON TERCİHLERİ`, `🗓️ ${day}`, SH_LINE,
    ms.map((m, i) => `${NUM_EMO[i] || "▪️"} ${m.home.name} 🆚 ${m.away.name}\n🕘 ${timeOf(m.utc)} · 👉 ${m.pred.safe.label}${m.pred.safe.odds ? ` · 💰 ${nf(m.pred.safe.odds, 2)}` : ""}`).join("\n\n")].join("\n");
  const key = "final:" + todayStr();
  const item = { key, title: `✅ Son tercihler · ${ms.length} maç`, text, added: Date.now() };
  const i = shareItems.findIndex((x) => x.key === key);
  if (i >= 0) shareItems[i] = item; else shareItems.push(item);
  saveShare(); renderShare();
}
function shareText() {
  const parts = [];
  if (shareNote.trim()) parts.push(`📣 ${shareNote.trim()}`);
  shareItems.forEach((x) => parts.push(x.text));
  // öğeler arasında belirgin ayraç, sonda imza
  return parts.join("\n\n〰️〰️〰️〰️〰️〰️〰️\n\n") + `\n\n${SH_LINE}\n${SHARE_SIGN} · ⚠️ Tahminler kesinlik içermez`;
}
function renderShare() {
  const v = $("#view");
  const items = shareItems.map((x, i) => `<div class="shitem">
      <div class="shhead"><b>${esc(x.title)}</b>
        <span class="shbtns"><button class="calbtn" data-smv="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="Yukarı">↑</button><button class="calbtn" data-smv="${i}:1" ${i === shareItems.length - 1 ? "disabled" : ""} aria-label="Aşağı">↓</button><button class="calbtn" data-sdel="${i}" aria-label="Çıkar">✕</button></span></div>
      <pre class="shtext">${esc(x.text)}</pre></div>`).join("");
  v.innerHTML = `<div class="card" style="--c:#39c5cf">${head("📤", `Paylaşım <span class="muted">· ${shareItems.length} öğe</span>`)}
    <p class="muted">Sitede kuponların, maç özetlerinin, maç yorumlarının ve oran hareketlerinin yanındaki <b>➕ Paylaşıma ekle</b> ile seçtiklerin burada toplanır. Metinde site adı, linki ya da veri kaynağı geçmez; sonuna kanal imzası eklenir.</p>
    <label class="shlab">Başa eklenecek not (isteğe bağlı)</label>
    <textarea id="shareNote" rows="2" placeholder="Örn: Bugünün seçmeleri 👇">${esc(shareNote)}</textarea>
    <div class="kshare"><button class="kbtn" id="shareFinal">✅ Bugünün kesinleşen tercihlerini ekle</button></div>
    <p class="muted" id="shareFinalNote">Resmi 11'i açıklanmış ve tercihi kilitlenmiş, henüz başlamamış maçların garanti tercihleri tek mesaj olarak eklenir. Tekrar basınca güncellenir.</p></div>
    ${shareItems.length ? `<div class="card" style="--c:#58a6ff">${items}</div>` : `<div class="card"><p class="muted">Henüz bir şey eklenmedi.</p></div>`}
    ${shareItems.length ? `<div class="card" style="--c:#2ea043">${head("👁️", "Önizleme")}<pre class="shtext shprev">${esc(shareText())}</pre>
      <div class="kshare"><button class="kbtn big" id="shareCopy">📋 Kopyala</button><button class="kbtn" id="shareClear">🗑️ Listeyi temizle</button></div>
      <p class="muted">Kopyaladıktan sonra Telegram kanalına yapıştır. Liste sen temizleyene kadar kalır.</p></div>` : ""}`;
  $("#shareFinal").onclick = addFinalPicks;
  $("#shareNote").oninput = (e) => { shareNote = e.target.value; safeSet("shareNote", shareNote); const p = $(".shprev"); if (p) p.textContent = shareText(); };
  v.querySelectorAll("[data-smv]").forEach((b) => b.onclick = () => {
    const [i, d] = b.dataset.smv.split(":").map(Number);
    [shareItems[i], shareItems[i + d]] = [shareItems[i + d], shareItems[i]]; saveShare(); renderShare();
  });
  v.querySelectorAll("[data-sdel]").forEach((b) => b.onclick = () => { shareItems.splice(+b.dataset.sdel, 1); saveShare(); renderShare(); });
  const cp = $("#shareCopy");
  if (cp) cp.onclick = async () => {
    const text = shareText();
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = Object.assign(document.createElement("textarea"), { value: text }); document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    cp.textContent = "✓ Kopyalandı"; cp.classList.add("ok"); setTimeout(() => { cp.textContent = "📋 Kopyala"; cp.classList.remove("ok"); }, 1800);
  };
  const cl = $("#shareClear");
  if (cl) cl.onclick = () => { if (confirm("Paylaşım listesi temizlensin mi?")) { shareItems = []; shareNote = ""; safeSet("shareNote", ""); saveShare(); renderShare(); } };
}

/* ---------- yönlendirme ---------- */
// uygulama içi gezinme yığını: Geri butonu sitenin dışına çıkmadan bir önceki sayfaya döner
const navStack = [];
function route() {
  const mm = location.hash.match(/^#\/mac\/(\d+)/);
  const pm = location.hash.match(/^#\/oyuncu\/(\d+)/);
  const km = location.hash.startsWith("#/karne");
  const cm = location.hash.startsWith("#/kombine");
  const lm = location.hash.match(/^#\/lig\/(\d+)/);
  const om = location.hash.startsWith("#/oranlar");
  const shm = location.hash.startsWith("#/paylas");
  const tm = location.hash.match(/^#\/takim\/(\d+)/);
  const xm = location.hash.match(/^#\/karsilastir\/(\d+)\/(\d+)/);
  const hm = location.hash.match(/^#\/hakem\/(\d+)/);
  const bk = location.hash.startsWith("#/basket");
  const h = location.hash || "#/";
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
  // maç, oyuncu ve karne sayfalarında üst barda yalnızca Geri butonu görünür
  document.body.classList.toggle("in-match", !!(mm || pm || lm || shm || tm || xm || hm || (bk && /^#\/basket\/(mac|lig|takim)/.test(location.hash))));
  document.body.classList.toggle("sport-bk", bk);
  document.querySelectorAll("#sportTabs [data-sport]").forEach((a) => a.classList.toggle("on", (a.dataset.sport === "bk") === bk));
  state.player = pm ? +pm[1] : null;
  state.karne = km;
  state.kombine = cm;
  state.lig = lm ? +lm[1] : null;
  state.oranlar = om || shm || !!tm || !!xm || !!hm || bk;  // paylaşım, takım ve karşılaştırma sayfalarında da gün listesi arka planda çizilmesin
  state.takim = tm ? +tm[1] : null;
  state.cmp = xm ? [+xm[1], +xm[2]] : null;
  state.hakem = hm ? +hm[1] : null;
  const navKey = om ? "oranlar" : km ? "karne" : cm ? "kombine" : (mm || pm || lm || tm || xm || hm) ? "" : "home";
  document.querySelectorAll("#fbNav [data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === navKey));
  document.body.classList.toggle("on-home", navKey === "home" && !bk);  // sayfa altı yazısı sadece futbol ana sayfasında
  if (bk) { state.current = null; renderBasket(); }
  else if (shm) { state.current = null; window.scrollTo(0, 0); renderShare(); }
  else if (tm) { state.current = null; window.scrollTo(0, 0); renderTeam(state.takim); }
  else if (xm) { state.current = null; window.scrollTo(0, 0); renderCompare(...state.cmp); }
  else if (hm) { state.current = null; window.scrollTo(0, 0); renderReferee(state.hakem); }
  else if (lm) { state.current = null; window.scrollTo(0, 0); renderLeague(state.lig); }
  else if (om) { state.current = null; window.scrollTo(0, 0); renderMoves(); }
  else if (cm) { state.current = null; window.scrollTo(0, 0); renderCoupons(); }
  else if (km) { state.current = null; window.scrollTo(0, 0); renderKarne(); }
  else if (mm) { state.current = +mm[1]; window.scrollTo(0, 0); renderMatch(state.current); }
  else if (pm) { state.current = null; window.scrollTo(0, 0); renderPlayer(state.player); }
  else { state.current = null; renderDay(); }
}
$("#backBtn").onclick = () => {
  if (navStack.length > 1) history.back();
  else { const b = location.hash.startsWith("#/basket"); navStack.length = 0; location.hash = b ? "#/basket" : "#/"; }
};
// kadrodaki oyunculara tıklayınca oyuncu sayfası
$("#view").addEventListener("click", (e) => {
  const ob = e.target.closest("[data-ocode]");
  if (ob) { e.stopPropagation(); e.preventDefault(); openOddsAt(+ob.dataset.omid, ob.dataset.ocode); return; }
  const sa = e.target.closest("[data-sadd]");
  if (sa) { e.stopPropagation(); e.preventDefault(); toggleShare(sa.dataset.sadd, sa); return; }
  const sh = e.target.closest("[data-share]");
  if (sh) { e.stopPropagation(); e.preventDefault(); copyCoupon(sh.dataset.cid, sh); return; }
  const el = e.target.closest("[data-pid]");
  if (el && el.dataset.pid !== "0") { location.hash = "#/oyuncu/" + el.dataset.pid; return; }
  const km = e.target.closest("[data-mid]");
  if (km) location.hash = "#/mac/" + km.dataset.mid;
});
function setDate(s) {
  state.date = s; renderDays();
  renderDay();
}
// Dün / Bugün / Yarın düğmeleri
function renderDays() {
  const base = todayStr(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
  $("#fbDays").innerHTML = [[shift(-1), "Dün"], [base, "Bugün"], [shift(1), "Yarın"]].map(([d, l]) =>
    `<button class="ptab ${d === state.date ? "on" : ""}" data-fbd="${d}">${l}</button>`).join("");
  $("#fbDays").querySelectorAll("[data-fbd]").forEach((b) => b.onclick = () => setDate(b.dataset.fbd));
}

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
function startPolling() {
  let lastEv = +(safeGet("lastEventId") || 0);
  const tick = async () => {
    try {
      const m = await getData("meta.json");
      if (meta && m.updated === meta.updated) return;
      meta = m;
      const evs = await getData("events.json");
      evs.filter((e) => e.id > lastEv).reverse().forEach((ev) => addFeed(ev, true));
      if (evs.length) { lastEv = Math.max(lastEv, evs[0].id); safeSet("lastEventId", String(lastEv)); }
      /^#\/(paylas|takim|karsilastir|hakem)/.test(location.hash) ? null : state.lig ? renderLeague(state.lig) : state.oranlar ? renderMoves() : state.kombine ? (dayCache = null, renderCoupons()) : state.karne ? renderKarne(true) : state.player ? renderPlayer(state.player, true) : state.current ? renderMatch(state.current, true) : renderDay(true);
    } catch { /* bir sonraki turda tekrar dener */ }
  };

  setInterval(tick, 60000);
}

/* ---------- yenilikler penceresi ----------
   Her güncellemede RELEASES'e yeni bir kayıt eklenir (id bir artar). Kişi o cihazda daha önce görmediği
   kayıtları bir kez görür; "Tamam" ile en son id kaydedilir ve pencere tekrar çıkmaz. */
const RELEASES = [
  {
    id: 28, date: "30 Ekim 2026", title: "Yeni basketbol kuponları", sub: "Bu güncellemede gelenler",
    items: [
      ["🎟️", "Futbolla aynı görünüm", "Basketbol kuponları tema sekmeleri, zaman çizelgesi, canlı skor ve paylaşım düğmeleriyle yenilendi."],
    ],
  },
  {
    id: 27, date: "30 Ekim 2026", title: "Basketbol kupon karnesi", sub: "Bu güncellemede gelenler",
    items: [
      ["🎟️", "Kupon karnesi", "Basketbol karnesinde yeni Kuponlar sekmesi: isabet, kâr/zarar, temalar ve sonuçlanan bütün kuponlar."],
    ],
  },
  {
    id: 26, date: "30 Ekim 2026", title: "Yeni tutarlar", sub: "Bu güncellemede gelenler",
    items: [
      ["💰", "1.000 ₺ ve 5.000 ₺", "Futbol ve basketbolda her tek tercihe 1.000 ₺, her kupona 5.000 ₺ oynanmış gibi hesaplanır; geçmiş sonuçlar da bu tutarlarla güncellendi."],
    ],
  },
  {
    id: 25, date: "30 Ekim 2026", title: "Basketbola maç yorumu", sub: "Bu güncellemede gelenler",
    items: [
      ["🗣️", "Maç yorumu", "Basketbol maç sayfasında form, sakatlıklar, dinlenme ve oranlara göre kısa bir yorum var. Maç başlayınca yorum değişmez."],
    ],
  },
  {
    id: 24, date: "30 Ekim 2026", title: "NBA gece maçları", sub: "Bu güncellemede gelenler",
    items: [
      ["🌙", "Gece maçları aynı günde", "Sabaha karşı oynanan NBA maçları artık bir önceki akşamın listesinde, saatleri kartta yazıyor."],
      ["★", "NBA'de favori yıldızı", "Oranı çıkmamış ya da başlamış NBA maçlarında da favori ve yüzdeler görünür."],
    ],
  },
  {
    id: 23, date: "30 Ekim 2026", title: "Yenilenen maç ekranı", sub: "Bu güncellemede gelenler",
    items: [
      ["⚽", "Futbol ve basketbol aynı düzende", "Üstte Maçlar, Kuponlar, Karne ve Oranlar; altında Dün, Bugün, Yarın ve lig seçimi."],
      ["🃏", "Sade maç kartları", "Kartta skor, kazanma yüzdesi ve en garanti tercih var; ayrıntılar maç sayfasında."],
    ],
  },
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
    id: 5, date: "20 Ekim 2026", title: "Yeni: Takvim", sub: "Bu güncellemede gelenler",
    items: [
      ["📅", "Takvim simgesi", "Tarih çubuğu kalktı; Filtre butonunun yanındaki takvimden gün değiştirebilirsin."],
    ],
  },
  {
    id: 6, date: "21 Ekim 2026", title: "Yeni: Canlı veriler", sub: "Bu güncellemede gelenler",
    items: [
      ["🔴", "Anlık skor ve dakika", "Canlı maçların skoru ve dakikası artık saniyeler içinde geliyor; sayfa açıkken 30 saniyede bir yenilenir."],
      ["⚽", "Gol bildirimi", "Açık sayfada gol olunca anında çan listesine \"GOL!\" bildirimi düşer."],
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
  {
    id: 8, date: "22 Ekim 2026", title: "Yeni: Tüm bahis pazarları", sub: "Bu güncellemede gelenler",
    items: [
      ["💰", "Tek sağlayıcı: Unibet", "Oranlar artık tek bir yerden, Unibet'ten geliyor; büyük maçlarda 100'ü aşkın pazar ve yaklaşık 1000 seçenek."],
      ["🧩", "Kombine bahisler", "MS + KG, KG Var + 2.5 Üst, MS + alt/üst, korner ve kart kombinleri gibi hazır kombineler; model her biri için olasılık hesaplar."],
      ["🏃", "Oyuncu pazarları", "Gol, ilk gol, 2+ gol, kafa golü, asist, gol veya asist, şut, isabetli şut, kart ve faul pazarları."],
      ["📊", "Daha fazla pazar", "Yarılar, handikaplar, korner/kart/şut/ofsayt/faul toplamları, takım bazlı alt/üst ve dakika aralıkları."],
      ["🔍", "Oranlarda arama", "Oranlar sekmesinde oyuncu veya pazar adı yaz, sadece o seçenekler kalsın; gruplar açılıp kapanır."],
      ["🔕", "Sessiz bildirimler", "Bildirimler artık ekranı kaplamaz; yalnızca sarı çana dokununca görünür."],
    ],
  },
  {
    id: 22, date: "30 Ekim 2026", title: "Yeni: Basketbol", sub: "Bu güncellemede gelenler",
    items: [
      ["🏀", "Futbol ve Basketbol", "En üstteki kutucuklardan iki bölüm arasında geçebilirsin. Basketbolda NBA ve EuroLeague var."],
      ["📊", "Maç sayfası", "Sezon karşılaştırması, son maçlar, oyuncu ortalamaları, sakatlıklar, eksikler ve maç istatistiği."],
      ["🏆", "Lig ve takım sayfaları", "Puan durumu, sayı, ribaund ve asist liderleri, takım kadrosu ve fikstür."],
      ["🎯", "En garanti tercih ve kupon", "Takım gücü ve piyasa çizgisiyle tahmin, her maça en garanti tercih, günlük kuponlar ve ayrı basketbol karnesi."],
    ],
  },
  {
    id: 21, date: "28 Ekim 2026", title: "Yeni: Katlama serisi", sub: "Bu güncellemede gelenler",
    items: [
      ["🔁", "Günde tek kupon", "Kombineler'de yeni Katlama sekmesi: her gün oranı 1.90-3.00, tercih başına en az %65 güvenle tek kupon."],
      ["💰", "Para katlanır", "1.000 ₺ ile başlar; kazanınca dönen paranın tamamı ertesi güne yatırılır (1.000 → 2.000 → 4.000). Kaybedince 1.000 ₺ ile yeni seri."],
      ["📒", "Ayrı hesap", "Kasa, toplam, en uzun seri ve geçmiş ayrı tutulur; karnenin kâr/zararına eklenmez, diğer kuponlardan bağımsızdır."],
      ["🏁", "3 günde kâr al", "3 gün üst üste kazanınca seri kapanır: kârın yarısıyla yeni seri başlar, ana para ve kârın diğer yarısı kenara alınır. Kaybedince 1.000 ₺ ile yeniden."],
    ],
  },
  {
    id: 20, date: "28 Ekim 2026", title: "Yeni: Tercih takibi ve haftalık rapor", sub: "Bu güncellemede gelenler",
    items: [
      ["📡", "Canlı tercih takibi", "Canlı sekmesinde garanti, değerli, sürpriz ve skor tahmini ile bu maçın kupon ayaklarının anlık durumu: '1 gol daha lazım', 'tutuyor; 2 korner daha olursa yanar'."],
      ["🏁", "Maç sonu değerlendirmesi", "Biten maçlarda özetin başında hangi tercihin tuttuğu; maç listesinde garanti tercihin yanında ✓/✗."],
      ["🔎", "Neden tutmadı?", "Tutmayan tercihlerde not: şanssız (oyun tercihi destekledi, xG), kıl payı ya da model yanıldı."],
      ["📊", "Haftanın raporu", "Karnede seçili haftanın özeti: isabet, kâr/zarar, en iyi/zayıf tür ve lig, tutmayanların nedeni. Paylaşıma eklenebilir."],
      ["🌍", "Lig dersleri", "Karnede garanti tercihleri belirgin şekilde zayıf giden liglerin tercihleri seçimde biraz geri alınır."],
      ["🧑‍⚖️", "Hakem sayfası", "Hakem adına dokun: kart ve faul eğilimi (lig ortalamasıyla), kırmızı kart, penaltı ve sitede kayıtlı maçları."],
      ["⚡", "Hızlı filtreler", "Maç listesinin üstünde: kesinleşenler, değerli oranlı, canlı, takımlarım, bitenler."],
      ["🧩", "Kupon ilerlemesi", "Kuponda kaç ayağın tuttuğu ince bir çubukta; canlı ayakta '1 gol daha lazım' gibi durum."],
    ],
  },
  {
    id: 19, date: "28 Ekim 2026", title: "Garanti tercihte yeni kural", sub: "Bu güncellemede gelenler",
    items: [
      ["🚫", "Favorinin gol altı yok", "Maçın favorisi olan takımın gol altı (ör. favori Trabzonspor için 'Trabzonspor gol 2.5 Alt') artık garanti tercih ve Banko kuponlarına girmiyor."],
      ["🔽", "Daha seyrek", "Çifte şans 12 ve takım golü altı garanti tercihte daha seyrek seçiliyor."],
    ],
  },
  {
    id: 18, date: "28 Ekim 2026", title: "Kombinelerde yeni düzen", sub: "Bu güncellemede gelenler",
    items: [
      ["✅", "Banko tek tema", "Banko ve En garantiler birleşti: her gün 5 Banko kuponu. Eski En garantiler kuponlarının sonuçları da karnede Banko altında."],
      ["🟨", "Yeni tema: Kartlar", "Yalnızca kart tercihleri (toplam ve takım kart alt/üstleri), toplam oranı en az 2. Yeterli maç olan günlerde 3 kupon."],
    ],
  },
  {
    id: 17, date: "27 Ekim 2026", title: "Yeni: Takım sayfası ve değerli oranlar", sub: "Bu güncellemede gelenler",
    items: [
      ["🏟️", "Takım sayfası", "Maç sayfasında takım adına dokun: son maçlar, güç puanı grafiği, maç başı ortalamalar, sezon sıralamaları, öne çıkan oyuncular ve sıradaki maçlar."],
      ["⚖️", "Takım karşılaştırma", "Takım sayfasından ya da maçın İstatistikler sekmesinden iki takımı hücum, savunma ve oyun tarzında yan yana karşılaştır."],
      ["💎", "Değerli oran", "Oranı 1.60-3.20 arasında, modelin piyasadan belirgin şekilde olası gördüğü ve türü karnede kendini kanıtlamış tercih. Karnede ayrı izlenir."],
      ["🧠", "Karneden öğrenme", "Karnede modelin sandığından zayıf çıkan tercih türleri garanti tercih seçiminde geri alınıyor; karnede hangi türün nasıl gittiği yazıyor."],
      ["⚠️", "Haberlerden dikkat", "Maç özetinin başında takımla ilgili sakatlık, ceza, kadro dışı ya da teknik direktör haberleri (tahmini değiştirmez)."],
      ["🟨", "Kart tahmini", "Az dinlenmeyle (3 gün ve altı) gelen takımların kart beklentisi biraz artırıldı; geçmiş maçlarda isabeti iyileştirdi."],
      ["📤", "Son tercihleri paylaş", "Paylaşım sayfasında tek tuşla bugünün resmi 11 sonrası kesinleşen tercihleri tek mesaj olarak eklenir."],
    ],
  },
  {
    id: 16, date: "27 Ekim 2026", title: "Yeni görünüm", sub: "Bu güncellemede gelenler",
    items: [
      ["🎲", "Skor vitrini", "Maç özetinde skor tahmini iki takımın logosu arasında büyük yazıyor; diğer olası skorlar altında."],
      ["📊", "Model ve piyasa", "1-X-2 çubuğunun altında piyasanın (oranların) olasılıkları; modelle piyasa arasındaki fark tek bakışta görünür."],
      ["✅", "Büyük tercih kartları", "En garanti tercih ve olası sürpriz tam genişlikte, oranları iri; gol bilgileri tek 'Gol beklentisi' kartında."],
      ["🟩", "Maç listesinde durum rengi", "Kartın sol kenarı: yeşil resmi 11 açıklandı, sarı 11'ler bekleniyor, kırmızı canlı, gri bitti."],
      ["🧩", "Kupon zaman çizelgesi", "Kupondaki maçlar saat çizgisi üzerinde; tutan yeşil, tutmayan kırmızı, canlı yanıp söner. Kapalı kartta tutma ihtimali ve durum işareti."],
      ["📈", "Karnede grafikler", "Birikimli kâr/zarar grafiği (üzerine gelince günün değeri) ve tercih türleriyle kupon temalarının isabet halkaları."],
    ],
  },
  {
    id: 15, date: "27 Ekim 2026", title: "Yeni: Son tercih işareti", sub: "Bu güncellemede gelenler",
    items: [
      ["❗", "Değişebilir", "En garanti tercih, resmi ilk 11'ler açıklanana kadar yeni bilgilerle (oran, eksik, kadro) değişebilir; bu sürede kutuda ünlem ve 'Değişebilir' yazar."],
      ["✅", "Son tercih", "Resmi 11'ler açıklanınca model son bir kontrol yapar ve tercihini kilitler; kutuda tik ve 'Son tercih' yazar, maç başlayana kadar değişmez."],
      ["🧩", "Kombineler de", "Kuponlar, içlerindeki maçlardan ilkinin resmi 11'i açıklanınca son kontrolle kilitlenir; öncesinde 'Değişebilir', sonrasında 'Son hali' yazar."],
    ],
  },
  {
    id: 14, date: "27 Ekim 2026", title: "Yeni: Maça özel yorumlar ve skor tahmini", sub: "Bu güncellemede gelenler",
    items: [
      ["🎯", "Daha tutarlı skor tahmini", "Skor, iki takımın beklenen gollerinden (güç puanı, rakibe göre xG, yenen goller, oranlar) kuruluyor ve alt/üst olasılıklarıyla çelişmiyor; maç özetinde skorun dayanağı yazıyor."],
      ["🗣️", "Yeni maç yorumları", "Her maçın yorumu artık kendine özgü: güç dengesi, formun gerçek mi şans mı olduğu (gol ve xG karşılaştırması), hücum-savunma eşleşmesi, as kadrodan eksikler, maçın temposu ve skorun gerekçesi."],
      ["🧹", "Asistan kaldırıldı", "Sohbet asistanı kaldırıldı; aynı bilgiler maç sayfalarında ve yorumlarda."],
    ],
  },
  {
    id: 13, date: "27 Ekim 2026", title: "Yeni: Takım gücü puanı ve kapanış oranı takibi", sub: "Bu güncellemede gelenler",
    items: [
      ["🏆", "Takım gücü puanı (Elo)", "Model artık takımların son iki sezon ve bu sezondaki bütün sonuçlarından (Avrupa kupaları dahil) çıkan güç puanını da kullanıyor; maç sonucu tahminleri belirgin şekilde iyileşti."],
      ["📉", "Kapanış oranı farkı", "Karnede yeni ölçü: tercihlerimizin oranı maç başlayana kadar düştü mü? Artıda olması modelin doğru tarafı bulduğunu gösterir."],
      ["🎯", "Kendini düzelten model", "Bir tercih türü karnede sürekli beklenenden az ya da çok tutarsa model o türün olasılıklarını kendiliğinden düzeltir."],
    ],
  },
  {
    id: 12, date: "27 Ekim 2026", title: "Yeni: Haber filtresi ve daha isabetli model", sub: "Bu güncellemede gelenler",
    items: [
      ["📰", "Haber filtresi", "Haberler sekmesinde konu seçimi: Kadro & sakatlık, Maç önü, Transfer, Diğer. Alakasız, tekrar eden, canlı skor ve magazin haberleri otomatik ayıklanıyor."],
      ["📦", "Sabit kutular", "Maç kartındaki korner kutusu her maçta 8.5 Üst, kart kutusu 3.5 Üst olasılığını gösteriyor (oranıyla); tercihleri etkilemez."],
      ["🧠", "Model güncellemesi", "761 maçlık testle ayarlandı: maç sonucunda piyasa payı %90, gollerde %60; rakip gücüne göre xG düzeltmesi; korner ve kartta son 10 maç."],
    ],
  },
  {
    id: 11, date: "26 Ekim 2026", title: "Yeni: Puan durumu, oran hareketleri ve daha fazlası", sub: "Bu güncellemede gelenler",
    items: [
      ["📈", "Oran hareketleri", "Sağ üstteki zil yerine yeni simge: açılıştan bu yana en çok düşen ve yükselen oranlar; güne ve pazara göre filtre."],
      ["🏆", "Puan durumu", "Lig adına dokun: puan tablosu (Avrupa/düşme renkleri, son 5 maç puanı), gol ve asist krallığı."],
      ["⭐", "Takımlarım", "Takım adının yanındaki ☆ ile takımını ekle; maçları ana sayfada en üstte."],
      ["🔍", "Takım arama", "Araç çubuğundaki büyüteçle takım ara; dün, bugün ve yarının maçları."],
      ["🟨", "Hakem istatistikleri", "Maç özetinde hakemin maç başı kart, penaltı ve faul ortalaması (lig ortalamasıyla)."],
      ["⚠️", "İlk 11 uyarısı", "Resmi 11'de sezonun en etkili oyuncuları yoksa uyarı."],
      ["📒", "Karne ekleri", "Haftalık özet, lige göre performans, modelin olasılık-isabet uyumu ve en çok kazandıran kupon teması."],
    ],
  },
  {
    id: 10, date: "25 Ekim 2026", title: "Yeni: Temalı kombineler", sub: "Bu güncellemede gelenler",
    items: [
      ["🧩", "Beş tema, günde 15 kupon", "Günün kombinelerinde sekmeler: Banko, En garantiler, Gol şöleni, Kornerler, Değerli oranlar; her temada her gün 3 kupon (2-5 maç)."],
      ["🎚️", "Sabit oran aralıkları", "Banko ve En garantiler 2-3.5, Gol şöleni ve Kornerler 2.5-6, Değerli oranlar 3-6 (tercih başına en az %58, kupon en az %25) toplam oran."],
      ["🔁", "Daha çeşitli kuponlar", "Aynı tercih günün en fazla iki kuponunda kullanılır."],
      ["💰", "Yeni tutarlar", "Karnede her tek tercihe 250 ₺, her kombineye 1.000 ₺; geçmiş sonuçlar da bu tutarlarla yeniden hesaplandı."],
    ],
  },
  {
    id: 9, date: "22 Ekim 2026", title: "Yeni: Günün kombineleri ve yeni karne", sub: "Bu güncellemede gelenler",
    items: [
      ["🧩", "Günün kombineleri", "Ana sayfadaki yeni kutu: model her gün 3-5 kupon hazırlar (Banko, En garantiler, Günün favorileri, Gol şöleni, Korner kombinesi, Değerli oranlar); her kupon 2-5 maç."],
      ["🧠", "Daha geniş tercih yelpazesi", "Model artık takım golleri, toplam korner, beraberlikte iade ve kombine pazarları da değerlendiriyor; tercih başına risk düşük tutuluyor."],
      ["🎯", "Daha iyi skor tahminleri", "Skor tahmini istatistiklerle birlikte piyasanın skor oranlarını da hesaba katıyor."],
      ["📒", "Karne sıfırlandı", "Yeni modelle karne 22 Ekim'den başlıyor; üç ayrı başlık: Tek tercihler (250 ₺), Kombineler (1.000 ₺), Skorlar (isabet)."],
      ["📅", "Kâr/zarar takvimi", "Karnenin altında aylık takvim: her gün toplam kâr yeşil, zarar kırmızı (+100, −50 gibi)."],
    ],
  },
];
function showWhatsNew() {
  const seen = +(safeGet("seenRelease") || 0);
  // sıralı ve en büyük id ile: dizideki sıra karışsa da bir kez görülen not tekrar çıkmasın
  const fresh = RELEASES.filter((r) => r.id > seen).sort((a, b) => a.id - b.id);
  if (!fresh.length) return;
  const maxId = Math.max(...RELEASES.map((r) => r.id));
  safeSet("seenRelease", String(maxId));  // gösterildiği an görüldü sayılır (Tamam'a basılmadan kapansa da)
  const latest = fresh[fresh.length - 1];
  $("#wnTitle").textContent = fresh.length === 1 ? latest.title : "Yenilikler";
  $("#wnSub").textContent = fresh.length === 1 ? `${latest.sub} · ${latest.date}` : `${fresh.length} güncelleme`;
  $("#wnList").innerHTML = fresh.slice().reverse().flatMap((r) => r.items).map(([ic, t, d]) =>
    `<div class="wn-item"><span class="wn-ii">${ic}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></div>`).join("");
  $("#newsModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("#wnOk").focus();
  $("#wnOk").onclick = () => {
    $("#newsModal").classList.add("hidden");
    document.body.classList.remove("modal-open");
  };
}

let ready = false;
async function boot() {
  // açılışta şifre çözme ve ilk veriler gelene kadar boş ekran yerine sayfanın taslağı
  if (!STATIC || safeGet("siteKey")) {
    const h = location.hash;
    $("#view").innerHTML = skel(h.startsWith("#/mac") || h.startsWith("#/oyuncu") ? "page" : h.length > 2 ? "list" : "cards");
  }
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

renderDays();
// bildirim zili kaldırıldı (yerine oran hareketleri); olay akışı arka planda tutulur
updateShareCount();
window.addEventListener("hashchange", () => { if (ready) route(); });
// liste görünümünü 60 sn'de bir sessizce tazele (canlı skorlar için)
if (!STATIC) setInterval(() => { if (ready && !state.current) renderDay(true); }, 60000);

boot();
