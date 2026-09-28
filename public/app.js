// Upper Hand Edge — live NY-open command dashboard (browser).
import {
  UK, NY, clip, isNum, nums, fp, fpct, fsig, tzParts, wallToDate, fmtT, fmtDay, isTD, clock, nyOpenUKMin, ukMinOf,
  DEFAULTS, COMP, COT_MAP, COT_NAMES, FIN_NAMES, CLS_NAMES, FUT_NAME, TV, TV_FUT, normCfg,
  applyLive, buildModel, regime, calItems, parseScan, spBias, erLabel, autoBrief
} from "./model.js";

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fk(n) { if (!isNum(n)) return "—"; const a = Math.abs(n), s = n < 0 ? "−" : n > 0 ? "+" : ""; return a >= 1e6 ? s + (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? s + (a / 1e3).toFixed(1) + "K" : s + a.toFixed(0); }
const cls = x => !isNum(x) ? "flat" : x > 0 ? "up" : x < 0 ? "down" : "flat";
const col = x => !isNum(x) ? "var(--flat)" : x > 0 ? "var(--long)" : x < 0 ? "var(--short)" : "var(--flat)";
function toast(msg, ms = 4500) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }
function dur(ms) { const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`; }
const hm = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const ymdLabel = d => d ? fmtDay(d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), { day: "numeric", month: "short" }) : "";
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

/* ================= state & feeds ================= */
const S = {
  D: { quotes: null, basis: null, markets: null, scan: null, flow: null, calendar: null, brief: null }, meta: {},
  live: {}, M: null, SP: null, settings: store.get("uhe.model", null), draft: null, journal: store.get("uhe.journal", []),
  cls: "all", sort: "conv", open: null, openStock: null, mapMetric: "gap", orderIds: null, edgeIds: null, prevPx: {},
  chart: { id: "US500", feed: "cfd", key: null, visible: false }, drFeed: "cfd", drKey: null, heatOn: false,
  briefMode: "ai", autoCache: null, snap: store.get("uhe.snap", null), notify: store.get("uhe.notify", false), snapBusy: false, lastFocus: null
};
if (!Array.isArray(S.journal)) S.journal = [];
const FEEDS = {
  quotes: { url: "/api/quotes", every: 5e3, hidden: 30e3 },
  basis: { url: "/api/basis", every: 60e3 },
  markets: { url: "/api/markets", every: 120e3 },
  scan: { url: "/api/scan", every: 60e3, hidden: 180e3 },
  calendar: { url: "/api/calendar", every: 15 * 60e3 },
  flow: { url: "/api/flow", every: 3 * 3600e3 },
  brief: { url: "/api/brief", every: 10 * 60e3 }
};
async function load(k) {
  const f = FEEDS[k], m = S.meta[k] = S.meta[k] || { fails: 0 };
  if (m.busy) return m.busy;
  m.busy = (async () => {
    try {
      const r = await fetch(f.url, { headers: { Accept: "application/json" }, cache: "no-cache" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error((j && j.error) || "HTTP " + r.status);
      S.D[k] = j; m.ok = Date.now(); m.fails = 0; m.err = null;
      onData(k);
    } catch (e) { m.fails++; m.err = String((e && e.message) || e); onFail(k); }
    finally { m.busy = null; }
  })();
  return m.busy;
}
function loop(k) {
  const f = FEEDS[k];
  const run = async () => {
    await load(k);
    const m = S.meta[k];
    let wait = document.hidden && f.hidden ? f.hidden : f.every;
    if (m.fails) wait = Math.min(Math.max(f.every, 60e3), 5e3 * 2 ** Math.min(m.fails, 6));
    clearTimeout(m.timer); m.timer = setTimeout(run, wait);
  };
  run();
}
function onData(k) {
  if (k === "quotes" || k === "basis" || k === "markets" || k === "flow") recompute();
  if (k === "markets") { reorder(); renderLab(); renderSymList(); renderChartSyms(); }
  if (k === "flow") { renderCot(); renderFinra(); }
  if (k === "scan") { S.SP = parseScan(S.D.scan); renderScanner(); renderSymList(); if (S.openStock) renderStockDrawer(); }
  if (k === "calendar") { renderCal(); renderNext(); renderTimeline(); }
  if (k === "brief" && S.D.brief && S.D.brief.ai === false && !S.D.brief.error) FEEDS.brief.every = 6 * 3600e3;
  if (k === "brief" || k === "scan" || k === "calendar" || k === "markets") renderBrief();
  renderStatus();
}
function onFail(k) {
  renderStatus();
  if (!S.D[k]) {
    if (k === "markets") { renderEdges(); renderMatrix(); renderRegime(); renderLab(); }
    if (k === "scan") renderScanner();
    if (k === "flow") { renderCot(); renderFinra(); }
    if (k === "calendar") { renderCal(); renderNext(); }
  }
}
function eff() { const c = normCfg(S.settings), d = S.draft || {}; return { weights: d.weights || c.weights, longAt: isNum(d.longAt) ? d.longAt : c.longAt, shortAt: isNum(d.shortAt) ? d.shortAt : c.shortAt }; }
function recompute() {
  if (!S.D.markets) return;
  const L = applyLive(S.D.markets, S.D.quotes, S.D.basis);
  S.live = L.live;
  const fl = S.D.flow || {};
  S.M = buildModel({ instruments: L.instruments, context: L.context, cot: fl.cot, finra: fl.finra }, eff());
  if (S.M && (!S.orderIds || !S.edgeIds)) reorder();
  schedule();
}
function sortedRows() {
  const k = { conv: r => r.conv, score: r => r.score, bear: r => -r.score, chg: r => Math.abs(r.chg || 0), adr: r => r.left == null ? -1 : r.left, none: r => -r.order }[S.sort] || (r => r.conv);
  return S.M.rows.slice().sort((a, b) => k(b) - k(a));
}
// Order is refreshed every minute (and on user actions) so cards don't jump around on every tick.
function reorder() {
  if (!S.M) return;
  S.orderIds = sortedRows().map(r => r.id);
  S.edgeIds = S.M.rows.filter(r => r.bias !== "neutral").sort((a, b) => b.conv - a.conv).slice(0, 4).map(r => r.id);
}
// Live re-renders wait while a pointer is down, so a tap on a card is never swallowed by a refresh.
let raf = 0, ptr = false, ptrUntil = 0;
document.addEventListener("pointerdown", () => { ptr = true; }, true);
["pointerup", "pointercancel"].forEach(t => document.addEventListener(t, () => { ptr = false; ptrUntil = Date.now() + 300; }, true));
function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (ptr || Date.now() < ptrUntil) { setTimeout(schedule, 120); return; } renderLive(); }); }
function renderLive() {
  renderRegime(); renderEdges(); renderMatrix(); renderSnap(); renderChartQuote(); renderChartSyms();
  if (S.open) renderDrawer();
  if (S.M) for (const r of S.M.rows) S.prevPx[r.id] = r.px;
}
function flash(root) {
  if (!S.M) return;
  for (const el of root.querySelectorAll("[data-pxid]")) {
    const r = S.M.map[el.dataset.pxid], prev = S.prevPx[el.dataset.pxid];
    if (r && isNum(prev) && isNum(r.px) && r.px !== prev) el.classList.add(r.px > prev ? "fl-up" : "fl-dn");
  }
}
function keepFocus(root, fn) {
  const a = document.activeElement, id = a && root.contains(a) && a.dataset ? a.dataset.id : null;
  fn();
  if (id) { const n = root.querySelector(`[data-id="${CSS.escape(id)}"]`); if (n) n.focus({ preventScroll: true }); }
}

/* ================= TradingView embeds ================= */
function tvEmbed(el, kind, cfg) {
  el.innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "tradingview-widget-container";
  const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; inner.style.height = kind === "ticker-tape" ? "auto" : "calc(100% - 28px)"; inner.style.width = "100%";
  const cr = document.createElement("div"); cr.className = "tradingview-widget-copyright";
  cr.innerHTML = `<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">Charts and live prices by TradingView</a>`;
  const s = document.createElement("script"); s.type = "text/javascript"; s.async = true;
  s.src = `https://s3.tradingview.com/external-embedding/embed-widget-${kind}.js`; s.textContent = JSON.stringify(cfg);
  wrap.append(inner, cr, s); el.append(wrap);
}
const chartCfg = (symbol, interval = "15") => ({ autosize: true, symbol, interval, timezone: "Europe/London", theme: "dark", style: "1", locale: "en", backgroundColor: "rgba(7, 11, 22, 1)", gridColor: "rgba(140, 170, 255, 0.06)", allow_symbol_change: true, calendar: false, hide_volume: false, support_host: "https://www.tradingview.com" });
function tvTape() {
  const order = ["US500", "NAS100", "US30", "US2000", "UK100", "GER40", "EU50", "EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "WTI", "BTCUSD", "ETHUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP", "GBPJPY", "EURJPY", "AUDJPY", "GBPAUD", "XAGUSD"];
  tvEmbed($("#tape"), "ticker-tape", { symbols: order.map(id => ({ proName: TV[id], title: id })).concat([{ proName: "TVC:DXY", title: "DXY" }]), showSymbolLogo: true, isTransparent: true, displayMode: "adaptive", colorTheme: "dark", locale: "en" });
}
const tvSym = (id, feed) => feed === "fut" && TV_FUT[id] ? TV_FUT[id] : TV[id];
function mountMainChart() {
  if (!S.chart.visible) return;
  const key = S.chart.id + "|" + S.chart.feed; if (S.chart.key === key) return;
  S.chart.key = key; tvEmbed($("#tvMain"), "advanced-chart", chartCfg(tvSym(S.chart.id, S.chart.feed)));
}
function mountHeat() {
  if (S.heatOn) return; S.heatOn = true;
  tvEmbed($("#tvHeat"), "stock-heatmap", { exchanges: [], dataSource: "SPX500", grouping: "sector", blockSize: "market_cap_basic", blockColor: "change", locale: "en", symbolUrl: "", colorTheme: "dark", hasTopBar: true, isDataSetEnabled: false, isZoomEnabled: true, hasSymbolTooltip: true, isMonoSize: false, width: "100%", height: "100%" });
}

/* ================= svg ================= */
function spark(vals, color, w = 240, h = 40, opts = {}) {
  if (!vals || vals.length < 2) return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const mn = Math.min(...vals, opts.ref != null ? opts.ref : Infinity), mx = Math.max(...vals, opts.ref != null ? opts.ref : -Infinity), span = mx - mn || 1, pad = 3;
  const X = i => pad + i * (w - 2 * pad) / (vals.length - 1), Y = v => pad + (h - 2 * pad) * (1 - (v - mn) / span);
  const d = vals.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join("");
  const id = "g" + Math.random().toString(36).slice(2, 8);
  const ref = opts.ref != null ? `<line x1="0" x2="${w}" y1="${Y(opts.ref).toFixed(1)}" y2="${Y(opts.ref).toFixed(1)}" style="stroke:rgba(255,255,255,.22);stroke-dasharray:3 4"/>` : "";
  const dot = opts.dot ? `<circle cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="2.6" style="fill:${color};filter:drop-shadow(0 0 4px ${color})"/>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.35"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>${ref}<path d="${d}L${X(vals.length - 1).toFixed(1)} ${h}L${X(0)} ${h}Z" fill="url(#${id})"/><path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;filter:drop-shadow(0 0 4px ${color})" vector-effect="non-scaling-stroke"/>${dot}</svg>`;
}
function arc(score, bias, w = 74, h = 46, big = false) {
  const cx = w / 2, cy = h - 4, r = Math.min(w / 2 - 6, h - 10), s = clip(score, 0, 100) / 100;
  const P = a => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const [x0, y0] = P(Math.PI), [x1, y1] = P(Math.PI * (1 - s)), [xe, ye] = P(0);
  const c = bias === "long" ? "var(--long)" : bias === "short" ? "var(--short)" : "var(--cyan)";
  return `<svg class="arc" viewBox="0 0 ${w} ${h}" style="${big ? `width:${w}px;height:${h}px` : ""}" role="img" aria-label="Edge score ${score}"><path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${xe} ${ye}" style="fill:none;stroke:rgba(255,255,255,.08);stroke-width:${big ? 10 : 6};stroke-linecap:round"/><path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" style="fill:none;stroke:${c};stroke-width:${big ? 10 : 6};stroke-linecap:round;filter:drop-shadow(0 0 6px ${c})"/><text x="${cx}" y="${cy - (big ? 10 : 3)}" text-anchor="middle" style="fill:var(--ink);font-size:${big ? 30 : 16}px">${score}</text></svg>`;
}
const pill = (b, short) => `<span class="pill ${b}">${b === "long" ? (short ? "Long" : "Long bias") : b === "short" ? (short ? "Short" : "Short bias") : "Neutral"}</span>`;
function srcTag(id) {
  const l = S.live[id];
  if (!l) return `<span class="src cl" title="Waiting for a live quote; showing 15-minute session data">Session</span>`;
  if (!l.fresh) return `<span class="src cl" title="No trades in the last 20 minutes">Closed</span>`;
  if (l.src === "etf") return `<span class="src rt" title="Real-time estimate: ${esc(l.etf)} price × the ${esc(FUT_NAME[id] || "")} futures/${esc(l.etf)} ratio">Live · ${esc(l.etf)}</span>`;
  if (l.delay) return `<span class="src dl" title="This exchange feed is delayed ${l.delay} minutes on free data. The ticker tape and chart stream in real time.">${l.delay}m delay</span>`;
  return `<span class="src rt">Live</span>`;
}
const waitMsg = k => { const m = S.meta[k]; return m && m.fails && m.err ? `Couldn't load data (${esc(m.err)}). Retrying…` : "Connecting to live data…"; };

/* ================= HUD / status ================= */
function renderClocks() { const now = new Date(); $("#clkUK").textContent = fmtT(now, UK); $("#clkNY").textContent = fmtT(now, NY); }
function renderLiveChip() {
  const el = $("#liveChip"), m = S.meta.quotes, now = Date.now();
  const age = m && m.ok ? now - m.ok : Infinity, lim = document.hidden ? 45e3 : 15e3;
  const st = age < lim ? "on" : age < 120e3 ? "lag" : m && (m.ok || m.fails) ? "off" : "";
  el.className = "live " + st;
  const q = S.D.quotes, at = q && q.asOf ? new Date(q.asOf) : null;
  const txt = st === "on" ? `LIVE · ${at ? new Intl.DateTimeFormat("en-GB", { timeZone: UK, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(at) : ""}` : st === "lag" ? "RECONNECTING" : st === "off" ? "OFFLINE · RETRYING" : "CONNECTING";
  el.querySelector("span").textContent = txt;
  el.title = q && q.mode === "chart-meta" ? "Live quotes via the fallback feed" : "Quotes refresh every 5 seconds";
}
function renderStatus() {
  const chips = [], D = S.D;
  const chip = (ok, label, title) => `<span class="chip ${ok}" title="${esc(title || "")}"><span class="dot"></span>${label}</span>`;
  const mk = D.markets;
  if (mk && mk.asOf) chips.push(chip(mk.errors && mk.errors.length ? "warn" : "ok", `Sessions ${fmtT(new Date(mk.asOf), UK)}`, (mk.errors || []).join("\n") || "15-minute session bars and NY-open statistics"));
  else if (S.meta.markets && S.meta.markets.fails) chips.push(chip("bad", "Sessions offline", S.meta.markets.err));
  if (D.scan && D.scan.asOf) chips.push(chip("ok", `S&amp;P scan ${fmtT(new Date(D.scan.asOf), UK)}`, `${D.scan.breadth ? D.scan.breadth.n : ""} stocks`));
  else if (S.meta.scan && S.meta.scan.fails) chips.push(chip("bad", "Scanner offline", S.meta.scan.err));
  const cot = D.flow && D.flow.cot, fin = D.flow && D.flow.finra;
  if (cot && cot.report) chips.push(`<span class="hide-sm">${chip("ok", "COT " + esc(fmtDay(cot.report, { day: "numeric", month: "short" })), cot.source)}</span>`);
  if (fin && fin.latest) chips.push(`<span class="hide-sm">${chip("ok", "FINRA " + esc(ymdLabel(fin.latest)), fin.source)}</span>`);
  $("#status").innerHTML = chips.join("");
}

/* ================= deck ================= */
function renderRing() {
  const c = clock(), now = c.now;
  const todayUK = tzParts(now, UK).ymd;
  const lonOpen = wallToDate(todayUK, "08:00", UK);
  let target, from, cap, eyebrow;
  if (c.state === "open") { target = c.close; from = wallToDate(c.todayNY, "09:30", NY); cap = "NY session live"; eyebrow = "Time to US close"; }
  else { target = c.open; from = now >= lonOpen && now < c.open && c.day === c.todayNY ? lonOpen : new Date(c.open.getTime() - 6.5 * 3600000); cap = "to New York open"; eyebrow = c.day === c.todayNY ? "Countdown · today" : `Countdown · ${fmtDay(c.day)}`; }
  const total = target - from, left = Math.max(0, target - now), prog = clip(1 - left / total, 0, 1);
  const H = Math.floor(left / 3600000), Mi = Math.floor(left % 3600000 / 60000), Se = Math.floor(left % 60000 / 1000);
  const R = 100, C = 2 * Math.PI * R;
  const ticks = Array.from({ length: 60 }, (_, i) => { const a = i / 60 * 2 * Math.PI; const r1 = 112, r2 = i % 5 ? 116 : 120; return `<line x1="${120 + r1 * Math.cos(a)}" y1="${120 + r1 * Math.sin(a)}" x2="${120 + r2 * Math.cos(a)}" y2="${120 + r2 * Math.sin(a)}" style="stroke:${i / 60 <= prog ? "rgba(0,229,255,.8)" : "rgba(255,255,255,.12)"};stroke-width:${i % 5 ? 1 : 2}"/>`; }).join("");
  $("#ring").innerHTML = `<svg viewBox="0 0 240 240" aria-hidden="true"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00E5FF"/><stop offset=".6" stop-color="#8A6CFF"/><stop offset="1" stop-color="#FF3DCB"/></linearGradient></defs>${ticks}<circle cx="120" cy="120" r="${R}" style="fill:none;stroke:rgba(255,255,255,.07);stroke-width:12"/><circle cx="120" cy="120" r="${R}" style="fill:none;stroke:url(#rg);stroke-width:12;stroke-linecap:round;stroke-dasharray:${(C * prog).toFixed(1)} ${C.toFixed(1)};filter:drop-shadow(0 0 8px rgba(0,229,255,.7))"/></svg><div class="mid"><div class="t num">${String(H).padStart(2, "0")}:${String(Mi).padStart(2, "0")}<small>:${String(Se).padStart(2, "0")}</small></div><div class="cap">${cap}</div></div>`;
  $("#ringEyebrow").textContent = eyebrow;
  $("#ringSub").innerHTML = c.state === "open" ? `Closes <b>${fmtT(c.close, UK)}</b> UK · ${fmtT(c.close, NY)} NY` : `Opens <b>${fmtT(c.open, UK)}</b> UK · ${fmtT(c.open, NY)} NY`;
  const mins = (c.state === "open" ? now - wallToDate(c.todayNY, "09:30", NY) : c.open - now) / 60000;
  document.body.classList.toggle("nyo-window", (c.state === "open" && mins <= 60) || (c.state !== "open" && c.day === c.todayNY && mins <= 60));
}
function renderRegime() {
  const el = $("#regime"), M = S.M;
  if (!M) { el.innerHTML = `<div class="eyebrow">Market regime</div><div class="empty">${waitMsg("markets")}</div>`; return; }
  const rg = regime(M), ctx = M.ctx;
  const why = rg.avg != null ? `US index futures ${fpct(rg.avg)} vs the prior close. S&P ${fpct(rg.es)}, Nasdaq ${fpct(rg.nq)}.` : "";
  const g = (lbl, v, chg, sp, dp, suffix = "") => `<div class="g"><div class="l">${lbl}</div><div class="v">${isNum(v) ? fp(v, dp) + suffix : "—"}</div><div class="c ${cls(chg)}">${fpct(chg)}</div>${spark(nums(sp), col(chg), 120, 26)}</div>`;
  const tc = rg.tone === "long" ? "var(--long)" : rg.tone === "short" ? "var(--short)" : "var(--ink)", glow = rg.tone === "long" ? "rgba(43,255,176,.5)" : rg.tone === "short" ? "rgba(255,79,122,.5)" : "rgba(0,229,255,.4)";
  const vix = ctx.VIX, gold = M.map.XAUUSD;
  el.innerHTML = `<div class="eyebrow">Market regime · live</div><div class="tone"><b style="color:${tc};text-shadow:0 0 24px ${glow}">${esc(rg.word)}</b>${rg.ratio != null ? `<span class="pill ${rg.term === "Stress" ? "short" : rg.term === "Calm" ? "cyan" : "warn"}" title="VIX divided by 3-month VIX. Above 1 means near-term fear exceeds longer-term.">Vol curve ${rg.term} · ${rg.ratio.toFixed(2)}</span>` : ""}</div><p class="why">${esc(why)}</p>
  <div class="gauges">${g("Dollar index", ctx.DXY && ctx.DXY.px, ctx.DXY && ctx.DXY.chg, ctx.DXY && ctx.DXY.spark, 2)}${g("US 10Y yield", ctx.US10Y && ctx.US10Y.px, ctx.US10Y && ctx.US10Y.chg, ctx.US10Y && ctx.US10Y.spark, 3, "%")}${g("VIX", vix && vix.px, vix && vix.chg, vix && vix.spark, 2)}${g("Nikkei 225", ctx.N225 && ctx.N225.px, ctx.N225 && ctx.N225.chg, ctx.N225 && ctx.N225.spark, 0)}${g("Hang Seng", ctx.HSI && ctx.HSI.px, ctx.HSI && ctx.HSI.chg, ctx.HSI && ctx.HSI.spark, 0)}${g("Gold", gold && gold.px, gold && gold.chg, gold && gold.spark, 1)}</div>`;
}
function renderNext() {
  const el = $("#nextEvents"), now = Date.now();
  const up = calItems(S.D.calendar).filter(i => i.at && i.at.getTime() > now - 5 * 60000 && i.imp !== "hol").sort((a, b) => a.at - b.at);
  const hi = up.filter(i => i.imp === "high").slice(0, 2), rest = up.filter(i => !hi.includes(i)).slice(0, 4 - hi.length);
  const list = hi.concat(rest).sort((a, b) => a.at - b.at);
  el.innerHTML = `<div class="eyebrow">Next on the calendar</div>` + (list.length ? `<div class="next-list">${list.map(i => `<div class="nx ${i.imp === "high" ? "hi" : ""}"><span class="cur">${esc(i.c)}</span><span class="ev">${esc(i.ev)}<small>${esc(fmtDay(i.d))} · ${esc(i.t)} UK${i.f ? ` · f/c ${esc(i.f)}` : ""}${i.p ? ` · prev ${esc(i.p)}` : ""}</small></span><span class="in">${i.at.getTime() - now < 36 * 3600000 ? (i.at.getTime() <= now ? "now" : "in " + dur(i.at.getTime() - now)) : esc(fmtDay(i.d, { weekday: "short" }))}</span></div>`).join("")}</div>` : `<div class="empty">${S.D.calendar ? "Nothing high or medium impact left this week." : waitMsg("calendar")}</div>`);
}
function renderTimeline() {
  const el = $("#tl"), now = new Date(), todayUK = tzParts(now, UK).ymd;
  const nyo = nyOpenUKMin(todayUK);
  const P = m => (m / 1440 * 100).toFixed(3) + "%";
  const band = (a, b, c, lbl, op = 0.5, lane = "") => `<div class="tl-band ${lane}" style="left:${P(a)};width:${P(b - a)};background:${c};opacity:${op};box-shadow:0 0 18px ${c}"><span>${lbl}</span></div>`;
  const ev = calItems(S.D.calendar).filter(i => i.d === todayUK && i.at && (i.imp === "high" || i.imp === "med")).map(i => `<div class="tl-pin ${i.imp === "high" ? "hi" : ""}" style="left:${P(ukMinOf(i.at))}" title="${esc(i.t + " UK · " + i.c + " · " + i.ev)}"></div>`).join("");
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${P(h * 60)}">${String(h % 24).padStart(2, "0")}:00</span>`).join("");
  el.innerHTML = `<div class="tl-base"></div>${band(0, 420, "var(--violet)", "Asia", .55)}${band(480, 990, "var(--cyan)", "London", .5)}${band(nyo, nyo + 390, "var(--magenta)", "New York", .55, "lane2")}<div class="tl-nyo" style="left:${P(nyo)}" title="New York open ${hm(nyo)} UK"></div>${ev}<div class="tl-now" style="left:${P(ukMinOf(now))}" data-t="${fmtT(now, UK)}"></div><div class="tl-ticks">${ticks}</div>`;
}

/* ================= edges, snapshot & matrix ================= */
const levelWord = (v, dp) => `<b>${fp(v, dp)}</b>`;
function renderEdges() {
  const el = $("#edgeCards"), M = S.M;
  if (!M) { el.innerHTML = `<div class="glass pad empty" style="grid-column:1/-1">${waitMsg("markets")}</div>`; return; }
  const top = (S.edgeIds || []).map(id => M.map[id]).filter(Boolean);
  $("#edgesSub").textContent = top.length ? `${top.length} markets clear the bias thresholds. Scores update with every tick; the ranking refreshes each minute. Tap one for the full playbook.` : "No market clears the bias thresholds right now. That is a signal too: wait for the open to pick a side.";
  if (!top.length) { el.innerHTML = `<div class="glass pad empty" style="grid-column:1/-1"><strong>No strong edge yet</strong>Scores cluster near 50. The ranking refreshes every minute.</div>`; return; }
  keepFocus(el, () => {
    el.innerHTML = top.map(r => {
      const p = r.plan, long = r.bias === "long", neutral = r.bias === "neutral";
      const trig = p && !neutral ? (long ? `Trigger: above ${p.src} high ${levelWord(p.H, r.dp)}` : `Trigger: below ${p.src} low ${levelWord(p.L, r.dp)}`) : p ? `Range ${levelWord(p.L, r.dp)} – ${levelWord(p.H, r.dp)}` : "";
      const tgt = p && !neutral ? (long ? p.up[0] : p.dn[0]) : null;
      const stat = r.lonRate != null ? `NY's first hour ${r.lonRate >= 50 ? "followed" : "faded"} London ${Math.round(r.lonRate >= 50 ? r.lonRate : 100 - r.lonRate)}% of the time${r.lonStrong ? " after strong London sessions" : ""} (${r.lonStrong ? r.st.sN : r.st.n} days).` : "";
      return `<article class="glass pad edge-card ${r.bias}" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.id)} details">
        <div class="ec-top"><div><div class="sym">${esc(r.id)}</div><div class="sym-n">${esc(r.name)} · <span class="num p" data-pxid="${esc(r.id)}">${fp(r.px, r.dp)}</span> <span class="${cls(r.chg)} num">${fpct(r.chg)}</span></div></div>${arc(r.score, r.bias)}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pill(r.bias)}${srcTag(r.id)}</div>
        <div class="ec-line">${trig}${tgt ? `<br>First target: ${esc(tgt[0])} ${levelWord(tgt[1], r.dp)}` : ""}</div>
        <div class="ec-line" style="font-size:12px">${esc(stat)}</div>
        <div class="ec-stat">${r.used != null ? `<span class="mini"><em>ADR used</em>${Math.round(r.used * 100)}%</span>` : ""}${isNum(r.cotPct) ? `<span class="mini"><em>COT</em>${Math.round(r.cotPct)}th pct</span>` : ""}${isNum(r.rsi) ? `<span class="mini"><em>RSI</em>${Math.round(r.rsi)}</span>` : ""}</div>
      </article>`;
    }).join("");
  });
  flash(el);
}
function snapStatus(s, r) {
  if (!r || !isNum(r.px)) return ["—", ""];
  const long = s.bias === "long", px = r.px, dir = long ? 1 : -1;
  if (s.t1 && (px - s.t1[1]) * dir >= 0) return ["Past target 1", "hit"];
  if ((px - s.trig) * dir > 0) return ["Triggered", "hit"];
  if (isNum(s.stop) && (px - s.stop) * dir < 0 && Math.abs(px - s.trig) > Math.abs(s.trig - s.stop) * 2) return ["Against", "miss"];
  return ["Waiting", ""];
}
function renderSnap() {
  const s = S.snap, M = S.M;
  const today = tzParts(new Date(), UK).ymd, lock = hm(nyOpenUKMin(today) - 10);
  const canNotify = typeof Notification !== "undefined";
  const btns = `<div style="display:flex;gap:8px;flex-wrap:wrap">${canNotify ? `<button class="btn sm ${S.notify ? "ghost" : ""}" id="snapNotify">${S.notify ? `Alert on · ${lock}` : `Alert me at ${lock}`}</button>` : ""}<button class="btn sm ghost" id="snapNow">Snapshot now</button></div>`;
  let body = "";
  if (s && s.rows) {
    body = s.rows.length ? `<div class="snap-grid">${s.rows.map(x => {
      const r = M && M.map[x.id], [st, k] = snapStatus(x, r), mv = r && x.adr ? (r.px - x.px) * (x.bias === "long" ? 1 : -1) / x.adr * 100 : null;
      return `<div class="sn ${k}" data-id="${esc(x.id)}" role="button" tabindex="0"><span><b class="s">${esc(x.id)}</b> ${pill(x.bias, true)}</span><span class="st pill ${k === "hit" ? "long" : k === "miss" ? "short" : "neutral"}">${st}</span><span class="m">Edge ${x.score} · ${esc(x.src)} ${x.bias === "long" ? "&gt;" : "&lt;"} ${fp(x.trig, x.dp)}${x.t1 ? ` · T1 ${fp(x.t1[1], x.dp)}` : ""}</span><span class="m">Locked ${fp(x.px, x.dp)} → now ${r ? fp(r.px, x.dp) : "—"} <span class="${cls(mv)}">${isNum(mv) ? fsig(mv, 0) + "% ADR" : ""}</span></span></div>`;
    }).join("")}</div>` : `<div class="empty">No market cleared the thresholds at the snapshot.</div>`;
  }
  const stale = s && s.day !== today;
  const head = `<div class="snap-head"><div><div class="eyebrow">Pre-open snapshot · locks at ${lock} UK</div><p class="note" style="margin-top:4px">${s ? `Locked ${fmtT(new Date(s.at), UK)} UK, ${esc(fmtDay(s.day))}${s.manual ? " (manual)" : ""}${stale ? " · earlier session" : ""}. Each setup is tracked against the live price.` : `At ${lock} UK the page refreshes every feed and freezes the top setups, so you can grade the plan after the open. Keep this tab open.`}</p></div>${btns}</div>`;
  const h = $("#snapHead"), b = $("#snapBody");
  if (h._html !== head) { h.innerHTML = head; h._html = head; }
  if (b._html !== body) { b.innerHTML = body; b._html = body; }
}
async function takeSnapshot(manual) {
  if (S.snapBusy) return; S.snapBusy = true;
  try {
    await Promise.all(["markets", "quotes", "basis", "scan", "calendar"].map(k => load(k)));
    recompute(); reorder();
    const M = S.M; if (!M) { toast("No market data yet for a snapshot."); return; }
    const now = new Date(), day = tzParts(now, UK).ymd;
    const rows = M.rows.filter(r => r.bias !== "neutral" && r.plan).sort((a, b) => b.conv - a.conv).slice(0, 6).map(r => {
      const long = r.bias === "long";
      return { id: r.id, dp: r.dp, bias: r.bias, score: r.score, px: r.px, trig: long ? r.plan.H : r.plan.L, src: r.plan.src, t1: (long ? r.plan.up[0] : r.plan.dn[0]) || null, stop: r.plan.mid, adr: r.adr };
    });
    S.snap = { day, at: now.toISOString(), manual: !!manual, rows };
    store.set("uhe.snap", S.snap);
    renderSnap(); renderBrief();
    if (!manual && S.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification("NY open in 10 minutes", { body: rows.slice(0, 3).map(r => `${r.id} ${r.bias} · edge ${r.score}`).join("   ") || "No strong edges. Let the open pick a side.", icon: "/favicon.svg", tag: "uhe-" + day }); } catch (e) { /* ignore */ }
    }
    if (manual) toast("Snapshot saved.");
  } finally { S.snapBusy = false; }
}
function snapDue(now) {
  const p = tzParts(now, UK); if (!isTD(p.ymd)) return false;
  const nyo = nyOpenUKMin(p.ymd), m = p.H * 60 + p.M;
  return m >= nyo - 10 && m < nyo && !(S.snap && S.snap.day === p.ymd && !S.snap.manual);
}
function renderMatrix() {
  const el = $("#matrix"), M = S.M;
  if (!M) { el.innerHTML = `<div class="glass pad empty" style="grid-column:1/-1">${waitMsg("markets")}</div>`; return; }
  const ids = (S.orderIds || []).concat(M.rows.map(r => r.id).filter(id => !(S.orderIds || []).includes(id)));
  const rows = ids.map(id => M.map[id]).filter(r => r && (S.cls === "all" || r.cls === S.cls));
  keepFocus(el, () => {
    el.innerHTML = rows.map(r => {
      const used = r.used, lmPct = r.lm != null && r.adr ? r.lm / r.adr * 100 : null, sp = r.sp;
      return `<article class="glass icard" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.id)} details" aria-current="${S.open === r.id}">
        <div class="ic-top"><div><div class="sym">${esc(r.id)}</div><div class="sym-n">${esc(r.name)}</div></div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">${pill(r.bias, true)}<span class="num" style="font-size:11.5px;color:var(--ink-3)">Edge <b style="color:var(--ink)">${r.score}</b></span></div></div>
        <div class="ic-px"><span class="p" data-pxid="${esc(r.id)}">${fp(r.px, r.dp)}</span><span class="c ${cls(r.chg)}">${fpct(r.chg)}</span></div>
        <div style="display:flex;justify-content:space-between;gap:6px">${srcTag(r.id)}</div>
        <div class="ic-spark">${spark(sp, col(sp.length > 1 ? sp[sp.length - 1] - sp[0] : 0), 240, 40, { dot: true })}</div>
        <div><div class="mrow"><span>Range used today</span><b>${used == null ? "—" : Math.round(used * 100) + "% of ADR"}</b></div><div class="meter"><i style="left:0;width:${used == null ? 0 : Math.min(100, used * 100)}%;background:${used != null && used >= 0.8 ? "linear-gradient(90deg,var(--amber),var(--short))" : "linear-gradient(90deg,var(--cyan),var(--violet))"}"></i></div></div>
        <div class="ic-foot">${lmPct != null ? `<span class="mini"><em>London</em><span class="${cls(lmPct)}">${fsig(lmPct, 0)}% ADR</span></span>` : `<span class="mini"><em>London</em>not open</span>`}${r.st && isNum(r.st.cont) ? `<span class="mini"><em>NY follows</em>${Math.round(r.st.cont)}%</span>` : ""}${isNum(r.rsi) ? `<span class="mini"><em>RSI</em>${Math.round(r.rsi)}</span>` : ""}</div>
      </article>`;
    }).join("") || `<div class="glass pad empty" style="grid-column:1/-1">No markets in this group.</div>`;
  });
  flash(el);
}

/* ================= live chart ================= */
function renderChartSyms() {
  const el = $("#chartSyms"), M = S.M; if (!M) return;
  const html = M.rows.map(r => `<button data-sym="${esc(r.id)}" aria-pressed="${S.chart.id === r.id}"><i style="background:${r.bias === "long" ? "var(--long)" : r.bias === "short" ? "var(--short)" : "var(--ink-4)"}"></i>${esc(r.id)}</button>`).join("");
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  const fut = $("#feedTabs [data-f=fut]"); fut.disabled = !TV_FUT[S.chart.id]; fut.title = TV_FUT[S.chart.id] ? TV_FUT[S.chart.id] + " (TradingView may delay futures data)" : "No futures chart for this market";
}
function renderChartQuote() {
  const r = S.M && S.M.map[S.chart.id];
  $("#chartSym").textContent = S.chart.id; $("#chartName").textContent = r ? r.name + " · " + tvSym(S.chart.id, S.chart.feed) : "";
  $("#chartQuote").innerHTML = r ? `Dashboard ${fp(r.px, r.dp)} <span class="${cls(r.chg)}">${fpct(r.chg)}</span> · ${pill(r.bias, true)} <span class="muted">edge ${r.score}</span> ${srcTag(r.id)}` : "";
}
function setChart(id, feed) {
  S.chart.id = id; if (feed) S.chart.feed = feed;
  if (S.chart.feed === "fut" && !TV_FUT[id]) S.chart.feed = "cfd";
  $$("#feedTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === S.chart.feed)));
  renderChartSyms(); renderChartQuote(); mountMainChart();
}

/* ================= drawer ================= */
function showDrawer() { $("#scrim").hidden = false; $("#drawer").hidden = false; $("#drawer").scrollTop = 0; document.body.style.overflow = "hidden"; $("#drClose").focus(); }
function drawerChart(symbols) {
  const tabs = $("#drFeed");
  if (symbols.length > 1) { tabs.hidden = false; tabs.innerHTML = symbols.map(([k, lbl]) => `<button data-df="${k}" aria-pressed="${S.drFeed === k}">${lbl}</button>`).join(""); } else { tabs.hidden = true; tabs.innerHTML = ""; }
  const sym = (symbols.find(([k]) => k === S.drFeed) || symbols[0])[2];
  if (S.drKey !== sym) { S.drKey = sym; tvEmbed($("#drChart"), "advanced-chart", { ...chartCfg(sym, "15"), hide_top_toolbar: false, hide_legend: false }); }
}
function openDrawer(id) {
  if (!S.M || !S.M.map[id]) return;
  S.lastFocus = document.activeElement; S.open = id; S.openStock = null; S.drFeed = "cfd"; S.drKey = null;
  renderDrawer(); drawerChart(TV_FUT[id] ? [["cfd", "CFD · real-time", TV[id]], ["fut", "Futures · levels", TV_FUT[id]]] : [["cfd", "Live", TV[id]]]);
  showDrawer(); $$(".icard").forEach(c => c.setAttribute("aria-current", String(c.dataset.id === id)));
}
function closeDrawer() {
  S.open = null; S.openStock = null; S.drKey = null; $("#scrim").hidden = true; $("#drawer").hidden = true; document.body.style.overflow = ""; $("#drChart").innerHTML = "";
  $$(".icard").forEach(c => c.setAttribute("aria-current", "false"));
  if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
}
function renderDrawer() {
  const r = S.M && S.M.map[S.open]; if (!r) return;
  const dp = r.dp, t = r.td || {}, pd = r.pd || {}, pv = r.piv || {}, st = r.st || {};
  const fxRows = COMP.map(([k, n]) => {
    const v = r.comp[k];
    if (!isNum(v)) return `<span class="n">${n}</span><span class="dbar na" title="No data for this market"></span><span class="v">—</span>`;
    return `<span class="n">${n}</span><span class="dbar"><i style="left:${v >= 0 ? 50 : 50 + v * 50}%;width:${Math.abs(v) * 50}%;background:${v >= 0 ? "var(--long)" : "var(--short)"};box-shadow:0 0 10px ${v >= 0 ? "var(--long)" : "var(--short)"}"></i></span><span class="v">${fsig(v)}</span>`;
  }).join("");
  const p = r.plan, fav = r.bias;
  const plan = p ? `<div class="play">
      <div class="pb bull ${fav === "long" ? "fav" : ""}"><h4>Bull case${fav === "long" ? " · favoured" : ""}</h4><dl><dt>Trigger</dt><dd>&gt; ${fp(p.H, dp)}</dd><dt>Stop</dt><dd>&lt; ${fp(p.mid, dp)}</dd><dt>Target 1</dt><dd>${p.up[0] ? fp(p.up[0][1], dp) : "—"}</dd><dt>Target 2</dt><dd>${p.up[1] ? fp(p.up[1][1], dp) : "—"}</dd></dl><p class="note" style="margin-top:6px">${p.up[0] ? esc(p.up[0][0]) : ""}${p.up[1] ? " → " + esc(p.up[1][0]) : ""}</p></div>
      <div class="pb bear ${fav === "short" ? "fav" : ""}"><h4>Bear case${fav === "short" ? " · favoured" : ""}</h4><dl><dt>Trigger</dt><dd>&lt; ${fp(p.L, dp)}</dd><dt>Stop</dt><dd>&gt; ${fp(p.mid, dp)}</dd><dt>Target 1</dt><dd>${p.dn[0] ? fp(p.dn[0][1], dp) : "—"}</dd><dt>Target 2</dt><dd>${p.dn[1] ? fp(p.dn[1][1], dp) : "—"}</dd></dl><p class="note" style="margin-top:6px">${p.dn[0] ? esc(p.dn[0][0]) : ""}${p.dn[1] ? " → " + esc(p.dn[1][0]) : ""}</p></div>
    </div><p class="note">Triggers are the ${esc(p.src)} range edges, stops the range midpoint, targets the next levels beyond. NY's first hour took the London high ${isNum(st.bLH) ? Math.round(st.bLH) + "%" : "—"} and the London low ${isNum(st.bLL) ? Math.round(st.bLL) + "%" : "—"} of the time.</p>${r.used != null && r.used >= 0.8 ? `<p class="warnline">${Math.round(r.used * 100)}% of the average daily range is already used. Breakouts have less room; fades into levels work better on days like this.</p>` : ""}` : `<p class="note">Not enough session data for a playbook.</p>`;
  const L = [["London high", t.lH, "lon"], ["London low", t.lL, "lon"], ["Asia high", t.aH, "asia"], ["Asia low", t.aL, "asia"], ["Prior-day high", pd.h, "pd"], ["Prior-day low", pd.l, "pd"], ["Prior-day close", pd.c, "pd"], ["Prior NY high", pd.nH, "ny"], ["Prior NY low", pd.nL, "ny"], ["Week open", r.wo, "wo"], ["Pivot", pv.p, "piv"], ["R1", pv.r1, "piv"], ["S1", pv.s1, "piv"], ["R2", pv.r2, "piv"], ["S2", pv.s2, "piv"], ["ADR high", p && p.adrHi, "adr"], ["ADR low", p && p.adrLo, "adr"], ["20-day high", r.hi20, "d20"], ["20-day low", r.lo20, "d20"], ["20-day average", r.sma20, "d20"]];
  const C = { lon: "var(--cyan)", asia: "var(--violet)", pd: "var(--ink)", ny: "var(--magenta)", wo: "var(--amber)", piv: "var(--ink-3)", adr: "var(--amber)", d20: "var(--ink-4)" };
  const unit = r.adr || r.atr || 1, rng = unit * 1.6;
  const lv = L.filter(([, v, k]) => isNum(v) && (k === "lon" || k === "pd" || Math.abs(v - r.px) <= rng)).sort((a, b) => b[1] - a[1]);
  let placed = false; const rows = [];
  const nowRow = `<div class="lv now"><i style="background:var(--cyan);box-shadow:0 0 8px var(--cyan)"></i><span class="n">Now</span><span class="p" data-pxid="${esc(r.id)}">${fp(r.px, dp)}</span><span class="d">—</span></div>`;
  for (const [n, v, k] of lv) {
    if (!placed && v < r.px) { rows.push(nowRow); placed = true; }
    rows.push(`<div class="lv"><i style="background:${C[k]}"></i><span class="n">${esc(n)}</span><span class="p">${fp(v, dp)}</span><span class="d">${fsig((v - r.px) / unit * 100, 0)}% ADR</span></div>`);
  }
  if (!placed) rows.push(nowRow);
  const cm = COT_MAP[r.id], cotRow = cm && S.M.cot[cm[0]];
  const l = S.live[r.id], mk = S.D.markets;
  $("#drHead").innerHTML = `<div class="dr-head"><div><div class="eyebrow">${esc(CLS_NAMES[r.cls] || r.cls)} · ${srcTag(r.id)}</div><div class="sym" id="drSym">${esc(r.id)}</div><div class="sym-n">${esc(r.name)}</div><div class="dr-px"><span class="p" data-pxid="${esc(r.id)}">${fp(r.px, dp)}</span> <span class="${cls(r.chg)}">${fpct(r.chg)}</span></div></div></div>`;
  $("#drBody").innerHTML = `<div class="dsec"><div class="big-arc">${arc(r.score, r.bias, 150, 92, true)}<div>${pill(r.bias)}<p style="margin-top:8px">${r.bias === "neutral" ? "No clear edge. Let the open pick a side and trade the break of the range with the tape." : `Leaning ${r.bias}. The ${r.bias === "long" ? "bull" : "bear"} case below is favoured, but both are live until the range breaks.`}</p></div></div></div>
    <div class="dsec"><h3>Why this score · live</h3><div class="fx">${fxRows}</div></div>
    <div class="dsec"><h3>NY open playbook</h3>${plan}</div>
    <div class="dsec"><h3>Key levels</h3><div class="ladder">${rows.join("")}</div></div>
    <div class="dsec"><h3>First NY hour · last ${st.n || "—"} sessions</h3><div class="kv">
      <div><span>Follows London</span><b>${isNum(st.cont) ? Math.round(st.cont) + "%" : "—"}</b></div><div><span>After strong London</span><b>${isNum(st.sCont) ? Math.round(st.sCont) + "%" : "—"}<small class="muted"> n=${st.sN || 0}</small></b></div><div><span>Closes up</span><b>${isNum(st.up) ? Math.round(st.up) + "%" : "—"}</b></div>
      <div><span>Avg range</span><b>${fp(st.ny1, dp)}</b></div><div><span>Range / ADR</span><b>${isNum(st.ny1Adr) ? Math.round(st.ny1Adr) + "%" : "—"}</b></div><div><span>Tags prior day</span><b>${isNum(st.pdTag) ? Math.round(st.pdTag) + "%" : "—"}</b></div>
    </div></div>
    <div class="dsec"><h3>Context</h3><div class="kv">
      <div><span>ADR 20</span><b>${fp(r.adr, dp)}</b></div><div><span>ATR 14</span><b>${fp(r.atr, dp)}</b></div><div><span>RSI 14</span><b>${isNum(r.rsi) ? r.rsi.toFixed(0) : "—"}</b></div>
      <div><span>5 days</span><b class="${cls(r.ret5)}">${fpct(r.ret5, 1)}</b></div><div><span>20 days</span><b class="${cls(r.ret20)}">${fpct(r.ret20, 1)}</b></div><div><span>vs 200-day</span><b class="${cls(r.px - r.sma200)}">${isNum(r.sma200) ? fpct((r.px / r.sma200 - 1) * 100, 1) : "—"}</b></div>
      ${cotRow ? `<div><span>Specs (${esc(COT_NAMES[cm[0]])})</span><b>${Math.round(cotRow.pct)}th pct</b></div><div><span>Weekly change</span><b class="${cls(cotRow.chg)}">${fk(cotRow.chg)}</b></div>` : ""}
      ${r.fin ? `<div><span>${esc(r.fin.s)} off-exch</span><b>${(r.fin.last * 100).toFixed(0)}% <small class="${cls(r.fin.z)}">z ${fsig(r.fin.z)}</small></b></div>` : ""}
    </div><p class="note">${l && l.src === "etf" ? `Live price estimated from ${esc(l.etf)} (futures quotes are delayed on free feeds). ` : l && l.delay ? `Quote delayed ${l.delay} minutes by the exchange; the chart above streams in real time. ` : ""}${FUT_NAME[r.id] ? `Levels are on the ${esc(FUT_NAME[r.id])} front-month future. ` : ""}Session levels from 15-minute bars at ${mk && mk.asOf ? fmtT(new Date(mk.asOf), UK) + " UK" : "—"}.</p></div>`;
  flash($("#drawer"));
}

/* ================= S&P 500 scanner ================= */
const SP_COMP = [["trend", "Trend"], ["momentum", "Momentum"], ["rs", "Strength vs SPY"], ["clv", "Close location"], ["gap", "Pre-market gap"], ["thrust", "Volume thrust"]];
const SP_W = { trend: 20, momentum: 10, rs: 20, clv: 10, gap: 25, thrust: 15 };
const moveWord = () => (S.SP && S.SP.moveLabel) || "Pre-market";
const isRegular = () => !!(S.SP && S.SP.breadth && /REGULAR|POST/.test(S.SP.breadth.state || ""));
function renderBreadth() {
  const el = $("#breadth"), SP = S.SP;
  if (!SP || !SP.breadth) { el.innerHTML = `<div class="eyebrow">Breadth</div><div class="empty">${S.D.scan ? "No breadth data." : waitMsg("scan") + (S.meta.scan && S.meta.scan.fails ? "" : "<br>The first scan of all 500 stocks can take up to a minute.")}</div>`; return; }
  const b = SP.breadth, stateName = { PRE: "Pre-market", PREPRE: "Overnight", REGULAR: "Market open", POST: "After hours", POSTPOST: "After hours", CLOSED: "Closed" }[b.state] || b.state;
  const ring = (v, lbl) => { const R = 34, C = 2 * Math.PI * R, p = clip((v || 0) / 100, 0, 1), c = v >= 60 ? "var(--long)" : v <= 40 ? "var(--short)" : "var(--cyan)"; return `<div><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${R}" style="fill:none;stroke:rgba(255,255,255,.07);stroke-width:7"/><circle cx="42" cy="42" r="${R}" transform="rotate(-90 42 42)" style="fill:none;stroke:${c};stroke-width:7;stroke-linecap:round;stroke-dasharray:${(C * p).toFixed(1)} ${C.toFixed(1)};filter:drop-shadow(0 0 5px ${c})"/><text x="42" y="47" text-anchor="middle" style="fill:var(--ink);font:700 15px var(--f-disp)">${isNum(v) ? Math.round(v) : "—"}%</text></svg><span>${lbl}</span></div>`; };
  const split = (a, d) => { const t = a + d || 1; return `<div class="split"><i style="width:${a / t * 100}%;background:var(--long);box-shadow:0 0 10px var(--long)"></i><i style="width:${d / t * 100}%;background:var(--short);box-shadow:0 0 10px var(--short)"></i></div>`; };
  let read = "";
  if (isNum(b.a50) && isNum(b.spy20)) read = b.a50 < 40 && b.spy20 > -1 ? `Narrow market: SPY is ${fpct(b.spy20, 2)} over 20 sessions, but only ${Math.round(b.a50)}% of members sit above their 50-day. Leadership is concentrated in the mega caps.` : b.a50 > 60 ? `Broad participation: ${Math.round(b.a50)}% of members are above their 50-day.` : `Mixed participation: ${Math.round(b.a50)}% of members are above their 50-day.`;
  const mw = moveWord().toLowerCase();
  el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="eyebrow">Breadth · ${b.n} stocks</div><span class="pill ${b.state === "REGULAR" ? "long" : "cyan"}">${esc(stateName)}</span></div>
    <div class="brd-row"><span>${isRegular() ? "Today" : "Last session"}: up vs down</span><b><span class="up">${b.adv}</span> / <span class="down">${b.dec}</span></b></div>${split(b.adv, b.dec)}
    <div class="brd-row"><span>Moving ±1% ${mw === "today" ? "today" : mw}</span><b><span class="up">${b.gapUp}</span> / <span class="down">${b.gapDn}</span></b></div>${split(b.gapUp, b.gapDn)}
    <div class="brd-row"><span>Cap-weighted ${mw} move</span><b class="${cls(b.gapCap)}">${fpct(b.gapCap)}</b></div>
    <div class="brd-row" style="margin-top:4px"><span>Near 20-day highs / lows</span><b><span class="up">${b.nh20}</span> / <span class="down">${b.nl20}</span></b></div>
    <div class="rings">${ring(b.a20, "Above 20-day")}${ring(b.a50, "Above 50-day")}${ring(b.a200, "Above 200-day")}</div>
    ${read ? `<p class="note" style="color:var(--ink-2)">${esc(read)}</p>` : ""}`;
}
function squarify(items, x, y, w, h) {
  const out = []; const total = items.reduce((s, i) => s + i.v, 0); if (!total || w <= 0 || h <= 0) return out;
  const scale = w * h / total; let rest = items.filter(i => i.v > 0).sort((a, b) => b.v - a.v).map(i => ({ ...i, a: i.v * scale }));
  let r = { x, y, w, h };
  const worst = (row, side) => { const s = row.reduce((t, i) => t + i.a, 0), mx = Math.max(...row.map(i => i.a)), mn = Math.min(...row.map(i => i.a)); return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
  while (rest.length) {
    const side = Math.min(r.w, r.h); let row = [rest[0]], i = 1;
    while (i < rest.length && worst(row.concat(rest[i]), side) <= worst(row, side)) { row.push(rest[i]); i++; }
    const s = row.reduce((t, it) => t + it.a, 0);
    if (r.w >= r.h) { const cw = s / r.h; let yy = r.y; for (const it of row) { const hh = it.a / cw; out.push({ ...it, x: r.x, y: yy, w: cw, h: hh }); yy += hh; } r = { x: r.x + cw, y: r.y, w: r.w - cw, h: r.h }; }
    else { const rh = s / r.w; let xx = r.x; for (const it of row) { const ww = it.a / rh; out.push({ ...it, x: xx, y: r.y, w: ww, h: rh }); xx += ww; } r = { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh }; }
    rest = rest.slice(row.length);
  }
  return out;
}
function tileColor(v, metric) {
  if (!isNum(v)) return "rgba(120,140,170,.16)";
  const t = metric === "score" ? clip((v - 50) / 30) : clip(v / (metric === "gap" ? 2.5 : 3));
  const a = (0.14 + Math.abs(t) * 0.7).toFixed(2);
  return t >= 0 ? `rgba(43,255,176,${a})` : `rgba(255,79,122,${a})`;
}
function renderTreemap() {
  const el = $("#tmap"), lg = $("#tmLegend"), heat = $("#tvHeat"), metric = S.mapMetric || "gap", SP = S.SP;
  $("#mmGap").textContent = moveWord() === "Today" ? "Today's move" : moveWord() + " move";
  if (metric === "tv") { el.hidden = true; heat.hidden = false; mountHeat(); lg.innerHTML = `<span>Streaming from TradingView · S&amp;P 500 by sector, sized by market cap, coloured by today's change.</span>`; return; }
  el.hidden = false; heat.hidden = true;
  if (!SP || !SP.rows.length) { el.innerHTML = `<div class="empty" style="padding-top:220px">${S.D.scan ? "No heat-map data in this scan." : waitMsg("scan")}</div>`; lg.innerHTML = ""; return; }
  const W = el.clientWidth || 800, H = el.clientHeight || 560;
  const secs = SP.names.map((name, i) => ({ i, name, v: SP.rows.filter(r => r.sec === i).reduce((s, r) => s + (r.mcap || 0), 0) }));
  let html = "";
  for (const sr of squarify(secs, 0, 0, W, H)) {
    const head = sr.h > 60 && sr.w > 70 ? 16 : 0;
    html += `<div class="tm-sec" style="left:${sr.x}px;top:${sr.y}px;width:${sr.w}px;height:${sr.h}px">${head ? `<b>${esc(sr.name)}</b>` : ""}`;
    for (const t of squarify(SP.rows.filter(r => r.sec === sr.i).map(r => ({ ...r, v: r.mcap || 0.5 })), 0, head, sr.w, sr.h - head)) {
      const val = metric === "score" ? t.score : metric === "chg" ? t.chg : t.gap;
      const fs = clip(Math.min(t.w / (t.s.length * 0.72 + 0.6), t.h * 0.38), 0, 22);
      const lab = t.w >= 26 && t.h >= 16 && fs >= 7.5, showV = lab && t.h >= fs * 2.6 && t.w >= 40;
      const vtxt = !isNum(val) ? "—" : metric === "score" ? String(val) : fpct(val, 1);
      html += `<div class="tm" data-s="${esc(t.s)}" style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${t.w.toFixed(1)}px;height:${t.h.toFixed(1)}px;background:${tileColor(val, metric)}" title="${esc(t.s)} · ${esc(SP.names[t.sec] || "")} · $${t.mcap >= 1000 ? (t.mcap / 1000).toFixed(2) + "T" : Math.round(t.mcap) + "B"} · ${isRegular() ? "today" : "last"} ${fpct(t.chg)} · ${moveWord().toLowerCase()} ${isNum(t.gap) ? fpct(t.gap) : "—"} · edge ${t.score}${t.er ? " · earnings " + erLabel(t.er) : ""}">${lab ? `<b style="font-size:${fs.toFixed(1)}px">${esc(t.s)}</b>` : ""}${showV ? `<span style="font-size:${Math.max(8, fs * 0.62).toFixed(1)}px">${vtxt}</span>` : ""}</div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
  const L = metric === "score" ? ["Edge 20", "80"] : metric === "chg" ? ["−3%", "+3%"] : ["−2.5%", "+2.5%"];
  lg.innerHTML = `<span>${L[0]}</span><span class="grad"></span><span>${L[1]}</span><span style="margin-left:8px">Tiles sized by market cap · ${metric === "gap" ? (moveWord() === "Pre-market" ? "grey = no pre-market trade yet" : moveWord().toLowerCase() + " move") : metric === "chg" ? (isRegular() ? "today's session" : "last completed session") : "UHE stock edge score"}</span>${SP.asOf ? `<span style="margin-left:auto">Scanned ${fmtT(new Date(SP.asOf), UK)} UK</span>` : ""}`;
}
function fmtBn(m) { return !isNum(m) ? "—" : m >= 1000 ? (m / 1000).toFixed(1) + "B" : Math.round(m) + "M"; }
function srow(r, mode) {
  const b = spBias(r.score);
  let v, sub;
  if (mode === "play") { v = `<span class="${cls(r.gap)}">${fpct(r.gap)}</span><small>${fp(r.ext, 2)}</small>`; sub = `${isNum(r.atrPct) && isNum(r.gap) ? (Math.abs(r.gap) / r.atrPct).toFixed(1) + "× ATR" : ""} · $${fmtBn(r.dv)}/day · RSI ${r.rsi ?? "—"}`; }
  else if (mode === "long") { v = `${fp(r.px, 2)}<small class="${cls(r.chg)}">${fpct(r.chg)}</small>`; sub = `Trigger > ${fp(r.pdh, 2)} prior high · ATR ${fp(r.atrPct, 1)}%`; }
  else { v = `${fp(r.px, 2)}<small class="${cls(r.chg)}">${fpct(r.chg)}</small>`; sub = `Trigger < ${fp(r.pdl, 2)} prior low · ATR ${fp(r.atrPct, 1)}%`; }
  const er = r.er ? `<span class="pill warn" style="margin-left:6px;padding:2px 7px;font-size:9.5px">ER ${esc(erLabel(r.er))}</span>` : "";
  return `<div class="srow" data-s="${esc(r.s)}" tabindex="0" role="button"><div style="min-width:0"><span class="t">${esc(r.s)}<small>${esc(r.name || "")}</small></span>${er}<span class="sub">${esc(sub)}</span></div><div class="v">${v}</div><div class="sc ${b}">${r.score}</div></div>`;
}
function renderSpLists() {
  const SP = S.SP, fill = (id, arr, mode, none) => { $(id).innerHTML = arr && arr.length ? arr.map(r => srow(r, mode)).join("") : `<div class="empty">${none}</div>`; };
  $("#playTitle").textContent = `Stocks in play · biggest ${moveWord() === "Today" ? "moves today" : moveWord().toLowerCase() + " moves"}`;
  if (!SP) { ["#spPlay", "#spLongs", "#spShorts"].forEach(id => { $(id).innerHTML = `<div class="empty">${waitMsg("scan")}</div>`; }); return; }
  fill("#spPlay", SP.play, "play", "No extended-hours prints yet. US stocks start trading at 09:00 UK.");
  fill("#spLongs", SP.longs, "long", "No stock clears the long threshold.");
  fill("#spShorts", SP.shorts, "short", "No stock clears the short threshold.");
}
function renderSecBoard() {
  const el = $("#secBoard"), SP = S.SP;
  if (!SP || !SP.sec) { el.innerHTML = `<div class="eyebrow">Sectors</div><div class="empty">${waitMsg("scan")}</div>`; return; }
  const rows = SP.sec.filter(s => s.n).slice().sort((a, b) => (b.gap ?? b.chg ?? 0) - (a.gap ?? a.chg ?? 0));
  const mx = Math.max(0.5, ...rows.map(s => Math.abs(s.gap || 0))), mw = moveWord() === "Pre-market" ? "Pre-mkt" : moveWord() === "Today" ? "Today" : "After hrs";
  el.innerHTML = `<div class="eyebrow">Sectors · cap-weighted</div><div class="secr head" style="margin-top:10px"><span>Sector</span><span>${esc(moveWord() === "Today" ? "Today's move" : moveWord() + " move")}</span><span style="text-align:right">${mw}</span><span style="text-align:right">${isRegular() ? "Today" : "Last"}</span><span style="text-align:right">&gt;50d</span></div>` +
    rows.map(s => `<div class="secr" title="Best edge ${esc(s.best || "—")} · weakest ${esc(s.worst || "—")} · average edge ${s.score ?? "—"}"><span>${esc(s.name)} <span class="muted" style="font-size:10.5px">${s.n}</span></span><span class="dbar"><i style="left:${(s.gap || 0) >= 0 ? 50 : 50 - Math.abs(s.gap) / mx * 50}%;width:${Math.abs(s.gap || 0) / mx * 50}%;background:${(s.gap || 0) >= 0 ? "var(--long)" : "var(--short)"};box-shadow:0 0 8px ${(s.gap || 0) >= 0 ? "var(--long)" : "var(--short)"}"></i></span><span class="v ${cls(s.gap)}">${fpct(s.gap)}</span><span class="v ${cls(s.chg)}">${fpct(s.chg)}</span><span class="v">${isNum(s.a50) ? Math.round(s.a50) + "%" : "—"}</span></div>`).join("");
}
function renderSpEarn() {
  const el = $("#spEarn"), SP = S.SP, er = SP && SP.er || [];
  if (!er.length) { el.innerHTML = `<div class="eyebrow">S&amp;P 500 earnings · next 7 days</div><div class="empty">${SP ? "No members report in the next 7 days." : waitMsg("scan")}</div>`; return; }
  const days = [...new Set(er.map(e => e.d))].sort();
  el.innerHTML = `<div class="eyebrow">S&amp;P 500 earnings · next 7 days</div>` + days.map(d => `<div class="erday"><h4>${esc(fmtDay(d, { weekday: "long", day: "numeric", month: "short" }))}</h4><div class="erchips">${er.filter(e => e.d === d).sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).map(e => `<span class="erchip ${e.mcap >= 100 ? "big" : ""}" data-s="${esc(e.s)}" role="button" tabindex="0" title="Market cap $${Math.round(e.mcap)}B${e.est ? " · date estimated" : ""}">${esc(e.s)}<small>${e.t === "BMO" ? "pre-open" : e.t === "AMC" ? "after close" : "in session"}</small></span>`).join("")}</div></div>`).join("") + `<p class="note">Pre-open reports hit before the 14:30 UK open; after-close reports gap the next morning.</p>`;
}
function renderScanner() { renderBreadth(); renderTreemap(); renderSpLists(); renderSecBoard(); renderSpEarn(); }
function stockWhy(comp, b) {
  const sign = b === "long" ? 1 : -1;
  const top = SP_COMP.map(([k, n]) => [n.toLowerCase(), (comp[k] || 0) * SP_W[k] * sign]).filter(([, v]) => v > 1).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([n]) => n);
  return top.length ? `: ${top.join(" and ")} ${top.length > 1 ? "drive" : "drives"} it` : "";
}
function openStock(s) {
  const SP = S.SP; if (!SP || !(SP.by[s] || SP.det[s])) return;
  S.lastFocus = document.activeElement; S.open = null; S.openStock = s; S.drKey = null;
  renderStockDrawer();
  const r = SP.det[s] || SP.by[s], tvx = r.tv || (SP.by[s] && SP.by[s].tv);
  drawerChart([["cfd", "Live", tvx ? `${tvx}:${s.replace("-", ".")}` : s.replace("-", ".")]]);
  showDrawer();
}
function renderStockDrawer() {
  const SP = S.SP, s = S.openStock, r = SP && (SP.det[s] || SP.by[s]); if (!r) return;
  const full = !!(SP.det[s] && SP.det[s].pdh != null);
  const b = spBias(r.score), sect = SP.names[r.sec] || "", comp = r.comp || {};
  const fx = full ? SP_COMP.map(([k, n]) => { const v = comp[k]; if (!isNum(v)) return `<span class="n">${n}</span><span class="dbar na"></span><span class="v">—</span>`; return `<span class="n">${n}</span><span class="dbar"><i style="left:${v >= 0 ? 50 : 50 + v * 50}%;width:${Math.abs(v) * 50}%;background:${v >= 0 ? "var(--long)" : "var(--short)"};box-shadow:0 0 10px ${v >= 0 ? "var(--long)" : "var(--short)"}"></i></span><span class="v">${fsig(v)}</span>`; }).join("") : "";
  const pxLabel = isRegular() ? "Price" : "Last close";
  let plan = "", ladder = "", kv = "";
  if (full) {
    const A = r.atr || 0;
    const bs = r.pdc < r.pdh - 0.25 * A ? r.pdc : r.pdl, bt1 = r.pdh + A, bt2 = r.hi20 > bt1 ? r.hi20 : r.pdh + 2 * A;
    const ss = r.pdc > r.pdl + 0.25 * A ? r.pdc : r.pdh, st1 = r.pdl - A, st2 = r.lo20 < st1 ? r.lo20 : r.pdl - 2 * A;
    plan = `<div class="dsec"><h3>Opening plan</h3><div class="play"><div class="pb bull ${b === "long" ? "fav" : ""}"><h4>Bull case${b === "long" ? " · favoured" : ""}</h4><dl><dt>Trigger</dt><dd>&gt; ${fp(r.pdh, 2)}</dd><dt>Stop</dt><dd>&lt; ${fp(bs, 2)}</dd><dt>Target 1</dt><dd>${fp(bt1, 2)}</dd><dt>Target 2</dt><dd>${fp(bt2, 2)}</dd></dl></div><div class="pb bear ${b === "short" ? "fav" : ""}"><h4>Bear case${b === "short" ? " · favoured" : ""}</h4><dl><dt>Trigger</dt><dd>&lt; ${fp(r.pdl, 2)}</dd><dt>Stop</dt><dd>&gt; ${fp(ss, 2)}</dd><dt>Target 1</dt><dd>${fp(st1, 2)}</dd><dt>Target 2</dt><dd>${fp(st2, 2)}</dd></dl></div></div><p class="note">Triggers are the prior session's high and low, stops the prior close (or the far side of the range), targets one ATR (${fp(A, 2)}) and the 20-day extreme.${isNum(r.gap) ? ` ${moveWord()} it is ${fpct(r.gap)} (${(Math.abs(r.gap) / (r.atrPct || 1)).toFixed(1)}× ATR)${Math.abs(r.gap) / (r.atrPct || 1) >= 0.7 ? ", a large move: let the first 5–15 minutes settle before trusting a break" : ""}.` : ""}</p></div>`;
    const hi52 = isNum(r.d52) ? r.px / (1 + r.d52 / 100) : null;
    const L = [[moveWord() === "Today" ? "Last trade" : moveWord(), isRegular() ? null : r.ext, "var(--cyan)"], ["Prior high", r.pdh, "var(--ink)"], ["Prior close", Math.abs((r.pdc || 0) - r.px) > 1e-6 ? r.pdc : null, "var(--ink-2)"], ["Prior low", r.pdl, "var(--ink)"], ["20-day high", r.hi20, "var(--violet)"], ["20-day low", r.lo20, "var(--violet)"], ["50-day average", r.sma50, "var(--amber)"], ["200-day average", r.sma200, "var(--magenta)"], ["52-week high", hi52, "var(--ink-3)"]].filter(([, v]) => isNum(v)).sort((a, b2) => b2[1] - a[1]);
    let placed = false; const out = [];
    const nowRow = `<div class="lv now"><i style="background:var(--cyan)"></i><span class="n">${pxLabel}</span><span class="p">${fp(r.px, 2)}</span><span class="d">—</span></div>`;
    for (const [n, v, c] of L) { if (!placed && v < r.px) { out.push(nowRow); placed = true; } out.push(`<div class="lv"><i style="background:${c}"></i><span class="n">${esc(n)}</span><span class="p">${fp(v, 2)}</span><span class="d">${A ? fsig((v - r.px) / A, 1) + " ATR" : ""}</span></div>`); }
    if (!placed) out.push(nowRow);
    ladder = `<div class="dsec"><h3>Key levels</h3><div class="ladder">${out.join("")}</div></div>`;
    kv = `<div><span>ATR 14</span><b>${fp(r.atr, 2)} <small class="muted">${fp(r.atrPct, 1)}%</small></b></div><div><span>RSI 14</span><b>${r.rsi ?? "—"}</b></div><div><span>Rel. volume</span><b>${isNum(r.rvol) ? r.rvol.toFixed(2) + "×" : "—"}</b></div><div><span>5 days</span><b class="${cls(r.ret5)}">${fpct(r.ret5, 1)}</b></div><div><span>20 days</span><b class="${cls(r.ret20)}">${fpct(r.ret20, 1)}</b></div><div><span>$ volume/day</span><b>$${fmtBn(r.dv)}</b></div><div><span>vs 50-day</span><b class="${cls(r.d50)}">${fpct(r.d50, 1)}</b></div><div><span>vs 200-day</span><b class="${cls(r.d200)}">${fpct(r.d200, 1)}</b></div><div><span>From 52w high</span><b>${fpct(r.d52, 1)}</b></div>`;
  } else {
    kv = `<div><span>${isRegular() ? "Today" : "Last session"}</span><b class="${cls(r.chg)}">${fpct(r.chg)}</b></div><div><span>${esc(moveWord())}</span><b class="${cls(r.gap)}">${isNum(r.gap) ? fpct(r.gap) : "—"}</b></div><div><span>RSI 14</span><b>${r.rsi ?? "—"}</b></div><div><span>ATR %</span><b>${isNum(r.atrPct) ? r.atrPct.toFixed(1) + "%" : "—"}</b></div><div><span>Rel. volume</span><b>${isNum(r.rvol) ? r.rvol.toFixed(2) + "×" : "—"}</b></div><div><span>Market cap</span><b>$${r.mcap >= 1000 ? (r.mcap / 1000).toFixed(2) + "T" : Math.round(r.mcap) + "B"}</b></div>`;
  }
  $("#drHead").innerHTML = `<div class="dr-head"><div><div class="eyebrow">${esc(sect)} · S&amp;P 500</div><div class="sym" id="drSym">${esc(r.s)}</div><div class="sym-n">${esc(r.name || "")}${r.mcap ? ` · $${r.mcap >= 1000 ? (r.mcap / 1000).toFixed(2) + "T" : Math.round(r.mcap) + "B"}` : ""}</div><div class="dr-px">${isNum(r.px) ? fp(r.px, 2) + " " : ""}<span class="${cls(r.chg)}">${fpct(r.chg)}</span>${isNum(r.gap) && !isRegular() ? ` <span class="muted" style="font-size:13px">· ${esc(moveWord().toLowerCase())} ${isNum(r.ext) ? fp(r.ext, 2) + " " : ""}<span class="${cls(r.gap)}">${fpct(r.gap)}</span></span>` : ""}</div></div></div>`;
  $("#drBody").innerHTML = `<div class="dsec"><div class="big-arc">${arc(r.score, b, 150, 92, true)}<div>${pill(b)}${r.er ? ` <span class="pill warn">Earnings ${esc(erLabel(r.er))}</span>` : ""}<p style="margin-top:8px">${b === "neutral" ? "No clear edge. Trade it only if it breaks the prior range with volume." : `Leaning ${b}${stockWhy(comp, b)}.`}</p></div></div></div>
    ${full ? `<div class="dsec"><h3>Why this score</h3><div class="fx">${fx}</div></div>` : ""}${plan}${ladder}
    <div class="dsec"><h3>Stats</h3><div class="kv">${kv}</div>${full ? "" : `<p class="note">Full levels and the opening plan load for the in-play and top-ranked names.</p>`}<p class="note">Scanned ${SP.asOf ? fmtT(new Date(SP.asOf), UK) + " UK" : "—"}; the scan refreshes every minute. The chart above streams live.</p></div>`;
}

/* ================= lab & flow ================= */
function heatCell(v, mode, extra = "") {
  if (!isNum(v)) return `<span class="cell muted">—</span>`;
  let bg;
  if (mode === "dir") { const d = clip((v - 50) / 20); bg = d >= 0 ? `rgba(0,229,255,${(0.08 + d * 0.42).toFixed(2)})` : `rgba(255,61,203,${(0.08 - d * 0.42).toFixed(2)})`; }
  else if (mode === "updown") { const d = clip((v - 50) / 20); bg = d >= 0 ? `rgba(43,255,176,${(0.06 + d * 0.4).toFixed(2)})` : `rgba(255,79,122,${(0.06 - d * 0.4).toFixed(2)})`; }
  else { const d = clip(v / 100, 0, 1); bg = `rgba(138,108,255,${(0.05 + d * 0.45).toFixed(2)})`; }
  return `<span class="cell" style="background:${bg}">${Math.round(v)}%${extra}</span>`;
}
function renderLab() {
  const body = $("#heatBody"), M = S.M;
  if (!M) { body.innerHTML = `<tr><td colspan="8" class="empty">${waitMsg("markets")}</td></tr>`; return; }
  body.innerHTML = ["index", "fx", "cmd", "crypto"].map(g => {
    const rs = M.rows.filter(r => r.cls === g).sort((a, b) => a.order - b.order); if (!rs.length) return "";
    return `<tr class="grp"><td colspan="8">${esc(CLS_NAMES[g])}</td></tr>` + rs.map(r => { const s = r.st || {}; return `<tr data-id="${esc(r.id)}" tabindex="0"><td><span class="sym" style="font-size:14px">${esc(r.id)}</span> <span class="muted" style="font-size:11px">n=${s.n || 0}</span></td><td>${heatCell(s.cont, "dir")}</td><td>${heatCell(s.sCont, "dir", `<small>n=${s.sN || 0}</small>`)}</td><td>${heatCell(s.up, "updown")}</td><td>${heatCell(s.bLH, "mag")}</td><td>${heatCell(s.bLL, "mag")}</td><td>${heatCell(s.pdTag, "mag")}</td><td>${heatCell(s.ny1Adr, "mag")}</td></tr>`; }).join("");
  }).join("") + `<tr><td colspan="8" style="text-align:left;padding:12px 18px;font-size:11.5px;color:var(--ink-3)"><span style="color:var(--cyan)">Cyan</span> = NY tends to follow London · <span style="color:var(--magenta)">magenta</span> = NY tends to fade it · <span style="color:var(--long)">green</span>/<span style="color:var(--short)">red</span> = first hour closes up/down more often · <span style="color:#B9A8FF">violet</span> = how often it happens. Samples under 20 days are noisy.</td></tr>`;
}
function renderCot() {
  const el = $("#cot"), c = S.D.flow && S.D.flow.cot, rows = ((c && c.rows) || []).filter(r => !r.err);
  $("#cotDate").textContent = c && c.report ? `Report ${fmtDay(c.report, { day: "numeric", month: "short" })}` : "";
  if (!rows.length) { el.innerHTML = `<div class="empty">${c && c.error ? "CFTC data unavailable right now." : S.D.flow ? "No positioning data." : waitMsg("flow")}</div>`; return; }
  el.innerHTML = rows.map(r => `<div class="cot"><span class="n">${esc(COT_NAMES[r.k] || r.name)}</span><span class="pbar" title="${Math.round(r.pct)}th percentile of the 3-year range"><i class="${r.pct >= 85 || r.pct <= 15 ? "ext" : ""}" style="left:${clip(r.pct, 0, 100)}%"></i></span><span class="v">${Math.round(r.pct)}</span><span class="v ${cls(r.chg)}" title="Weekly change in net contracts">${fk(r.chg)}</span></div>`).join("");
}
function renderFinra() {
  const el = $("#finra"), f = S.D.flow && S.D.flow.finra, rows = ((f && f.rows) || []).filter(r => !r.err);
  $("#finDate").textContent = f && f.latest ? `Latest ${ymdLabel(f.latest)}` : "";
  if (!rows.length) { el.innerHTML = `<div class="empty">${f && f.error ? "FINRA data unavailable right now." : S.D.flow ? "No off-exchange data." : waitMsg("flow")}</div>`; return; }
  el.innerHTML = rows.map(r => { const s = nums(r.series); const c = r.z >= 1 ? "var(--long)" : r.z <= -1 ? "var(--short)" : "var(--cyan)"; return `<div class="fin"><span><span class="t">${esc(r.s)}</span><br><span class="muted" style="font-size:10.5px">${esc(FIN_NAMES[r.s] || "")}</span></span>${spark(s, c, 240, 30, { ref: r.avg })}<span class="v">${(r.last * 100).toFixed(1)}%</span><span class="v"><span class="pill ${r.z >= 1 ? "long" : r.z <= -1 ? "short" : "neutral"}" style="letter-spacing:.04em">z ${fsig(r.z, 1)}</span></span></div>`; }).join("");
}

/* ================= calendar ================= */
function renderCal() {
  const el = $("#cal"), items = calItems(S.D.calendar);
  if (!items.length) { el.innerHTML = `<div class="glass pad empty" style="grid-column:1/-1">${S.D.calendar ? "No events listed." : waitMsg("calendar")}</div>`; return; }
  const today = tzParts(new Date(), UK).ymd, now = Date.now();
  const days = [...new Set(items.map(i => i.d))].sort().filter(d => { const wd = new Date(d + "T12:00:00Z").getUTCDay(); return wd > 0 && wd < 6; });
  el.innerHTML = days.map(d => {
    const list = items.filter(i => i.d === d).sort((a, b) => a.t.localeCompare(b.t));
    return `<div class="glass pad cday ${d === today ? "today" : ""}"><h3>${esc(fmtDay(d, { weekday: "long", day: "numeric", month: "short" }))}${d === today ? '<span class="pill cyan">Today</span>' : ""}</h3>${list.map(i => {
      const ny = i.at ? fmtT(i.at, NY) : "";
      return `<div class="ce ${i.imp === "high" ? "hi" : ""} ${i.at && i.at.getTime() < now ? "past" : ""}"><span class="tm">${esc(i.t)}${ny ? `<small>${esc(ny)} NY</small>` : ""}</span><span class="ev"><span class="ccur">${esc(i.c)}</span><b>${esc(i.ev)}</b>${i.f || i.p ? `<span class="meta">${i.f ? `<span>f/c ${esc(i.f)}</span>` : ""}${i.p ? `<span>prev ${esc(i.p)}</span>` : ""}</span>` : ""}</span></div>`;
    }).join("")}</div>`;
  }).join("");
}

/* ================= brief ================= */
function mdLite(text) {
  let html = "", inList = false; const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)_(.+?)_(?=\s|$|[.,])/g, "$1<em>$2</em>");
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (/^#{1,4}\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h4>${inline(line.replace(/^#{1,4}\s+/, ""))}</h4>`; continue; }
    if (/^[-*•]\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(line.replace(/^[-*•]\s+/, ""))}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    if (line) html += `<p>${inline(line)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}
function currentBrief() {
  const ai = S.D.brief && S.D.brief.ai && S.D.brief.text ? S.D.brief : null;
  if (ai && S.briefMode === "ai") return ai;
  const key = Math.floor(Date.now() / 60000) + "|" + (S.D.markets && S.D.markets.asOf) + "|" + (S.SP && S.SP.asOf);
  if (!S.autoCache || S.autoCache.key !== key) { const b = S.M ? autoBrief(S.M, S.D.calendar, S.SP) : null; if (b) S.autoCache = { key, b }; }
  return S.autoCache ? S.autoCache.b : null;
}
function renderBrief() {
  const t = $("#briefText"), meta = $("#briefMeta"), ai = S.D.brief && S.D.brief.ai && S.D.brief.text;
  $("#briefSrc").hidden = !ai;
  $$("#briefSrc button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.b === (ai ? S.briefMode : "auto"))));
  const b = currentBrief();
  if (!b) { t.innerHTML = `<p class="muted">${S.D.markets ? "Building the brief…" : waitMsg("markets")}</p>`; meta.innerHTML = ""; $("#briefMore").hidden = true; return; }
  t.innerHTML = mdLite(b.text);
  const stale = b.day && b.day !== clock().day;
  meta.innerHTML = `<span>For the ${esc(b.day ? fmtDay(b.day) : "—")} open</span><span>·</span><span>${esc(b.by || "")}</span>${b.at ? `<span>·</span><span>${fmtT(new Date(b.at), UK)} UK</span>` : ""}${stale ? `<span class="pill warn">Earlier session</span>` : ""}${!ai && S.D.brief && S.D.brief.error ? `<span class="muted" title="${esc(S.D.brief.error)}">· Claude brief unavailable</span>` : ""}`;
  const more = $("#briefMore"); more.hidden = false; more.textContent = t.classList.contains("clamped") ? "Show full brief" : "Collapse";
}

/* ================= journal ================= */
function tcalc(t) { const e = +t.entry, s = +t.stop, x = t.exit == null || t.exit === "" ? null : +t.exit, q = +t.qty, long = t.side !== "Short", risk = e - s; return { e, s, x, q, long, R: x != null && risk ? (x - e) / risk : null, pnl: x != null ? (x - e) * q * (long ? 1 : -1) : null, open: x == null }; }
function renderJournal() {
  const trades = S.journal.map(t => ({ ...t, ...tcalc(t) })).sort((a, b) => String(a.d).localeCompare(String(b.d)) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const closed = trades.filter(t => !t.open && isNum(t.R)), wins = closed.filter(t => t.R > 0), losses = closed.filter(t => t.R <= 0);
  const sumR = closed.reduce((s, t) => s + t.R, 0), gw = wins.reduce((s, t) => s + t.R, 0), gl = Math.abs(losses.reduce((s, t) => s + t.R, 0));
  let cum = 0, peak = 0, mdd = 0; const curve = [0]; for (const t of closed) { cum += t.R; curve.push(cum); peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  const st = [["Trades", `${closed.length}${trades.length - closed.length ? `<small class="muted" style="font-size:12px"> +${trades.length - closed.length} open</small>` : ""}`], ["Win rate", closed.length ? Math.round(wins.length / closed.length * 100) + "%" : "—"], ["Expectancy", closed.length ? `<span class="${cls(sumR)}">${fsig(sumR / closed.length)}R</span>` : "—"], ["Profit factor", closed.length ? (gl ? (gw / gl).toFixed(2) : gw > 0 ? "∞" : "—") : "—"], ["Total", closed.length ? `<span class="${cls(sumR)}">${fsig(sumR, 1)}R</span>` : "—"], ["Max drawdown", closed.length ? mdd.toFixed(1) + "R" : "—"]];
  $("#jstats").innerHTML = st.map(([k, v]) => `<div class="glass stat"><span>${k}</span><b>${v}</b></div>`).join("");
  drawEq(curve);
  const body = $("#jBody");
  if (!trades.length) { body.innerHTML = `<tr><td colspan="11" class="empty"><strong>No trades yet</strong>Log your first NY-open trade with the form.</td></tr>`; return; }
  body.innerHTML = trades.slice().reverse().map(t => `<tr><td>${esc(t.d ? fmtDay(t.d, { day: "numeric", month: "short" }) : "—")}</td><td class="l"><b style="font-family:var(--f-disp);font-size:12px">${esc(t.s)}</b></td><td class="l"><span class="pill ${t.long ? "long" : "short"}">${t.long ? "Long" : "Short"}</span></td><td class="l" style="font-family:var(--f-ui)" title="${esc(t.notes || "")}">${esc(t.setup || "")}</td><td>${esc(t.entry)}</td><td>${esc(t.stop)}</td><td>${t.open ? '<span class="pill cyan">Open</span>' : esc(t.exit)}</td><td>${esc(t.qty)}</td><td class="${cls(t.R)}">${isNum(t.R) ? fsig(t.R) + "R" : "—"}</td><td class="${cls(t.pnl)}">${isNum(t.pnl) ? fsig(t.pnl, 2) : "—"}</td><td><button class="btn sm ghost danger" data-del="${esc(t.id)}">Delete</button></td></tr>`).join("");
}
function drawEq(curve) {
  const el = $("#eq");
  if (curve.length < 2) { el.innerHTML = `<div class="empty"><strong>No closed trades yet</strong>The curve starts with your first closed trade.</div>`; return; }
  const W = Math.max(280, el.clientWidth - 40 || 640), H = 190, pl = 44, pr = 18, pt = 16, pb = 24;
  let lo = Math.min(0, ...curve), hi = Math.max(0, ...curve); if (hi - lo < 2) { hi += 1; lo -= 1; }
  const step = hi - lo > 12 ? 4 : hi - lo > 6 ? 2 : 1; lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = i => pl + i * (W - pl - pr) / (curve.length - 1), Y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  let g = ""; for (let v = lo; v <= hi + 1e-9; v += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:${v === 0 ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.06)"}"/><text x="${pl - 8}" y="${Y(v) + 4}" text-anchor="end" style="fill:var(--ink-3);font:11px var(--f-num)">${v > 0 ? "+" : ""}${v}R</text>`;
  const d = curve.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join(""), end = curve[curve.length - 1], c = end >= 0 ? "var(--long)" : "var(--short)";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative R ${fsig(end, 1)} after ${curve.length - 1} trades">${g}<path d="${d}L${X(curve.length - 1)} ${Y(0)}L${X(0)} ${Y(0)}Z" style="fill:${c};fill-opacity:.12"/><path d="${d}" style="fill:none;stroke:${c};stroke-width:2.2;filter:drop-shadow(0 0 6px ${c})"/><circle cx="${X(curve.length - 1)}" cy="${Y(end)}" r="4" style="fill:${c}"/><text x="${W - pr}" y="${Math.max(14, Y(end) - 10)}" text-anchor="end" style="fill:var(--ink);font:600 12px var(--f-num)">${fsig(end, 1)}R</text></svg>`;
}
function persistJournal() { if (!store.set("uhe.journal", S.journal)) toast("This browser blocked saving (private mode?). Export a backup to keep your trades."); }
function saveTrade(ev) {
  ev.preventDefault(); const msg = $("#jMsg"), v = id => $(id).value.trim();
  const t = { d: v("#jDate"), s: v("#jSym").toUpperCase(), side: v("#jSide"), setup: v("#jSetup"), entry: parseFloat(v("#jEntry")), stop: parseFloat(v("#jStop")), exit: v("#jExit") === "" ? null : parseFloat(v("#jExit")), qty: parseFloat(v("#jQty")), notes: v("#jNotes") };
  const bad = []; if (!t.d) bad.push("date"); if (!t.s) bad.push("market"); if (!(t.entry > 0)) bad.push("entry"); if (!(t.stop > 0)) bad.push("stop"); if (t.exit !== null && !(t.exit > 0)) bad.push("exit"); if (!(t.qty > 0)) bad.push("size");
  if (bad.length) { msg.innerHTML = `<span class="down">Check ${bad.join(", ")}.</span>`; return; }
  if (t.side === "Long" && t.stop >= t.entry) { msg.innerHTML = `<span class="down">For a long, the stop sits below the entry.</span>`; return; }
  if (t.side === "Short" && t.stop <= t.entry) { msg.innerHTML = `<span class="down">For a short, the stop sits above the entry.</span>`; return; }
  S.journal.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...t, createdAt: new Date().toISOString() });
  persistJournal(); renderJournal();
  msg.innerHTML = `<span class="up">Saved ${esc(t.s)} ${t.side.toLowerCase()}.</span>`; ["#jEntry", "#jStop", "#jExit", "#jNotes"].forEach(id => { $(id).value = ""; });
}
function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: "upper-hand-edge", v: 1, exportedAt: new Date().toISOString(), journal: S.journal, model: S.settings }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `uhe-backup-${tzParts(new Date(), UK).ymd}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importBackup(file) {
  try {
    const j = JSON.parse(await file.text());
    const list = Array.isArray(j) ? j : Array.isArray(j.journal) ? j.journal : null;
    if (!list) throw new Error("no journal in file");
    const have = new Set(S.journal.map(t => t.id)); let n = 0;
    for (const t of list) if (t && t.s && isNum(+t.entry) && !have.has(t.id)) { S.journal.push({ ...t, id: t.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }); n++; }
    persistJournal();
    if (j.model && j.model.weights) { S.settings = normCfg(j.model); store.set("uhe.model", S.settings); S.draft = null; renderWeights(); recompute(); reorder(); }
    renderJournal(); toast(`Imported ${n} trade${n === 1 ? "" : "s"}${j.model ? " and your model" : ""}.`);
  } catch (e) { toast("That file isn't a UHE backup."); }
}

/* ================= model ================= */
function renderWeights() {
  const E = eff();
  $("#weights").innerHTML = COMP.map(([k, n]) => `<div class="wrow"><label for="w-${k}">${n}</label><input type="range" id="w-${k}" data-w="${k}" min="0" max="50" step="1" value="${E.weights[k]}"><b>${E.weights[k]}</b></div>`).join("");
  $("#thLong").value = E.longAt; $("#thLongV").textContent = E.longAt; $("#thShort").value = E.shortAt; $("#thShortV").textContent = E.shortAt;
  $("#wSave").disabled = !S.draft;
}
function saveModel() {
  const E = eff(); S.settings = { weights: E.weights, longAt: E.longAt, shortAt: E.shortAt, updatedAt: new Date().toISOString() };
  toast(store.set("uhe.model", S.settings) ? "Model saved in this browser." : "This browser blocked saving; the model applies until you reload.");
  S.draft = null; renderWeights();
}
function rerank() { recompute(); reorder(); schedule(); }

/* ================= misc renders ================= */
function renderSymList() {
  const ids = (S.M ? S.M.rows.map(r => r.id) : []).concat(S.SP ? S.SP.rows.map(r => r.s).sort() : []);
  const html = ids.map(id => `<option value="${esc(id)}">`).join("");
  const el = $("#symList"); if (el._html !== html) { el.innerHTML = html; el._html = html; }
}
function tick1s() {
  renderClocks(); renderRing(); renderLiveChip();
  if (snapDue(new Date())) takeSnapshot(false);
}

/* ================= events ================= */
function onCardActivate(e) { const c = e.target.closest("[data-id]"); if (c && !e.target.closest("button")) openDrawer(c.dataset.id); }
["#edgeCards", "#matrix", "#heatBody", "#snap"].forEach(sel => { const el = $(sel); el.addEventListener("click", onCardActivate); el.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-id]")) { e.preventDefault(); openDrawer(e.target.dataset.id); } }); });
function onStockActivate(e) { const c = e.target.closest("[data-s]"); if (c) openStock(c.dataset.s); }
["#tmap", "#spPlay", "#spLongs", "#spShorts", "#spEarn"].forEach(sel => { const el = $(sel); el.addEventListener("click", onStockActivate); el.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-s]")) { e.preventDefault(); openStock(e.target.dataset.s); } }); });
$("#scrim").addEventListener("click", closeDrawer);
$("#drClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && (S.open || S.openStock)) closeDrawer(); });
$("#drFeed").addEventListener("click", e => {
  const b = e.target.closest("button[data-df]"); if (!b) return; S.drFeed = b.dataset.df;
  $$("#drFeed button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  if (S.open) drawerChart(TV_FUT[S.open] ? [["cfd", "CFD · real-time", TV[S.open]], ["fut", "Futures · levels", TV_FUT[S.open]]] : [["cfd", "Live", TV[S.open]]]);
});
$("#clsTabs").addEventListener("click", e => { const b = e.target.closest("button[data-c]"); if (!b) return; S.cls = b.dataset.c; $$("#clsTabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderMatrix(); });
$("#sortSel").addEventListener("change", e => { S.sort = e.target.value; reorder(); renderMatrix(); });
$("#chartSyms").addEventListener("click", e => { const b = e.target.closest("button[data-sym]"); if (b) setChart(b.dataset.sym); });
$("#feedTabs").addEventListener("click", e => { const b = e.target.closest("button[data-f]"); if (b && !b.disabled) setChart(S.chart.id, b.dataset.f); });
$("#mapMetric").addEventListener("click", e => { const b = e.target.closest("button[data-m]"); if (!b) return; S.mapMetric = b.dataset.m; $$("#mapMetric button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderTreemap(); });
$("#briefSrc").addEventListener("click", e => { const b = e.target.closest("button[data-b]"); if (!b) return; S.briefMode = b.dataset.b; renderBrief(); });
$("#briefMore").addEventListener("click", () => { $("#briefText").classList.toggle("clamped"); renderBrief(); });
$("#snap").addEventListener("click", async e => {
  if (e.target.closest("#snapNow")) { e.stopPropagation(); takeSnapshot(true); return; }
  if (e.target.closest("#snapNotify")) {
    e.stopPropagation();
    if (S.notify) { S.notify = false; store.set("uhe.notify", false); renderSnap(); return; }
    let perm = Notification.permission; if (perm === "default") { try { perm = await Notification.requestPermission(); } catch (err) { perm = "denied"; } }
    if (perm === "granted") { S.notify = true; store.set("uhe.notify", true); toast("You'll get an alert 10 minutes before the NY open while this tab is open."); }
    else toast("Notifications are blocked for this site in your browser settings.");
    renderSnap();
  }
});
$("#jForm").addEventListener("submit", saveTrade);
$("#jBody").addEventListener("click", e => {
  const b = e.target.closest("[data-del]"); if (!b) return;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm"; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = "Delete"; } }, 3500); return; }
  S.journal = S.journal.filter(t => t.id !== b.dataset.del); persistJournal(); renderJournal(); toast("Trade deleted.");
});
$("#jExport").addEventListener("click", exportBackup);
$("#jImportBtn").addEventListener("click", () => $("#jImport").click());
$("#jImport").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ""; });
$("#weights").addEventListener("input", e => { const k = e.target.dataset.w; if (!k) return; const E = eff(); S.draft = { ...(S.draft || {}), weights: { ...E.weights, [k]: +e.target.value } }; e.target.nextElementSibling.textContent = e.target.value; $("#wSave").disabled = false; rerank(); });
$("#thLong").addEventListener("input", e => { S.draft = { ...(S.draft || {}), longAt: +e.target.value }; $("#thLongV").textContent = e.target.value; $("#wSave").disabled = false; rerank(); });
$("#thShort").addEventListener("input", e => { S.draft = { ...(S.draft || {}), shortAt: +e.target.value }; $("#thShortV").textContent = e.target.value; $("#wSave").disabled = false; rerank(); });
$("#wReset").addEventListener("click", () => { S.draft = { weights: { ...DEFAULTS.weights }, longAt: DEFAULTS.longAt, shortAt: DEFAULTS.shortAt }; renderWeights(); $("#wSave").disabled = false; rerank(); });
$("#wSave").addEventListener("click", saveModel);
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { renderJournal(); if (S.mapMetric !== "tv") renderTreemap(); }, 150); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { load("quotes"); renderLiveChip(); } });

/* ================= boot ================= */
$("#jDate").value = tzParts(new Date(), UK).ymd;
renderClocks(); renderRing(); renderTimeline(); renderRegime(); renderEdges(); renderMatrix(); renderSnap(); renderLab(); renderScanner(); renderCot(); renderFinra(); renderCal(); renderNext(); renderBrief(); renderJournal(); renderWeights(); renderStatus(); renderLiveChip();
tvTape();
if ("IntersectionObserver" in window) new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { S.chart.visible = true; mountMainChart(); } }, { rootMargin: "300px" }).observe($("#live-chart"));
else { S.chart.visible = true; mountMainChart(); }
Object.keys(FEEDS).forEach((k, i) => setTimeout(() => loop(k), i * 120));
setInterval(tick1s, 1000);
setInterval(() => { renderTimeline(); renderNext(); renderCal(); renderBrief(); }, 60000);
setInterval(() => { reorder(); schedule(); }, 60000);
