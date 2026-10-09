// UHE Strategy rules: Joey's day-trade and long-term checklists, evaluated per stock.
// Shared by the browser (strategy.js) and the tests. Pure functions, no DOM.
// Not investment advice: each check is a filter on public data, not a prediction.
import { isNum, nyOpenUKMin, ukMinOf, tzParts, UK } from "./model.js";

export const RULE_DEFAULTS = {
  day: { rsiMin: 50, rsiMax: 72, rvolMin: 1.2, pcrMax: 1, recMax: 2.2, analystsMin: 5, instMin: 50, etfMin: 2, tpPct: 2, slPct: 1.5, stBull: 60 },
  long: { rsiMin: 50, recMax: 2.2, analystsMin: 5, upsideMin: 5, instMin: 50, etfMin: 2, divMin: 2.5, erFrom: 2, erTo: 10, tpPct: 8, slPct: 5 }
};
export function normRules(r) {
  const out = { day: { ...RULE_DEFAULTS.day }, long: { ...RULE_DEFAULTS.long } };
  for (const k of ["day", "long"]) for (const [f, v] of Object.entries((r && r[k]) || {})) if (f in out[k] && isNum(+v)) out[k][f] = +v;
  out.day.tpPct = Math.min(3, Math.max(1, out.day.tpPct));
  return out;
}

export const DAY_RULES = [
  ["rsi", "RSI"], ["vol", "Volume"], ["news", "News & retail"], ["etf", "ETF / big holders"],
  ["trend", "Uptrend"], ["opts", "Calls > puts"], ["analysts", "Analysts"]
];
export const LONG_RULES = [
  ["rsi5", "RSI ≥ 50 · 5 days"], ["kst5", "KST · 5 days"], ["earn", "Pre-earnings window"], ["etf", "ETF / big holders"],
  ["opts", "Calls > puts"], ["analysts", "Analysts"], ["div", "Dividend"]
];

const f1 = x => isNum(x) ? x.toFixed(1) : "—";
const daysTo = (ymd, now) => { if (!ymd) return null; const a = Date.parse(ymd + "T12:00:00Z"), p = tzParts(now, UK); const b = Date.UTC(p.y, p.m - 1, p.d, 12); return Math.round((a - b) / 864e5); };
const all5 = (a, f) => Array.isArray(a) && a.length === 5 && a.every(v => isNum(v) && f(v));

function holders(F, R) {
  if (!F || (F.inst == null && F.etfN == null)) return { pass: null, val: "No holder data yet" };
  const pass = (F.inst != null && F.inst >= R.instMin) || (F.etfN != null && F.etfN >= R.etfMin);
  const bits = []; if (F.inst != null) bits.push(`${f1(F.inst)}% institutions`); if (F.etfN) bits.push(`${F.etfN} index fund${F.etfN > 1 ? "s" : ""} in top holders`);
  return { pass, val: bits.join(" · ") || "—" };
}
function analysts(F, R, needUpside) {
  if (!F || F.rm == null) return { pass: null, val: "No analyst data yet" };
  const word = F.rm <= 1.5 ? "Strong buy" : F.rm <= 2.5 ? "Buy" : F.rm <= 3.5 ? "Hold" : "Sell";
  const pass = F.rm <= R.recMax && (F.na || 0) >= R.analystsMin && (!needUpside || (F.up != null && F.up >= R.upsideMin));
  return { pass, val: `${word} ${F.rm.toFixed(1)} · ${F.na || 0} analysts${F.up != null ? ` · target ${F.up >= 0 ? "+" : "−"}${Math.abs(F.up).toFixed(Math.abs(F.up) < 10 ? 1 : 0)}%` : ""}` };
}
function newsCheck(N, R) {
  if (!N) return { pass: null, val: "Not on the news shortlist" };
  const st = N.st && (N.st.bull + N.st.bear) >= 5 ? Math.round(N.st.bull / (N.st.bull + N.st.bear) * 100) : null;
  const pos = N.tone48 > 0 || (st != null && st >= R.stBull), neg = N.tone48 < 0 || (st != null && st < 100 - R.stBull);
  const bits = [`${N.n48} headline${N.n48 === 1 ? "" : "s"} in 48h${N.n48 ? ` (tone ${N.tone48 > 0 ? "+" : ""}${N.tone48})` : ""}`];
  if (st != null) bits.push(`StockTwits ${st}% bullish`);
  return { pass: pos && !neg, val: bits.join(" · ") };
}

// Day-trade plan: buy at the 14:30 open (or the first dip that reclaims), take 1–3%, but sell before the previous high.
export function dayPlan(d, R) {
  const entry = isNum(d.ext) && d.ext > 0 ? d.ext : d.px;
  if (!isNum(entry)) return null;
  let tp = entry * (1 + R.tpPct / 100), capped = false;
  if (isNum(d.pdh) && d.pdh > entry * 1.003 && d.pdh * 0.998 < tp) { tp = d.pdh * 0.998; capped = true; }
  const sl = entry * (1 - R.slPct / 100);
  return { entry, tp, sl, tpPct: (tp / entry - 1) * 100, slPct: R.slPct, capped, rr: (tp - entry) / (entry - sl), dipLevel: isNum(d.pdc) ? d.pdc : null };
}
export function longPlan(d, R) {
  const entry = isNum(d.px) ? d.px : null; if (!entry) return null;
  return { entry, tp: entry * (1 + R.tpPct / 100), sl: entry * (1 - R.slPct / 100), tpPct: R.tpPct, slPct: R.slPct, rr: R.tpPct / R.slPct };
}

export function evalDay(d, O, F, N, R) {
  const c = {};
  c.rsi = isNum(d.rsi) ? { pass: d.rsi >= R.rsiMin && d.rsi <= R.rsiMax && (!isNum(d.rsiP) || d.rsi >= d.rsiP), val: `${Math.round(d.rsi)}${isNum(d.rsiP) ? (d.rsi >= d.rsiP ? " rising" : " falling") : ""}${d.rsi > R.rsiMax ? " · overbought" : ""}` } : { pass: null, val: "—" };
  c.vol = isNum(d.rvol) ? { pass: d.rvol >= R.rvolMin, val: `${d.rvol.toFixed(2)}× its 20-day average` } : { pass: null, val: "—" };
  c.news = newsCheck(N, R);
  c.etf = holders(F, R);
  const sma50 = isNum(d.sma50) ? d.sma50 : d.sma50d;
  c.trend = isNum(d.px) && isNum(d.sma20) && isNum(sma50) ? { pass: d.px > d.sma20 && d.sma20 > sma50 && d.sma20up !== false, val: `${d.px > d.sma20 ? "Above" : "Below"} 20-day · 20-day ${d.sma20 > sma50 ? "above" : "below"} 50-day${d.sma20up === true ? " · rising" : d.sma20up === false ? " · flattening" : ""}` } : { pass: null, val: "—" };
  c.opts = O && (O.cv || O.pv) ? { pass: O.cv > O.pv && (O.pcr == null || O.pcr < R.pcrMax), val: `${(O.cv || 0).toLocaleString("en-US")} calls vs ${(O.pv || 0).toLocaleString("en-US")} puts · P/C ${O.pcr ?? "—"}` } : { pass: null, val: "No options data" };
  c.analysts = analysts(F, R, false);
  return c;
}
export function evalLong(d, O, F, N, R, now = new Date()) {
  const c = {};
  c.rsi5 = Array.isArray(d.rsi5) && d.rsi5.length === 5 ? { pass: all5(d.rsi5, v => v >= R.rsiMin), val: d.rsi5.map(v => isNum(v) ? Math.round(v) : "—").join(" · ") } : { pass: null, val: "Needs the next history refresh" };
  const kOK = Array.isArray(d.kst5) && Array.isArray(d.kstSig5) && d.kst5.length === 5 && d.kst5.every(isNum) && d.kstSig5.every(isNum);
  c.kst5 = kOK ? (() => { const above = d.kst5.filter((v, i) => v > d.kstSig5[i]).length; return { pass: above === 5, val: `Above signal ${above}/5 days · KST ${f1(d.kst5[4])}${d.kst5[4] > 0 ? " (positive)" : ""}` }; })() : { pass: null, val: "Needs the next history refresh" };
  const dd = daysTo(F && F.erd, now);
  if (dd == null) c.earn = { pass: null, val: "No earnings date yet" };
  else {
    const tone = N ? N.tone7 : null, toneTxt = tone == null ? "" : ` · news tone ${tone > 0 ? "+" : ""}${tone} this week`;
    const inWin = dd >= R.erFrom && dd <= R.erTo;
    c.earn = { pass: inWin && (tone == null || tone >= 0), val: dd < 0 ? `Reported ${-dd}d ago` : inWin ? `Earnings in ${dd}d (${F.erd.slice(5)}) · buying window${toneTxt}` : dd < R.erFrom ? `Earnings in ${dd}d · too close` : `Earnings in ${dd}d · window opens in ${dd - R.erTo}d` };
  }
  c.etf = holders(F, R);
  c.opts = O && (O.coi || O.poi || O.cv || O.pv) ? (() => { const useOI = (O.coi || 0) + (O.poi || 0) > 0, a = useOI ? O.coi : O.cv, b = useOI ? O.poi : O.pv; return { pass: a > b, val: `${useOI ? "Open interest" : "Volume"} ${(a || 0).toLocaleString("en-US")} calls vs ${(b || 0).toLocaleString("en-US")} puts` }; })() : { pass: null, val: "No options data" };
  c.analysts = analysts(F, R, true);
  c.div = F && F.dy != null ? { pass: F.dy >= R.divMin, val: `${F.dy.toFixed(2)}% yield${F.exd ? ` · ex-div ${F.exd.slice(5)}` : ""}` } : F ? { pass: false, val: "No dividend" } : { pass: null, val: "No dividend data yet" };
  return c;
}

// One ranked row per stock. `u` filters by universe letter (S, N, Q) or a watchlist Set.
export function rank(mode, D, O, F, N, rules, { u = "S", watch = null, minPass = 0, q = "", now = new Date() } = {}) {
  const R = rules[mode], keys = (mode === "day" ? DAY_RULES : LONG_RULES).map(r => r[0]);
  const rows = [];
  for (const [s, d] of Object.entries(D || {})) {
    if (watch ? !watch.has(s) : !(d.u || "S").includes(u)) continue;
    if (q && !s.startsWith(q) && !(d.name || "").toUpperCase().includes(q)) continue;
    const c = mode === "day" ? evalDay(d, O[s], F[s], N[s], R) : evalLong(d, O[s], F[s], N[s], R, now);
    const pass = keys.filter(k => c[k].pass === true).length, fail = keys.filter(k => c[k].pass === false).length;
    if (pass < minPass) continue;
    rows.push({ s, d, c, pass, fail, known: pass + fail, plan: mode === "day" ? dayPlan(d, R) : longPlan(d, R), F: F[s], N: N[s], O: O[s] });
  }
  rows.sort((a, b) => b.pass - a.pass || a.fail - b.fail || (b.d.score || 0) - (a.d.score || 0) || (b.d.mcap || 0) - (a.d.mcap || 0));
  return rows;
}

// Where we are in Joey's day-trade routine (UK time): 14:00 pre-market check, 14:30 open, then dip-buys.
export function dayPhase(now = new Date()) {
  const p = tzParts(now, UK), ymd = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, wd = new Date(ymd + "T12:00:00Z").getUTCDay();
  const open = nyOpenUKMin(ymd), m = ukMinOf(now), hm = x => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(Math.round(x % 60)).padStart(2, "0")}`;
  if (wd === 0 || wd === 6) return { k: "closed", t: "Weekend", d: `Shortlist builds again on Monday. Pre-market check at ${hm(open - 30)} UK, open at ${hm(open)}.` };
  if (m < open - 30) return { k: "build", t: "Building the shortlist", d: `Pre-market check at ${hm(open - 30)} UK · open at ${hm(open)} UK.` };
  if (m < open) return { k: "pre", t: `Pre-market check (${hm(open - 30)})`, d: `Look for ticks lining up and a gap up on volume. Orders go in at the ${hm(open)} open.` };
  if (m < open + 15) return { k: "open", t: `Open (${hm(open)})`, d: "Buy strength on the opening print, or wait for the first sell-off and buy when it reclaims yesterday's close." };
  if (m < open + 390) return { k: "session", t: "Session: dip-buys", d: "Only buy a dip that reclaims yesterday's close. Take 1–3% and sell before the previous day's high." };
  return { k: "closed", t: "US market closed", d: `Next pre-market check ${hm(open - 30)} UK.` };
}
