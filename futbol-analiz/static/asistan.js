"use strict";
/* Model asistanı: soruyu anlar ve SİTEDEKİ verilerle (maç analizleri, tahminler, oranlar, karne, oyuncu
   istatistikleri) cevap verir. Dış bir yapay zekâ servisi kullanmaz; app.js'deki yardımcıları kullanır. */

const norm = (s) => (s || "").toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
// sık kullanılan takma adlar -> takım adının normalize hâlinde geçen parça
const ALIASES = {
  fener: "fenerbahce", fb: "fenerbahce", gs: "galatasaray", cimbom: "galatasaray", galata: "galatasaray",
  bjk: "besiktas", kartal: "besiktas", ts: "trabzonspor", trabzon: "trabzonspor", barca: "barcelona",
  real: "real madrid", madrid: "real madrid", city: "manchester city", united: "manchester united", manu: "manchester united",
  psg: "paris saint-germain", juve: "juventus", bayern: "bayern", atletico: "atletico madrid", dortmund: "dortmund", bvb: "dortmund",
};
const STOP = new Set(["bugun", "yarin", "dun", "mac", "maci", "macı", "ne", "olur", "olacak", "kim", "kazanir", "kazanacak", "nasil",
  "hangi", "skor", "tahmin", "tahmini", "oran", "oranlar", "kupon", "garanti", "banko", "icin", "ile", "ve", "mi", "mu", "mı", "bu",
  "aksam", "gece", "sence", "senin", "bana", "bir", "the", "fc", "sk", "afc", "cf", "club", "korner", "kart", "gol", "golu", "atar",
  "oynanir", "oynar", "oynardin", "oynarsin", "oyna", "takim", "takimi", "takımı", "karsi", "karşı", "vs", "kac", "var", "yok"]);

const chatState = { open: false, busy: false, days: null, bundles: new Map(), greeted: false };

function dayKeys() {
  if (STATIC && meta && meta.days) return meta.days;
  const t = new Date(todayStr() + "T12:00:00");
  return [-1, 0, 1].map((d) => { const x = new Date(t); x.setDate(x.getDate() + d); return x.toLocaleDateString("sv-SE"); });
}
async function loadDays() {
  if (chatState.days) return chatState.days;
  const out = {};
  for (const k of dayKeys()) {
    try { out[k] = (await api("/api/day?date=" + k)).matches || []; } catch { out[k] = []; }
  }
  chatState.days = out;
  return out;
}
async function bundle(id) {
  if (!chatState.bundles.has(id)) chatState.bundles.set(id, await api(`/api/match/${id}`));
  return chatState.bundles.get(id);
}
const relDay = (k) => {
  const diff = Math.round((new Date(k + "T12:00:00") - new Date(todayStr() + "T12:00:00")) / 86400000);
  return { "-1": "dün", "0": "bugün", "1": "yarın" }[diff] || new Date(k + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
};

// sorudan gün: "yarın" / "dün" / yoksa bugün (takım bulunamazsa diğer günlere de bakılır)
function wantedDay(q) {
  const keys = dayKeys(), t = todayStr();
  const idx = keys.indexOf(t);
  if (/\byarin\b/.test(q)) return keys[idx + 1] || keys[keys.length - 1];
  if (/\bdun\b/.test(q)) return keys[idx - 1] || keys[0];
  return t;
}

// sorudaki takım(lar)a uyan maçlar
function findMatches(q, days) {
  const toks = q.split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
  const wanted = new Set();
  toks.forEach((w) => { if (ALIASES[w]) wanted.add(ALIASES[w]); });
  const hits = [];
  for (const [day, ms] of Object.entries(days)) {
    for (const m of ms) {
      let score = 0;
      for (const side of [m.home, m.away]) {
        const n = norm(side.name), words = n.split(" ").filter((w) => w.length >= 3);
        if ([...wanted].some((a) => n.includes(a))) score += 3;
        for (const t of toks) {
          if (t.length < 3) continue;
          if (words.some((w) => w === t || (t.length >= 4 && (w.startsWith(t) || t.startsWith(w) && w.length >= 4)))) score += 2;
        }
      }
      if (score) hits.push({ m, day, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

// risk dili: garanti tercihin olasılığı ve model güvenine göre
function riskText(pick, conf) {
  const p = pick.p;
  const lvl = p >= 0.72 && conf !== "Düşük" ? ["düşük-orta", "🟢"] : p >= 0.6 ? ["orta", "🟡"] : ["yüksek", "🔴"];
  return `${lvl[1]} Risk seviyesi: <b>${lvl[0]}</b> (model ${pc(p)}${pick.odds ? `, oranın ima ettiği ${pc(1 / pick.odds)}` : ""}; model güveni ${esc(conf)}).`;
}

async function answerMatch(q, hit) {
  const b = await bundle(hit.m.id);
  const P = b.analysis.prediction, H = b.home.name, A = b.away.name, st = b.status;
  const when = `${relDay(hit.day)} ${timeOf(b.utc)}`;
  const lines = [];
  const link = `<a href="#/mac/${b.id}" class="chat-link">Maç sayfasını aç ›</a>`;
  lines.push(`<b>${esc(H)} – ${esc(A)}</b> · ${esc(b.league_name || "")} · ${esc(when)}`);
  if (st.finished) {
    lines.push(`Maç bitti: <b>${b.home.score}-${b.away.score}</b>. Modelin maç öncesi skor tahmini ${esc((P.score_pick || P.scores[0]).score)} idi.`);
    return lines.join("<br>") + "<br>" + link;
  }
  if (st.started) lines.push(`🔴 Maç şu an oynanıyor: <b>${b.home.score}-${b.away.score}</b> (${esc(st.live || "")}).`);

  const has = (re) => re.test(q);
  if (has(/korner/)) {
    const c = P.corners;
    lines.push(c ? `🚩 Korner beklentisi: ${esc(H)} ${nf(c.home)}, ${esc(A)} ${nf(c.away)} · toplam ${nf(c.total)} (9.5 üst ${pc(c.over["9.5"])}, 10.5 üst ${pc(c.over["10.5"])}).` : "Bu maç için korner verisi yok.");
    if (P.probs && P.probs.cm1 != null) lines.push(`Daha çok korner: ${esc(H)} ${pc(P.probs.cm1)} · ${esc(A)} ${pc(P.probs.cm2)}.`);
  }
  if (has(/kart|kirmizi|sari/)) {
    lines.push(P.yellow && P.yellow.total != null ? `🟨 Sarı kart ortalaması: toplam ${nf(P.yellow.total)} (${esc(H)} ${nf(P.yellow.home)}, ${esc(A)} ${nf(P.yellow.away)}).` : "Kart verisi sınırlı.");
    if (P.probs && P.probs.rc_yes != null) lines.push(`🟥 Kırmızı kart çıkma ihtimali ${pc(P.probs.rc_yes)}.`);
    if (b.referee) lines.push(`Hakem: ${esc(b.referee)}.`);
  }
  if (has(/kadro|11|eksik|sakat|ceza/)) {
    const lu = b.lineup || {};
    const typ = { predicted: "olası 11", lastStarting11: "son maçın 11'i" }[lu.type] || (lu.type ? "resmi 11" : "kadro yok");
    lines.push(`👥 Kadro durumu: ${typ}.`);
    for (const [side, name] of [["home", H], ["away", A]]) {
      const u = (lu[side] || {}).unavailable || [];
      lines.push(`${esc(name)} eksikleri: ${u.length ? u.slice(0, 5).map((p) => esc(p.name)).join(", ") + (u.length > 5 ? ` ve ${u.length - 5} oyuncu daha` : "") : "bilinen eksik yok"}.`);
    }
  }
  if (has(/gol|ust|alt|kg|karsilikli/)) {
    lines.push(`⚽ Gol beklentisi ${nf(P.lam_home, 2)} – ${nf(P.lam_away, 2)} · 2.5 üst ${pc(P.over25)} · 3.5 üst ${pc(P.over35)} · KG var ${pc(P.btts)}.`);
  }
  if (has(/oran/) && b.odds) {
    const mw = b.odds.markets.find((m) => m.key === "who_will_win");
    if (mw) lines.push(`💰 Maç sonucu oranları: ${mw.selections.map((s) => `${esc(s.label)}: <b>${nf(s.odds, 2)}</b>`).join(" · ")} (${esc(mw.provider)}).`);
  }
  // her soruda temel tahmin
  const out = { "1": `${H} kazanır`, X: "beraberlik", "2": `${A} kazanır` }[P.pick];
  lines.push(`📊 Olasılıklar: 1 ${pc(P.p_home)} · X ${pc(P.p_draw)} · 2 ${pc(P.p_away)}. Beklentim: <b>${esc(out)}</b>, skor tahminim <b>${esc((P.score_pick || P.scores[0]).score)}</b>.`);
  const tags = (b.analysis.commentary && b.analysis.commentary.tags) || [];
  if (tags.length) lines.push(tags.slice(0, 3).map(esc).join(" · "));
  const cm = b.analysis.commentary && b.analysis.commentary.paragraphs || [];
  const ctx = cm.find((p) => /lider|şampiyonluk|düşme|sırada|Avrupa hattında/.test(p));
  if (ctx) lines.push(`🗣️ ${esc(ctx)}`);
  if (P.best_pick) {
    lines.push(`✅ Ben olsam <b>${esc(P.best_pick.label)}</b>${P.best_pick.odds ? ` (oran ${nf(P.best_pick.odds, 2)})` : ""} oynardım. ${riskText(P.best_pick, P.confidence)}`);
  }
  if (P.surprise) lines.push(`⚡ Sürpriz arıyorsan: ${esc(P.surprise.label)}${P.surprise.odds ? ` (oran ${nf(P.surprise.odds, 2)})` : ""}. Yüksek oranlı tercihler daha sık kaybeder; küçük tutarla düşün.`);
  lines.push(`<small class="muted">Unutma: bu bir istatistik modeli, kesinlik yok. Kaybetmeyi göze alamayacağın tutarla oynama.</small>`);
  return lines.join("<br>") + "<br>" + link;
}

async function answerDayList(day, days) {
  const ms = days[day] || [];
  if (!ms.length) return `${cap(relDay(day))} seçili liglerde maç görünmüyor.`;
  const rows = ms.slice(0, 15).map((m) => {
    const t = m.started || m.finished ? `${m.home.score ?? 0}-${m.away.score ?? 0}` : timeOf(m.utc);
    const sp = m.pred && m.pred.safe ? ` · ✅ ${esc(m.pred.safe.label.replace(/ \(.*\)$/, ""))}${m.pred.safe.odds ? ` @${nf(m.pred.safe.odds, 2)}` : ""}` : "";
    return `• <a href="#/mac/${m.id}" class="chat-link">${esc(m.home.name)} – ${esc(m.away.name)}</a> <span class="muted">${esc(t)}</span>${sp}`;
  });
  return `<b>${cap(relDay(day))} ${ms.length} maç var:</b><br>${rows.join("<br>")}${ms.length > 15 ? `<br><span class="muted">… ve ${ms.length - 15} maç daha.</span>` : ""}`;
}

async function answerBest(day, days, n) {
  const ms = (days[day] || []).filter((m) => !m.started && !m.finished && m.pred && m.pred.safe);
  if (!ms.length) return `${cap(relDay(day))} için oynanmamış ve tahmini hazır maç yok.`;
  const list = [];
  for (const m of ms) {
    try { const b = await bundle(m.id); const bp = b.analysis.prediction.best_pick; if (bp) list.push({ m, b, bp }); } catch { }
  }
  list.sort((a, b) => b.bp.p - a.bp.p);
  const top = list.slice(0, n);
  const rows = top.map(({ m, bp }) => `• <a href="#/mac/${m.id}" class="chat-link">${esc(m.home.name)} – ${esc(m.away.name)}</a>: <b>${esc(bp.label)}</b>${bp.odds ? ` @${nf(bp.odds, 2)}` : ""} <span class="muted">(model ${pc(bp.p)})</span>`);
  const withOdds = top.filter((x) => x.bp.odds);
  let coupon = "";
  if (withOdds.length >= 2) {
    const odd = withOdds.reduce((a, x) => a * x.bp.odds, 1), prob = withOdds.reduce((a, x) => a * x.bp.p, 1);
    coupon = `<br>🎟️ Bunları tek kuponda birleştirirsen toplam oran <b>${nf(odd, 2)}</b>, modele göre tutma ihtimali yaklaşık <b>${pc(prob)}</b>. Kombine kuponda her maç riski katlar; ben olsam bunları tek tek, küçük tutarlarla oynardım.`;
  }
  return `<b>${cap(relDay(day))} modelin en güvendiği ${top.length} tercih:</b><br>${rows.join("<br>")}${coupon}<br><small class="muted">Oranı 1.30 altındaki tercihler zaten elenir. Kesinlik yok, riske dikkat.</small>`;
}

async function answerSurprise(day, days) {
  const ms = (days[day] || []).filter((m) => !m.started && !m.finished);
  const list = [];
  for (const m of ms) {
    try { const b = await bundle(m.id); const s = b.analysis.prediction.surprise; if (s && s.odds) list.push({ m, s }); } catch { }
  }
  list.sort((a, b) => (b.s.ev || 0) - (a.s.ev || 0));
  if (!list.length) return "Şu an oranlı bir sürpriz tahmin bulamadım.";
  return `<b>${cap(relDay(day))} en dikkat çekici sürprizler:</b><br>` + list.slice(0, 4).map(({ m, s }) =>
    `• <a href="#/mac/${m.id}" class="chat-link">${esc(m.home.name)} – ${esc(m.away.name)}</a>: <b>${esc(s.label)}</b> @${nf(s.odds, 2)} <span class="muted">(model ${pc(s.p)})</span>`).join("<br>") +
    `<br><small class="muted">Sürprizler yüksek oranlı, düşük ihtimalli tahminlerdir; çoğu tutmaz. Sadece küçük tutarlarla, eğlence için.</small>`;
}

async function answerKarne() {
  let rows = [], coupons = [];
  try { const k = await api("/api/karne"); rows = Array.isArray(k) ? k : k.singles || []; coupons = Array.isArray(k) ? [] : (k.coupons || []).flatMap((d) => d.coupons); } catch { }
  const cdone = coupons.filter((c) => c.state === "done");
  const cpl = cdone.reduce((a, c) => a + (c.won ? 1000 * ((c.paid_odds || c.odds) - 1) : -1000), 0);
  const ctxt = cdone.length ? `<br>🧩 Günün kombineleri: <b>${cdone.filter((c) => c.won).length}/${cdone.length}</b> kupon tuttu, kupon başına 1.000 ₺ ile <b>${cpl >= 0 ? "+" : ""}${Math.round(cpl).toLocaleString("tr-TR")} ₺</b>.` : "";
  const done = rows.filter((r) => r.state === "done" && (r.pick_hit === true || r.pick_hit === false));
  const pending = rows.filter((r) => r.state === "pending").length;
  if (!done.length) return `Henüz sonuçlanmış tahmin yok; ${pending} tahmin sonucunu bekliyor. <a href="#/karne" class="chat-link">Karneyi aç ›</a>`;
  const hit = done.filter((r) => r.pick_hit).length;
  const wo = done.filter((r) => r.pick.odds);
  const pl = wo.reduce((a, r) => a + (r.pick_hit ? 250 * (r.pick.odds - 1) : -250), 0);
  const sh = rows.filter((r) => r.state === "done" && r.score_hit).length;
  return `📒 Garanti tercihler: <b>${hit}/${done.length}</b> (${pc(hit / done.length)}). Skor tahminleri: ${sh} tam isabet.<br>` +
    `💰 Her tercihe 250 ₺ oynansaydı: <b>${pl >= 0 ? "+" : ""}${Math.round(pl).toLocaleString("tr-TR")} ₺</b> (${wo.length} tercih). ${pending} tahmin bekliyor.${ctxt}<br><a href="#/karne" class="chat-link">Karneyi aç ›</a>`;
}

// oyuncu: bugünün/yarının kadrolarında adı geçen oyuncu
async function answerPlayer(q, days) {
  const toks = q.split(" ").filter((w) => w.length >= 4 && !STOP.has(w) && !ALIASES[w]);
  if (!toks.length) return null;
  for (const k of Object.keys(days)) {
    for (const m of days[k]) {
      let b; try { b = await bundle(m.id); } catch { continue; }
      const lu = b.lineup || {};
      for (const side of ["home", "away"]) {
        for (const p of [...((lu[side] || {}).starters || []), ...((lu[side] || {}).subs || []), ...((lu[side] || {}).unavailable || [])]) {
          const pn = norm(p.name).split(" ");
          if (toks.some((t) => pn.some((w) => w.length >= 4 && (w === t || w.startsWith(t))))) {
            let d; try { d = await api(`/api/player/${p.id}`); } catch (e) { return `${esc(p.name)} için istatistikler henüz hazır değil.`; }
            const c = d.total || d.comps[0];
            if (!c) return `${esc(d.name)} için bu sezon istatistik yok.`;
            const g = (key) => { const i = [...c.top, ...c.sections.flatMap((s) => s.items), ...c.derived].find((x) => x.key === key); return i ? i.value : null; };
            const body = d.keeper
              ? `${c.matches || "?"} maç · ${g("saves") ?? "—"} kurtarış · kurtarış yüzdesi %${nf(g("save_percentage"), 1)} · ${g("goals_conceded") ?? "—"} gol yedi · önlenen gol ${nf(g("goals_prevented"), 2)}`
              : `${c.matches || "?"} maç · <b>${g("goals") ?? 0} gol</b> · <b>${g("assists") ?? 0} asist</b> · xG ${nf(g("expected_goals"), 2)} · ${g("shots") ?? "—"} şut (isabet %${nf(g("shot_accuracy"), 0)}) · ${g("chances_created") ?? "—"} kilit pas`;
            return `🏃 <b>${esc(d.name)}</b> (${esc(d.team.name || "")}) · ${esc(c.name === "Tüm kulvarlar" ? "tüm kulvarlar" : c.name)}, ${esc(d.season || "")}:<br>${body} · reyting ${nf(g("rating"), 2)}.<br><a href="#/oyuncu/${d.id}" class="chat-link">Oyuncu sayfasını aç ›</a>`;
          }
        }
      }
    }
  }
  return null;
}

const HELP = `Bana şunları sorabilirsin:<br>• <i>Bugün Fenerbahçe maçı ne olur?</i><br>• <i>Barcelona maçında korner / kart / gol beklentisi</i><br>• <i>Bugün hangi maçlar var?</i> · <i>Yarın ne oynayayım?</i><br>• <i>Günün en garanti tercihleri</i> · <i>Sürpriz tahmin ver</i><br>• <i>Model karnesi nasıl?</i> · <i>Salah kaç gol attı?</i>`;

async function answer(text) {
  const q = norm(text);
  const days = await loadDays();
  const day = wantedDay(q);
  if (!q) return HELP;
  if (/^(selam|merhaba|sa|slm|hey|naber|iyi aksamlar|gunaydin)\b/.test(q) && q.split(" ").length <= 3)
    return `Selam! 👋 Ben Maç Analiz Merkezi'nin model asistanıyım. ${HELP}`;
  if (/yardim|neler yapabilirsin|ne sorabilirim/.test(q)) return HELP;
  if (/karne|basari|kac tuttu|model nasil|kar zarar|kazandirdi/.test(q)) return answerKarne();
  if (/surpriz|yuksek oran|riskli/.test(q)) return answerSurprise(day, days);
  const hits = findMatches(q, days);
  if (hits.length) {
    const sameDay = hits.filter((h) => h.day === day);
    const best = (sameDay.length ? sameDay : hits)[0];
    let pre = "";
    if (!sameDay.length && /bugun/.test(q)) pre = `Bu takımın ${relDay(day)} maçı yok; ${relDay(best.day)} oynayacağı maça bakıyorum.<br>`;
    return pre + await answerMatch(q, best);
  }
  if (/garanti|banko|ne oyna|kupon|oynayayim|oynanir|tercih|tavsiye|oneri/.test(q)) return answerBest(day, days, /kupon/.test(q) ? 3 : 4);
  if (/hangi mac|maclar|mac var|fikstur|program/.test(q)) return answerDayList(day, days);
  if (/gol|asist|kurtaris|kac/.test(q)) {
    const p = await answerPlayer(q, days);
    if (p) return p;
  }
  const p = await answerPlayer(q, days);
  if (p) return p;
  return `Bunu sitedeki verilerle eşleştiremedim 🤔 Takım adını yazarsan (örn. "Galatasaray maçı ne olur?") o maçın analizini anlatırım.<br>${HELP}`;
}

/* ---------- arayüz ---------- */
function chatAdd(who, html) {
  const d = document.createElement("div");
  d.className = "msg " + who;
  d.innerHTML = who === "bot" ? `<span class="mav">🤖</span><div class="bub">${html}</div>` : `<div class="bub">${esc(html)}</div>`;
  $("#chatLog").appendChild(d);
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  return d;
}
async function chatAsk(text) {
  if (chatState.busy || !text.trim()) return;
  chatState.busy = true;
  chatAdd("me", text);
  const typing = chatAdd("bot", `<span class="typing"><i></i><i></i><i></i></span>`);
  try {
    const [html] = await Promise.all([answer(text), new Promise((r) => setTimeout(r, 450))]);
    typing.querySelector(".bub").innerHTML = html;
  } catch (e) {
    typing.querySelector(".bub").innerHTML = "Bir sorun oldu, tekrar dener misin? (" + esc(e.message) + ")";
  }
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  chatState.busy = false;
}
function openChat(open) {
  chatState.open = open;
  $("#chat").classList.toggle("hidden", !open);
  $("#chatBackdrop").classList.toggle("hidden", !open);
  document.body.classList.toggle("chat-open", open);
  if (open) {
    chatState.days = null; // her açılışta güncel veriler
    if (!chatState.greeted) {
      chatState.greeted = true;
      chatAdd("bot", `Selam! 👋 Sitedeki maç analizleri, oranlar, karne ve oyuncu istatistikleriyle sorularını cevaplarım. ${HELP}`);
    }
    setTimeout(() => $("#chatInput").focus(), 50);
  }
}
const CHIPS = ["Bugün hangi maçlar var?", "Günün en garanti tercihleri", "Sürpriz tahmin ver", "Model karnesi nasıl?", "Yarın ne oynayayım?"];
$("#chatChips").innerHTML = CHIPS.map((c) => `<button type="button" class="chip-q">${esc(c)}</button>`).join("");
$("#chatChips").querySelectorAll(".chip-q").forEach((b) => b.onclick = () => chatAsk(b.textContent));
$("#botBtn").onclick = () => openChat(!chatState.open);
$("#chatClose").onclick = $("#chatBackdrop").onclick = () => openChat(false);
$("#chatForm").onsubmit = (e) => { e.preventDefault(); const v = $("#chatInput").value; $("#chatInput").value = ""; chatAsk(v); };
$("#chatLog").addEventListener("click", (e) => { if (e.target.closest(".chat-link")) openChat(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && chatState.open) openChat(false); });
