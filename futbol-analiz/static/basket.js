"use strict";
/* Basketbol bölümü: NBA ve EuroLeague. Veriler bk-*.json dosyalarından gelir (build_static).
   Sayfalar: #/basket (maçlar), #/basket/mac/<id>, #/basket/lig/<lig>, #/basket/takim/<lig>/<id> */

const BK = { day: null, tab: "ozet", lg: "all", cday: null };
const BK_LG = { nba: "NBA", el: "EuroLeague" };
const BK_LOGO = { nba: "🏀", el: "🇪🇺" };

async function bkGet(name, missing) {
  if (!STATIC) throw new Error("Basketbol bölümü yalnızca yayındaki sitede çalışır.");
  try { return await getData(name); }
  catch (e) { if (e.message === "NOTFOUND") throw new Error(missing); throw e; }
}
const bkNum = (x, d = 1) => x == null ? "—" : nf(x, d);
// futboldaki gibi: favori takımın logosunun üstünde yıldız
const bkCrest = (t, size, isFav, pct) => {
  const ini = (t.short || t.name || "?").split(" ").map((w) => w[0]).join("").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3);
  return `<div class="crest ${isFav ? "fav" : ""}"${size ? ` style="width:${size}px;height:${size}px"` : ""}>
    ${isFav ? `<span class="star" title="Favori · kazanma olasılığı ${pc(pct)}">★</span>` : ""}
    ${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer"${size ? ` style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px"` : ""}
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fb',textContent:'${esc(ini)}'}))">` : `<span class="fb">${esc(ini)}</span>`}</div>`;
};
const bkFav = (p) => {
  if (!p || p.p_home == null) return null;
  const h = Math.round(p.p_home * 100), a = Math.round(p.p_away * 100);
  return h === a ? null : h > a ? "home" : "away";
};
const bkBoxes = (p) => (p && p.boxes && p.boxes.length ? probBoxes(p.boxes.map((x) => [x.ic, x.label, x.p, null, x.odds])) : "");
const bkTeamLink = (lg, t, txt) => `<a href="#/basket/takim/${lg}/${encodeURIComponent(t.id)}">${esc(txt || t.short || t.name)}</a>`;
const bkDots = (s) => [...(s || "")].map((c) => `<span class="bkf ${c === "G" ? "w" : "l"}">${c}</span>`).join("");

const bkNav = (on) => `<div class="bknav">${[["mac", "#/basket", "🏀 Maçlar"], ["kupon", "#/basket/kupon", "🎟️ Kuponlar"], ["karne", "#/basket/karne", "📒 Karne"]].map(([k, h, l]) =>
  `<a class="${k === on ? "on" : ""}" href="${h}">${l}</a>`).join("")}</div>`;

/* ---------- maç listesi ---------- */
function bkCard(m, withLeague) {
  const live = m.state === "live", done = m.state === "post", p = m.pred, fav = bkFav(p);
  const top = live ? `<span class="badge-live">CANLI ${esc(m.clock || "")}</span>` : done ? `<span class="when">Maç sonu</span>` : `<span></span>`;
  const mid = live || done
    ? `<div class="sc">${m.home.score ?? 0} - ${m.away.score ?? 0}</div><div class="sub">${live ? "devam ediyor" : "skor"}</div>`
    : `<div class="ko">${esc(timeOf(m.utc))}</div><div class="sub">başlama</div>`;
  const quarters = m.q && m.q[0] && m.q[0].length ? `<div class="bkq">${m.q[0].map((x, i) => `<span>${x ?? "–"}-${(m.q[1] || [])[i] ?? "–"}</span>`).join("")}</div>` : "";
  const tm = (t, sd) => `<div class="tm">${bkCrest(t, null, fav === sd, p && p["p_" + sd])}<div class="nm">${esc(t.short)}</div>${t.rec ? `<small class="muted">${esc(t.rec)}</small>` : ""}</div>`;
  const s = p && p.safe, started = m.state !== "pre";
  const bottom = p && p.p_home != null ? `
    <div class="probs"><span class="ph">${pc(p.p_home)}</span><div class="probbar"><span style="width:${p.p_home * 100}%"></span><span style="width:0"></span><span style="width:${p.p_away * 100}%"></span></div><span class="pa">${pc(p.p_away)}</span></div>
    <div class="pills">${s ? `<span class="pill safe${p.hit === true ? " won" : p.hit === false ? " lost" : started ? "" : " tbd"}" title="${p.hit === true ? "Tuttu" : p.hit === false ? "Tutmadı" : started ? "Son tercih" : "Maç başlayana kadar değişebilir"}"><i>${p.hit === true ? "✓" : p.hit === false ? "✗" : started ? "✅" : "!"}</i>${esc(s.label.replace(/ \(.*\)$/, ""))} @${nf(s.odds, 2)}</span>` : ""}</div>
    ${bkBoxes(p)}` : (done ? "" : `<div class="pending">Oranlar bekleniyor…</div>`);
  const tag = m.round ? `<span class="tag">${esc(typeof m.round === "number" ? m.round + ". hafta" : m.round)}</span>` : "";
  return `<div class="mcard ${live ? "is-live" : ""} st-${live ? "live" : done ? "done" : p && p.safe ? "open" : "wait"}" data-bk="${esc(m.id)}">
    <div class="mtop">${top}<div class="mtags">${withLeague ? `<span class="tag">${BK_LOGO[m.lg]} ${BK_LG[m.lg]}</span>` : tag}</div></div>
    <div class="mteams">${tm(m.home, "home")}<div class="mid">${mid}</div>${tm(m.away, "away")}</div>${quarters}${bottom}
  </div>`;
}
// liste başındaki öne çıkanlar: kuponlar, en net favori, en çok sayı, en dengeli maç
function bkHighlights(ms, coupons) {
  const open = ms.filter((m) => m.state === "pre" && m.pred && m.pred.p_home != null);
  const kTile = coupons.length ? `<div class="hl kombi" data-go="#/basket/kupon"><div class="ic">🧩</div>
    <div class="hlb"><div class="k">Günün kuponları</div><div class="t">${coupons.length} kupon hazır ›</div>
    <div class="s">${[...new Set(coupons.map((c) => c.icon))].map((ic) => `${ic} ${coupons.filter((c) => c.icon === ic).length}`).join(" · ")}</div></div></div>` : "";
  if (open.length < 2) return kTile ? `<div class="highlights">${kTile}</div>` : "";
  const pick = (score) => open.reduce((a, b) => (score(b) > score(a) ? b : a));
  const favM = pick((m) => Math.max(m.pred.p_home, m.pred.p_away));
  const totM = pick((m) => m.pred.total || 0), evenM = pick((m) => -Math.abs(m.pred.p_home - m.pred.p_away));
  const side = bkFav(favM.pred) || "home", opp = side === "home" ? favM.away : favM.home;
  const tile = (cls, ic, k, m, t, x) => `<div class="hl ${cls}" data-bk="${esc(m.id)}"><div class="ic">${ic}</div>
    <div class="hlb"><div class="k">${k}</div><div class="t">${t}</div><div class="s">${esc(x)}</div></div></div>`;
  const tl2 = (t) => `<span class="hlt">${t.logo ? `<img src="${esc(t.logo)}" alt="" onerror="this.remove()">` : ""}${esc(t.short)}</span>`;
  const pair = (m) => `${tl2(m.home)}<span class="hlv">-</span>${tl2(m.away)}`;
  return `<div class="highlights">${kTile}
    ${tile("fav", "★", "En net favori", favM, tl2(favM[side]), `Rakip: ${opp.short} · kazanma ${pc(favM.pred["p_" + side])}`)}
    ${tile("goal", "🏀", "En çok sayı beklentisi", totM, pair(totM), `Toplam ${nf(totM.pred.total, 1)} sayı`)}
    ${tile("even", "⚖", "En dengeli maç", evenM, pair(evenM), `1 ${pc(evenM.pred.p_home)} · 2 ${pc(evenM.pred.p_away)}`)}
  </div>`;
}
async function renderBasketHome() {
  const v = $("#view");
  if (!BK.day) BK.day = todayStr();
  const base = todayStr(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
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
      <div class="mgrid">${list.map((m) => bkCard(m)).join("")}</div></section>` : "";
  }).join("");
  const leagues = `<div class="bkleagues">${Object.keys(BK_LG).map((k) => `<a class="bklg" href="#/basket/lig/${k}">${BK_LOGO[k]} ${BK_LG[k]} <small>puan durumu</small></a>`).join("")}</div>`;
  v.innerHTML = bar + bkHighlights(D.matches, D.coupons || []) + lgBar + (sections || `<div class="card"><p class="muted">Bu tarihte maç yok.</p></div>`) + leagues;
  bkBindDays();
  v.querySelectorAll("[data-bkl]").forEach((b) => b.onclick = () => { BK.lg = b.dataset.bkl; renderBasketHome(); });
  v.querySelectorAll("[data-bk]").forEach((c) => c.onclick = () => location.hash = "#/basket/mac/" + c.dataset.bk);
  v.querySelectorAll("[data-go]").forEach((c) => c.onclick = () => location.hash = c.dataset.go);
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
  const P = b.pred, R = b.rec, pick = (R && R.pick) || null, H = b.home, A = b.away;
  if (!P) return "";
  const seg = (v, c, t, txt) => `<div style="flex:${v};background:${c}" title="${esc(t)}">${txt}</div>`;
  const ml = (b.options || []).filter((o) => o.group === "Maç sonucu");
  let mk = null;
  if (ml.length === 2) { const t = 1 / ml[0].odds + 1 / ml[1].odds; mk = [1 / ml[0].odds / t, 1 / ml[1].odds / t]; }
  const bars = `<div class="obars"><div class="obl"><span>Model</span></div><div class="bigbar">${seg(P.p_home, "var(--home)", H.short + " kazanır", "1 " + pc(P.p_home))}${seg(P.p_away, "var(--away)", A.short + " kazanır", "2 " + pc(P.p_away))}</div>
    ${mk ? `<div class="obl"><span>Piyasa</span></div><div class="bigbar mkbar">${seg(mk[0], "var(--home)", "Piyasa: " + H.short, pc(mk[0]))}${seg(mk[1], "var(--away)", "Piyasa: " + A.short, pc(mk[1]))}</div>` : ""}</div>`;
  const side = (t) => `<div class="shs">${t.logo ? `<img src="${esc(t.logo)}" alt="" onerror="this.remove()">` : ""}<span>${esc(t.short)}</span></div>`;
  const score = P.total ? `<div class="shero"><div class="shk">${ico("🎲")} Skor tahmini</div>
    <div class="shrow">${side(H)}<div class="shsc"><b>${Math.round((P.total + P.margin) / 2)}</b><i>-</i><b>${Math.round((P.total - P.margin) / 2)}</b></div>${side(A)}</div></div>` : "";
  const started = b.state !== "pre";
  const badge = R && R.state === "done" ? (R.hit === true ? `<span class="fbadge ok">✓ Tuttu</span>` : R.hit === false ? `<span class="fbadge wait">✗ Tutmadı</span>` : `<span class="fbadge">İade</span>`)
    : started ? `<span class="fbadge ok" title="Maç başladı, tercih artık değişmez.">✓ Son tercih</span>` : `<span class="fbadge wait" title="Maç başlayana kadar değişebilir.">! Değişebilir</span>`;
  const fav = bkFav(P), who = fav ? b[fav].short : null;
  const sum = who ? `${who} favori (%${Math.round(P["p_" + fav] * 100)}).${P.total ? ` Beklenen toplam ${nf(P.total, 1)} sayı.` : ""}` : "Maç dengeli görünüyor.";
  const sg = (z) => (z > 0 ? "+" : "") + nf(z, 1);
  return `<div class="card" style="--c:#a371f7">${head("🎯", `Tahmin ve model özeti${started ? ` <span class="muted">· maç öncesi tahmin, başlama düdüğünde donduruldu 🔒</span>` : ""}`)}
    <div class="summary">${esc(sum)}${pick ? "" : " Bu maç için oran yok; tahmin yalnızca takım gücünden hesaplandı."}</div>
    ${bars}${score}<div class="pbwide">${bkBoxes({ boxes: (R && R.boxes) || [] })}</div>
    ${pick ? `<div class="bigpicks">${bigPick("safe", "✅", "En garanti tercih", pick, badge)}</div>` : ""}
    <div class="pred">
      ${P.total ? kpi("🏀", "#3fb950", "Sayı beklentisi", `${nf((P.total + P.margin) / 2, 1)} – ${nf((P.total - P.margin) / 2, 1)}`, `Toplam ${nf(P.total, 1)}`) : ""}
      ${P.mkt_margin != null ? kpi("⚖", "#58a6ff", "Piyasa farkı", sg(P.mkt_margin), P.mkt_total != null ? `Toplam ${nf(P.mkt_total, 1)}` : "") : ""}
      ${P.model_margin != null ? kpi("🧠", "#a371f7", "Model farkı", sg(P.model_margin), P.model_total != null ? `Toplam ${nf(P.model_total, 1)}` : "") : ""}
      ${kpi("🛏️", "#d29922", "Dinlenme", `${b.home.rest ?? "—"} – ${b.away.rest ?? "—"} gün`, "Son maçtan beri")}
    </div></div>`;
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
  return `${bkPredict(b)}${bkCompare(b)}<div class="grid2">${bkInjury(b, "home")}${bkInjury(b, "away")}</div>${h2h}<div class="grid2">${bkLog(H, b.lg)}${bkLog(A, b.lg)}</div>`;
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
  const chips = [b.round && chip("🗓️", esc(typeof b.round === "number" ? b.round + ". hafta" : b.round)), b.venue && chip("🏟️", esc(b.venue)),
    b.refs && b.refs.length && chip(WHISTLE, `Hakem: ${esc(b.refs.join(", "))}`)].filter(Boolean).join("");
  const team = (t, sd) => `<div class="team">${bkCrest(t, 84, fav === sd, pr["p_" + sd])}<span><a class="tlink" href="#/basket/takim/${b.lg}/${encodeURIComponent(t.id)}" title="Takım sayfası">${esc(t.short)}</a></span>${t.rec ? bkDots(t.rec.l5) : ""}</div>`;
  const hero = `<div class="hero"><a class="hero-league" href="#/basket/lig/${b.lg}" title="Puan durumu"><b>${BK_LOGO[b.lg]} ${esc(b.lg_name)}</b><small>· puan durumu ›</small></a>
    <div class="teams">${team(b.home, "home")}
      <div class="score ${live ? "live" : ""}">${live || done ? `${b.home.score ?? 0} - ${b.away.score ?? 0}<small>${esc(live ? (b.clock || "Canlı") : "Maç sonu")}</small>` : `${esc(timeOf(b.utc))}<small>${esc(dateOf(b.utc))}</small>`}</div>
      ${team(b.away, "away")}</div>${q}<div class="chips">${chips}</div></div>`;
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
function bkCoupon(c) {
  const done = c.state === "done", paid = c.paid || c.odds;
  const legs = c.legs.map((l) => `<div class="bkleg"><span class="kst ${l.hit === true ? "ok" : l.hit === false ? "no" : ""}">${l.hit === true ? "✓" : l.hit === false ? "✗" : l.done ? "↩" : timeOf(l.utc)}</span>
    <div><a href="#/basket/mac/${esc(l.mid)}">${esc(l.home)} - ${esc(l.away)}</a>${l.result ? ` <b>${l.result[0]}-${l.result[1]}</b>` : ""}<small>${esc(l.label)}</small></div><b>${nf(l.odds, 2)}</b></div>`).join("");
  const stake = COUPON_STAKE, ret = stake * paid;
  return `<div class="card bkcoupon"><h3>${esc(c.icon)} ${esc(c.name)} <span class="muted">· oran ${nf(c.odds, 2)} · tutma ${pc(c.p)}</span></h3>${legs}
    <p class="bkstake ${done ? (c.won ? "pos" : "neg") : ""}">${tl(stake)} → ${done ? (c.won ? `${tl(ret)} (${tl(ret - stake, true)})` : `0 ₺ (${tl(-stake, true)})`) : tl(ret)}</p></div>`;
}
async function renderBasketCoupons() {
  const v = $("#view");
  if (!BK.cday) BK.cday = todayStr();
  const base = todayStr(), shift = (n) => { const d = new Date(base + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("sv-SE"); };
  const days = [[shift(-1), "Dün"], [base, "Bugün"], [shift(1), "Yarın"]];
  if (!days.some(([d]) => d === BK.cday)) BK.cday = base;
  const bar = bkNav("kupon") + `<div class="ptabs">${days.map(([d, l]) => `<button class="ptab ${d === BK.cday ? "on" : ""}" data-bkc="${d}">${l}</button>`).join("")}</div>`;
  v.innerHTML = bar + skel("list");
  let D;
  try { D = await bkGet(`bk-day-${BK.cday}.json`, "Kuponlar bir sonraki güncellemede gelecek."); }
  catch (e) { v.innerHTML = bar + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (location.hash !== "#/basket/kupon") return;
  const cs = D.coupons || [];
  v.innerHTML = bar + (cs.length ? cs.map(bkCoupon).join("") : `<div class="card"><p class="muted">Bu gün için kupon yok. Kuponlar oranı açıklanmış maçlardan kurulur.</p></div>`)
    + `<p class="muted">Kuponlar maçlarından biri başlayana kadar değişebilir, başlayınca kilitlenir.</p>`;
  v.querySelectorAll("[data-bkc]").forEach((b) => b.onclick = () => { BK.cday = b.dataset.bkc; renderBasketCoupons(); });
}

/* ---------- karne ---------- */
async function renderBasketKarne() {
  const v = $("#view");
  v.innerHTML = bkNav("karne") + skel("list");
  let K;
  try { K = await bkGet("bk-karne.json", "Karne bir sonraki güncellemede gelecek."); }
  catch (e) { v.innerHTML = bkNav("karne") + `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (location.hash !== "#/basket/karne") return;
  const T = K.total;
  const line = (l, x) => x.n ? `<div class="bkrow"><span>${esc(l)}</span><span class="muted">${x.hit}/${x.n} · beklenen ${pc(x.exp)}</span><b class="${x.pl >= 0 ? "pos" : "neg"}">${pc(x.pct)} · ${tl(x.pl, true)}</b></div>` : "";
  const lg = Object.entries(K.by_lg).map(([k, x]) => line(BK_LG[k], x)).join("");
  const ty = Object.entries(K.by_type).map(([k, x]) => line(k, x)).join("");
  const rows = K.recent.filter((r) => r.state === "done").slice(0, 30).map((r) => `<div class="bkrow"><span class="muted">${dateOf(r.utc)}</span><span><a href="#/basket/mac/${esc(r.id)}">${esc(r.home)} ${r.result[0]}-${r.result[1]} ${esc(r.away)}</a> <small class="muted">${esc(r.pick.label)} · ${nf(r.pick.odds, 2)}</small></span><b class="${r.hit ? "pos" : r.hit === false ? "neg" : ""}">${r.hit ? "✓" : r.hit === false ? "✗" : "↩"}</b></div>`).join("");
  v.innerHTML = bkNav("karne") + `<div class="card" style="--c:#2ea043">${head("📒", "Basketbol karnesi")}
    ${T.n ? `<div class="bkexp"><div><small>Tutan</small><b>${T.hit}/${T.n}</b></div><div><small>Oran</small><b>${pc(T.pct)}</b></div><div><small>Beklenen</small><b>${pc(T.exp)}</b></div><div><small>Kâr/zarar</small><b class="${T.pl >= 0 ? "pos" : "neg"}">${tl(T.pl, true)}</b></div></div>
    <p class="muted">Tercih başına ${tl(K.stake)} oynanmış gibi hesaplanır. Kuponlar: ${K.coupons.won}/${K.coupons.n} tuttu. Futbol karnesinden ayrıdır.</p>` : `<p class="muted">Henüz sonuçlanmış tercih yok. En garanti tercihler maçlar bittikçe burada toplanacak.</p>`}</div>
    ${lg ? `<div class="card">${head("🏆", "Lige göre")}${lg}</div>` : ""}${ty ? `<div class="card">${head("🧩", "Tercih türüne göre")}${ty}</div>` : ""}${rows ? `<div class="card">${head("📅", "Son tercihler")}${rows}</div>` : ""}`;
}

/* ---------- alt menü: basketbolda aynı dört düğme basketbol sayfalarına gider ---------- */
const BK_NAV = { home: ["#/basket", "Maçlar"], kombine: ["#/basket/kupon", "Kuponlar"], karne: ["#/basket/karne", "Karne"], oranlar: ["#/basket/lig/nba", "Puan durumu"] };
const FB_NAV = { home: ["#/", "Maçlar"], kombine: ["#/kombine", "Kombineler"], karne: ["#/karne", "Karne"], oranlar: ["#/oranlar", "Oranlar"] };
function bkNavSync(bk) {
  const h = location.hash;
  document.querySelectorAll("#bottomNav [data-nav]").forEach((a) => {
    const [href, label] = (bk ? BK_NAV : FB_NAV)[a.dataset.nav];
    a.setAttribute("href", href);
    a.querySelector("span").textContent = label;
    if (bk) a.classList.toggle("on", a.dataset.nav === (h.startsWith("#/basket/kupon") ? "kombine" : h.startsWith("#/basket/karne") ? "karne" : h.startsWith("#/basket/lig") ? "oranlar" : h === "#/basket" ? "home" : ""));
  });
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
