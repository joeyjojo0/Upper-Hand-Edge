// UHE Strategy page: Joey's day-trade and long-term checklists on every scanned stock,
// plus a PIN-locked IC Markets (cTrader) order ticket. Data comes from the GitHub data engine (/data/*).
import { fp, isNum, UK, NY, fmtT } from "./model.js";
import { normRules, DAY_RULES, LONG_RULES, rank, dayPhase, redditBuzz, insiderView, insiderLabel } from "./strategy-model.js";
import { findPatterns, patternSummary, PATTERNS, TIMEFRAMES } from "./patterns.js";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
};
const money = (x, ccy = "$") => isNum(x) ? (x < 0 ? "−" : "") + ccy + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const pct = (x, d = 1) => isNum(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%" : "—";
const ago = iso => { if (!iso) return "—"; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
function toast(msg, ms = 3800) { const t = $("#toast"); t.innerHTML = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }

const S = {
  mode: ["day", "long"].includes(store.get("uhe.strat.mode")) ? store.get("uhe.strat.mode") : "day",
  u: ["S", "N", "Q", "W"].includes(store.get("uhe.strat.u")) ? store.get("uhe.strat.u") : "S",
  min: [0, 4, 5, 6, 7, 8, 9].includes(store.get("uhe.strat.min")) ? store.get("uhe.strat.min") : 6,
  q: "", rules: normRules(store.get("uhe.strat", {})), D: {}, feeds: {}, show: 60, open: null,
  pin: null, broker: null, acct: null, acctErr: "", lastPhase: null,
  pat: String(store.get("uhe.strat.pat", "off")), ins: String(store.get("uhe.strat.ins", "off")), live: {}
};

/* ---------------- clocks ---------------- */
const clocks = () => { $("#clkUK").textContent = fmtT(new Date(), UK); $("#clkNY").textContent = fmtT(new Date(), NY); };
clocks(); setInterval(clocks, 1000);

/* ---------------- data feeds ---------------- */
const FEEDS = {
  deep: { url: "/data/deep.json", every: 120e3, name: "Scan" },
  options: { url: "/data/options.json", every: 300e3, name: "Options" },
  fund: { url: "/data/fund.json", every: 1800e3, name: "Analysts & holders" },
  news: { url: "/data/news.json", every: 300e3, name: "News" },
  pulse: { url: "/data/pulse.json", every: 120e3, name: "Pulse" },
  patterns: { url: "/data/patterns.json", every: 120e3, name: "Patterns" }
};
async function load(k) {
  try {
    const r = await fetch(FEEDS[k].url, { cache: "no-cache" }); if (!r.ok) throw new Error("HTTP " + r.status);
    S.D[k] = await r.json(); S.feeds[k] = "ok";
  } catch (e) { S.feeds[k] = S.D[k] ? "stale" : "missing"; }
}
function renderChips() {
  $("#feedChips").innerHTML = Object.entries(FEEDS).map(([k, f]) => {
    const st = S.feeds[k], d = S.D[k], cls = st === "ok" ? "ok" : st === "stale" ? "warn" : st === "missing" ? "bad" : "";
    const txt = st === "missing" ? (k === "fund" || k === "news" || k === "pulse" || k === "patterns" ? "after next engine run" : "not loaded") : d && d.asOf ? fmtT(new Date(d.asOf), UK) : "…";
    return `<span class="chip ${cls}" title="${esc(f.name)}${d && d.asOf ? " · updated " + ago(d.asOf) : ""}"><span class="dot"></span>${esc(f.name)} ${esc(txt)}</span>`;
  }).join("");
  const live = $("#liveChip"), ok = S.feeds.deep === "ok";
  live.className = "live" + (ok ? " on" : ""); live.querySelector("span").textContent = ok ? "STRATEGY" : "WAITING";
}

/* ---------------- phase card ---------------- */
function renderPhase() {
  const ph = dayPhase(new Date()), steps = [["pre", "Pre-market check", "Ticks + gap up on volume"], ["open", "Open", "Buy strength or wait for the first dip"], ["session", "Dip-buys", "Reclaim of yesterday's close · sell before prior high"]];
  const at = steps.findIndex(s => s[0] === ph.k);
  $("#phase").innerHTML = `<div class="eyebrow">Day-trade routine · UK time</div><div class="ph-title">${esc(ph.t)}</div><p class="ph-d">${esc(ph.d)}</p>
    <ol class="ph-steps">${steps.map((s, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><b>${esc(s[1])}</b><span>${esc(s[2])}</span></li>`).join("")}</ol>`;
  if (S.lastPhase && S.lastPhase !== ph.k && (ph.k === "pre" || ph.k === "open")) notifyPhase(ph);
  S.lastPhase = ph.k;
}
function notifyPhase(ph) {
  if (!store.get("uhe.notify", false) || !("Notification" in window) || Notification.permission !== "granted") return;
  const top = currentRows("day", "S").filter(r => r.pass >= 6).slice(0, 4);
  try { new Notification(`UHE Strategy · ${ph.t}`, { body: top.length ? top.map(r => `${r.s}: ${r.pass}/${DAY_RULES.length} ticks`).join("\n") : "No day-trade setup has 6+ ticks right now.", icon: "/favicon.svg", tag: "uhe-strat" }); } catch { /* ignore */ }
}

/* ---------------- market pulse ---------------- */
const PRO_DESK = [
  ["FinancialJuice", "https://www.financialjuice.com/", "Free real-time headlines and audio squawk"],
  ["Benzinga Pro", "https://www.benzinga.com/pro/", "Paid: fastest US stock news, squawk, filings"],
  ["SEC EDGAR · latest filings", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent", "8-Ks, offerings and insider forms as filed"],
  ["Finviz news", "https://finviz.com/news.ashx", "Wire and blog headlines on one page"],
  ["ApeWisdom", "https://apewisdom.io/", "Reddit mentions across r/wallstreetbets, r/stocks…"],
  ["StockTwits", "https://stocktwits.com/", "Retail chatter and trending tickers"]
];
function chip(s, extra, title) { const inScan = !!(S.D.deep && S.D.deep.stocks && S.D.deep.stocks[s]); return `<button class="pchip${inScan ? "" : " off"}" data-go="${esc(s)}" title="${esc(title || "")}${inScan ? "" : " · not in the UHE scan"}"><b>${esc(s)}</b>${extra ? `<small>${extra}</small>` : ""}</button>`; }
function renderPulse() {
  const el = $("#pulse"), P = S.D.pulse; if (!el) return;
  const wire = P && P.wire && P.wire.length ? `<ul class="pl-wire">${P.wire.slice(0, 8).map(n => `<li class="${n.s > 0 ? "up" : n.s < 0 ? "down" : ""}"><a href="${esc(/^https:\/\//.test(n.u || "") ? n.u : "#")}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a><small>${esc(n.src)} · ${ago(new Date(n.ts * 1000).toISOString())}</small></li>`).join("")}</ul>` : `<div class="empty" style="padding:12px">${P ? "Wire needs FINNHUB_KEY in the data engine." : "Arrives after the next data-engine run."}</div>`;
  const rd = P && P.redditTop && P.redditTop.length ? P.redditTop.slice(0, 10).map(x => chip(x.s, `${x.m} · ${x.x >= 1 ? x.x.toFixed(1) + "×" : "↓"}`, `Reddit #${x.rank}: ${x.m} mentions in 24h (${x.m24} the day before)`)).join("") : `<span class="muted">No Reddit data yet</span>`;
  const st = P && P.stTrend && P.stTrend.length ? P.stTrend.slice(0, 10).map(x => chip(x.s, "", `${x.t} · trending on StockTwits`)).join("") : `<span class="muted">StockTwits trending unavailable</span>`;
  el.innerHTML = `<div class="pl-col"><div class="eyebrow">Market wire${P && P.asOf ? " · " + fmtT(new Date(P.asOf), UK) : ""}</div>${wire}</div>
    <div class="pl-col"><div class="eyebrow">Retail radar</div><h4>Reddit · biggest mention jumps</h4><div class="pchips">${rd}</div><h4>StockTwits · trending now</h4><div class="pchips">${st}</div><p class="note">Tap a ticker to find it in the checklist.</p></div>
    <div class="pl-col"><div class="eyebrow">Pro desk</div><ul class="pl-desk">${PRO_DESK.map(([n, u, d]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(n)}</a><small>${esc(d)}</small></li>`).join("")}</ul></div>`;
}
function goTo(s) {
  const d = S.D.deep && S.D.deep.stocks && S.D.deep.stocks[s];
  if (!d) return toast(`${esc(s)} isn't in the UHE scan (not S&amp;P 500 or Nasdaq-listed, or too thinly traded).`);
  const u = d.u || "S"; S.u = u.includes("S") ? "S" : u.includes("N") ? "N" : "Q"; S.q = s; S.min = 0; S.open = s; S.show = 60;
  if (S.pat !== "off" || S.ins !== "off") { S.pat = "off"; S.ins = "off"; renderFilters(); }
  $("#q").value = s; syncTabs(); renderList(); $("#list").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#pulse").addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) goTo(b.dataset.go); });

/* ---------------- ranking + list ---------------- */
// Per-stock news merged with Reddit mention counts from the pulse feed (cached until either feed changes).
function newsMap() {
  const n = S.D.news, p = S.D.pulse;
  if (S._nm && S._nm.n === n && S._nm.p === p) return S._nm.m;
  const m = { ...((n && n.stocks) || {}) };
  for (const [s, rd] of Object.entries((p && p.reddit) || {})) m[s] = { ...(m[s] || {}), rd };
  S._nm = { n, p, m }; return m;
}
function currentRows(mode = S.mode, u = S.u, minPass = S.min, filtered = true) {
  const D = (S.D.deep && S.D.deep.stocks) || {}, O = (S.D.options && S.D.options.chains) || {}, F = (S.D.fund && S.D.fund.stocks) || {}, N = newsMap();
  const watch = u === "W" ? new Set(store.get("uhe.watch", []) || []) : null;
  let rows = rank(mode, D, O, F, N, S.rules, { u, watch, minPass, q: S.q.trim().toUpperCase(), pat: patFor });
  if (filtered && S.pat !== "off") rows = rows.filter(r => patOK(r.s));
  if (filtered && S.ins !== "off") rows = rows.filter(r => insOK(r.s));
  return rows;
}
// Patterns for a stock: a live IC Markets scan if one was run, else the engine's latest.
const patFor = s => (S.live[s] && S.live[s].byTf) || (S.D.patterns && S.D.patterns.stocks && S.D.patterns.stocks[s]) || null;
function patOK(s) {
  const P = patFor(s); if (!P) return false;
  const sm = patternSummary(P);
  if (S.pat === "bull") return sm.bull.length > 0;
  if (S.pat === "break") return sm.bull.some(p => p.status === "breakout");
  if (S.pat === "bear") return sm.bear.length > 0;
  if (S.pat.startsWith("tf:")) return (P[S.pat.slice(3)] || []).some(p => p.bias === "bull");
  return true;
}
function insView(s) {
  const n = S.D.news, f = S.D.fund; if (!S._iv || S._iv.n !== n || S._iv.f !== f) S._iv = { n, f, m: {} };
  if (!(s in S._iv.m)) S._iv.m[s] = insiderView(newsMap()[s], f && f.stocks && f.stocks[s]);
  return S._iv.m[s];
}
function insOK(s) { const v = insView(s); return S.ins === "insider" ? v.insider : S.ins === "whale" ? v.whale : v.any; }
const RULES = () => S.mode === "day" ? DAY_RULES : LONG_RULES;
const SHORT = { rsi: "RSI", vol: "Vol", news: "News", etf: "ETF", trend: "Trend", opts: "C>P", analysts: "Analysts", rsi5: "RSI×5", kst5: "KST×5", earn: "Earnings", div: "Div", firms: "Firms", pattern: "Pattern" };
const mark = p => p === true ? "✓" : p === false ? "✕" : "–";
const ckCls = p => p === true ? "ok" : p === false ? "no" : "na";

const ST_TXT = { forming: "forming", breakout: "broke out", breakdown: "broke down" };
function rowTags(s) {
  const out = [], P = patFor(s);
  if (P) { const sm = patternSummary(P), b = sm.bestBull, x = sm.bestBear;
    if (b) out.push(`<i class="tg bull" title="${esc(b.name)} on ${b.tf}: ${ST_TXT[b.status]}${sm.bull.length > 1 ? ` · ${sm.bull.length} bullish patterns in all` : ""}">▲ ${esc(b.name)} · ${b.tf}${b.status === "breakout" ? " ✓" : ""}</i>`);
    if (x) out.push(`<i class="tg bear" title="${esc(x.name)} on ${x.tf}: ${ST_TXT[x.status]}">▼ ${esc(x.name)} · ${x.tf}</i>`); }
  const lab = insiderLabel(insView(s)); if (lab) out.push(`<i class="tg ins">◆ ${esc(lab)}</i>`);
  return out.length ? `<span class="st-tags">${out.join("")}</span>` : "";
}
function spark(sk, bias, w = 132, h = 42) {
  if (!sk || !sk.px || sk.px.length < 2) return "";
  const vals = sk.px.concat(...(sk.ln || []).map(l => [l[1], l[3]])).filter(isNum), lo = Math.min(...vals), hi = Math.max(...vals);
  const X = i => 2 + (i / (sk.px.length - 1)) * (w - 4), Y = v => h - 3 - ((v - lo) / ((hi - lo) || 1)) * (h - 6);
  return `<svg class="pspark ${bias}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${(sk.ln || []).map(l => `<line x1="${X(l[0]).toFixed(1)}" y1="${Y(l[1]).toFixed(1)}" x2="${X(l[2]).toFixed(1)}" y2="${Y(l[3]).toFixed(1)}"/>`).join("")}<polyline points="${sk.px.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}"/></svg>`;
}
function patternsHTML(s) {
  const P = patFor(s), live = S.live[s], meta = S.D.patterns || {};
  const src = live ? `Live from IC Markets · ${fmtT(new Date(live.asOf), UK)}` : P ? `Engine scan · intraday ${meta.tfAsOf && meta.tfAsOf["1m"] ? fmtT(new Date(meta.tfAsOf["1m"]), UK) : "—"}, 1h–1w ${meta.tfAsOf && meta.tfAsOf["1d"] ? fmtT(new Date(meta.tfAsOf["1d"]), UK) : "—"}` : "Not in the engine's pattern shortlist yet";
  const cell = tf => { const a = (P && P[tf]) || [];
    return `<div class="pt-cell"><b class="pt-tf">${tf}</b>${a.length ? a.map(p => `<div class="pt-p ${p.bias}">${spark(p.sk, p.bias)}<div><b>${esc(p.name)}</b><span>${ST_TXT[p.status] || p.status} · quality ${p.conf}</span><span class="num">key ${fp(p.level, 2)} → ${fp(p.target, 2)}${isNum(p.stop) ? ` · stop ${fp(p.stop, 2)}` : ""}</span></div></div>`).join("") : `<span class="muted">${P ? "No pattern" : "—"}</span>`}</div>`; };
  return `<div class="dt-sec dt-pat"><div class="pt-head"><h4>Chart patterns · 1m to 1w</h4><span class="muted">${esc(src)}</span><button class="btn sm" data-live="${esc(s)}">${live ? "Rescan live" : "Scan live (IC Markets)"}</button></div>
    <div class="pt-grid">${TIMEFRAMES.map(cell).join("")}</div><p class="note">Patterns are probabilities, not promises: many fail, and random price moves form them too. Use them with the checklist, and respect the stop.</p></div>`;
}
const usd = x => !isNum(x) ? "—" : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "k" : "$" + Math.round(x);
const dshort = d => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
function insiderHTML(s) {
  const v = insView(s); if (!v.buys.length && !v.sells.length && !v.funds.length && !v.stake && !v.n6) return "";
  const buyLi = b => `<li class="up">${/^https:\/\//.test(b.u || "") ? `<a href="${esc(b.u)}" target="_blank" rel="noopener noreferrer">${esc(b.n)}</a>` : esc(b.n)}<small>${esc(b.role || "Insider")}${b.ten ? " · 10% owner (whale)" : ""} · bought ${isNum(b.sh) ? Math.round(b.sh).toLocaleString("en-US") : "—"}${isNum(b.px) ? " @ " + fp(b.px, 2) : ""} = <b>${usd(b.v)}</b> · ${dshort(b.d)} · ${b.src}</small></li>`;
  const sold = v.sells.reduce((t, x) => t + (x.v || 0), 0), planN = v.sells.filter(x => x.plan).length;
  return `<div class="dt-sec"><h4>Insiders &amp; whales</h4>
    ${v.buys.length ? `<ul class="dt-news">${v.buys.slice(0, 5).map(buyLi).join("")}</ul>` : `<p class="muted">No open-market insider buying in the last 90 days.</p>`}
    ${v.cluster ? `<p class="up"><b>Cluster buy:</b> ${v.buyers} insiders bought in the last 30 days.</p>` : ""}
    ${v.stake ? `<p class="up"><b>13D filed:</b> an investor took an active 5%+ stake in the last 10 days.</p>` : ""}
    ${v.sells.length ? `<p class="note">Recent sales (SEC): ${usd(sold)} by ${new Set(v.sells.map(x => x.n)).size} insider${v.sells.length > 1 ? "s" : ""}${planN ? `, ${planN} under pre-set 10b5-1 plans` : ""}.</p>` : ""}
    ${v.n6 ? `<p class="note">Last 6 months: ${v.n6.b ?? 0} insider buy${v.n6.b === 1 ? "" : "s"} vs ${v.n6.s ?? 0} sell${v.n6.s === 1 ? "" : "s"}.</p>` : ""}
    ${v.funds.length ? `<p class="note">Funds adding (latest 13F): ${v.funds.slice(0, 4).map(f => `${esc(f.n)} <span class="up">+${f.ch.toFixed(0)}%</span>`).join(", ")}.</p>` : ""}</div>`;
}
function planText(r) {
  const p = r.plan; if (!p) return "—";
  return `Buy ${fp(p.entry, 2)} → <span class="up">${fp(p.tp, 2)}</span> <small>(${pct(p.tpPct)}${p.capped ? " · before prior high" : ""})</small> · stop <span class="down">${fp(p.sl, 2)}</span>`;
}
function renderList() {
  const el = $("#list");
  if (!S.D.deep) { el.innerHTML = `<div class="empty"><strong>${S.feeds.deep === "missing" ? "No scan yet" : "Loading the scan…"}</strong>${S.feeds.deep === "missing" ? "The data engine hasn't published deep.json yet. Run it from GitHub Actions." : ""}</div>`; return; }
  const watchN = (store.get("uhe.watch", []) || []).length;
  if (S.u === "W" && !watchN) { el.innerHTML = `<div class="empty"><strong>Your watchlist is empty</strong>Tick ✓ any stock here or on the Stocks page to follow it.</div>`; return; }
  const rows = currentRows(), R = RULES(), watch = new Set(store.get("uhe.watch", []) || []);
  const head = `<div class="st-row st-head" aria-hidden="true"><span></span><span>Stock</span><div class="st-checks" style="--n:${R.length}">${R.map(([k, l]) => `<span title="${esc(l)}">${esc(SHORT[k] || l)}</span>`).join("")}</div><span>Ticks</span><span>${S.mode === "day" ? "Plan: 1–3%, before prior high" : "Plan"}</span><span></span></div>`;
  const extra = [S.pat !== "off" ? PAT_OPTS.find(o => o[0] === S.pat)[1].toLowerCase() : "", S.ins !== "off" ? INS_OPTS.find(o => o[0] === S.ins)[1].toLowerCase() : ""].filter(Boolean).join(" + ");
  if (!rows.length) { el.innerHTML = head + `<div class="empty"><strong>Nothing passes ${S.min ? S.min + "+ ticks" : "the filters"}${extra ? " with " + esc(extra) : ""} right now</strong>${S.pat !== "off" ? "Patterns are scanned for the top ~110 checklist names: lower the tick minimum or use “Scan live” on a stock. " : ""}Try a lower minimum, another universe, or check back nearer the open.</div>`; return; }
  const shown = rows.slice(0, S.show);
  el.innerHTML = head + shown.map(r => {
    const d = r.d, open = S.open === r.s;
    return `<div class="st-row${open ? " open" : ""}" data-s="${esc(r.s)}">
      <button class="tick" data-w="${esc(r.s)}" aria-pressed="${watch.has(r.s)}" title="${watch.has(r.s) ? "Remove from" : "Add to"} watchlist" aria-label="Watch ${esc(r.s)}">✓</button>
      <button class="st-main" aria-expanded="${open}"><b>${esc(r.s)}</b><span>${esc((d.name || "").slice(0, 26))} · <span class="num">${fp(d.px, 2)}</span> <span class="${d.chg > 0 ? "up" : d.chg < 0 ? "down" : ""}">${pct(d.chg, 2)}</span></span>${rowTags(r.s)}</button>
      <div class="st-checks" style="--n:${R.length}">${R.map(([k, l]) => `<span class="ck ${ckCls(r.c[k].pass)}" title="${esc(l)}: ${esc(r.c[k].val)}"><i>${mark(r.c[k].pass)}</i><em>${esc(SHORT[k] || l)}</em></span>`).join("")}</div>
      <div class="st-score ${r.pass >= 6 ? "hi" : r.pass >= 5 ? "mid" : ""}"><b>${r.pass}</b>/${R.length}</div>
      <div class="st-plan num">${planText(r)}</div>
      <button class="btn sm prime st-trade" data-t="${esc(r.s)}">Buy</button>
    </div>${open ? detailHTML(r) : ""}`;
  }).join("") + (rows.length > shown.length ? `<div class="st-more"><button class="btn sm" id="more">Show more (${rows.length - shown.length} left)</button></div>` : "")
    + `<div class="st-foot">${rows.length.toLocaleString("en-US")} stocks with ${S.min ? S.min + "+ ticks" : "any ticks"}${extra ? " · " + esc(extra) : ""} · ${S.mode === "day" ? "day-trade" : "long-term"} rules</div>`;
}
function detailHTML(r) {
  const R = RULES(), d = r.d, F = r.F || {}, N = r.N, tv = d.tv ? `${d.tv}-${r.s.replace(".", "_")}` : r.s;
  const crit = R.map(([k, l]) => `<div class="dt-c ${ckCls(r.c[k].pass)}"><i>${mark(r.c[k].pass)}</i><div><b>${esc(l)}</b><span>${esc(r.c[k].val)}</span></div></div>`).join("");
  const safe = u => /^https:\/\//.test(u || "") ? u : "#";
  const news = N && N.items && N.items.length ? `<div class="dt-sec"><h4>Latest headlines</h4><ul class="dt-news">${N.items.map(n => `<li class="${n.s > 0 ? "up" : n.s < 0 ? "down" : ""}"><a href="${esc(safe(n.l))}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a><small>${n.q === "pro" ? '<span class="tier">Wire</span> ' : n.q === "op" ? '<span class="tier op">Opinion</span> ' : ""}${esc(n.p)} · ${ago(new Date(n.ts * 1000).toISOString())}</small></li>`).join("")}</ul></div>` : "";
  const fil = N && N.sec && N.sec.length ? `<div class="dt-sec"><h4>SEC filings · last 10 days</h4><ul class="dt-news dt-sec-list">${N.sec.map(f => `<li class="${f.tone > 0 ? "up" : f.tone < 0 ? "down" : ""}"><a href="${esc(safe(f.u))}" target="_blank" rel="noopener noreferrer">${esc(f.l)}</a><small>${esc(f.d)}${f.ts ? " · " + fmtT(new Date(f.ts * 1000), UK) + " UK" : ""}</small></li>`).join("")}</ul></div>` : "";
  const rb = N && N.rd ? redditBuzz(N.rd) : null, stt = N && N.st && (N.st.bull + N.st.bear) ? N.st : null;
  const retail = rb || stt ? `<div class="dt-sec"><h4>Retail crowd</h4>${rb ? `<p>Reddit: <b>#${rb.rank}</b> most-mentioned · ${rb.m} mentions in 24h${rb.m24 ? ` (${rb.x.toFixed(1)}× the day before)` : ""}</p>` : ""}${stt ? `<p>StockTwits: ${stt.bull} bullish / ${stt.bear} bearish tags in the last ${stt.n} posts${stt.watch ? ` · ${stt.watch.toLocaleString("en-US")} watchers` : ""}</p>` : ""}</div>` : "";
  const hold = F.top && F.top.length ? `<div class="dt-sec"><h4>Top fund holders</h4><ul class="dt-hold">${F.top.map(([n, p, e]) => `<li><span class="nm">${e ? '<span class="pill cyan">ETF</span> ' : ""}${esc(n)}</span><b class="num">${isNum(p) ? p.toFixed(2) + "%" : "—"}</b></li>`).join("")}</ul></div>` : "";
  const an = F.rm != null ? `<div class="dt-sec"><h4>Analysts</h4><div class="dt-an">${[["Strong buy", F.sb], ["Buy", F.b], ["Hold", F.h], ["Sell", F.s], ["Strong sell", F.ss]].map(([n, v]) => `<span><b class="num">${v ?? "—"}</b>${n}</span>`).join("")}</div>${F.tgt ? `<p class="note">Average target ${fp(F.tgt, 2)} (${pct(F.up)}).${F.erd ? " Next earnings " + esc(F.erd) + "." : ""}</p>` : ""}</div>` : "";
  const p = r.plan, plan = p ? (S.mode === "day"
    ? `<p><b>Entry:</b> buy around ${fp(p.entry, 2)}. Take ${pct(p.tpPct)} at ${fp(p.tp, 2)}${p.capped ? `, just under yesterday's high (${fp(d.pdh, 2)})` : ""}. Stop ${fp(p.sl, 2)} (−${p.slPct}%).</p><p class="note">If it sells off first, wait for it to reclaim yesterday's close${isNum(p.dipLevel) ? " (" + fp(p.dipLevel, 2) + ")" : ""} before buying, then sell before yesterday's high.</p>`
    : `<p>Buy around ${fp(p.entry, 2)}, target ${fp(p.tp, 2)} (${pct(p.tpPct)}), stop ${fp(p.sl, 2)} (−${p.slPct}%).</p>`) : "";
  return `<div class="st-detail"><div class="dt-grid">${crit}</div>${patternsHTML(r.s)}<div class="dt-cols"><div class="dt-sec"><h4>Plan</h4>${plan}<p><a href="https://www.tradingview.com/symbols/${esc(tv)}/" target="_blank" rel="noopener">Open ${esc(r.s)} on TradingView</a></p></div>${insiderHTML(r.s)}${an}${retail}${fil}${news}${hold}</div></div>`;
}

/* ---------------- pattern & insider filters ---------------- */
const PAT_OPTS = [["off", "Patterns: off"], ["bull", "Any bullish pattern"], ["break", "Bullish breakouts only"], ...TIMEFRAMES.map(t => ["tf:" + t, "Bullish pattern on " + t]), ["bear", "Bearish warning (any)"]];
const INS_OPTS = [["off", "Insiders: off"], ["any", "Insider or whale buying"], ["insider", "Directors & officers buying"], ["whale", "Whales: 10% owners, 13D, big funds"]];
function renderFilters() {
  if (!PAT_OPTS.some(o => o[0] === S.pat)) S.pat = "off"; if (!INS_OPTS.some(o => o[0] === S.ins)) S.ins = "off";
  $("#patFilter").innerHTML = PAT_OPTS.map(([v, l]) => `<option value="${v}"${v === S.pat ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("#insFilter").innerHTML = INS_OPTS.map(([v, l]) => `<option value="${v}"${v === S.ins ? " selected" : ""}>${esc(l)}</option>`).join("");
}
$("#patFilter").addEventListener("change", e => { S.pat = e.target.value; store.set("uhe.strat.pat", S.pat); S.show = 60; renderList(); });
$("#insFilter").addEventListener("change", e => { S.ins = e.target.value; store.set("uhe.strat.ins", S.ins); S.show = 60; renderList(); });

// Live pattern scan: fresh 1m–1w candles from IC Markets (cTrader), patterns found in the browser.
async function scanLive(sym, btn) {
  if (!(S.broker && S.broker.ready)) return toast("Live scans use your IC Markets connection. Finish the cTrader setup first.");
  if (!S.pin) { toast("Unlock the IC Markets panel with your PIN first."); $("#broker").scrollIntoView({ behavior: "smooth", block: "center" }); const i = $("#pinIn"); if (i) i.focus(); return; }
  btn.disabled = true; btn.textContent = "Scanning 8 timeframes…";
  const j = await api("bars", { symbol: sym });
  if (!j.ok) { btn.disabled = false; btn.textContent = "Scan live (IC Markets)"; return toast(esc(j.error || "Live scan failed")); }
  const byTf = {};
  for (const tf of TIMEFRAMES) { const a = j.bars && j.bars[tf]; byTf[tf] = Array.isArray(a) ? findPatterns(a.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), { limit: 2 }) : []; }
  S.live[sym] = { asOf: j.asOf || new Date().toISOString(), byTf, src: j.symbol };
  renderList(); toast(`${esc(sym)}: live patterns from IC Markets (${esc(j.symbol)})`);
}

// Market-wide insider & whale buying across the stocks the engine covers.
function renderInsiders() {
  const el = $("#insiders"); if (!el) return;
  const D = (S.D.deep && S.D.deep.stocks) || {}, F = (S.D.fund && S.D.fund.stocks) || {}, N = newsMap();
  if (!S.D.fund && !S.D.news) { el.innerHTML = `<div class="eyebrow">Insider &amp; whale buying</div><div class="empty">Arrives after the next data-engine run.</div>`; return; }
  const rows = [], whales = [];
  for (const s of new Set([...Object.keys(F), ...Object.keys(N)])) {
    if (!D[s]) continue; const v = insView(s);
    for (const b of v.b30) rows.push({ s, ...b, cluster: v.cluster });
    if (v.stake || v.bigFund) whales.push({ s, v });
  }
  rows.sort((a, b) => (b.v || 0) - (a.v || 0));
  el.innerHTML = `<div class="ins-head"><div><div class="eyebrow">Insider &amp; whale buying · last 30 days</div><p class="note" style="margin-top:4px">Open-market purchases of $20k+ by directors, officers and 10% owners (SEC Form 4), new 13D stakes and big 13F adds. Insiders sell for many reasons; they usually buy for one.</p></div></div>
    ${rows.length ? `<div class="ins-tbl">${rows.slice(0, 12).map(b => `<button class="ins-row" data-go="${esc(b.s)}"><b>${esc(b.s)}</b><span>${esc(b.n)}<small>${esc(b.role || "Insider")}${b.ten ? " · 10% owner" : ""}</small></span><span class="num up">${usd(b.v)}</span><span class="muted">${dshort(b.d)}${b.cluster ? ' · <span class="tg ins">cluster</span>' : ""}</span></button>`).join("")}</div>` : `<div class="empty" style="padding:12px">No open-market insider buys over $20k in the covered stocks this month.</div>`}
    ${whales.length ? `<h4>Whale moves</h4><div class="pchips">${whales.slice(0, 14).map(w => chip(w.s, w.v.stake ? "13D" : "fund +" + Math.round(w.v.funds[0].ch) + "%", w.v.stake ? "New active 5%+ stake (13D)" : `${w.v.funds[0].n} added ${Math.round(w.v.funds[0].ch)}% (13F)`)).join("")}</div>` : ""}`;
}
$("#insiders").addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) goTo(b.dataset.go); });

// Pattern guide: our own sketches of each shape (clean lines, no noise).
const GUIDE = { hs: [[0, 2], [2, 6], [3, 4], [5, 9], [7, 4], [8, 6], [10, 1]], ihs: [[0, 8], [2, 4], [3, 6], [5, 1], [7, 6], [8, 4], [10, 9]], dt: [[0, 2], [3, 8], [5, 5], [7, 8], [10, 2]], db: [[0, 8], [3, 2], [5, 5], [7, 2], [10, 8]],
  asc: [[0, 1], [2, 7], [3, 3], [5, 7], [6, 4.5], [8, 7], [9, 6], [10, 9]], desc: [[0, 9], [2, 2], [3, 7], [5, 2], [6, 5.5], [8, 2], [9, 4], [10, 7]], bflag: [[0, 1], [3, 8], [4, 7], [5, 7.5], [6, 6.5], [7, 7], [8, 6], [10, 9.5]],
  sflag: [[0, 9], [3, 2], [4, 3], [5, 2.5], [6, 3.5], [7, 3], [8, 4], [10, 0.5]], cup: [[0, 8], [1, 6], [3, 2.5], [5, 2], [7, 2.5], [8.5, 7.5], [9, 6.5], [9.5, 7], [10, 9.5]],
  fwedge: [[0, 9], [2, 4], [3, 7], [5, 3], [6, 5], [8, 2.5], [9, 3.5], [10, 7]], rwedge: [[0, 1], [2, 6], [3, 4], [5, 7.5], [6, 6], [8, 8], [9, 7.5], [10, 3]], sym: [[0, 9], [2, 2], [4, 7.5], [5.5, 3.5], [7, 6.5], [8, 4.5], [10, 8]] };
function renderGuide() {
  $("#guide").innerHTML = `<div class="eyebrow">Pattern guide</div><div class="guide-grid">${Object.entries(PATTERNS).map(([id, p]) => { const g = GUIDE[id], X = x => 4 + x * 12.4, Y = y => 40 - y * 3.8;
    return `<div class="guide-c ${p.bias}"><svg viewBox="0 0 132 44" width="132" height="44" aria-hidden="true"><polyline points="${g.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}"/></svg><b>${esc(p.name)}</b><span class="pill ${p.bias === "bull" ? "long" : p.bias === "bear" ? "short" : "warn"}">${p.bias === "bull" ? "Bullish" : p.bias === "bear" ? "Bearish" : "Break decides"}</span><p>${esc(p.what)}</p></div>`; }).join("")}</div>
    <p class="note">Scanned on 1m, 5m, 10m, 30m, 1h, 4h, 1d and 1w for the top checklist names (intraday every engine run, 1h–1w hourly). “Scan live” pulls fresh candles for any stock from your IC Markets account. A pattern “broke out” only counts while price stays beyond the key level; targets are the classic measured move.</p>`;
}
$("#guideBtn").addEventListener("click", () => { const g = $("#guide"), open = g.hidden; g.hidden = !open; $("#guideBtn").setAttribute("aria-expanded", String(open)); if (open) renderGuide(); });

/* ---------------- rules editor ---------------- */
const RULE_FIELDS = {
  day: [["rsiMin", "RSI from"], ["rsiMax", "RSI up to"], ["rvolMin", "Volume ≥ × 20-day avg"], ["stBull", "StockTwits bullish ≥ %"], ["instMin", "Institutions hold ≥ %"], ["etfMin", "…or index funds in top holders ≥"], ["pcrMax", "Put/call below"], ["recMax", "Analyst rating ≤ (1 = strong buy)"], ["analystsMin", "Min. analysts"], ["insMinUsd", "Insider buy ≥ $ (30 days)"], ["fundsAdding", "…or firms adding (of top 10) ≥"], ["fundAddPct", "Firm counts as adding at +%"], ["patConf", "Pattern quality ≥ (0–100)"], ["tpPct", "Take profit % (1–3)"], ["slPct", "Stop loss %"]],
  long: [["rsiMin", "RSI ≥ on each of 5 days"], ["erFrom", "Earnings window from (days)"], ["erTo", "…to (days)"], ["instMin", "Institutions hold ≥ %"], ["etfMin", "…or index funds in top holders ≥"], ["recMax", "Analyst rating ≤"], ["analystsMin", "Min. analysts"], ["upsideMin", "Analyst target upside ≥ %"], ["divMin", "Dividend yield ≥ %"], ["insMinUsd", "Insider buy ≥ $ (30 days)"], ["fundsAdding", "…or firms adding (of top 10) ≥"], ["fundAddPct", "Firm counts as adding at +%"], ["patConf", "Pattern quality ≥ (0–100)"], ["tpPct", "Take profit %"], ["slPct", "Stop loss %"]]
};
const RULE_TEXT = {
  day: ["RSI in range and rising", "Yesterday's volume above its 20-day average", "Positive headline tone (48h) or bullish StockTwits", "Big institutions or index ETFs hold it", "Price above 20-day, 20-day above 50-day and rising", "More call volume than puts", "Analysts at Buy or better", "Insiders or firms buying: director/officer buys, a 10% owner or 13D whale, or several big firms adding in the latest 13F", "A bullish chart pattern (forming or just broken out) on 1m–1d"],
  long: ["RSI ≥ 50 on each of the last 5 days", "KST above its signal on each of the last 5 days", "Earnings 2–10 days away (the week-before buying window) with no bad news", "Big institutions or index ETFs hold it", "More call open interest than puts", "Analysts at Buy with target upside", "Dividend yield above your minimum", "Insiders or firms buying (as above)", "A bullish chart pattern on the 4h, daily or weekly chart"]
};
function renderRules() {
  const R = S.rules[S.mode];
  $("#rules").innerHTML = `<div class="rules-grid"><div><div class="eyebrow">${S.mode === "day" ? "Day trade" : "Long term"} checklist</div><ol class="rules-list">${RULE_TEXT[S.mode].map(t => `<li>${esc(t)}</li>`).join("")}</ol></div>
    <form class="form" id="rulesForm" novalidate>${RULE_FIELDS[S.mode].map(([k, l]) => `<label>${esc(l)}<input class="inp num" type="number" step="any" name="${k}" value="${R[k]}"></label>`).join("")}
    <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm prime" type="submit">Save rules</button><button class="btn sm" type="button" id="rulesReset">Reset to defaults</button></div></form></div>`;
}
$("#rules").addEventListener("submit", e => {
  e.preventDefault(); const f = new FormData(e.target), saved = store.get("uhe.strat", {}) || {};
  saved[S.mode] = Object.fromEntries([...f.entries()].map(([k, v]) => [k, +v]));
  S.rules = normRules(saved); store.set("uhe.strat", saved); renderRules(); renderList(); toast("Rules saved on this device.");
});
$("#rules").addEventListener("click", e => {
  if (e.target.id !== "rulesReset") return; const saved = store.get("uhe.strat", {}) || {}; delete saved[S.mode];
  store.set("uhe.strat", saved); S.rules = normRules(saved); renderRules(); renderList();
});
$("#rulesBtn").addEventListener("click", () => { const r = $("#rules"), open = r.hidden; r.hidden = !open; $("#rulesBtn").setAttribute("aria-expanded", String(open)); if (open) renderRules(); });

/* ---------------- controls ---------------- */
function minOptions() {
  const n = RULES().length, opts = [n, n - 1, n - 2, n - 3, n - 4, 0];
  if (!opts.includes(S.min)) S.min = opts.reduce((a, b) => Math.abs(b - S.min) < Math.abs(a - S.min) ? b : a, n - 3);
  $("#minPass").innerHTML = opts.map(v => `<option value="${v}"${v === S.min ? " selected" : ""}>${v === n ? `All ${n} ticks` : v ? `${v}+ ticks` : "Show all"}</option>`).join("");
}
function syncTabs() {
  $$("#modeTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === S.mode)));
  $$("#univTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.u === S.u)));
  minOptions();
}
$("#modeTabs").addEventListener("click", e => { const b = e.target.closest("button[data-m]"); if (!b) return; S.mode = b.dataset.m; S.open = null; S.show = 60; store.set("uhe.strat.mode", S.mode); syncTabs(); renderList(); if (!$("#rules").hidden) renderRules(); });
$("#univTabs").addEventListener("click", e => { const b = e.target.closest("button[data-u]"); if (!b) return; S.u = b.dataset.u; S.open = null; S.show = 60; store.set("uhe.strat.u", S.u); syncTabs(); renderList(); });
$("#minPass").addEventListener("change", e => { S.min = +e.target.value; store.set("uhe.strat.min", S.min); renderList(); });
$("#q").addEventListener("input", e => { S.q = e.target.value; S.show = 60; renderList(); });
$("#list").addEventListener("click", e => {
  const w = e.target.closest("[data-w]");
  if (w) { const s = w.dataset.w; let l = store.get("uhe.watch", []) || []; l = l.includes(s) ? l.filter(x => x !== s) : l.concat(s).slice(-25); store.set("uhe.watch", l); renderList(); return; }
  const t = e.target.closest("[data-t]"); if (t) { openTicket(t.dataset.t); return; }
  const lv = e.target.closest("[data-live]"); if (lv) { scanLive(lv.dataset.live, lv); return; }
  if (e.target.id === "more") { S.show += 60; renderList(); return; }
  const m = e.target.closest(".st-main"); if (m) { const s = m.closest(".st-row").dataset.s; S.open = S.open === s ? null : s; renderList(); }
});

/* ---------------- broker (IC Markets via cTrader) ---------------- */
async function api(action, extra = {}) {
  let r, j;
  try { r = await fetch("/api/trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, pin: S.pin, ...extra }) }); }
  catch { return { ok: false, error: "Can't reach the trading bridge." }; }
  try { j = await r.json(); } catch { j = { ok: false, error: "HTTP " + r.status }; }
  if (r.status === 401) S.pin = null;
  return j;
}
async function brokerStatus() {
  try { const r = await fetch("/api/trade", { cache: "no-store" }); if (!r.ok) throw new Error(); S.broker = await r.json(); } catch { S.broker = { error: true }; }
  renderBroker();
}
const envPill = env => `<span class="pill ${env === "live" ? "short" : "cyan"}">${env === "live" ? "LIVE · real money" : "DEMO"}</span>`;
function renderBroker() {
  const b = S.broker, el = $("#broker");
  if (!b) return;
  if (b.error) { el.innerHTML = `<div class="eyebrow">IC Markets · cTrader</div><div class="empty"><strong>Trading bridge offline</strong>The /api/trade function didn't answer. Redeploy on Vercel and refresh.</div>`; return; }
  const c = b.configured || {}, head = `<div class="br-head"><div><div class="eyebrow">IC Markets · cTrader Open API</div><b class="br-title">${S.acct ? "Connected" : b.ready ? "Ready" : "Not connected"}</b></div>${envPill(b.env)}</div>`;
  if (!b.ready) {
    const item = (ok, t) => `<li class="${ok ? "ok" : ""}"><i>${ok ? "✓" : "•"}</i>${t}</li>`;
    el.innerHTML = head + `<ul class="br-setup">${item(c.app, "cTrader app: <code>CTRADER_CLIENT_ID</code> + <code>CTRADER_CLIENT_SECRET</code>")}${item(c.token, "Access token: <code>CTRADER_ACCESS_TOKEN</code>")}${item(c.account, "Account: <code>CTRADER_ACCOUNT_ID</code>")}${item(c.pin, "Trading PIN: <code>TRADE_PIN</code> (8+ characters)")}</ul>
      <p class="note">Add these in Vercel → Settings → Environment Variables, then redeploy. Start on a demo account (<code>CTRADER_ENV=demo</code>).</p>
      ${c.app && c.token && c.pin && !c.account ? `<form class="br-unlock" id="acctForm"><input class="inp" type="password" id="pinIn" placeholder="Trading PIN" autocomplete="off" aria-label="Trading PIN"><button class="btn sm prime">Find my account IDs</button></form><div id="acctList" class="note"></div>` : ""}`;
    return;
  }
  if (!S.pin || !S.acct) {
    el.innerHTML = head + `<p class="br-sub">Unlock with your trading PIN to see your balance and positions and to place orders. The PIN stays in this tab only.</p>
      <form class="br-unlock" id="unlockForm"><input class="inp" type="password" id="pinIn" placeholder="Trading PIN" autocomplete="off" aria-label="Trading PIN"><button class="btn sm prime">Unlock</button></form>
      <div class="form-msg" id="brMsg">${esc(S.acctErr)}</div><p class="note">Max per order: $${b.maxUsd.toLocaleString("en-US")} · stop loss always attached.</p>`;
    return;
  }
  const a = S.acct.account || {}, P = S.acct.positions || [], ccy = a.ccy === "USD" ? "$" : a.ccy === "GBP" ? "£" : a.ccy === "EUR" ? "€" : (a.ccy ? a.ccy + " " : "");
  el.innerHTML = head + `<div class="kv br-kv"><div><span>Balance</span><b>${money(a.balance, ccy)}</b></div><div><span>Open P&amp;L</span><b class="${P.reduce((t, p) => t + (p.pnl || 0), 0) >= 0 ? "up" : "down"}">${money(P.reduce((t, p) => t + (p.pnl || 0), 0), "$")}</b></div><div><span>Leverage</span><b>${a.leverage ? "1:" + a.leverage : "—"}</b></div></div>
    <div class="br-pos">${P.length ? P.map(p => `<div class="br-p"><div><b>${esc(p.symbol)}</b> <small class="muted">${esc(p.side)} ${p.units} @ ${fp(p.price, 2)}</small><small class="muted">SL ${fp(p.sl, 2)} · TP ${fp(p.tp, 2)}${p.label ? " · " + esc(p.label) : ""}</small></div><b class="num ${p.pnl >= 0 ? "up" : "down"}">${p.pnl == null ? "—" : money(p.pnl, "$")}</b><button class="btn sm" data-close="${esc(p.id)}">Close</button></div>`).join("") : `<div class="empty" style="padding:12px">No open positions</div>`}</div>
    <div class="br-actions"><button class="btn sm" id="brRefresh">Refresh</button><button class="btn sm" id="brLock">Lock</button><span class="muted" style="font-size:11.5px">Login ${esc(a.login || "—")} · cap $${b.maxUsd.toLocaleString("en-US")}/order</span></div>`;
}
async function refreshAccount(quiet) {
  const j = await api("account");
  if (j.ok) { S.acct = j; S.acctErr = ""; }
  else { if (!S.pin) S.acct = null; S.acctErr = j.error || "Couldn't load the account."; if (!quiet) toast(esc(S.acctErr)); }
  renderBroker();
}
$("#broker").addEventListener("submit", async e => {
  e.preventDefault(); const pin = ($("#pinIn") || {}).value || ""; if (!pin) return;
  S.pin = pin; const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Checking…";
  if (e.target.id === "acctForm") {
    const j = await api("accounts"); btn.disabled = false; btn.textContent = "Find my account IDs";
    $("#acctList").innerHTML = j.ok ? (j.accounts.length ? j.accounts.map(a => `Account ID <b class="num">${esc(a.id)}</b> · login ${esc(a.login)} · ${a.live ? "LIVE" : "demo"} · ${esc(a.broker)}`).join("<br>") + "<br>Put the ID in <code>CTRADER_ACCOUNT_ID</code> and redeploy." : "No accounts on this token.") : esc(j.error);
    return;
  }
  await refreshAccount(true);
});
$("#broker").addEventListener("click", async e => {
  if (e.target.id === "brRefresh") return refreshAccount();
  if (e.target.id === "brLock") { S.pin = null; S.acct = null; renderBroker(); return; }
  const c = e.target.closest("[data-close]"); if (!c) return;
  if (c.dataset.armed !== "1") { c.dataset.armed = "1"; c.textContent = "Confirm close"; c.classList.add("warn"); setTimeout(() => { if (c.isConnected) { c.dataset.armed = ""; c.textContent = "Close"; c.classList.remove("warn"); } }, 4000); return; }
  c.disabled = true; c.textContent = "Closing…";
  const j = await api("close", { positionId: c.dataset.close });
  toast(j.ok ? `Closed position ${esc(j.closed)}${j.price ? " at " + fp(j.price, 2) : ""}` : esc(j.error || "Close failed"));
  refreshAccount(true);
});
setInterval(() => { if (S.pin && S.acct && document.visibilityState === "visible") refreshAccount(true); }, 30e3);

/* ---------------- order ticket ---------------- */
const T = {};
function openTicket(sym) {
  const r = currentRows(S.mode, S.u, 0).find(x => x.s === sym) || rank(S.mode, { [sym]: S.D.deep.stocks[sym] }, (S.D.options || {}).chains || {}, (S.D.fund || {}).stocks || {}, (S.D.news || {}).stocks || {}, S.rules, { watch: new Set([sym]) })[0];
  if (!r || !r.plan) return toast("No price for " + esc(sym) + " yet.");
  const R = S.rules[S.mode];
  Object.assign(T, { r, s: sym, mode: S.mode, usd: store.get("uhe.tk.usd", 1000), tpPct: R.tpPct, slPct: R.slPct, cap: S.mode === "day" && !!r.plan.capped, live: false, busy: false, result: "" });
  T.lastFocus = document.activeElement;
  renderTicket(); $("#scrim").hidden = false; $("#ticket").hidden = false; document.body.style.overflow = "hidden";
  setTimeout(() => { const i = $("#tkUsd"); if (i) i.focus(); }, 30);
}
function closeTicket() { $("#scrim").hidden = true; $("#ticket").hidden = true; document.body.style.overflow = ""; if (T.lastFocus && T.lastFocus.focus) T.lastFocus.focus(); }
function calc() {
  const p = T.r.plan, d = T.r.d, entry = p.entry, units = T.usd > 0 ? T.usd / entry : 0;
  let tp = entry * (1 + T.tpPct / 100), capped = false;
  if (T.cap && isNum(d.pdh) && d.pdh > entry * 1.003 && d.pdh * 0.998 < tp) { tp = d.pdh * 0.998; capped = true; }
  const sl = entry * (1 - T.slPct / 100);
  return { entry, units, tp, sl, capped, reward: (tp - entry) * units, risk: (entry - sl) * units, rr: (tp - entry) / (entry - sl) };
}
function renderTicket() {
  const r = T.r, d = r.d, b = S.broker || {}, k = calc(), R = RULES(), miss = R.filter(([key]) => r.c[key].pass !== true).map(([, l]) => l);
  const ready = b.ready, env = b.env || "demo";
  $("#tkBody").innerHTML = `<div class="eyebrow">${T.mode === "day" ? "Day trade" : "Long term"} · market order</div>
    <h3 id="tkTitle" class="tk-title">Buy ${esc(r.s)} ${envPill(env)}</h3>
    <p class="muted" style="margin:2px 0 12px">${esc(d.name || "")} · last ${fp(d.px, 2)} · ${r.pass}/${R.length} ticks${miss.length ? " · missing: " + esc(miss.join(", ")) : " · all rules pass"}</p>
    <form class="form" id="tkForm" novalidate>
      <label>Amount ($)<input class="inp num" id="tkUsd" type="number" min="1" step="any" value="${T.usd}"></label>
      <label>Stop loss %<input class="inp num" id="tkSl" type="number" min="0.2" max="15" step="any" value="${T.slPct}"></label>
      <label class="full">Take profit ${T.mode === "day" ? "(1–3%)" : "%"} · <span class="num" id="tkTpV">${T.tpPct.toFixed(2)}%</span>
        <input id="tkTp" type="range" min="${T.mode === "day" ? 1 : 2}" max="${T.mode === "day" ? 3 : 30}" step="${T.mode === "day" ? 0.25 : 0.5}" value="${T.tpPct}"></label>
      ${T.mode === "day" && isNum(d.pdh) ? `<label class="full tk-check"><input type="checkbox" id="tkCap" ${T.cap ? "checked" : ""}> Sell before yesterday's high (${fp(d.pdh, 2)})</label>` : ""}
      <div class="full kv tk-kv"><div><span>Shares ≈</span><b>${k.units ? k.units.toFixed(2) : "—"}</b></div><div><span>Target</span><b class="up">${fp(k.tp, 2)}</b></div><div><span>Stop</span><b class="down">${fp(k.sl, 2)}</b></div>
        <div><span>Reward ≈</span><b class="up">${money(k.reward)}</b></div><div><span>Risk ≈</span><b class="down">${money(-k.risk)}</b></div><div><span>Reward : risk</span><b>${isNum(k.rr) ? k.rr.toFixed(2) : "—"}</b></div></div>
      <p class="full note" style="margin:0">Fills at the live IC Markets price; the stop and target are set as distances from the fill${k.capped ? ", with the target just under yesterday's high" : ""}.</p>
      ${env === "live" ? `<label class="full tk-check tk-live"><input type="checkbox" id="tkLive" ${T.live ? "checked" : ""}> I understand this is my LIVE account and real money</label>` : ""}
      ${!S.pin ? `<label class="full">Trading PIN<input class="inp" id="tkPin" type="password" autocomplete="off"></label>` : ""}
      <div class="full tk-go">${ready ? `<button class="btn prime" id="tkSend" ${T.busy ? "disabled" : ""}>${T.busy ? "Sending…" : `Buy ${esc(r.s)} · ${env === "live" ? "LIVE" : "DEMO"}`}</button>` : `<span class="warnline">IC Markets isn't connected yet. Finish the setup in the panel above.</span>`}
        <button class="btn sm" type="button" id="tkFind">Check IC symbol</button></div>
      <div class="full form-msg" id="tkMsg">${T.result}</div>
    </form>`;
}
$("#ticket").addEventListener("input", e => {
  const id = e.target.id;
  if (id === "tkUsd") { T.usd = Math.max(0, +e.target.value || 0); store.set("uhe.tk.usd", T.usd); }
  else if (id === "tkSl") T.slPct = Math.min(15, Math.max(0.2, +e.target.value || T.slPct));
  else if (id === "tkTp") T.tpPct = +e.target.value;
  else if (id === "tkCap") T.cap = e.target.checked;
  else if (id === "tkLive") T.live = e.target.checked;
  else return;
  const k = calc(), kv = $(".tk-kv");
  if (id === "tkTp") $("#tkTpV").textContent = T.tpPct.toFixed(2) + "%";
  if (kv) kv.innerHTML = `<div><span>Shares ≈</span><b>${k.units ? k.units.toFixed(2) : "—"}</b></div><div><span>Target</span><b class="up">${fp(k.tp, 2)}</b></div><div><span>Stop</span><b class="down">${fp(k.sl, 2)}</b></div><div><span>Reward ≈</span><b class="up">${money(k.reward)}</b></div><div><span>Risk ≈</span><b class="down">${money(-k.risk)}</b></div><div><span>Reward : risk</span><b>${isNum(k.rr) ? k.rr.toFixed(2) : "—"}</b></div>`;
});
$("#ticket").addEventListener("click", async e => {
  if (e.target.id !== "tkFind") return;
  const pin = ($("#tkPin") || {}).value; if (pin) S.pin = pin;
  if (!S.pin) { $("#tkMsg").textContent = "Enter your trading PIN first."; return; }
  $("#tkMsg").textContent = "Looking up…";
  const j = await api("find", { symbol: T.s });
  $("#tkMsg").innerHTML = j.ok ? (j.matches.length ? "IC Markets symbol: " + j.matches.slice(0, 3).map(m => `<b>${esc(m.name)}</b>${m.desc ? " (" + esc(m.desc) + ")" : ""}`).join(", ") : "No matching symbol on your cTrader account.") : `<span class="down">${esc(j.error)}</span>`;
});
$("#ticket").addEventListener("submit", async e => {
  e.preventDefault(); if (T.busy) return;
  const pin = ($("#tkPin") || {}).value; if (pin) S.pin = pin;
  if (!S.pin) { $("#tkMsg").textContent = "Enter your trading PIN."; return; }
  if ((S.broker || {}).env === "live" && !T.live) { $("#tkMsg").innerHTML = `<span class="down">Tick the live-account box first.</span>`; return; }
  const k = calc(); if (!(T.usd > 0)) { $("#tkMsg").textContent = "Enter an amount."; return; }
  T.busy = true; T.result = ""; renderTicket();
  const j = await api("order", { symbol: T.s, usd: T.usd, tpPct: T.tpPct, slPct: T.slPct, tpPrice: k.capped ? +k.tp.toFixed(4) : undefined, refPx: k.entry, mode: T.mode, confirmLive: T.live });
  T.busy = false;
  T.result = j.ok
    ? `<span class="up">${j.status === "ORDER_FILLED" ? "Filled" : "Sent"}: ${esc(j.units)} ${esc(j.symbol)}${j.fill ? " at " + fp(j.fill, 2) : ""} · stop ${fp(j.sl, 2)} · target ${fp(j.tp, 2)} (${esc((j.env || "").toUpperCase())})</span>${j.note ? `<br><span class="muted">${esc(j.note)}</span>` : ""}`
    : `<span class="down">${esc(j.error || "Order failed")}</span>`;
  renderTicket();
  if (j.ok) { toast(`${esc(j.symbol)} order ${j.status === "ORDER_FILLED" ? "filled" : "sent"} (${esc((j.env || "").toUpperCase())})`); refreshAccount(true); }
});
$("#tkClose").addEventListener("click", closeTicket);
$("#scrim").addEventListener("click", closeTicket);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#ticket").hidden) closeTicket(); });

/* ---------------- boot ---------------- */
{ const a = $("nav.jump a[aria-current=page]"); if (a) a.parentElement.scrollLeft = a.offsetLeft - 16; }
syncTabs(); renderFilters(); renderPhase(); setInterval(renderPhase, 30e3);
(async () => {
  await Promise.all(Object.keys(FEEDS).map(load));
  renderChips(); renderList(); renderPulse(); renderInsiders();
  for (const [k, f] of Object.entries(FEEDS)) setInterval(async () => { if (document.visibilityState !== "visible") return; await load(k); renderChips(); if (k === "pulse") renderPulse(); if (k === "fund" || k === "news") renderInsiders(); if (!$("#ticket").hidden) return; renderList(); }, f.every);
})();
brokerStatus();
