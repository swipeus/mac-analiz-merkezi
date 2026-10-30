"use strict";
/* Basketbol bölümü: NBA, EuroLeague, Türkiye Basketbol Süper Ligi. Veriler bk-*.json dosyalarından gelir (build_static).
   Sayfalar: #/basket (maçlar), #/basket/mac/<id>, #/basket/lig/<lig>, #/basket/takim/<lig>/<id> */

const BK = { day: null, tab: "ozet", lg: "all" };
const BK_LG = { nba: "NBA", el: "EuroLeague", bsl: "Türkiye Basketbol Süper Ligi" };
const BK_LOGO = { nba: "🏀", el: "🇪🇺", bsl: "🇹🇷" };

async function bkGet(name, missing) {
  if (!STATIC) throw new Error("Basketbol bölümü yalnızca yayındaki sitede çalışır.");
  try { return await getData(name); }
  catch (e) { if (e.message === "NOTFOUND") throw new Error(missing); throw e; }
}
const bkNum = (x, d = 1) => x == null ? "—" : nf(x, d);
const bkCrest = (t, size = 56) => {
  const ini = (t.short || t.name || "?").split(" ").map((w) => w[0]).join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3);
  return `<div class="crest" style="width:${size}px;height:${size}px">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px"
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fb',textContent:'${esc(ini)}'}))">` : `<span class="fb">${esc(ini)}</span>`}</div>`;
};
const bkTeamLink = (lg, t, txt) => `<a href="#/basket/takim/${lg}/${encodeURIComponent(t.id)}">${esc(txt || t.short || t.name)}</a>`;
const bkDots = (s) => [...(s || "")].map((c) => `<span class="bkf ${c === "G" ? "w" : "l"}">${c}</span>`).join("");

/* ---------- maç listesi ---------- */
function bkCard(m) {
  const live = m.state === "live", done = m.state === "post";
  const top = live ? `<span class="badge-live">CANLI ${esc(m.clock || "")}</span>` : done ? `<span class="when">Maç sonu</span>` : `<span></span>`;
  const mid = live || done
    ? `<div class="sc">${m.home.score ?? 0} - ${m.away.score ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`
    : `<div class="ko">${esc(timeOf(m.utc))}</div><div class="sub">başlama</div>`;
  const quarters = m.q && m.q[0] && m.q[0].length ? `<div class="bkq">${m.q[0].map((x, i) => `<span>${x ?? "–"}-${(m.q[1] || [])[i] ?? "–"}</span>`).join("")}</div>` : "";
  const tm = (t) => `<div class="tm">${bkCrest(t)}<div class="nm">${esc(t.short)}</div>${t.rec ? `<small class="muted">${esc(t.rec)}</small>` : ""}</div>`;
  return `<div class="mcard ${live ? "is-live" : ""} st-${live ? "live" : done ? "done" : "open"}" data-bk="${esc(m.id)}">
    <div class="mtop">${top}<div class="mtags">${m.round ? `<span class="tag">${esc(typeof m.round === "number" ? m.round + ". hafta" : m.round)}</span>` : ""}</div></div>
    <div class="mteams">${tm(m.home)}<div class="mid">${mid}</div>${tm(m.away)}</div>${quarters}
  </div>`;
}
async function renderBasketHome() {
  const v = $("#view");
  if (!BK.day) BK.day = todayStr();
  const base = todayStr(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
  const days = [[shift(-1), "Dün"], [base, "Bugün"], [shift(1), "Yarın"]];
  if (!days.some(([d]) => d === BK.day)) BK.day = base;
  const bar = `<div class="ptabs">${days.map(([d, l]) => `<button class="ptab ${d === BK.day ? "on" : ""}" data-bkd="${d}">${l}</button>`).join("")}</div>`;
  v.innerHTML = bar + skel("cards");
  let D;
  try { D = await bkGet(`bk-day-${BK.day}.json`, "Basketbol verileri bir sonraki güncellemede gelecek, birkaç dakika sonra tekrar bak."); }
  catch (e) { v.innerHTML = bar + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; bkBindDays(); return; }
  if (!location.hash.startsWith("#/basket") || location.hash.length > 9) return;
  const present = Object.keys(BK_LG).filter((k) => D.matches.some((m) => m.lg === k));
  const lgBar = present.length > 1 ? `<div class="chiprow quickbar"><button class="chipbtn ${BK.lg === "all" ? "on" : ""}" data-bkl="all">Tümü <small>${D.matches.length}</small></button>${present.map((k) =>
    `<button class="chipbtn ${BK.lg === k ? "on" : ""}" data-bkl="${k}">${BK_LOGO[k]} ${k === "bsl" ? "Türkiye" : BK_LG[k]} <small>${D.matches.filter((m) => m.lg === k).length}</small></button>`).join("")}</div>` : "";
  const shown = Object.keys(BK_LG).filter((k) => (BK.lg === "all" || BK.lg === k));
  const sections = shown.map((k) => {
    const list = D.matches.filter((m) => m.lg === k);
    return list.length ? `<section class="lg-block"><a class="lg-title" href="#/basket/lig/${k}"><span class="sorticon">${BK_LOGO[k]}</span><b>${BK_LG[k]}</b><span>${list.length} maç</span></a>
      <div class="mgrid">${list.map(bkCard).join("")}</div></section>` : "";
  }).join("");
  const leagues = `<div class="bkleagues">${Object.keys(BK_LG).map((k) => `<a class="bklg" href="#/basket/lig/${k}">${BK_LOGO[k]} ${BK_LG[k]} <small>puan durumu</small></a>`).join("")}</div>`;
  v.innerHTML = bar + lgBar + (sections || `<div class="card"><p class="muted">Bu tarihte maç yok.</p></div>`) + leagues;
  bkBindDays();
  v.querySelectorAll("[data-bkl]").forEach((b) => b.onclick = () => { BK.lg = b.dataset.bkl; renderBasketHome(); });
  v.querySelectorAll("[data-bk]").forEach((c) => c.onclick = () => location.hash = "#/basket/mac/" + c.dataset.bk);
}
function bkBindDays() {
  $("#view").querySelectorAll("[data-bkd]").forEach((b) => b.onclick = () => { BK.day = b.dataset.bkd; renderBasketHome(); });
}

/* ---------- maç sayfası ---------- */
const bkRec = (r) => r ? `${r.w}-${r.l}` : "—";
function bkCompare(b) {
  const H = b.home, A = b.away, x = H.rec, y = A.rec;
  if (!x && !y) return `<div class="card"><p class="muted">Bu sezon henüz oynanmış maçları yok.</p></div>`;
  const hi = (u, w, less) => u == null || w == null || u === w ? ["", ""] : (less ? u < w : u > w) ? ["better", ""] : ["", "better"];
  const row = (l, u, w, fmt, less) => {
    const [p, q] = hi(u, w, less);
    return `<tr><td class="${p}">${fmt(u)}</td><td>${l}</td><td class="${q}">${fmt(w)}</td></tr>`;
  };
  const n1 = (z) => bkNum(z), sg = (z) => z == null ? "—" : (z > 0 ? "+" : "") + nf(z, 1), plain = (z) => z ?? "—";
  const pct = (r) => r && r.gp ? r.w / r.gp : null;
  return `<div class="card" style="--c:#58a6ff">${head("📊", "Sezon karşılaştırması")}
    <div class="tbl-wrap"><table class="cmp"><thead><tr><th>${esc(H.short)}</th><th></th><th>${esc(A.short)}</th></tr></thead><tbody>
      <tr><td>${bkRec(x)}</td><td>Galibiyet-mağlubiyet</td><td>${bkRec(y)}</td></tr>
      <tr><td>${x ? `${x.hw}-${x.hl}` : "—"}</td><td>İç saha (ev sahibi) / deplasman (konuk)</td><td>${y ? `${y.aw}-${y.al}` : "—"}</td></tr>
      ${row("Maç başı sayı", x && x.ppg, y && y.ppg, n1)}
      ${row("Maç başı yenilen sayı", x && x.opp, y && y.opp, n1, true)}
      ${row("Averaj (maç başı)", x && x.diff, y && y.diff, sg)}
      ${row("Son 5 maç sayı", x && x.l5ppg, y && y.l5ppg, n1)}
      ${row("Son 5 maç yenilen", x && x.l5opp, y && y.l5opp, n1, true)}
      <tr><td>${bkDots(x && x.l5)}</td><td>Son maçlar</td><td>${bkDots(y && y.l5)}</td></tr>
      ${row("Dinlenme (gün)", H.rest, A.rest, plain)}
    </tbody></table></div></div>`;
}
function bkLog(t, lg) {
  if (!t.log.length) return "";
  return `<div class="card">${head("📅", `${esc(t.short)} · son maçlar`)}${t.log.map((g) => `<div class="bkrow"><span class="muted">${dateOf(g.utc)}</span>
    <span>${g.home ? "" : "@ "}${bkTeamLink(lg, { id: g.opp_id, short: g.opp })}</span><b class="${g.win ? "pos" : "neg"}">${g.win ? "G" : "M"} ${g.pf}-${g.pa}</b></div>`).join("")}</div>`;
}
function bkInjury(b, sd) {
  const t = b[sd], inj = b.injuries[sd] || [], abs = b.absent[sd] || [], news = (b.news || {})[sd] || [];
  const rows = inj.map((i) => `<div class="bkrow"><span>${esc(i.name)}</span><span class="muted">${esc(i.part || "")}${i.ret ? ` · dönüş ${dateOf(i.ret)}` : ""}</span><b class="${i.out ? "neg" : ""}">${esc(i.status || "")}</b></div>`).join("");
  const miss = abs.length ? `<p class="muted bksub">Son maçta oynamadı</p>${abs.map((p) => `<div class="bkrow"><span>${esc(p.name)}</span><span class="muted">${nf(p.pts, 1)} sayı · ${nf(p.min, 0)} dk ortalama</span></div>`).join("")}` : "";
  const nw = news.length ? `<p class="muted bksub">Sakatlık haberleri</p>${news.map((n) => `<a class="bknews" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)} <small class="muted">${esc(n.source)} · ${ago(n.time)}</small></a>`).join("")}` : "";
  const empty = b.lg === "nba" ? "Bildirilmiş sakatlık yok." : "Bu lig için resmi sakatlık listesi yok; son maçtaki eksikler ve haberler gösterilir. Şu an kayıtlı bilgi yok.";
  return `<div class="card">${head("🩹", `${esc(t.short)} · eksikler`)}${rows + miss + nw || `<p class="muted">${empty}</p>`}</div>`;
}
const bkPlayers = (rows, lg, title) => rows.length ? `<div class="card">${head("👤", title)}<div class="tbl-wrap"><table><thead><tr><th class="l">Oyuncu</th><th>M</th><th>Dk</th><th>Sayı</th><th>Rib</th><th>Ast</th><th>Top Ç.</th><th>Blok</th></tr></thead><tbody>
  ${rows.map((p) => `<tr><td class="l">${esc(p.name)}</td><td>${p.gp ?? "—"}</td><td>${bkNum(p.min)}</td><td><b>${bkNum(p.pts)}</b></td><td>${bkNum(p.reb)}</td><td>${bkNum(p.ast)}</td><td>${bkNum(p.stl)}</td><td>${bkNum(p.blk)}</td></tr>`).join("")}
  </tbody></table></div></div>` : `<div class="card"><p class="muted">${esc(title)}: oyuncu istatistiği henüz yok.</p></div>`;
const bkBox = (rows, title) => `<div class="card">${head("📋", title)}<div class="tbl-wrap"><table><thead><tr><th class="l">Oyuncu</th><th>Dk</th><th>Sayı</th><th>Rib</th><th>Ast</th><th>Saha</th><th>3 Sayı</th><th>Faul</th></tr></thead><tbody>
  ${rows.filter((p) => p.min > 0).sort((a, b) => b.pts - a.pts).map((p) => `<tr><td class="l">${p.start ? "▪ " : ""}${esc(p.name)}</td><td>${nf(p.min, 0)}</td><td><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td><td>${esc(p.fg || "")}</td><td>${esc(p.tp || "")}</td><td>${p.pf}</td></tr>`).join("")}
  </tbody></table></div></div>`;
function bkTabs(b) {
  const hasBox = b.box.home.length || b.box.away.length;
  const tabs = [["ozet", "📊 Özet"], ["oyuncu", "👥 Oyuncular"], ...(hasBox ? [["kutu", "📋 Maç istatistiği"]] : [])];
  if (!tabs.some(([k]) => k === BK.tab)) BK.tab = "ozet";
  return `<div class="ptabs mtabs">${tabs.map(([k, l]) => `<button class="ptab ${BK.tab === k ? "on" : ""}" data-bkt="${k}">${l}</button>`).join("")}</div>`;
}
function bkBody(b) {
  const H = b.home, A = b.away;
  if (BK.tab === "oyuncu") return `<div class="grid2">${bkPlayers(b.players.home, b.lg, `${H.short} · sezon ortalamaları`)}${bkPlayers(b.players.away, b.lg, `${A.short} · sezon ortalamaları`)}</div>`;
  if (BK.tab === "kutu") return `<div class="grid2">${bkBox(b.box.home, H.short)}${bkBox(b.box.away, A.short)}</div>`;
  const h2h = b.h2h.length ? `<div class="card">${head("🤝", "Aralarındaki maçlar (bu sezon)")}${b.h2h.map((x) => `<div class="bkrow"><span class="muted">${dateOf(x.utc)}</span><span>${esc(x.home)} <b>${x.hs}-${x.as}</b> ${esc(x.away)}</span></div>`).join("")}</div>` : "";
  return `${bkCompare(b)}<div class="grid2">${bkInjury(b, "home")}${bkInjury(b, "away")}</div>${h2h}<div class="grid2">${bkLog(H, b.lg)}${bkLog(A, b.lg)}</div>`;
}
async function renderBasketMatch(id) {
  const v = $("#view");
  v.innerHTML = skel("page");
  let b;
  try { b = await bkGet(`bk-match-${id}.json`, "Bu maçın sayfası henüz hazırlanmadı. Site dünün, bugünün ve yarının maçlarını gösterir."); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  if (location.hash !== "#/basket/mac/" + id) return;
  const live = b.state === "live", done = b.state === "post";
  const q = b.q && b.q[0] && b.q[0].length ? `<div class="bkq big">${b.q[0].map((x, i) => `<span><small>${i < 4 ? i + 1 + ". Ç" : "UZ"}</small>${x ?? "–"}-${(b.q[1] || [])[i] ?? "–"}</span>`).join("")}</div>` : "";
  const hero = `<div class="hero"><div class="hero-league"><a href="#/basket/lig/${b.lg}">${BK_LOGO[b.lg]} ${esc(b.lg_name)}</a>${b.round ? ` · ${esc(typeof b.round === "number" ? b.round + ". hafta" : b.round)}` : ""}</div>
    <div class="teams"><a class="team" href="#/basket/takim/${b.lg}/${encodeURIComponent(b.home.id)}">${bkCrest(b.home, 78)}${esc(b.home.short)}</a>
      <div class="score ${live ? "live" : ""}">${live || done ? `${b.home.score ?? 0} - ${b.away.score ?? 0}<small>${esc(live ? (b.clock || "Canlı") : "Maç sonu")}</small>` : `${esc(timeOf(b.utc))}<small>${esc(dateOf(b.utc))}</small>`}</div>
      <a class="team" href="#/basket/takim/${b.lg}/${encodeURIComponent(b.away.id)}">${bkCrest(b.away, 78)}${esc(b.away.short)}</a></div>${q}
    <div class="meta">${b.venue ? `<span>📍 ${esc(b.venue)}</span>` : ""}${b.refs && b.refs.length ? `<span>${WHISTLE} ${esc(b.refs.join(", "))}</span>` : ""}</div></div>`;
  const draw = () => {
    v.innerHTML = hero + bkTabs(b) + `<div class="mtab-body">${bkBody(b)}</div>`;
    v.querySelectorAll("[data-bkt]").forEach((x) => x.onclick = () => { BK.tab = x.dataset.bkt; draw(); });
  };
  draw();
}

/* ---------- lig sayfası ---------- */
async function renderBasketLeague(lg) {
  const v = $("#view");
  v.innerHTML = skel("list");
  let L;
  try { L = await bkGet(`bk-league-${lg}.json`, "Bu ligin sayfası henüz hazırlanmadı, birkaç dakika sonra tekrar bak."); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  const sg = (z) => (z > 0 ? "+" : "") + nf(z, 1);
  const table = L.table.map((g) => `<div class="card">${head(BK_LOGO[lg], `${esc(L.name)}${g.group ? ` · ${esc(g.group)}` : ""}`)}<div class="tbl-wrap"><table class="bktable"><thead><tr><th>#</th><th class="l">Takım</th><th>O</th><th>G</th><th>M</th><th>Sayı</th><th>Yenilen</th><th>Averaj</th><th>Son 5</th></tr></thead><tbody>
    ${g.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="l"><span class="bktm">${r.logo ? `<img src="${esc(r.logo)}" alt="" loading="lazy">` : ""}${bkTeamLink(lg, r)}</span></td><td>${r.gp}</td><td><b>${r.w}</b></td><td>${r.l}</td><td>${nf(r.ppg, 1)}</td><td>${nf(r.opp, 1)}</td><td class="${r.diff >= 0 ? "pos" : "neg"}">${sg(r.diff)}</td><td class="bkl5">${bkDots(r.l5)}</td></tr>`).join("")}
    </tbody></table></div></div>`).join("");
  const lead = (k, l) => L.leaders[k] && L.leaders[k].length ? `<div class="card">${head("🏆", l)}${L.leaders[k].slice(0, 5).map((p, i) => `<div class="bkrow"><span class="muted">${i + 1}</span><span>${esc(p.name)} <small class="muted">${bkTeamLink(lg, { id: p.team_id, short: p.team })}</small></span><b>${nf(p[k], 1)}</b></div>`).join("")}</div>` : "";
  v.innerHTML = table + `<div class="grid3">${lead("pts", "Sayı ortalaması")}${lead("reb", "Ribaund ortalaması")}${lead("ast", "Asist ortalaması")}</div>`;
}

/* ---------- takım sayfası ---------- */
async function renderBasketTeam(lg, id) {
  const v = $("#view");
  v.innerHTML = skel("page");
  let T;
  try { T = await bkGet(`bk-team-${lg}-${id}.json`, "Bu takımın sayfası henüz hazırlanmadı, birkaç dakika sonra tekrar bak."); }
  catch (e) { v.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  const s = T.stats;
  const hero = `<div class="hero"><div class="hero-league"><a href="#/basket/lig/${lg}">${BK_LOGO[lg]} ${esc(T.lg_name)}</a></div>
    <div class="bkthead">${bkCrest(T, 78)}<h2>${esc(T.name)}</h2><p class="muted">${bkRec(s)} · sayı ${nf(s.ppg, 1)} · yenilen ${nf(s.opp, 1)}</p><div>${bkDots(s.l5)}</div></div></div>`;
  const next = T.next.length ? `<div class="card">${head("🗓️", "Sıradaki maçlar")}${T.next.map((m) => `<div class="bkrow"><span class="muted">${dateOf(m.utc)} ${timeOf(m.utc)}</span><span>${esc(m.home.short)} - ${esc(m.away.short)}</span></div>`).join("")}</div>` : "";
  const inj = T.injuries.length ? `<div class="card">${head("🩹", "Sakatlıklar")}${T.injuries.map((i) => `<div class="bkrow"><span>${esc(i.name)}</span><span class="muted">${esc(i.part || "")}</span><b class="${i.out ? "neg" : ""}">${esc(i.status || "")}</b></div>`).join("")}</div>` : "";
  const abs = T.absent.length ? `<div class="card">${head("🩹", "Son maçta oynamadı")}${T.absent.map((p) => `<div class="bkrow"><span>${esc(p.name)}</span><span class="muted">${nf(p.pts, 1)} sayı · ${nf(p.min, 0)} dk ortalama</span></div>`).join("")}</div>` : "";
  v.innerHTML = hero + next + inj + abs + bkPlayers(T.roster, lg, "Kadro · sezon ortalamaları") + bkLog({ short: "Sezon", log: T.log }, lg);
}

/* ---------- yönlendirme (app.js route çağırır) ---------- */
function renderBasket() {
  const h = location.hash;
  let m;
  window.scrollTo(0, 0);
  if ((m = h.match(/^#\/basket\/mac\/([\w-]+)/))) { BK.tab = "ozet"; return renderBasketMatch(m[1]); }
  if ((m = h.match(/^#\/basket\/lig\/(\w+)/))) return renderBasketLeague(m[1]);
  if ((m = h.match(/^#\/basket\/takim\/(\w+)\/([^/]+)/))) return renderBasketTeam(m[1], decodeURIComponent(m[2]));
  return renderBasketHome();
}
