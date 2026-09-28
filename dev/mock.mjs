// Offline mock API for local development and UI tests. Built from real snapshots saved on 28 Sep 2026
// (dev/fixtures), with prices random-walking on every quote request. The S&P 500 heat-map values are synthetic.
import { readFileSync } from "node:fs";

const F = n => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8"));
const inst = F("instruments.json"), ctx = F("context.json"), cot = F("cot.json"), fin = F("finra.json"), cal = F("calendar.json"), scan = F("scan_partial.json");
const csv = readFileSync(new URL("./fixtures/constituents.csv", import.meta.url), "utf8").trim().split(/\r?\n/).slice(1);
const SECTORS = ["Information Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples", "Health Care", "Financials", "Industrials", "Energy", "Materials", "Utilities", "Real Estate"];
const RATIO = { US500: ["SPY", 11.61], NAS100: ["QQQ", 41.3], US30: ["DIA", 100.2], US2000: ["IWM", 11.3], XAUUSD: ["GLD", 10.92], XAGUSD: ["SLV", 1.09], WTI: ["USO", 0.84] };
const DELAY = { US30: 10, US500: 10, NAS100: 10, US2000: 10, XAUUSD: 10, XAGUSD: 10, WTI: 10, UK100: 15, GER40: 15, EU50: 15 };
const BIG = { NVDA: 4500, MSFT: 3800, AAPL: 3600, GOOGL: 1250, GOOG: 1150, AMZN: 2300, META: 1900, AVGO: 1600, TSLA: 1300, "BRK.B": 1050, JPM: 800, WMT: 800, LLY: 700, ORCL: 700, V: 650, MA: 520, NFLX: 500, XOM: 470, COST: 420, JNJ: 400, HD: 380, PG: 360, ABBV: 350, BAC: 340, PLTR: 400, AMD: 300, CRM: 260, KO: 290, UNH: 280, CVX: 270 };

let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const r2 = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const px = {}; for (const x of inst.instruments) px[x.id] = x.px; for (const c of ctx.context) px[c.id] = c.px;
function step() {
  for (const x of inst.instruments) px[x.id] *= 1 + gauss() * ((x.adr || x.px * 0.01) / x.px) / 30;
  for (const c of ctx.context) px[c.id] *= 1 + gauss() * 0.0004;
}
function quotes() {
  step();
  const now = Math.floor(Date.now() / 1000), q = { asOf: new Date().toISOString(), mode: "quote", inst: {}, ctx: {}, etf: {} };
  for (const x of inst.instruments) {
    const d = DELAY[x.id] || 0, p = r2(px[x.id], x.dp + 1), prev = x.pd ? x.pd.c : x.px;
    q.inst[x.id] = { px: p, prev, chgd: r2((p / prev - 1) * 100), hi: null, lo: null, t: now - d * 60, state: "REGULAR", delay: d };
    if (RATIO[x.id]) { const [s, k] = RATIO[x.id]; q.etf[s] = { px: r2(p / k, 3), t: now - 2, state: "PRE", delay: 0 }; }
  }
  for (const c of ctx.context) { const p = r2(px[c.id], 3), prev = c.px / (1 + (c.chg || 0) / 100); q.ctx[c.id] = { px: p, prev: r2(prev, 3), chgd: r2((p / prev - 1) * 100), t: now, state: "REGULAR", delay: 0 }; }
  return q;
}
function basis() {
  const t = Math.floor(Date.now() / 1000) - 660, pairs = {};
  for (const [id, [etf, k]] of Object.entries(RATIO)) pairs[id] = { etf, ratio: k, t, fut: px[id], etfPx: px[id] / k };
  return { asOf: new Date().toISOString(), pairs, errors: [] };
}
function markets() { return { v: 3, asOf: new Date().toISOString(), source: "mock (saved Yahoo snapshot)", instruments: inst.instruments, context: ctx.context, errors: [] }; }
let MAP = null;
function scanLive() {
  if (!MAP) {
    const det = {}; for (const r of [].concat(scan.play, scan.longs, scan.shorts)) det[r.s] = r;
    MAP = csv.map(line => {
      const p = []; let cur = "", qd = false; for (const ch of line) { if (ch === '"') qd = !qd; else if (ch === "," && !qd) { p.push(cur); cur = ""; } else cur += ch; } p.push(cur);
      const s = p[0], sec = Math.max(0, SECTORS.indexOf(p[2])), d = det[s];
      const mcap = d ? d.mcap : BIG[s] || r2(Math.exp(2.2 + rnd() * 3.3), 1);
      const chg = d ? d.chg : r2(gauss() * 1.3), gap = d ? d.gap : r2(gauss() * 0.7 - 0.2), score = d ? d.score : Math.round(Math.max(8, Math.min(92, 50 + gauss() * 13)));
      return [s, sec, mcap, chg, gap, score, d ? d.rsi : Math.round(50 + gauss() * 12), d ? d.atrPct : r2(1.2 + rnd() * 2.5), d ? d.rvol : r2(0.5 + rnd()), "", rnd() < 0.45 ? "NASDAQ" : "NYSE"];
    });
  }
  return { ...scan, v: 3, asOf: new Date().toISOString(), moveLabel: "Pre-market", map: MAP.map(a => a.join("|")) };
}
export async function handle(name) {
  switch (name) {
    case "quotes": return quotes();
    case "basis": return basis();
    case "markets": return markets();
    case "scan": return scanLive();
    case "flow": return { asOf: new Date().toISOString(), finra: fin, cot };
    case "calendar": return cal;
    case "brief": return { ai: false, reason: "mock" };
    case "health": return { ok: true, mode: "mock" };
    default: return null;
  }
}
