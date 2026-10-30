"use strict";
/* Basketbol bölümü: NBA ve EuroLeague. Veriler bk-*.json dosyalarından gelir (build_static).
   Sayfalar: #/basket (maçlar), #/basket/mac/<id>, #/basket/lig/<lig>, #/basket/takim/<lig>/<id> */

const BK = { day: null, tab: "ozet", lg: "all", cday: null, ktab: "tercih", ctheme: "banko" };
const BK_LG = { nba: "NBA", el: "EuroLeague" };
const BK_LOGO = { nba: "🏀", el: "🇪🇺" };

async function bkGet(name, missing) {
  if (!STATIC) throw new Error("Basketbol bölümü yalnızca yayındaki sitede çalışır.");
  try { return await getData(name); }
  catch (e) { if (e.message === "NOTFOUND") throw new Error(missing); throw e; }
}
// sabaha karşı oynanan NBA maçları önceki akşamın listesinde: gün sabah 08.00'de değişir
const bkToday = () => new Date(Date.now() - 8 * 3600e3).toLocaleDateString("sv-SE", { timeZone: TZ });
const bkNum = (x, d = 1) => x == null ? "—" : nf(x, d);
// favori takımın logosunun üstünde yıldız
const bkCrest = (t, size = 56, isFav, pct) => {
  const ini = (t.short || t.name || "?").split(" ").map((w) => w[0]).join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3);
  return `<div class="crest ${isFav ? "fav" : ""}" style="width:${size}px;height:${size}px">
    ${isFav ? `<span class="star" title="Favori · kazanma olasılığı ${pc(pct)}">★</span>` : ""}
    ${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px"
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fb',textContent:'${esc(ini)}'}))">` : `<span class="fb">${esc(ini)}</span>`}</div>`;
};
const bkFav = (p) => {
  if (!p || p.p_home == null) return null;
  const h = Math.round(p.p_home * 100), a = Math.round(p.p_away * 100);
  return h === a ? null : h > a ? "home" : "away";
};
const bkTeamLink = (lg, t, txt) => `<a href="#/basket/takim/${lg}/${encodeURIComponent(t.id)}">${esc(txt || t.short || t.name)}</a>`;
const bkDots = (s) => [...(s || "")].map((c) => `<span class="bkf ${c === "G" ? "w" : "l"}">${c}</span>`).join("");

const bkNav = (on) => `<div class="bknav">${[["mac", "#/basket", "🏀 Maçlar"], ["kupon", "#/basket/kupon", "🎟️ Kuponlar"], ["karne", "#/basket/karne", "📒 Karne"]].map(([k, h, l]) =>
  `<a class="${k === on ? "on" : ""}" href="${h}">${l}</a>`).join("")}</div>`;

/* ---------- maç listesi ---------- */
function bkCard(m) {
  const live = m.state === "live", done = m.state === "post";
  const top = live ? `<span class="badge-live">CANLI ${esc(m.clock || "")}</span>` : done ? `<span class="when">Maç sonu</span>` : `<span></span>`;
  const mid = live || done
    ? `<div class="sc">${m.home.score ?? 0} - ${m.away.score ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`
    : `<div class="ko">${esc(timeOf(m.utc))}</div><div class="sub">başlama</div>`;
  const quarters = m.q && m.q[0] && m.q[0].length ? `<div class="bkq">${m.q[0].map((x, i) => `<span>${x ?? "–"}-${(m.q[1] || [])[i] ?? "–"}</span>`).join("")}</div>` : "";
  const p = m.pred, fav = bkFav(p);
  const tm = (t, sd) => `<div class="tm">${bkCrest(t, 56, fav === sd, p && p["p_" + sd])}<div class="nm">${esc(t.short)}</div>${t.rec ? `<small class="muted">${esc(t.rec)}</small>` : ""}</div>`;
  const bar = p && p.p_home != null ? `<div class="probs"><span class="ph">${pc(p.p_home)}</span><div class="probbar"><span style="width:${p.p_home * 100}%"></span><span style="width:0"></span><span style="width:${p.p_away * 100}%"></span></div><span class="pa">${pc(p.p_away)}</span></div>` : "";
  const safe = p && p.safe ? `<div class="bksafe ${p.hit === true ? "won" : p.hit === false ? "lost" : ""}"><span>${p.hit === true ? "✓" : p.hit === false ? "✗" : "✅"} ${esc(p.safe.label)}</span><b>${pc(p.safe.p)} · ${nf(p.safe.odds, 2)}</b></div>` : "";
  return `<div class="mcard ${live ? "is-live" : ""} st-${live ? "live" : done ? "done" : "open"}" data-bk="${esc(m.id)}">
    <div class="mtop">${top}<div class="mtags">${m.round ? `<span class="tag">${esc(typeof m.round === "number" ? m.round + ". hafta" : m.round)}</span>` : ""}</div></div>
    <div class="mteams">${tm(m.home, "home")}<div class="mid">${mid}</div>${tm(m.away, "away")}</div>${quarters}${bar}${safe}
  </div>`;
}
async function renderBasketHome() {
  const v = $("#view");
  if (!BK.day) BK.day = bkToday();
  const base = bkToday(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
  const days = [[shift(-1), "Dün"], [base, "Bugün"], [shift(1), "Yarın"]];
  if (!days.some(([d]) => d === BK.day)) BK.day = base;
  const bar = bkNav("mac") + `<div class="ptabs">${days.map(([d, l]) => `<button class="ptab ${d === BK.day ? "on" : ""}" data-bkd="${d}">${l}</button>`).join("")}</div>`;
  v.innerHTML = bar + skel("cards");
  let D;
  try { D = await bkGet(`bk-day-${BK.day}.json`, "Basketbol verileri bir sonraki güncellemede gelecek, birkaç dakika sonra tekrar bak."); }
  catch (e) { v.innerHTML = bar + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; bkBindDays(); return; }
  if (location.hash !== "#/basket") return;
  const present = Object.keys(BK_LG).filter((k) => D.matches.some((m) => m.lg === k));
  const lgBar = present.length > 1 ? `<div class="chiprow quickbar"><button class="chipbtn ${BK.lg === "all" ? "on" : ""}" data-bkl="all">Tümü <small>${D.matches.length}</small></button>${present.map((k) =>
    `<button class="chipbtn ${BK.lg === k ? "on" : ""}" data-bkl="${k}">${BK_LOGO[k]} ${BK_LG[k]} <small>${D.matches.filter((m) => m.lg === k).length}</small></button>`).join("")}</div>` : "";
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
function bkPredict(b) {
  const P = b.pred, R = b.rec, pick = (R && R.pick) || null, H = b.home.short, A = b.away.short;
  const ph = P ? P.p_home : R && R.p_home;
  if (ph == null) return "";
  const pa = 1 - ph;
  const bars = `<div class="bigbar"><div style="flex:${ph};background:var(--home)">${esc(H)} ${pc(ph)}</div><div style="flex:${pa};background:var(--away)">${pc(pa)} ${esc(A)}</div></div>`;
  const started = b.state !== "pre";
  const badge = R && R.state === "done" ? (R.hit === true ? `<span class="bkbdg ok">✓ Tuttu</span>` : R.hit === false ? `<span class="bkbdg no">✗ Tutmadı</span>` : `<span class="bkbdg">İade</span>`)
    : started ? `<span class="bkbdg ok">✓ Son tercih</span>` : `<span class="bkbdg warn">! Değişebilir</span>`;
  const safe = pick ? `<div class="bkpick"><div><small>En garanti tercih</small><b>${esc(pick.label)}</b></div><div class="bkpv"><b>${pc(pick.p)}</b><small>oran ${nf(pick.odds, 2)}</small></div>${badge}</div>`
    : `<p class="muted">Bu maç için oran bülteninde uygun seçenek yok; tahmin yalnızca takım gücünden hesaplandı.</p>`;
  const score = P && P.total ? `<div class="bkexp"><div><small>Beklenen skor</small><b>${Math.round((P.total + P.margin) / 2)} - ${Math.round((P.total - P.margin) / 2)}</b></div>
    <div><small>Beklenen toplam</small><b>${nf(P.total, 1)}</b></div>${P.mkt_margin != null ? `<div><small>Piyasa farkı</small><b>${P.mkt_margin > 0 ? "+" : ""}${nf(P.mkt_margin, 1)}</b></div>` : ""}${P.model_margin != null ? `<div><small>Model farkı</small><b>${P.model_margin > 0 ? "+" : ""}${nf(P.model_margin, 1)}</b></div>` : ""}</div>` : "";
  return `<div class="card" style="--c:#2ea043">${head("🎯", "Tahmin")}${bars}${safe}${score}</div>`;
}
function bkComment(b) {
  const c = b.comment;
  if (!c) return "";
  return `<div class="card comm" style="--c:#39c5cf">${head("🗣️", `Maç yorumu <span class="muted">· ${b.state === "pre" ? "form, sakatlıklar ve oranlara göre" : "maç öncesi yazıldı"}</span>`)}
    ${c.paras.map((p) => `<p>${esc(p)}</p>`).join("")}<p class="cconcl">${esc(c.concl)}</p></div>`;
}
function bkOdds(b) {
  const pick = (b.rec && b.rec.pick) || {};
  const groups = ["Maç sonucu", "Handikap", "Toplam sayı", "Takım toplamı"];
  return groups.map((g) => {
    const rows = b.options.filter((o) => o.group === g);
    return rows.length ? `<div class="card">${head("💰", g)}<div class="bktiles">${rows.map((o) => `<div class="bktile ${o.code === pick.code ? "safe" : ""}"><span>${esc(o.label)}</span><b>${nf(o.odds, 2)}</b><small>model ${pc(o.p)}</small></div>`).join("")}</div></div>` : "";
  }).join("") + `<p class="muted">Oranlar Unibet'ten, maç başlayana kadar güncellenir.</p>`;
}
function bkTabs(b) {
  const hasBox = b.box.home.length || b.box.away.length;
  const tabs = [["ozet", "📊 Özet"], ["oyuncu", "👥 Oyuncular"], ...(b.options && b.options.length ? [["oran", "💰 Oranlar"]] : []), ...(hasBox ? [["kutu", "📋 Maç istatistiği"]] : [])];
  if (!tabs.some(([k]) => k === BK.tab)) BK.tab = "ozet";
  return `<div class="ptabs mtabs">${tabs.map(([k, l]) => `<button class="ptab ${BK.tab === k ? "on" : ""}" data-bkt="${k}">${l}</button>`).join("")}</div>`;
}
function bkBody(b) {
  const H = b.home, A = b.away;
  if (BK.tab === "oyuncu") return `<div class="grid2">${bkPlayers(b.players.home, b.lg, `${H.short} · sezon ortalamaları`)}${bkPlayers(b.players.away, b.lg, `${A.short} · sezon ortalamaları`)}</div>`;
  if (BK.tab === "kutu") return `<div class="grid2">${bkBox(b.box.home, H.short)}${bkBox(b.box.away, A.short)}</div>`;
  if (BK.tab === "oran") return bkOdds(b);
  const h2h = b.h2h.length ? `<div class="card">${head("🤝", "Aralarındaki maçlar (bu sezon)")}${b.h2h.map((x) => `<div class="bkrow"><span class="muted">${dateOf(x.utc)}</span><span>${esc(x.home)} <b>${x.hs}-${x.as}</b> ${esc(x.away)}</span></div>`).join("")}</div>` : "";
  return `${bkPredict(b)}${bkComment(b)}${bkCompare(b)}<div class="grid2">${bkInjury(b, "home")}${bkInjury(b, "away")}</div>${h2h}<div class="grid2">${bkLog(H, b.lg)}${bkLog(A, b.lg)}</div>`;
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
  const fav = bkFav(b.pred), pr = b.pred || {};
  const hero = `<div class="hero"><div class="hero-league"><a href="#/basket/lig/${b.lg}">${BK_LOGO[b.lg]} ${esc(b.lg_name)}</a>${b.round ? ` · ${esc(typeof b.round === "number" ? b.round + ". hafta" : b.round)}` : ""}</div>
    <div class="teams"><a class="team" href="#/basket/takim/${b.lg}/${encodeURIComponent(b.home.id)}">${bkCrest(b.home, 78, fav === "home", pr.p_home)}${esc(b.home.short)}</a>
      <div class="score ${live ? "live" : ""}">${live || done ? `${b.home.score ?? 0} - ${b.away.score ?? 0}<small>${esc(live ? (b.clock || "Canlı") : "Maç sonu")}</small>` : `${esc(timeOf(b.utc))}<small>${esc(dateOf(b.utc))}</small>`}</div>
      <a class="team" href="#/basket/takim/${b.lg}/${encodeURIComponent(b.away.id)}">${bkCrest(b.away, 78, fav === "away", pr.p_away)}${esc(b.away.short)}</a></div>${q}
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
    ${g.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="l"><span class="bktm">${r.logo ? `<img src="${esc(r.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}${bkTeamLink(lg, r)}</span></td><td>${r.gp}</td><td><b>${r.w}</b></td><td>${r.l}</td><td>${nf(r.ppg, 1)}</td><td>${nf(r.opp, 1)}</td><td class="${r.diff >= 0 ? "pos" : "neg"}">${sg(r.diff)}</td><td class="bkl5">${bkDots(r.l5)}</td></tr>`).join("")}
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

/* ---------- kuponlar ---------- */
const BK_THEMES = [["banko", "✅", "Banko", "#2ea043", "Modelin en emin olduğu tercihler; düşük oran, yüksek isabet."],
  ["fav", "🏆", "Favoriler", "#e3b341", "Favori takımların maç sonucu ve handikap tercihleri."],
  ["sayi", "🎯", "Sayılar", "#f85149", "Toplam sayı ve takım sayısı tercihleri."]];
const bkCouponPl = (c) => c.won ? COUPON_STAKE * ((c.paid || c.odds) - 1) : -COUPON_STAKE;
// futbol kupon kartının aynısı; byId varsa ayaklara logo ve canlı skor eklenir
function bkCoupon(c, date, byId = {}, open = true) {
  const done = c.state === "done", th = BK_THEMES.find((x) => x[0] === c.theme) || [];
  const legs = [...c.legs].sort((a, b) => a.utc.localeCompare(b.utc)).map((l) => {
    const m = byId[l.mid];
    return { ...l, logo: l.hlogo || (m && m.home.logo), live: l.hit == null && m && m.state === "live" ? { min: m.clock, score: [m.home.score ?? 0, m.away.score ?? 0] } : null };
  });
  const started = c.legs.some((l) => new Date(l.utc) <= new Date());
  const stake = COUPON_STAKE, ret = stake * (done && c.won ? c.paid || c.odds : c.odds);
  const status = done ? (c.won ? `<span class="kst ok">✓ Kazandı</span>` : `<span class="kst no">✗ Kaybetti</span>`)
    : started ? `<span class="kst wait fin" title="Maçlarından biri başladı; kupon artık değişmez.">✓ Son hali · ⏳ Bekliyor</span>`
    : `<span class="kst wait tbd" title="Kupondaki maçlardan biri başlayınca kupon kesinleşir.">! Değişebilir</span>`;
  const mini = done ? `<span class="kpl ${c.won ? "pos" : "neg"}">${c.won ? "✓" : "✗"} ${tl(bkCouponPl(c), true)}</span>`
    : `<span class="kmini kp" title="Tutma ihtimali">%${Math.round(c.p * 100)}</span><span class="kmini ks ${started ? "fin" : "tbd"}" title="${started ? "Son hali" : "Değişebilir"}">${started ? "✓" : "!"}</span>`;
  const cid = "bk-" + c.id, shared = { ...c, date, legs: c.legs.map((l) => ({ ...l, home: { name: l.home }, away: { name: l.away } })) };
  COUPON_BY_ID.set(cid, shared);
  return `<details class="card kupon ogrp ${done ? (c.won ? "won" : "lost") : ""}" style="--c:${th[3] || "#e3b341"}" ${open ? "open" : ""}>
    <summary>${head(c.icon, `${esc(c.name)} <span class="muted">· ${c.legs.length} maç</span><span class="kodds">${nf(c.odds, 2)}</span>${mini}`)}</summary>
    <p class="muted kdesc">${esc(th[4] || "")}</p>
    <div class="klegs ktl">${legs.map((l) => `<div class="ktr ${legState(l)}"><div class="ktime">${esc(timeOf(l.utc))}</div><span class="kdot"></span><div class="kleg ${l.hit === true ? "hit" : l.hit === false ? "miss" : ""}" data-bkm="${esc(l.mid)}">
      <div class="klt">${l.logo ? `<img src="${esc(l.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${esc(l.home)} – ${esc(l.away)}</span>
        ${l.result ? `<b class="kres">${l.result[0]}-${l.result[1]}</b>` : l.live ? `<b class="kres live">● ${esc(l.live.min || "")} ${l.live.score[0]}-${l.live.score[1]}</b>` : ""}</div>
      <div class="klp"><span class="kpick">${esc(l.label)}</span><small>${pc(l.p)}</small><b>${nf(l.odds, 2)}</b>${legStatus(l)}</div>
      <div class="kpbar"><span style="width:${Math.round(l.p * 100)}%"></span></div>
    </div></div>`).join("")}</div>
    ${couponBar({ ...c, legs })}
    <div class="kfoot ksum"><span>Tutma ihtimali <b>${pc(c.p)}</b></span>
      <span class="kstake ${done ? (c.won ? "pos" : "neg") : ""}">${tl(stake)} → ${done ? (c.won ? tl(ret) + ` (${tl(ret - stake, true)})` : `0 ₺ (${tl(-stake, true)})`) : tl(ret)}</span>${status}</div>
    <div class="kshare"><button class="kbtn" data-share="copy" data-cid="${esc(cid)}">📋 Kopyala</button>${shareBtn("k:" + cid, `${c.icon} ${c.name} · ${nf(c.odds, 2)}`, couponText(shared))}</div>
  </details>`;
}
// kuponun ayağına dokununca basketbol maç sayfası
$("#view").addEventListener("click", (e) => { const k = e.target.closest("[data-bkm]"); if (k) location.hash = "#/basket/mac/" + k.dataset.bkm; });
// son 14 günde en çok kazandıran tema
function bkHotTheme(K) {
  const since = new Date(Date.now() - 14 * 86400e3).toLocaleDateString("sv-SE");
  const all = ((K && K.store && K.store.coupons) || []).filter((d) => d.date >= since).flatMap((d) => d.coupons).filter((c) => c.state === "done");
  const best = BK_THEMES.map(([k, ic, name]) => {
    const d = all.filter((c) => c.theme === k);
    return { k, ic, name, n: d.length, h: d.filter((c) => c.won).length, pl: d.reduce((a, c) => a + bkCouponPl(c), 0) };
  }).filter((t) => t.n >= 3).sort((a, b) => b.pl - a.pl)[0];
  return best && best.pl > 0 ? best : null;
}
async function renderBasketCoupons() {
  const v = $("#view");
  if (!BK.cday) BK.cday = bkToday();
  const base = bkToday(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
  const days = [[shift(-1), "Dün"], [base, "Bugün"], [shift(1), "Yarın"]];
  if (!days.some(([d]) => d === BK.cday)) BK.cday = base;
  const bar = bkNav("kupon") + `<div class="ptabs">${days.map(([d, l]) => `<button class="ptab ${d === BK.cday ? "on" : ""}" data-bkc="${d}">${l}</button>`).join("")}</div>`;
  v.innerHTML = bar + skel("list");
  let D, K;
  try { [D, K] = await Promise.all([bkGet(`bk-day-${BK.cday}.json`, "Kuponlar bir sonraki güncellemede gelecek."), bkGet("bk-karne.json", "").catch(() => null)]); }
  catch (e) { v.innerHTML = bar + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; bkBindCouponDays(); return; }
  if (location.hash !== "#/basket/kupon") return;
  const cs = D.coupons || [], byId = Object.fromEntries(D.matches.map((m) => [m.id, m])), hot = bkHotTheme(K);
  const title = new Date(BK.cday + "T12:00:00").toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" });
  const intro = `<div class="card" style="--c:#a371f7">${head("🧩", `Günün kuponları <span class="muted">· ${cap(title)}</span>`)}
    <details class="kinfo"><summary>Kuponlar nasıl hazırlanıyor? ›</summary><p class="muted">Model her gün üç temada kupon hazırlar: Banko üç, Favoriler ve Sayılar ikişer kupon. Her maçtan tek tercih alınır, bir maç aynı temada tek kupona girer ve aynı tercih en fazla iki kupona girer. Tercih başına en az olasılık Banko'da %66, Favoriler'de %60, Sayılar'da %55. Toplam oranlar: Banko 2-3.6, Favoriler 2-4.5, Sayılar 2-5. Kuponda <b>! Değişebilir</b> yazıyorsa oranlar güncellendikçe yenilenebilir; maçlarından biri başlayınca kupon kilitlenir ve <b>✓ Son hali</b> olur.</p></details></div>`;
  const tabs = `<div class="ptabs ctabs">${BK_THEMES.map(([k, ic, name, color]) => {
    const n = cs.filter((c) => c.theme === k).length;
    return `<button class="ptab ${BK.ctheme === k ? "on" : ""}" style="--tc:${color}" data-bkth="${k}">${ic} ${name}${hot && hot.k === k ? " 🔥" : ""}${n ? ` <small>${n}</small>` : ""}</button>`; }).join("")}</div>
    ${hot ? `<div class="hotnote">🔥 Son 14 günde en çok kazandıran tema: <b>${hot.ic} ${esc(hot.name)}</b> · ${hot.h}/${hot.n} kupon tuttu, <span class="kpl ${hot.pl >= 0 ? "pos" : "neg"}">${tl(hot.pl, true)}</span></div>` : ""}`;
  const list = cs.filter((c) => c.theme === BK.ctheme);
  const empty = cs.length ? `<div class="card"><p class="muted">Bu temada bu gün kupon çıkmadı: kurallara uyan yeterli maç yok.</p></div>`
    : `<div class="card"><p class="muted">Bu gün için kupon yok. Kuponlar oranı açıklanmış maçlardan kurulur.</p></div>`;
  v.innerHTML = bar + intro + tabs + (list.length ? list.map((c) => bkCoupon(c, BK.cday, byId)).join("") : empty);
  bkBindCouponDays();
  v.querySelectorAll("[data-bkth]").forEach((b) => b.onclick = () => { BK.ctheme = b.dataset.bkth; renderBasketCoupons(); });
}
function bkBindCouponDays() {
  $("#view").querySelectorAll("[data-bkc]").forEach((b) => b.onclick = () => { BK.cday = b.dataset.bkc; renderBasketCoupons(); });
}

/* ---------- karne ---------- */
function bkCouponKarne(K) {
  const all = ((K.store || {}).coupons || []).flatMap((d) => d.coupons.map((c) => ({ ...c, date: d.date })));
  const done = all.filter((c) => c.state === "done").sort((a, b) => b.date.localeCompare(a.date));
  const open = all.length - done.length;
  if (!done.length) return `<div class="card" style="--c:#e3b341">${head("🎟️", "Kupon karnesi")}<p class="muted">Henüz sonuçlanmış kupon yok.${open ? ` ${open} kupon sonuç bekliyor.` : ""}</p></div>`;
  const sum = (xs) => xs.reduce((a, c) => a + bkCouponPl(c), 0), pl = sum(done), won = done.filter((c) => c.won).length, staked = done.length * COUPON_STAKE;
  const series = {};
  done.forEach((c) => { series[c.date] = (series[c.date] || 0) + bkCouponPl(c); });
  const themes = [["banko", "✅ Banko"], ["fav", "🏆 Favoriler"], ["sayi", "🎯 Sayılar"]].map(([k, l]) => {
    const d = done.filter((c) => c.theme === k), w = sum(d);
    return d.length ? `<div class="bkrow"><span>${l}</span><span class="muted">${d.filter((c) => c.won).length}/${d.length}</span><b class="${w >= 0 ? "pos" : "neg"}">${tl(w, true)}</b></div>` : "";
  }).join("");
  const days = [...new Set(done.map((c) => c.date))].map((d) => {
    const g = done.filter((c) => c.date === d), w = sum(g);
    return `<h3 class="kath">${esc(cap(new Date(d + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long" })))} <span class="kpl ${w >= 0 ? "pos" : "neg"}">${tl(w, true)}</span></h3>${g.map((c) => bkCoupon(c, d, {}, false)).join("")}`;
  }).join("");
  return `<div class="card" style="--c:#e3b341">${head("🎟️", "Kupon karnesi")}
    <div class="bkexp"><div><small>Tutan</small><b>${won}/${done.length}</b></div><div><small>Oran</small><b>${pc(won / done.length)}</b></div><div><small>Yatırılan</small><b>${tl(staked)}</b></div><div><small>Kâr/zarar</small><b class="${pl >= 0 ? "pos" : "neg"}">${tl(pl, true)}</b></div></div>
    <p class="muted">Kupon başına ${tl(COUPON_STAKE)} oynanmış gibi hesaplanır.${open ? ` ${open} kupon sonuç bekliyor.` : ""} Futbol karnesinden ayrıdır.</p></div>
    ${Object.keys(series).length > 1 ? `<div class="card">${plChart(series, `Kupon başına ${tl(COUPON_STAKE)}`)}</div>` : ""}
    ${themes ? `<div class="card">${head("🧩", "Temaya göre")}${themes}</div>` : ""}${days}`;
}
async function renderBasketKarne() {
  const v = $("#view");
  v.innerHTML = bkNav("karne") + skel("list");
  let K;
  try { K = await bkGet("bk-karne.json", "Karne bir sonraki güncellemede gelecek."); }
  catch (e) { v.innerHTML = bkNav("karne") + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (location.hash !== "#/basket/karne") return;
  const tabs = `<div class="ptabs">${[["tercih", "✅ Tek tercihler"], ["kupon", "🎟️ Kuponlar"]].map(([k, l]) => `<button class="ptab ${BK.ktab === k ? "on" : ""}" data-bkk="${k}">${l}</button>`).join("")}</div>`;
  const bind = () => v.querySelectorAll("[data-bkk]").forEach((b) => b.onclick = () => { BK.ktab = b.dataset.bkk; renderBasketKarne(); });
  if (BK.ktab === "kupon") { v.innerHTML = bkNav("karne") + tabs + bkCouponKarne(K); bind(); return; }
  const T = K.total;
  const line = (l, x) => x.n ? `<div class="bkrow"><span>${esc(l)}</span><span class="muted">${x.hit}/${x.n} · beklenen ${pc(x.exp)}</span><b class="${x.pl >= 0 ? "pos" : "neg"}">${pc(x.pct)} · ${tl(x.pl, true)}</b></div>` : "";
  const lg = Object.entries(K.by_lg).map(([k, x]) => line(BK_LG[k], x)).join("");
  const ty = Object.entries(K.by_type).map(([k, x]) => line(k, x)).join("");
  const rows = K.recent.filter((r) => r.state === "done").slice(0, 30).map((r) => `<div class="bkrow"><span class="muted">${dateOf(r.utc)}</span><span><a href="#/basket/mac/${esc(r.id)}">${esc(r.home)} ${r.result[0]}-${r.result[1]} ${esc(r.away)}</a> <small class="muted">${esc(r.pick.label)} · ${nf(r.pick.odds, 2)}</small></span><b class="${r.hit ? "pos" : r.hit === false ? "neg" : ""}">${r.hit ? "✓" : r.hit === false ? "✗" : "↩"}</b></div>`).join("");
  v.innerHTML = bkNav("karne") + tabs + `<div class="card" style="--c:#2ea043">${head("📒", "Basketbol karnesi")}
    ${T.n ? `<div class="bkexp"><div><small>Tutan</small><b>${T.hit}/${T.n}</b></div><div><small>Oran</small><b>${pc(T.pct)}</b></div><div><small>Beklenen</small><b>${pc(T.exp)}</b></div><div><small>Kâr/zarar</small><b class="${T.pl >= 0 ? "pos" : "neg"}">${tl(T.pl, true)}</b></div></div>
    <p class="muted">Tercih başına ${tl(K.stake)} oynanmış gibi hesaplanır. Futbol karnesinden ayrıdır.</p>` : `<p class="muted">Henüz sonuçlanmış tercih yok. En garanti tercihler maçlar bittikçe burada toplanacak.</p>`}</div>
    ${lg ? `<div class="card">${head("🏆", "Lige göre")}${lg}</div>` : ""}${ty ? `<div class="card">${head("🧩", "Tercih türüne göre")}${ty}</div>` : ""}${rows ? `<div class="card">${head("📅", "Son tercihler")}${rows}</div>` : ""}`;
  bind();
}

/* ---------- yönlendirme (app.js route çağırır) ---------- */
function renderBasket() {
  const h = location.hash;
  let m;
  window.scrollTo(0, 0);
  if (h.startsWith("#/basket/kupon")) return renderBasketCoupons();
  if (h.startsWith("#/basket/karne")) return renderBasketKarne();
  if ((m = h.match(/^#\/basket\/mac\/([\w-]+)/))) { BK.tab = "ozet"; return renderBasketMatch(m[1]); }
  if ((m = h.match(/^#\/basket\/lig\/(\w+)/))) return renderBasketLeague(m[1]);
  if ((m = h.match(/^#\/basket\/takim\/(\w+)\/([^/]+)/))) return renderBasketTeam(m[1], decodeURIComponent(m[2]));
  return renderBasketHome();
}
