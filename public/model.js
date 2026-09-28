// Upper Hand Edge — shared model. Runs in the browser (app.js) and on the server (/api/brief).
// Pure functions only: no DOM, no network.

export const UK = "Europe/London", NY = "America/New_York";
export const clip = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
export const isNum = x => typeof x === "number" && isFinite(x);
export const nums = s => typeof s === "string" ? s.trim().split(/\s+/).map(Number).filter(isFinite) : (Array.isArray(s) ? s.filter(isFinite) : []);
const rnd = (x, d) => isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : x;

/* ------------------------------------------------------------ formatting */
export function fp(x, dp) { if (!isNum(x)) return "—"; const d = Math.max(0, dp == null ? 2 : dp); return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
export function fpct(x, d = 2) { if (!isNum(x)) return "—"; return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%"; }
export function fsig(x, d = 2) { if (!isNum(x)) return "—"; return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d); }

/* ------------------------------------------------------------ time */
export function tzParts(date, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour % 24, M: +p.minute, s: +p.second, wd: p.weekday, ymd: `${p.year}-${p.month}-${p.day}` };
}
export function tzOff(date, tz) { const p = tzParts(date, tz); return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.s) - date.getTime()) / 60000); }
export function wallToDate(ymd, hm, tz) { const [y, m, d] = ymd.split("-").map(Number); const [H, M] = hm.split(":").map(Number); const g = new Date(Date.UTC(y, m - 1, d, H, M)); return new Date(g.getTime() - tzOff(g, tz) * 60000); }
export const fmtT = (d, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
export const fmtDay = (ymd, o = { weekday: "short", day: "numeric", month: "short" }) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(new Date(ymd + "T12:00:00Z"));
export function addDays(ymd, n) { const t = new Date(ymd + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
// NYSE full-day holidays
export const HOLIDAYS = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"];
export function isTD(ymd) { const wd = new Date(ymd + "T12:00:00Z").getUTCDay(); return wd > 0 && wd < 6 && !HOLIDAYS.includes(ymd); }
// US cash session state and the next/current open, all DST-aware.
export function clock(now = new Date()) {
  const p = tzParts(now, NY), mins = p.H * 60 + p.M, td = isTD(p.ymd);
  let state = "closed";
  if (td && mins >= 570 && mins < 960) state = "open"; else if (td && mins >= 240 && mins < 570) state = "pre"; else if (td && mins >= 960 && mins < 1200) state = "post";
  let day = p.ymd;
  if (state !== "open" && !(td && mins < 570)) { day = addDays(day, 1); while (!isTD(day)) day = addDays(day, 1); }
  const open = wallToDate(day, "09:30", NY), close = wallToDate(p.ymd, "16:00", NY);
  return { state, day, open, close, now, todayNY: p.ymd };
}
// New York 09:30 in UK minutes after midnight for a UK date (870 most of the year, 810 when clocks change on different weeks)
export function nyOpenUKMin(ymd) { const noon = new Date(ymd + "T12:00:00Z"); return 570 - tzOff(noon, NY) + tzOff(noon, UK); }
export const ukMinOf = d => { const p = tzParts(d, UK); return p.H * 60 + p.M + p.s / 60; };

/* ------------------------------------------------------------ config */
export const DEFAULTS = { weights: { trend: 20, momentum: 10, london: 25, structure: 15, macro: 10, positioning: 10, flow: 10 }, longAt: 62, shortAt: 38 };
export const COMP = [["trend", "Trend"], ["momentum", "Momentum"], ["london", "London drive"], ["structure", "Structure"], ["macro", "Macro"], ["positioning", "Positioning"], ["flow", "Off-exchange"]];
export const MACRO_MAP = { EURUSD: "usdQ", GBPUSD: "usdQ", AUDUSD: "usdQ", NZDUSD: "usdQ", XAUUSD: "usdQ", XAGUSD: "usdQ", USDJPY: "usdB", USDCAD: "usdB", USDCHF: "usdB", US30: "risk", US500: "risk", NAS100: "risk", US2000: "risk", UK100: "risk", GER40: "risk", EU50: "risk", BTCUSD: "risk", ETHUSD: "risk", AUDJPY: "risk" };
export const COT_MAP = { EURUSD: ["EUR"], GBPUSD: ["GBP"], USDJPY: ["JPY", 1], AUDUSD: ["AUD"], USDCAD: ["CAD", 1], USDCHF: ["CHF", 1], NZDUSD: ["NZD"], US500: ["ES"], NAS100: ["NQ"], US30: ["YM"], US2000: ["RTY"], XAUUSD: ["GOLD"], XAGUSD: ["SILVER"], WTI: ["WTI"], BTCUSD: ["BTC"], ETHUSD: ["ETH"] };
export const FIN_MAP = { US500: "SPY", NAS100: "QQQ", US30: "DIA", US2000: "IWM", XAUUSD: "GLD" };
export const COT_NAMES = { EUR: "Euro", GBP: "Pound", JPY: "Yen", AUD: "Aussie", CAD: "Loonie", CHF: "Franc", NZD: "Kiwi", USD: "Dollar index", ES: "S&P 500", NQ: "Nasdaq 100", YM: "Dow", RTY: "Russell 2000", GOLD: "Gold", SILVER: "Silver", WTI: "WTI crude", BTC: "Bitcoin", ETH: "Ether" };
export const FIN_NAMES = { SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow", IWM: "Russell 2000", GLD: "Gold", TLT: "20y Treasuries", HYG: "High yield", XLF: "Financials", XLK: "Tech", SMH: "Semis" };
export const CLS_NAMES = { index: "Indices", fx: "Forex", cmd: "Metals & energy", crypto: "Crypto" };
// Real-time ETF that tracks each futures-based market (US equities are real-time on free feeds, CME futures are delayed).
export const PROXY = { US500: "SPY", NAS100: "QQQ", US30: "DIA", US2000: "IWM", XAUUSD: "GLD", XAGUSD: "SLV", WTI: "USO" };
export const FUT_NAME = { US30: "YM", US500: "ES", NAS100: "NQ", US2000: "RTY", XAUUSD: "GC", XAGUSD: "SI", WTI: "CL" };
// TradingView symbols: CFDs stream in real time in the free widgets; futures match the dashboard's levels.
export const TV = { US30: "OANDA:US30USD", US500: "OANDA:SPX500USD", NAS100: "OANDA:NAS100USD", US2000: "OANDA:US2000USD", UK100: "OANDA:UK100GBP", GER40: "OANDA:DE30EUR", EU50: "OANDA:EU50EUR",
  EURUSD: "FX:EURUSD", GBPUSD: "FX:GBPUSD", USDJPY: "FX:USDJPY", AUDUSD: "FX:AUDUSD", USDCAD: "FX:USDCAD", USDCHF: "FX:USDCHF", NZDUSD: "FX:NZDUSD", EURGBP: "FX:EURGBP", GBPJPY: "FX:GBPJPY", EURJPY: "FX:EURJPY", AUDJPY: "FX:AUDJPY", GBPAUD: "FX:GBPAUD",
  XAUUSD: "OANDA:XAUUSD", XAGUSD: "OANDA:XAGUSD", WTI: "OANDA:WTICOUSD", BTCUSD: "BITSTAMP:BTCUSD", ETHUSD: "BITSTAMP:ETHUSD" };
export const TV_FUT = { US30: "CBOT_MINI:YM1!", US500: "CME_MINI:ES1!", NAS100: "CME_MINI:NQ1!", US2000: "CME_MINI:RTY1!", XAUUSD: "COMEX:GC1!", XAGUSD: "COMEX:SI1!", WTI: "NYMEX:CL1!" };

export function normCfg(s) {
  s = s || {};
  const w = { ...DEFAULTS.weights }; for (const k in w) if (s.weights && isNum(+s.weights[k])) w[k] = clip(+s.weights[k], 0, 50);
  const longAt = isNum(s.longAt) ? clip(s.longAt, 51, 80) : DEFAULTS.longAt, shortAt = isNum(s.shortAt) ? clip(s.shortAt, 20, 49) : DEFAULTS.shortAt;
  return { weights: w, longAt, shortAt };
}

/* ------------------------------------------------------------ live merge */
// Overlay live quotes on the slower session data. Futures-based markets are "nowcast" from their real-time ETF
// (price x futures/ETF ratio measured on aligned 1-minute bars) while that ETF is trading; otherwise the futures quote is used.
export function applyLive(mk, q, bs, now = Date.now()) {
  const instruments = ((mk && mk.instruments) || []).map(x => x.err ? x : { ...x, td: x.td ? { ...x.td } : null });
  const context = ((mk && mk.context) || []).map(c => ({ ...c }));
  const live = {};
  const nowS = now / 1000;
  const ukNow = tzParts(new Date(now), UK), ukM = ukNow.H * 60 + ukNow.M;
  const mkDay = mk && mk.asOf ? tzParts(new Date(mk.asOf), UK).ymd : null;
  for (const x of instruments) {
    if (x.err || !q) continue;
    const qq = q.inst && q.inst[x.id], etfSym = PROXY[x.id], e = etfSym && q.etf ? q.etf[etfSym] : null, b = bs && bs.pairs ? bs.pairs[x.id] : null;
    let px = null, src = null, t = null, delay = 0;
    if (e && b && isNum(e.px) && isNum(b.ratio) && e.t && nowS - e.t < 180 && nowS - b.t < 3600) { px = e.px * b.ratio; src = "etf"; t = e.t; }
    else if (qq && isNum(qq.px)) { px = qq.px; src = "quote"; t = qq.t; delay = qq.delay || 0; }
    if (!isNum(px)) continue;
    const barT = x.at ? Date.parse(x.at + ":00Z") / 1000 : 0;
    if (src === "quote" && t && barT && t < barT) continue; // session bars are newer than the quote
    const dp = x.dp || 0;
    px = rnd(px, dp + 1);
    const fresh = t ? nowS - t < (delay * 60 + 20 * 60) : false;
    live[x.id] = { src, t, delay, fresh, etf: src === "etf" ? etfSym : null };
    x.px = px;
    x.chg = x.pd && isNum(x.pd.c) && x.pd.c ? rnd((px / x.pd.c - 1) * 100, 2) : (qq && isNum(qq.chgd) ? qq.chgd : x.chg);
    const sp = nums(x.spark); if (sp.length) { sp[sp.length - 1] = px; x.spark = sp.join(" "); }
    const td = x.td;
    if (td && mkDay === ukNow.ymd && fresh) {
      if (isNum(td.h)) td.h = Math.max(td.h, px); if (isNum(td.l)) td.l = Math.min(td.l, px);
      if (ukM < 420 && isNum(td.aH)) { td.aH = Math.max(td.aH, px); td.aL = Math.min(td.aL, px); }
      if (ukM >= 480 && ukM < (x.nyo || 870) && isNum(td.lH)) { td.lH = Math.max(td.lH, px); td.lL = Math.min(td.lL, px); td.lC = px; }
      if (ukM >= (x.nyo || 870) && ukM < (x.nyo || 870) + 390) { td.nH = isNum(td.nH) ? Math.max(td.nH, px) : px; td.nL = isNum(td.nL) ? Math.min(td.nL, px) : px; if (!isNum(td.nO)) td.nO = px; }
    }
  }
  if (q && q.ctx) for (const c of context) {
    const v = q.ctx[c.id]; if (!v || !isNum(v.px)) continue;
    c.px = v.px; if (isNum(v.chgd)) c.chg = v.chgd;
    const sp = nums(c.spark); if (sp.length) { sp[sp.length - 1] = v.px; c.spark = sp.join(" "); }
  }
  return { instruments, context, live };
}

/* ------------------------------------------------------------ scoring */
export function buildModel(data, cfg) {
  const list = ((data && data.instruments) || []).filter(x => x && !x.err && isNum(x.px));
  if (!list.length) return null;
  const ctx = Object.fromEntries(((data && data.context) || []).filter(c => !c.err).map(c => [c.id, c]));
  const cot = Object.fromEntries(((data.cot && data.cot.rows) || []).filter(r => !r.err).map(r => [r.k, r]));
  const fin = Object.fromEntries(((data.finra && data.finra.rows) || []).filter(r => !r.err).map(r => [r.s, r]));
  const E = normCfg(cfg);
  const dxy = ctx.DXY && ctx.DXY.chg, vix = ctx.VIX && ctx.VIX.chg;
  const rows = list.map((x0, i) => {
    const x = { ...x0, order: i, sp: nums(x0.spark) };
    const t = x.td || {};
    const c = {};
    if (isNum(x.sma20) && isNum(x.sma50) && x.atr) c.trend = 0.6 * clip(((x.px - x.sma20) / x.atr) / 2) + 0.4 * (x.sma20 >= x.sma50 ? 1 : -1);
    if (isNum(x.rsi)) c.momentum = clip((x.rsi - 50) / 20);
    x.lm = isNum(t.lO) ? x.px - t.lO : null;
    if (x.lm != null && x.adr && x.st && isNum(x.st.cont)) {
      const strong = Math.abs(x.lm) >= 0.35 * x.adr && x.st.sN >= 8 && isNum(x.st.sCont);
      x.lonRate = strong ? x.st.sCont : x.st.cont; x.lonStrong = strong;
      c.london = clip(x.lm / (0.35 * x.adr)) * clip((x.lonRate - 50) / 12);
    }
    if (x.pd && isNum(x.pd.h) && isNum(x.pd.l) && x.pd.h > x.pd.l) c.structure = x.px > x.pd.h ? 1 : x.px < x.pd.l ? -1 : (2 * (x.px - x.pd.l) / (x.pd.h - x.pd.l) - 1) * 0.6;
    const mm = MACRO_MAP[x.id];
    if (mm === "usdQ" && isNum(dxy)) c.macro = -clip(dxy / 0.3); else if (mm === "usdB" && isNum(dxy)) c.macro = clip(dxy / 0.3); else if (mm === "risk" && isNum(vix)) c.macro = -clip(vix / 6);
    const cm = COT_MAP[x.id];
    if (cm && cot[cm[0]] && isNum(cot[cm[0]].pct)) { const p = cm[1] ? 100 - cot[cm[0]].pct : cot[cm[0]].pct; x.cotPct = p; c.positioning = p >= 80 ? -(p - 80) / 20 : p <= 20 ? (20 - p) / 20 : 0; }
    const fm = FIN_MAP[x.id];
    if (fm && fin[fm] && isNum(fin[fm].z)) { x.fin = fin[fm]; c.flow = clip(fin[fm].z / 2); }
    let num = 0, den = 0; for (const k in c) { const w = +E.weights[k] || 0; num += w * c[k]; den += w; }
    x.comp = c;
    x.score = den ? Math.round(50 + 50 * num / den) : 50;
    x.bias = x.score >= E.longAt ? "long" : x.score <= E.shortAt ? "short" : "neutral";
    x.conv = Math.abs(x.score - 50);
    x.used = isNum(t.h) && isNum(t.l) && x.adr ? (t.h - t.l) / x.adr : null;
    x.left = x.used == null ? null : 1 - x.used;
    x.plan = playbook(x);
    return x;
  });
  return { rows, map: Object.fromEntries(rows.map(r => [r.id, r])), ctx, cot, fin, E, dxy, vix };
}
export function playbook(x) {
  const t = x.td || {}, pd = x.pd || {}, pv = x.piv || {};
  let H = t.lH, L = t.lL, src = "London";
  if (!isNum(H) || !isNum(L) || H <= L) { H = t.aH; L = t.aL; src = "Asia"; }
  if (!isNum(H) || !isNum(L) || H <= L) { H = pd.h; L = pd.l; src = "prior day"; }
  if (!isNum(H) || !isNum(L)) return null;
  const mid = (H + L) / 2;
  const adrHi = isNum(t.l) && x.adr ? t.l + x.adr : null, adrLo = isNum(t.h) && x.adr ? t.h - x.adr : null;
  const cand = [["Prior-day high", pd.h], ["Prior-day low", pd.l], ["Prior NY high", pd.nH], ["Prior NY low", pd.nL], ["Week open", x.wo], ["Pivot R1", pv.r1], ["Pivot R2", pv.r2], ["Pivot S1", pv.s1], ["Pivot S2", pv.s2], ["ADR high", adrHi], ["ADR low", adrLo], ["20-day high", x.hi20], ["20-day low", x.lo20]].filter(([, p]) => isNum(p));
  const gap = (x.adr || 0) * 0.05, sep = (x.adr || 0) * 0.1;
  const pick = arr => { const out = []; for (const c of arr) { if (!out.length || Math.abs(c[1] - out[out.length - 1][1]) >= sep) out.push(c); if (out.length === 2) break; } return out; };
  const up = pick(cand.filter(([, p]) => p > H + gap).sort((a, b) => a[1] - b[1]));
  const dn = pick(cand.filter(([, p]) => p < L - gap).sort((a, b) => b[1] - a[1]));
  return { src, H, L, mid, up, dn, adrHi, adrLo };
}
export function regime(M) {
  const es = M && M.map.US500 && M.map.US500.chg, nq = M && M.map.NAS100 && M.map.NAS100.chg;
  let word = "—", tone = "neutral", avg = null;
  if (isNum(es) && isNum(nq)) {
    avg = (es + nq) / 2;
    [word, tone] = avg <= -0.75 ? ["Risk-off", "short"] : avg <= -0.25 ? ["Heavy", "short"] : avg < 0.25 ? ["Balanced", "neutral"] : avg < 0.75 ? ["Firm", "long"] : ["Risk-on", "long"];
  }
  const vix = M && M.ctx.VIX, v3 = M && M.ctx.VIX3M, ratio = vix && v3 && v3.px ? vix.px / v3.px : null;
  const term = ratio == null ? null : ratio < 0.9 ? "Calm" : ratio < 1 ? "Tightening" : "Stress";
  return { word, tone, avg, es, nq, ratio, term };
}

/* ------------------------------------------------------------ calendar */
export function calItems(cal) { return ((cal && cal.items) || []).map(i => ({ ...i, at: /^\d{2}:\d{2}$/.test(i.t) ? wallToDate(i.d, i.t, UK) : null })); }

/* ------------------------------------------------------------ S&P scan helpers */
const nv = v => v === "" || v == null ? null : (isFinite(+v) ? +v : null);
export function parseScan(d) {
  if (!d) return null;
  const names = d.sectors || [];
  const det = {}; for (const r of [].concat(d.play || [], d.longs || [], d.shorts || [])) det[r.s] = r;
  const rows = (d.map || []).map(line => { const [s, sec, mcap, chg, gap, score, rsi, atrPct, rvol, er, tv] = String(line).split("|"); return { s, sec: +sec, mcap: +mcap || 0, chg: nv(chg), gap: nv(gap), score: +score, rsi: nv(rsi), atrPct: nv(atrPct), rvol: nv(rvol), er: er || null, tv: tv || "" }; }).filter(r => r.s);
  return { ...d, names, rows, det, by: Object.fromEntries(rows.map(r => [r.s, r])) };
}
export const spBias = sc => sc >= 62 ? "long" : sc <= 38 ? "short" : "neutral";
export function erLabel(er) {
  if (!er) return "";
  if (typeof er !== "string") return fmtDay(er.d, { weekday: "short" }) + " " + er.t;
  if (/^\d{4}-/.test(er)) return fmtDay(er.slice(0, 10), { weekday: "short" }) + " " + er.slice(11);
  const [md, t] = er.split(" "); const y = tzParts(new Date(), NY).y; return fmtDay(`${y}-${md}`, { weekday: "short" }) + " " + (t || "");
}

/* ------------------------------------------------------------ briefs */
const lcFirst = s => s.replace(/^(\w)(\w*)/, (m, a, b) => b && b === b.toUpperCase() ? m : a.toLowerCase() + b);
function topFactors(r, n = 2) {
  const sign = r.bias === "short" ? -1 : 1, W = { trend: 20, momentum: 10, london: 25, structure: 15, macro: 10, positioning: 10, flow: 10 };
  return COMP.map(([k, name]) => [name === "London drive" ? name : name.toLowerCase(), (r.comp[k] || 0) * W[k] * sign]).filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
// Deterministic brief built from the model. Always available; the Claude brief (when configured) replaces it.
export function autoBrief(M, cal, SP, now = new Date()) {
  if (!M) return null;
  const c = clock(now), rg = regime(M), out = [];
  const vix = M.ctx.VIX, dxy = M.ctx.DXY, y10 = M.ctx.US10Y;
  const b = SP && SP.breadth;
  out.push("## Tone");
  let tone = rg.avg != null ? `**${rg.word}.** US index futures are ${fpct(rg.avg)} on average vs the prior close (S&P ${fpct(rg.es)}, Nasdaq ${fpct(rg.nq)}).` : "Waiting for US index futures.";
  const bits = [];
  if (vix && isNum(vix.px)) bits.push(`VIX ${fp(vix.px, 2)} (${fpct(vix.chg)})${rg.term ? `, vol curve ${rg.term.toLowerCase()}` : ""}`);
  if (dxy && isNum(dxy.px)) bits.push(`dollar index ${fpct(dxy.chg)}`);
  if (y10 && isNum(y10.px)) bits.push(`US 10-year ${fp(y10.px, 3)}%`);
  if (bits.length) tone += " " + bits.join(", ").replace(/^./, s => s.toUpperCase()) + ".";
  if (b && isNum(b.a50)) tone += ` ${Math.round(b.a50)}% of S&P 500 members sit above their 50-day; ${b.gapUp} are up 1%+ and ${b.gapDn} down 1%+ (${(SP.moveLabel || "pre-market").toLowerCase()}).`;
  out.push(tone);
  out.push("## Best setups");
  const top = M.rows.filter(r => r.bias !== "neutral" && r.plan).sort((a, b2) => b2.conv - a.conv).slice(0, 4);
  if (!top.length) out.push("- No market clears the bias thresholds. Let the open pick a side: trade the break of the London range with the tape, not ahead of it.");
  for (const r of top) {
    const p = r.plan, long = r.bias === "long", tg = long ? p.up[0] : p.dn[0], why = topFactors(r);
    const stat = r.lonRate != null ? ` NY's first hour ${r.lonRate >= 50 ? "followed" : "faded"} London ${Math.round(r.lonRate >= 50 ? r.lonRate : 100 - r.lonRate)}% of the time (${r.lonStrong ? r.st.sN : r.st.n} days).` : "";
    out.push(`- **${r.id} ${long ? "long" : "short"}** (edge ${r.score}): trigger ${long ? "above" : "below"} the ${p.src} ${long ? "high" : "low"} **${fp(long ? p.H : p.L, r.dp)}**${tg ? `, first target ${lcFirst(tg[0])} **${fp(tg[1], r.dp)}**` : ""}.${why.length ? ` Driven by ${why.join(" and ")}.` : ""}${stat}`);
  }
  if (SP && SP.play && SP.play.length) out.push(`- Stocks in play: ${SP.play.slice(0, 5).map(r => `${r.s} ${fpct(r.gap, 1)}`).join(", ")}.`);
  out.push("## Levels that matter");
  const lv = ["US500", "NAS100", "US30"].map(id => M.map[id]).filter(Boolean);
  for (const r of lv) { const t = r.td || {}, pd = r.pd || {}; out.push(`- **${r.id}** ${fp(r.px, r.dp)}: London ${fp(t.lL, r.dp)}–${fp(t.lH, r.dp)}, prior day ${fp(pd.l, r.dp)}–${fp(pd.h, r.dp)}${r.used != null ? `, ${Math.round(r.used * 100)}% of ADR used` : ""}.`); }
  out.push("## Event risk");
  const today = tzParts(now, UK).ymd;
  const ev = calItems(cal).filter(i => i.d === today && i.imp !== "hol" && i.at && i.at.getTime() > now.getTime() - 3600e3);
  const hi = ev.filter(i => i.imp === "high");
  if (!ev.length) out.push("- Nothing high or medium impact left on today's calendar.");
  else for (const i of (hi.length ? hi : ev).slice(0, 5)) out.push(`- ${i.t} UK · ${i.c} ${i.ev}${i.imp === "high" ? " (high impact)" : ""}${i.f ? ` · f/c ${i.f}` : ""}${i.p ? ` · prev ${i.p}` : ""}`);
  out.push("## What would change the plan");
  if (top[0]) { const r = top[0], p = r.plan; out.push(`- ${r.id}: a move back through the ${p.src} midpoint ${fp(p.mid, r.dp)} after the break cancels the ${r.bias} case.`); }
  if (rg.term === "Stress" || (vix && vix.chg > 8)) out.push("- Volatility is stretched; expect wider ranges and failed breaks. Size down.");
  else out.push("- A VIX spike above yesterday's level or a dollar reversal would undercut risk-on setups.");
  out.push(`\n_Setups, not advice. Built from the live model at ${fmtT(now, UK)} UK._`);
  return { text: out.join("\n"), day: c.day, at: now.toISOString(), by: "UHE auto brief" };
}
// Prompt for the optional Claude brief (server side, /api/brief).
export function briefPrompt(M, cal, SP, now = new Date()) {
  if (!M) return null;
  const c = clock(now), r2 = (x, dp) => isNum(x) ? fp(x, dp) : "n/a";
  const lines = [...M.rows].sort((a, b) => b.conv - a.conv).map(r => { const t = r.td || {}, p = r.plan; return `${r.id} (${r.name}): edge ${r.score} (${r.bias}); price ${r2(r.px, r.dp)} (${fpct(r.chg)} vs prior day); London range ${r2(t.lL, r.dp)}-${r2(t.lH, r.dp)}; prior day H/L ${r2(r.pd && r.pd.h, r.dp)}/${r2(r.pd && r.pd.l, r.dp)}; ADR ${r2(r.adr, r.dp)}, used ${r.used == null ? "n/a" : Math.round(r.used * 100) + "%"}; RSI ${r2(r.rsi, 0)}; NY first hour followed London ${r.st && isNum(r.st.cont) ? Math.round(r.st.cont) : "n/a"}% (n=${r.st ? r.st.n : 0}); ${p ? `bull trigger > ${r2(p.H, r.dp)} target ${p.up[0] ? p.up[0][0] + " " + r2(p.up[0][1], r.dp) : "n/a"}; bear trigger < ${r2(p.L, r.dp)} target ${p.dn[0] ? p.dn[0][0] + " " + r2(p.dn[0][1], r.dp) : "n/a"}` : ""}${isNum(r.cotPct) ? `; COT specs ${Math.round(r.cotPct)}th pct` : ""}${r.fin ? `; ${r.fin.s} off-exchange short share z ${fsig(r.fin.z, 1)}` : ""}`; });
  const ctx = Object.values(M.ctx).map(x => `${x.id} ${x.px} (${fpct(x.chg)})`).join("; ");
  const today = tzParts(now, UK).ymd;
  const ev = calItems(cal).filter(i => i.d === today && i.imp !== "hol").map(i => `${i.t} UK ${i.c} ${i.ev}${i.imp === "high" ? " [HIGH]" : ""}${i.f ? ` f/c ${i.f}` : ""}${i.p ? ` prev ${i.p}` : ""}`).join("; ");
  const B = SP && SP.breadth;
  const spTxt = B ? `\nS&P 500 breadth: ${B.adv} up / ${B.dec} down; ${Math.round(B.a50)}% above 50-day, ${Math.round(B.a200)}% above 200-day; ${(SP.moveLabel || "pre-market").toLowerCase()} cap-weighted ${fpct(B.gapCap)}; ${B.gapUp} moving up 1%+, ${B.gapDn} down.\nStocks in play: ${(SP.play || []).slice(0, 6).map(r => `${r.s} ${fpct(r.gap)} (prior high ${fp(r.pdh, 2)}, low ${fp(r.pdl, 2)}${r.er ? ", earnings " + erLabel(r.er) : ""})`).join("; ")}\nTop long stocks: ${(SP.longs || []).slice(0, 5).map(r => `${r.s} edge ${r.score}, trigger above ${fp(r.pdh, 2)}`).join("; ")}\nTop short stocks: ${(SP.shorts || []).slice(0, 5).map(r => `${r.s} edge ${r.score}, trigger below ${fp(r.pdl, 2)}`).join("; ")}` : "";
  const phase = c.state === "open" ? `The New York session is live (opened ${fmtT(wallToDate(c.todayNY, "09:30", NY), UK)} UK).` : `The next New York open is ${fmtDay(c.day)} at ${fmtT(c.open, UK)} UK.`;
  return `You are the pre-open analyst for a UK-based trader who trades the New York open on index CFDs, forex majors, gold, oil and crypto. ${phase} It is ${fmtT(now, UK)} UK. Write the brief using ONLY the data below.\n\nRules: under 240 words. Use exactly these '## ' headings: Tone, Best setups, Levels that matter, Event risk, What would change the plan. Under Best setups give at most 4 markets or stocks as '- ' bullets: market, side, trigger and first target (only numbers given below), and one line on why. Never invent prices, news or data. Describe setups and levels; do not tell the reader to buy or sell.\n\nContext: ${ctx}\nToday's calendar: ${ev || "nothing high or medium impact"}\nMarkets ranked by conviction (edge 50 = neutral, long at ${M.E.longAt}+, short at ${M.E.shortAt} or below):\n${lines.join("\n")}${spTxt}`;
}
