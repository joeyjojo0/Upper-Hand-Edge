// Upper Hand Edge — shared server-side data layer (Vercel Node functions).
// Public sources only: Yahoo Finance (unofficial chart/quote endpoints), FINRA Reg SHO daily files,
// CFTC Commitments of Traders (Socrata API) and the Forex Factory weekly calendar export.

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PROXY_BASE = process.env.YAHOO_PROXY || "";
// With YAHOO_PROXY set (GitHub data engine), every Yahoo call goes through the curl_cffi relay.
const HOSTS = PROXY_BASE ? [PROXY_BASE] : ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

/* ------------------------------------------------------------------ instruments */
// [id, yahoo symbol, name, class, decimals]
export const INSTRUMENTS = [
  ["US30", "YM=F", "Dow Jones", "index", 0], ["US500", "ES=F", "S&P 500", "index", 2], ["NAS100", "NQ=F", "Nasdaq 100", "index", 2],
  ["US2000", "RTY=F", "Russell 2000", "index", 1], ["UK100", "^FTSE", "FTSE 100", "index", 1], ["GER40", "^GDAXI", "DAX 40", "index", 1],
  ["EU50", "^STOXX50E", "Euro Stoxx 50", "index", 1],
  ["EURUSD", "EURUSD=X", "Euro / Dollar", "fx", 5], ["GBPUSD", "GBPUSD=X", "Pound / Dollar", "fx", 5], ["USDJPY", "USDJPY=X", "Dollar / Yen", "fx", 3],
  ["AUDUSD", "AUDUSD=X", "Aussie / Dollar", "fx", 5], ["USDCAD", "USDCAD=X", "Dollar / Loonie", "fx", 5], ["USDCHF", "USDCHF=X", "Dollar / Franc", "fx", 5],
  ["NZDUSD", "NZDUSD=X", "Kiwi / Dollar", "fx", 5], ["EURGBP", "EURGBP=X", "Euro / Pound", "fx", 5], ["GBPJPY", "GBPJPY=X", "Pound / Yen", "fx", 3],
  ["EURJPY", "EURJPY=X", "Euro / Yen", "fx", 3], ["AUDJPY", "AUDJPY=X", "Aussie / Yen", "fx", 3], ["GBPAUD", "GBPAUD=X", "Pound / Aussie", "fx", 5],
  ["XAUUSD", "GC=F", "Gold", "cmd", 1], ["XAGUSD", "SI=F", "Silver", "cmd", 3], ["WTI", "CL=F", "WTI crude", "cmd", 2],
  ["BTCUSD", "BTC-USD", "Bitcoin", "crypto", 0], ["ETHUSD", "ETH-USD", "Ether", "crypto", 1]
];
export const CONTEXT = [["DXY", "DX-Y.NYB", 3], ["US10Y", "^TNX", 3], ["VIX", "^VIX", 2], ["VIX3M", "^VIX3M", 2], ["N225", "^N225", 0], ["HSI", "^HSI", 0]];

/* ------------------------------------------------------------------ helpers */
export const rd = (x, d = 2) => (x == null || !isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
export const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export const clip = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const pct = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1000) / 10;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const sma = (a, n) => a.length >= n ? avg(a.slice(-n)) : null;

export async function pool(items, fn, width) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: String(e && e.message || e), __item: items[k] }; } } }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

async function getJSON(path, { headers = {}, tries = 4 } = {}) {
  let err;
  for (let a = 0; a < tries; a++) {
    const host = HOSTS[a % HOSTS.length];
    try {
      const r = await fetch(host + path, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
      if (r.status === 429 || r.status >= 500) { err = new Error("Yahoo HTTP " + r.status); await sleep(500 * (a + 1) + Math.random() * 300); continue; }
      if (!r.ok) throw new Error("Yahoo HTTP " + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(300 * (a + 1)); }
  }
  throw err;
}

export async function chart(sym, range, interval, prepost = false) {
  const j = await getJSON(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=${prepost}`);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || "no chart result for " + sym);
  return res;
}

export function bars(res) {
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {}, t = res.timestamp || [], out = [];
  for (let i = 0; i < t.length; i++) {
    const c = q.close && q.close[i];
    if (c == null || q.high[i] == null || q.low[i] == null) continue;
    out.push({ t: t[i], o: q.open[i] == null ? c : q.open[i], h: q.high[i], l: q.low[i], c, v: (q.volume && q.volume[i]) || 0 });
  }
  return out;
}

// Cut bad-tick wicks: a wick longer than k x the median bar range goes back to the body.
export function despike(arr, k) {
  const rg = arr.map(b => b.h - b.l).sort((a, b) => a - b), med = rg[Math.floor(rg.length / 2)] || 0;
  if (!(med > 0)) return;
  for (const b of arr) { const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c); if (b.h - top > k * med) b.h = top; if (bot - b.l > k * med) b.l = bot; }
}

export function rsi(c, n = 14) {
  if (c.length <= n + 1) return null; let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
export function atr(b, n = 14) {
  if (b.length <= n + 1) return null; const tr = [];
  for (let i = 1; i < b.length; i++) { const pc = b[i - 1].c; tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - pc), Math.abs(b[i].l - pc))); }
  let a = avg(tr.slice(0, n)); for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a;
}

/* ------------------------------------------------------------------ time */
const fmtUK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
export function uk(ts) { const p = {}; for (const x of fmtUK.formatToParts(new Date(ts * 1000))) p[x.type] = x.value; return { d: `${p.year}-${p.month}-${p.day}`, m: (+p.hour % 24) * 60 + (+p.minute), wd: p.weekday }; }
const fmtET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
export function et(ts) { const p = {}; for (const x of fmtET.formatToParts(new Date(ts * 1000))) p[x.type] = x.value; return { d: `${p.year}-${p.month}-${p.day}`, m: (+p.hour % 24) * 60 + (+p.minute), h: +p.hour % 24, wd: p.weekday }; }
function offMin(date, tz) {
  const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date)) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - date.getTime()) / 60000);
}
const nyoCache = {};
// New York 09:30 expressed in UK minutes for that date (handles the weeks when US and UK clocks change on different dates)
export function nyOpenUK(d) { if (nyoCache[d] == null) { const noon = new Date(d + "T12:00:00Z"); nyoCache[d] = 570 - offMin(noon, "America/New_York") + offMin(noon, "Europe/London"); } return nyoCache[d]; }
function win(a, from, to) {
  const w = a.filter(b => b.m >= from && b.m < to); if (!w.length) return null;
  let h = -Infinity, l = Infinity; for (const b of w) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; }
  return { o: w[0].o, c: w[w.length - 1].c, h, l, n: w.length };
}

/* ------------------------------------------------------------------ markets: sessions + NY-open statistics */
export async function instrument([id, sym, name, cls, dp]) {
  const R = x => rd(x, dp + 1);
  const [dRes, iRes] = await Promise.all([chart(sym, "1y", "1d"), chart(sym, "60d", "15m", true)]);
  const d = bars(dRes), ib = bars(iRes);
  if (!ib.length || d.length < 30) throw new Error("not enough data");
  despike(ib, 8); despike(d, 3);
  const byDay = {};
  for (const b of ib) { const u = uk(b.t); b.m = u.m; b.wd = u.wd; (byDay[u.d] = byDay[u.d] || []).push(b); }
  const today = uk(Date.now() / 1000).d;
  const per = Object.keys(byDay).sort().map(dt => { const a = byDay[dt], nyo = nyOpenUK(dt); return { dt, wd: a[0].wd, nyo, all: win(a, 0, 1440), asia: win(a, 0, 420), lon: win(a, 480, nyo), ny1: win(a, nyo, nyo + 60), ny: win(a, nyo, nyo + 390) }; });
  const full = per.filter(p => p.dt < today && p.all && p.all.n >= 16 && p.wd !== "Sat" && p.wd !== "Sun");
  const adr = avg(full.slice(-20).map(p => p.all.h - p.all.l));
  const S = full.filter(p => p.lon && p.ny1 && p.lon.n >= 8 && p.ny1.n >= 3).slice(-55);
  let contN = 0, cont = 0, up = 0, bLH = 0, bLL = 0, rng = 0, pdN = 0, pdTag = 0, sN = 0, sCont = 0;
  for (const p of S) {
    const lm = p.lon.c - p.lon.o, nm = p.ny1.c - p.ny1.o;
    if (lm && nm) { contN++; if (Math.sign(lm) === Math.sign(nm)) cont++; }
    if (nm > 0) up++;
    if (p.ny1.h > p.lon.h) bLH++; if (p.ny1.l < p.lon.l) bLL++;
    rng += p.ny1.h - p.ny1.l;
    if (adr && Math.abs(lm) >= 0.35 * adr && nm) { sN++; if (Math.sign(lm) === Math.sign(nm)) sCont++; }
    const i = full.indexOf(p), prev = i > 0 ? full[i - 1] : null;
    if (prev && p.ny) { pdN++; if (p.ny.h > prev.all.h || p.ny.l < prev.all.l) pdTag++; }
  }
  const n = S.length;
  const st = { n, cont: contN ? pct(cont / contN) : null, up: n ? pct(up / n) : null, bLH: n ? pct(bLH / n) : null, bLL: n ? pct(bLL / n) : null, ny1: n ? R(rng / n) : null, ny1Adr: n && adr ? pct(rng / n / adr) : null, pdTag: pdN ? pct(pdTag / pdN) : null, sCont: sN ? pct(sCont / sN) : null, sN };
  const T = per.find(p => p.dt === today) || null, prev = full[full.length - 1] || null, last = ib[ib.length - 1];
  const dc = d.map(x => x.c), A = atr(d);
  const wdIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[uk(Date.now() / 1000).wd];
  const wkStart = new Date(Date.now() - wdIdx * 86400000).toISOString().slice(0, 10);
  const wkDay = per.find(p => p.dt >= wkStart);
  const P = prev ? (prev.all.h + prev.all.l + prev.all.c) / 3 : null;
  const spark = ib.slice(-64).map(b => R(b.c)).filter((_, i, arr) => (arr.length - 1 - i) % 2 === 0);
  return {
    id, name, cls, dp, px: R(last.c), at: new Date(last.t * 1000).toISOString().slice(0, 16),
    chg: prev ? rd((last.c / prev.all.c - 1) * 100, 2) : null, adr: R(adr), atr: R(A), nyo: T ? T.nyo : nyOpenUK(today),
    td: T ? { o: R(T.all.o), h: R(T.all.h), l: R(T.all.l), aH: T.asia ? R(T.asia.h) : null, aL: T.asia ? R(T.asia.l) : null, lO: T.lon ? R(T.lon.o) : null, lH: T.lon ? R(T.lon.h) : null, lL: T.lon ? R(T.lon.l) : null, lC: T.lon ? R(T.lon.c) : null, nO: T.ny1 ? R(T.ny1.o) : null, nH: T.ny ? R(T.ny.h) : null, nL: T.ny ? R(T.ny.l) : null } : null,
    pd: prev ? { d: prev.dt, h: R(prev.all.h), l: R(prev.all.l), c: R(prev.all.c), nH: prev.ny ? R(prev.ny.h) : null, nL: prev.ny ? R(prev.ny.l) : null, nC: prev.ny ? R(prev.ny.c) : null } : null,
    wo: wkDay ? R(wkDay.all.o) : null,
    piv: P ? { p: R(P), r1: R(2 * P - prev.all.l), s1: R(2 * P - prev.all.h), r2: R(P + prev.all.h - prev.all.l), s2: R(P - (prev.all.h - prev.all.l)) } : null,
    sma20: R(sma(dc, 20)), sma50: R(sma(dc, 50)), sma200: R(sma(dc, 200)), rsi: rd(rsi(dc), 1),
    ret5: dc.length > 6 ? rd((dc[dc.length - 1] / dc[dc.length - 6] - 1) * 100, 2) : null,
    ret20: dc.length > 21 ? rd((dc[dc.length - 1] / dc[dc.length - 21] - 1) * 100, 2) : null,
    hi20: R(Math.max(...d.slice(-20).map(x => x.h))), lo20: R(Math.min(...d.slice(-20).map(x => x.l))), st, spark: spark.join(" ")
  };
}

export async function contextSeries([id, sym, dp]) {
  const [intra, daily] = await Promise.all([chart(sym, "5d", "15m", true), chart(sym, "10d", "1d")]);
  const m = daily.meta, px = m.regularMarketPrice, mDate = uk(m.regularMarketTime).d;
  const db = bars(daily).filter(b => uk(b.t).d < mDate);
  const pc = db.length ? db[db.length - 1].c : m.chartPreviousClose;
  let sp = bars(intra).slice(-48).map(b => rd(b.c, dp));
  if (sp.length < 3) sp = bars(daily).map(b => rd(b.c, dp));
  return { id, px: rd(px, dp), prev: rd(pc, dp + 1), chg: pc ? rd((px / pc - 1) * 100, 2) : null, at: new Date((m.regularMarketTime || 0) * 1000).toISOString().slice(0, 16), spark: sp.join(" ") };
}

export async function markets() {
  const inst = await pool(INSTRUMENTS, instrument, 6);
  const ctx = await pool(CONTEXT, contextSeries, 6);
  const errors = [];
  const instruments = inst.map((x, i) => x.__err ? (errors.push(INSTRUMENTS[i][0] + ": " + x.__err), { id: INSTRUMENTS[i][0], err: x.__err }) : x);
  const context = ctx.map((x, i) => x.__err ? (errors.push(CONTEXT[i][0] + ": " + x.__err), { id: CONTEXT[i][0], err: x.__err }) : x);
  if (errors.length >= INSTRUMENTS.length) throw new Error("Yahoo Finance unavailable: " + errors[0]);
  return { v: 3, asOf: new Date().toISOString(), source: "Yahoo Finance (daily 1y, 15-minute 60d)", instruments, context, errors };
}

/* ------------------------------------------------------------------ live quotes */
let CRUMB = null;
export async function crumb(force = false) {
  if (PROXY_BASE) return { cookie: "", crumb: "relay", at: Date.now() };
  if (!force && CRUMB && Date.now() - CRUMB.at < 25 * 60e3) return CRUMB;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const sc = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")];
  const cookie = sc.filter(Boolean).map(c => c.split(";")[0]).join("; ");
  let c = "", status = 0;
  for (const h of HOSTS) {
    const r2 = await fetch(h + "/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
    status = r2.status; c = (await r2.text()).trim();
    if (r2.ok && c && !c.includes("<") && c.length < 40) break;
    c = "";
  }
  if (!c) throw new Error("Yahoo crumb unavailable (HTTP " + status + ")");
  CRUMB = { cookie, crumb: c, at: Date.now() };
  return CRUMB;
}

// Batch quotes. Tries the v7 quote API (needs a crumb); falls back to chart metadata per symbol.
export async function quoteMap(symbols, { batch = 100 } = {}) {
  const out = {};
  let mode = "quote";
  try {
    let cr = await crumb();
    for (let i = 0; i < symbols.length; i += batch) {
      const part = symbols.slice(i, i + batch).map(encodeURIComponent).join(",");
      let j;
      try { j = await getJSON(`/v7/finance/quote?symbols=${part}&crumb=${encodeURIComponent(cr.crumb)}`, { headers: { Cookie: cr.cookie }, tries: 2 }); }
      catch (e) { cr = await crumb(true); j = await getJSON(`/v7/finance/quote?symbols=${part}&crumb=${encodeURIComponent(cr.crumb)}`, { headers: { Cookie: cr.cookie }, tries: 2 }); }
      for (const q of (j.quoteResponse && j.quoteResponse.result) || []) out[q.symbol] = q;
    }
  } catch (e) {
    mode = "chart-meta";
    const missing = symbols.filter(s => !out[s]);
    const res = await pool(missing, async s => { const r = await chart(s, "1d", "5m", true); return [s, r.meta]; }, 12);
    for (const r of res) if (r && !r.__err) {
      const [s, m] = r;
      const pc = m.chartPreviousClose ?? m.previousClose;
      out[s] = { symbol: s, regularMarketPrice: m.regularMarketPrice, regularMarketPreviousClose: pc, regularMarketChangePercent: pc ? (m.regularMarketPrice / pc - 1) * 100 : undefined, regularMarketTime: m.regularMarketTime, regularMarketDayHigh: m.regularMarketDayHigh, regularMarketDayLow: m.regularMarketDayLow, exchangeDataDelayedBy: 0, marketState: undefined };
    }
  }
  return { mode, q: out };
}

// Real-time ETFs used to nowcast the (delayed) CME futures while US equities trade (04:00-20:00 New York).
export const PROXIES = { US500: ["ES=F", "SPY"], NAS100: ["NQ=F", "QQQ"], US30: ["YM=F", "DIA"], US2000: ["RTY=F", "IWM"], XAUUSD: ["GC=F", "GLD"], XAGUSD: ["SI=F", "SLV"], WTI: ["CL=F", "USO"] };
const ETFS = [...new Set(Object.values(PROXIES).map(p => p[1]))];
// Latest traded price across pre-market, regular and after-hours sessions.
function lastPx(x) {
  const c = [[x.regularMarketPrice, x.regularMarketTime], [x.preMarketPrice, x.preMarketTime], [x.postMarketPrice, x.postMarketTime]].filter(([p, t]) => p != null && t);
  c.sort((a, b) => b[1] - a[1]);
  return c[0] || [x.regularMarketPrice, x.regularMarketTime];
}
export async function liveQuotes() {
  const syms = INSTRUMENTS.map(r => r[1]).concat(CONTEXT.map(r => r[1]), ETFS);
  const { mode, q } = await quoteMap(syms);
  const pick = (id, sym, dp) => {
    const x = q[sym]; if (!x || x.regularMarketPrice == null) return null;
    const prev = x.regularMarketPreviousClose;
    const chgd = x.regularMarketChangePercent != null ? x.regularMarketChangePercent : (prev ? (x.regularMarketPrice / prev - 1) * 100 : null);
    return { px: rd(x.regularMarketPrice, dp + 1), prev: rd(prev, dp + 1), chgd: rd(chgd, 2), hi: rd(x.regularMarketDayHigh, dp + 1), lo: rd(x.regularMarketDayLow, dp + 1), t: x.regularMarketTime || null, state: x.marketState || null, delay: x.exchangeDataDelayedBy || 0 };
  };
  const inst = {}, ctx = {}, etf = {};
  for (const [id, sym, , , dp] of INSTRUMENTS) { const v = pick(id, sym, dp); if (v) inst[id] = v; }
  for (const [id, sym, dp] of CONTEXT) { const v = pick(id, sym, dp); if (v) ctx[id] = v; }
  for (const s of ETFS) { const x = q[s]; if (!x || x.regularMarketPrice == null) continue; const [p, t] = lastPx(x); etf[s] = { px: rd(p, 3), t: t || null, state: x.marketState || null, delay: x.exchangeDataDelayedBy || 0 }; }
  if (!Object.keys(inst).length) throw new Error("no quotes returned by Yahoo Finance");
  return { asOf: new Date().toISOString(), mode, inst, ctx, etf };
}

// Futures/ETF price ratio on the latest 1-minute bar both traded in. Futures quotes are ~10 minutes late on free feeds;
// the ratio moves slowly, so ETF price x ratio gives a real-time estimate of the future.
export async function basis() {
  const pairs = {}, errors = [];
  const res = await pool(Object.entries(PROXIES), async ([id, [fut, etfSym]]) => {
    const [a, b] = await Promise.all([chart(fut, "1d", "1m", true), chart(etfSym, "1d", "1m", true)]);
    const A = bars(a), B = new Map(bars(b).map(x => [x.t, x.c]));
    for (let i = A.length - 1; i >= 0 && i >= A.length - 600; i--) {
      const e = B.get(A[i].t);
      if (e) return [id, { etf: etfSym, ratio: A[i].c / e, t: A[i].t, fut: A[i].c, etfPx: e }];
    }
    return [id, null];
  }, 7);
  res.forEach((r, i) => { if (r && r.__err) errors.push(Object.keys(PROXIES)[i] + ": " + r.__err); else if (r && r[1]) pairs[r[0]] = r[1]; });
  return { asOf: new Date().toISOString(), pairs, errors };
}

/* ------------------------------------------------------------------ FINRA off-exchange short volume */
export async function finra(SYMS = ["SPY", "QQQ", "DIA", "IWM", "GLD", "TLT", "HYG", "XLF", "XLK", "SMH"], N = 21) {
  const want = new Set(SYMS), data = Object.fromEntries(SYMS.map(s => [s, []])), days = [];
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  const cand = []; let t = new Date(); t.setUTCHours(12, 0, 0, 0);
  for (let i = 0; i < 45 && cand.length < N + 10; i++) { const wd = t.getUTCDay(); if (wd > 0 && wd < 6) cand.push(ymd(t)); t = new Date(t.getTime() - 86400000); }
  async function get(d) {
    const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${d}.txt`, { headers: { "User-Agent": UA } });
    if (!r.ok) return null; const txt = await r.text(); if (txt.length < 1000) return null;
    const rows = {}; for (const line of txt.split("\n")) { const p = line.split("|"); if (p.length >= 5 && want.has(p[1])) rows[p[1]] = [+p[2], +p[4]]; }
    return rows;
  }
  for (let i = 0; i < cand.length && days.length < N; i += 6) {
    const batch = cand.slice(i, i + 6); const res = await Promise.all(batch.map(d => get(d).catch(() => null)));
    batch.forEach((d, k) => { if (res[k] && days.length < N) { days.push(d); for (const s of SYMS) if (res[k][s]) data[s].push({ d, sv: res[k][s][0], tv: res[k][s][1] }); } });
  }
  const r3 = x => Math.round(x * 1000) / 1000;
  const rows = SYMS.map(s => {
    const a = data[s].slice().sort((x, y) => x.d.localeCompare(y.d)); if (a.length < 5) return { s, err: "not enough days" };
    const ratios = a.map(x => x.sv / x.tv), last = ratios[ratios.length - 1], hist = ratios.slice(0, -1);
    const m = avg(hist), sd = Math.sqrt(avg(hist.map(y => (y - m) ** 2))) || 1e-9;
    return { s, day: a[a.length - 1].d, last: r3(last), avg: r3(m), z: Math.round((last - m) / sd * 100) / 100, offVol: Math.round(a[a.length - 1].tv), series: ratios.map(r3).join(" ") };
  });
  return { asOf: new Date().toISOString(), days: days.length, latest: days[0] || null, source: "FINRA Reg SHO daily short sale volume", rows };
}

/* ------------------------------------------------------------------ CFTC Commitments of Traders */
export const COT_CODES = { EUR: "099741", GBP: "096742", JPY: "097741", AUD: "232741", CAD: "090741", CHF: "092741", NZD: "112741", USD: "098662", ES: "13874A", NQ: "209742", YM: "124603", RTY: "239742", GOLD: "088691", SILVER: "084691", WTI: "067651", BTC: "133741", ETH: "146021" };
export async function cot(MAP = COT_CODES) {
  const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const codes = Object.values(MAP).map(c => `'${c}'`).join(",");
  const q = `$select=report_date_as_yyyy_mm_dd,cftc_contract_market_code,market_and_exchange_names,noncomm_positions_long_all,noncomm_positions_short_all,open_interest_all&$where=cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${since}'&$order=report_date_as_yyyy_mm_dd&$limit=20000`;
  const r = await fetch("https://publicreporting.cftc.gov/resource/6dca-aqww.json?" + encodeURI(q), { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("CFTC HTTP " + r.status);
  const all = await r.json(), by = {};
  for (const x of all) (by[x.cftc_contract_market_code] = by[x.cftc_contract_market_code] || []).push(x);
  let report = null;
  const rows = Object.entries(MAP).map(([k, code]) => {
    const a = by[code]; if (!a || a.length < 10) return { k, err: "no data" };
    const net = a.map(x => (+x.noncomm_positions_long_all) - (+x.noncomm_positions_short_all));
    const last = net[net.length - 1], prev = net[net.length - 2], mn = Math.min(...net), mx = Math.max(...net);
    const d = a[a.length - 1].report_date_as_yyyy_mm_dd.slice(0, 10); if (!report || d > report) report = d;
    return { k, name: a[a.length - 1].market_and_exchange_names.split(" - ")[0].slice(0, 40), d, net: last, chg: last - prev, pct: mx > mn ? Math.round((last - mn) / (mx - mn) * 100) : 50, oi: +a[a.length - 1].open_interest_all };
  });
  return { asOf: new Date().toISOString(), report, source: "CFTC Commitments of Traders, legacy futures only", rows };
}

/* ------------------------------------------------------------------ economic calendar */
export async function calendar(CUR = ["USD", "GBP", "EUR", "JPY", "AUD", "CAD", "CHF", "NZD", "CNY"]) {
  const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("Calendar HTTP " + r.status);
  const j = await r.json();
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const items = [];
  for (const e of j) {
    if (!CUR.includes(e.country)) continue;
    if (!(e.impact === "High" || e.impact === "Medium" || e.impact === "Holiday")) continue;
    const p = {}; for (const x of fmt.formatToParts(new Date(e.date))) p[x.type] = x.value;
    const allDay = /T00:00:00/.test(e.date) && (e.impact === "Holiday" || /All Day|Tentative/i.test(e.title));
    items.push({ d: `${p.year}-${p.month}-${p.day}`, t: allDay ? "All day" : String(+p.hour % 24).padStart(2, "0") + ":" + p.minute, c: e.country, ev: e.title, imp: e.impact === "High" ? "high" : e.impact === "Medium" ? "med" : "hol", f: e.forecast || "", p: e.previous || "" });
  }
  items.sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t));
  return { asOf: new Date().toISOString(), source: "Forex Factory weekly calendar export", items };
}

/* ------------------------------------------------------------------ S&P 500 scanner */
export const SECTORS = ["Information Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples", "Health Care", "Financials", "Industrials", "Energy", "Materials", "Utilities", "Real Estate"];
export const SECTOR_SHORT = ["Tech", "Comms", "Discretionary", "Staples", "Health care", "Financials", "Industrials", "Energy", "Materials", "Utilities", "Real estate"];
let LIST = null;
export async function sp500List() {
  if (LIST && Date.now() - LIST.at < 12 * 3600e3) return LIST.rows;
  const r = await fetch("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv", { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Constituents HTTP " + r.status);
  const txt = await r.text();
  const parse = l => { const o = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; } o.push(cur); return o; };
  const lines = txt.trim().split(/\r?\n/), head = parse(lines[0]);
  const iS = head.indexOf("Symbol"), iN = head.indexOf("Security"), iG = head.indexOf("GICS Sector");
  const rows = lines.slice(1).map(parse).map(p => ({ s: p[iS].trim(), y: p[iS].trim().replace(/\./g, "-"), name: String(p[iN] || "").slice(0, 30), sec: Math.max(0, SECTORS.indexOf(p[iG])) })).filter(x => x.s);
  LIST = { rows, at: Date.now() };
  return rows;
}

// Daily-bar metrics for every member (slow: ~500 requests). Cache this for an hour at the edge.
export async function scanHist() {
  const list = await sp500List();
  const now = et(Date.now() / 1000), td = now.wd !== "Sat" && now.wd !== "Sun";
  const hist = await pool(["SPY"].concat(list.map(x => x.y)), async sym => {
    const b = bars(await chart(sym, "3mo", "1d"));
    // drop today's bar while the regular session is still running
    if (b.length && td && et(b[b.length - 1].t).d === now.d && now.m < 960) b.pop();
    return b;
  }, PROXY_BASE ? 8 : 24);
  const spy = hist[0] && !hist[0].__err ? hist[0] : [];
  const sc = spy.map(x => x.c), sn = sc.length;
  const spy5 = sn > 6 ? (sc[sn - 1] / sc[sn - 6] - 1) * 100 : 0, spy20 = sn > 21 ? (sc[sn - 1] / sc[sn - 21] - 1) * 100 : 0;
  const rows = [];
  list.forEach((x, i) => {
    const b = hist[i + 1]; if (!b || b.__err || b.length < 25) return;
    const c = b.map(z => z.c), n = c.length, last = b[n - 1], A = atr(b);
    const adv20 = avg(b.slice(-21, -1).map(z => z.v));
    rows.push({ s: x.s, y: x.y, name: x.name, sec: x.sec, atr: rd(A, 3), rsi: rd(rsi(c), 0), sma20: rd(avg(c.slice(-20)), 3), hi20: rd(Math.max(...b.slice(-20).map(z => z.h)), 3), lo20: rd(Math.min(...b.slice(-20).map(z => z.l)), 3),
      ret5: n > 6 ? rd((c[n - 1] / c[n - 6] - 1) * 100, 2) : null, ret20: n > 21 ? rd((c[n - 1] / c[n - 21] - 1) * 100, 2) : null, rvol: adv20 ? rd(last.v / adv20, 2) : null,
      lchg: rd((last.c / b[n - 2].c - 1) * 100, 2), clv: last.h > last.l ? rd(((last.c - last.l) - (last.h - last.c)) / (last.h - last.l), 2) : 0, pdh: rd(last.h, 3), pdl: rd(last.l, 3), pdc: rd(last.c, 3), adv20: Math.round(adv20 || 0), day: et(last.t).d });
  });
  if (rows.length < Math.min(50, list.length)) throw new Error("S&P 500 history incomplete (" + rows.length + " of " + list.length + ")");
  return { asOf: new Date().toISOString(), spy5: rd(spy5), spy20: rd(spy20), n: rows.length, missing: list.length - rows.length, rows };
}

let HIST = null;
export async function scanHistCached(maxAgeMs = 3 * 3600e3) {
  if (HIST && Date.now() - HIST.at < maxAgeMs) return HIST.data;
  const data = await scanHist(); HIST = { data, at: Date.now() }; return data;
}

const SCAN_W = { trend: 20, momentum: 10, rs: 20, clv: 10, gap: 25, thrust: 15 };
export async function scanLive(H) {
  const { q } = await quoteMap(H.rows.map(r => r.y));
  const nowET = et(Date.now() / 1000).d, horizon = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
  let state = "CLOSED";
  const rows = [];
  for (const h of H.rows) {
    const x = q[h.y]; if (!x || x.regularMarketPrice == null) continue;
    const ms = x.marketState || ""; if (ms) state = ms;
    const px = x.regularMarketPrice, A = h.atr, atrPct = A && px ? A / px * 100 : null;
    let gap = null, ext = null;
    if (/PRE/.test(ms) && x.preMarketPrice) { ext = x.preMarketPrice; gap = x.preMarketChangePercent; }
    else if (/REGULAR/.test(ms)) { ext = px; gap = x.regularMarketChangePercent; }
    else if (/POST|CLOSED/.test(ms) && x.postMarketPrice) { ext = x.postMarketPrice; gap = x.postMarketChangePercent; }
    const sma50 = x.fiftyDayAverage, sma200 = x.twoHundredDayAverage, sma20 = h.sma20;
    const comp = {};
    if (A && sma20 && sma50 && sma200) comp.trend = 0.5 * clip(((px - sma20) / A) / 2) + 0.25 * (sma20 >= sma50 ? 1 : -1) + 0.25 * (px >= sma200 ? 1 : -1);
    if (h.rsi != null) comp.momentum = clip((h.rsi - 50) / 20);
    if (h.ret5 != null && h.ret20 != null) comp.rs = clip(((h.ret5 - H.spy5) / 4 + (h.ret20 - H.spy20) / 8) / 2);
    comp.clv = h.clv || 0;
    if (gap != null && atrPct) comp.gap = clip(gap / (atrPct * 0.5));
    if (h.rvol != null && h.lchg != null) comp.thrust = Math.sign(h.lchg) * clip((h.rvol - 1) / 1.5, 0, 1);
    let num = 0, den = 0; for (const k in comp) { num += SCAN_W[k] * comp[k]; den += SCAN_W[k]; }
    const score = den ? Math.round(50 + 50 * num / den) : 50;
    let er = null; const ets = x.earningsTimestamp || x.earningsTimestampStart;
    if (ets) { const e = et(ets); if (e.d >= nowET && e.d <= horizon) er = { d: e.d, t: e.h < 12 ? "BMO" : e.h >= 15 ? "AMC" : "DUR", est: !!x.isEarningsDateEstimate }; }
    const exch = x.exchange || "", tv = /^(NMS|NGM|NCM|NAS)$/.test(exch) ? "NASDAQ" : /^(NYQ|NYS)$/.test(exch) ? "NYSE" : /^(ASE|PCX|AMEX)$/.test(exch) ? "AMEX" : /BATS|BTS/.test(exch) ? "CBOE" : "";
    rows.push({ s: h.s, name: h.name, sec: h.sec, tv, px: rd(px), chg: rd(x.regularMarketChangePercent), gap: rd(gap), ext: rd(ext), mcap: x.marketCap ? rd(x.marketCap / 1e9, 1) : rd(h.adv20 * px * 20 / 1e9, 1),
      dv: Math.round((x.averageDailyVolume3Month || h.adv20 || 0) * px / 1e6), atr: rd(A), atrPct: rd(atrPct), rsi: h.rsi, rvol: h.rvol, ret5: rd(h.ret5, 1), ret20: rd(h.ret20, 1), sma20: rd(sma20), sma50: rd(sma50), sma200: rd(sma200),
      d50: sma50 ? rd((px / sma50 - 1) * 100, 1) : null, d200: sma200 ? rd((px / sma200 - 1) * 100, 1) : null, d52: x.fiftyTwoWeekHigh ? rd((px / x.fiftyTwoWeekHigh - 1) * 100, 1) : null,
      pdh: rd(h.pdh), pdl: rd(h.pdl), pdc: rd(h.pdc), hi20: rd(h.hi20), lo20: rd(h.lo20), clv: h.clv, score, comp: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, rd(v)])), er });
  }
  if (!rows.length) throw new Error("no S&P 500 quotes returned by Yahoo Finance");
  const pctOf = (a, f) => a.length ? Math.round(a.filter(f).length / a.length * 1000) / 10 : null;
  const capw = (a, k) => { let s = 0, w = 0; for (const r of a) if (r[k] != null && r.mcap) { s += r[k] * r.mcap; w += r.mcap; } return w ? rd(s / w) : null; };
  const gaps = rows.filter(r => r.gap != null).map(r => r.gap).sort((a, b) => a - b);
  const breadth = { n: rows.length, adv: rows.filter(r => r.chg > 0).length, dec: rows.filter(r => r.chg < 0).length, a20: pctOf(rows, r => r.px > r.sma20), a50: pctOf(rows, r => r.px > r.sma50), a200: pctOf(rows, r => r.px > r.sma200),
    nh20: rows.filter(r => r.px >= r.hi20 * 0.995).length, nl20: rows.filter(r => r.px <= r.lo20 * 1.005).length, gapUp: rows.filter(r => r.gap >= 1).length, gapDn: rows.filter(r => r.gap <= -1).length,
    gapMed: gaps.length ? rd(gaps[Math.floor(gaps.length / 2)]) : null, gapCap: capw(rows, "gap"), chgCap: capw(rows, "chg"), state, spy5: H.spy5, spy20: H.spy20 };
  const sec = SECTOR_SHORT.map((name, i) => { const a = rows.filter(r => r.sec === i), s = a.slice().sort((x, y) => y.score - x.score); return { name, n: a.length, chg: capw(a, "chg"), gap: capw(a, "gap"), a50: pctOf(a, r => r.px > r.sma50), score: a.length ? Math.round(avg(a.map(r => r.score))) : null, best: s[0] ? s[0].s : null, worst: s[s.length - 1] ? s[s.length - 1].s : null, mcap: Math.round(a.reduce((t, r) => t + (r.mcap || 0), 0)) }; });
  const liquid = rows.filter(r => r.dv >= 150);
  const slim = r => { const { sma20, ...rest } = r; return rest; };
  const play = liquid.filter(r => r.gap != null).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 15).map(slim);
  const longs = liquid.filter(r => r.score >= 62).sort((a, b) => b.score - a.score).slice(0, 15).map(slim);
  const shorts = liquid.filter(r => r.score <= 38).sort((a, b) => a.score - b.score).slice(0, 15).map(slim);
  const er = rows.filter(r => r.er).sort((a, b) => (a.er.d + a.er.t).localeCompare(b.er.d + b.er.t)).map(r => ({ s: r.s, d: r.er.d, t: r.er.t, est: r.er.est, mcap: r.mcap }));
  const map = rows.map(r => [r.s, r.sec, r.mcap, r.chg, r.gap == null ? "" : r.gap, r.score, r.rsi == null ? "" : r.rsi, r.atrPct == null ? "" : r.atrPct, r.rvol == null ? "" : r.rvol, r.er ? r.er.d.slice(5) + " " + r.er.t : "", r.tv].join("|"));
  const moveLabel = /PRE/.test(state) ? "Pre-market" : /REGULAR/.test(state) ? "Today" : "After hours";
  return { v: 3, asOf: new Date().toISOString(), histAsOf: H.asOf, sectors: SECTOR_SHORT, moveLabel, breadth, sec, play, longs, shorts, er, map, missing: H.missing };
}

/* ------------------------------------------------------------------ http helpers */
export function send(res, status, body, maxAge, swr) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", status === 200 ? `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${swr}` : "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
export const handle = (fn, maxAge, swr) => async (req, res) => {
  try { send(res, 200, await fn(req), maxAge, swr); }
  catch (e) { send(res, 502, { error: String((e && e.message) || e), at: new Date().toISOString() }); }
};
export function origin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
