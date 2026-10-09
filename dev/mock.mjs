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
  const NDXS = new Set("AAPL MSFT NVDA AMZN GOOGL GOOG META AVGO TSLA COST NFLX PLTR AMD CSCO TMUS LIN INTU PEP ISRG TXN QCOM BKNG AMGN ADBE AMAT HON GILD CMCSA MU LRCX PANW ADP KLAC APP INTC SNPS CRWD CEG ADI CDNS VRTX ABNB DASH SBUX ORLY CTAS MDLZ MAR FTNT REGN PYPL WDAY CSX ADSK AEP NXPI ROP AXON PCAR MNST IDXX CHTR FAST KDP ROST PAYX DDOG EXC CPRT TTWO VRSK XEL BKR FANG EA CTSH KHC ODFL GEHC MCHP CSGP LULU DXCM CDW ON WBD BIIB".split(" "));
  const extra = ["ASML|0|300|1.2|0.8|66|61|2.1|1.2||NASDAQ|N", "ARM|0|160|-2.1|-1.4|35|44|4.2|1.6||NASDAQ|N", "SHOP|0|190|0.9|1.1|60|58|3.1|1.1||NASDAQ|N", "MELI|2|110|0.4|0.3|55|52|2.5|0.9||NASDAQ|N", "PDD|2|170|-0.8|-0.5|42|47|3.0|1.0||NASDAQ|N", "MSTR|5|90|3.4|2.2|71|69|6.1|2.3||NASDAQ|N"];
  const extraQ = extra.map(l => l + "Q");
  if (!scanLive.small) { let sd = 99; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; }; scanLive.small = Array.from({ length: 1400 }, (_, i) => { const sym = "X" + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + Math.floor(i / 676)); return [sym, 11, r2(0.05 + r() * r() * 8, 2), r2((r() - 0.5) * 8), r2((r() - 0.5) * 5), Math.round(15 + r() * 70), Math.round(30 + r() * 40), r2(2 + r() * 6), r2(0.4 + r() * 2), "", "NASDAQ", "Q"].join("|"); }); }
  const map = MAP.map(a => a.join("|") + "|" + (NDXS.has(a[0]) ? "SNQ" : a[10] === "NASDAQ" ? "SQ" : "S")).concat(extraQ, scanLive.small);
  const nd = { breadth: { ...scan.breadth, n: 100 }, sec: scan.sec, play: scan.play.slice(0, 8), longs: scan.longs.slice(0, 8), shorts: scan.shorts.slice(0, 8), er: scan.er };
  const nq = { breadth: { ...scan.breadth, n: map.filter(l => l.split("|")[11].includes("Q")).length }, sec: scan.sec.concat([{ name: "Other Nasdaq", n: 1400, chg: 0.4, gap: 0.2, a50: 48, score: 51, best: "XAAA", worst: "XBAA", mcap: 2100 }]), play: scan.play.slice(0, 10), longs: scan.longs.slice(0, 10), shorts: scan.shorts.slice(0, 10), er: scan.er };
  return { ...scan, v: 3, asOf: new Date().toISOString(), moveLabel: "Pre-market", sectors: (scan.sectors || []).length >= 12 ? scan.sectors : (scan.sectors || []).concat(["Other Nasdaq"]), map, ndx: nd, nasdaq: nq };
}
// Fake IC Markets bridge: PIN is "demo-pin-123". Orders "fill" at the scan price.
const POS = [];
async function mockTrade(req) {
  if (!req || req.method !== "POST") return { broker: "IC Markets", platform: "cTrader Open API", env: "demo", configured: { app: true, token: true, account: true, pin: true }, ready: true, maxUsd: 2000, asOf: new Date().toISOString() };
  let s = ""; for await (const ch of req) s += ch; const b = JSON.parse(s || "{}");
  if (b.pin !== "demo-pin-123") return { ok: false, code: "BAD_PIN", error: "Wrong PIN" };
  const acct = () => ({ ok: true, env: "demo", account: { balance: 25000, ccy: "USD", leverage: 30, login: 9001 }, positions: POS.map(p => ({ ...p, now: p.price * 1.004, pnl: +(p.price * 0.004 * p.units).toFixed(2) })) });
  if (b.action === "account" || b.action === "positions") return acct();
  if (b.action === "find") return { ok: true, matches: [{ id: 1, name: b.symbol + ".US", desc: "Mock", score: 90 }] };
  if (b.action === "close") { const i = POS.findIndex(p => String(p.id) === String(b.positionId)); if (i >= 0) POS.splice(i, 1); return { ok: true, env: "demo", closed: b.positionId, price: 100 }; }
  if (b.action === "order") { const px = b.refPx || 100, units = Math.floor(b.usd / px); if (units < 1) return { ok: false, code: "TOO_SMALL", error: "Order too small" };
    const p = { id: 500 + POS.length, symbol: b.symbol + ".US", side: "BUY", units, price: px, sl: +(px * (1 - b.slPct / 100)).toFixed(2), tp: b.tpPrice || +(px * (1 + b.tpPct / 100)).toFixed(2), label: "UHE " + b.mode }; POS.push(p);
    return { ok: true, env: "demo", status: "ORDER_FILLED", symbol: p.symbol, units, ask: px, fill: px, sl: p.sl, tp: p.tp, positionId: p.id }; }
  return { ok: false, error: "Unknown action" };
}
export async function handle(name, req) {
  switch (name) {
    case "quotes": return quotes();
    case "basis": return basis();
    case "markets": return markets();
    case "scan": return scanLive();
    case "flow": return { asOf: new Date().toISOString(), finra: fin, cot };
    case "calendar": return cal;
    case "brief": return { ai: false, reason: "mock" };
    case "deep": { const sc = scanLive(); const st = {}; for (const line of sc.map) { const [sym, sec, mcap, chg, gap, score, rsi, atrPct, rvol] = line.split("|"); const d = [].concat(scan.play, scan.longs, scan.shorts).find(r => r.s === sym) || {}; const px = d.px || 50 + rnd() * 400, k = 20 + rnd() * 70;
      const u = line.split("|")[11] || "S", tvx = line.split("|")[10] || "NASDAQ", R0 = +rsi || 50, kb = rnd() < 0.55;
      st[sym] = { u, tv: tvx, ext: gap === "" ? null : px * (1 + +gap / 100), rsi5: [0, 1, 2, 3, 4].map(i => Math.round(R0 - 4 + i + rnd() * 6)), kst5: [0, 1, 2, 3, 4].map(i => +(5 + i + rnd() * 3).toFixed(1)), kstSig5: [0, 1, 2, 3, 4].map(i => +(kb ? 3 + i : 9 + i).toFixed(1)), sma20up: rnd() < 0.6, px, chg: +chg, gap: gap === "" ? null : +gap, rsi: +rsi || 50, rsiP: (+rsi || 50) - 3 + rnd() * 6, stK: k, stD: k - 8 + rnd() * 16, stKp: k - 6 + rnd() * 12, rvol: +rvol || 1, sma20: px * (0.95 + rnd() * 0.06), sma50: px * (0.92 + rnd() * 0.06), atrPct: +atrPct || 2, pdh: px * 1.01, pdl: px * 0.99, pdc: px, name: d.name || sym, sec: +sec, mcap: +mcap }; }
      return { asOf: new Date().toISOString(), stocks: st }; }
    case "options": { const ch = {}; for (const line of scanLive().map) { const sym = line.split("|")[0]; const cv = Math.round(1000 + rnd() * 50000), pv = Math.round(cv * (0.3 + rnd() * 1.5)); ch[sym] = { cv, pv, coi: cv * 4, poi: pv * 4, pcr: +(pv / cv).toFixed(2), cvOi: +(cv / (cv * 4)).toFixed(2), iv: 30, topCall: { k: 100, v: Math.round(cv / 5) } }; } return { asOf: new Date().toISOString(), chains: ch }; }
    case "fund": { const out = {}; for (const line of scanLive().map) { const sym = line.split("|")[0], k = rnd(); if (k < 0.08) continue;
      out[sym] = { rm: +(1.4 + rnd() * 1.8).toFixed(2), na: Math.round(3 + rnd() * 40), tgt: null, up: +(rnd() * 30 - 5).toFixed(1), sb: Math.round(rnd() * 15), b: Math.round(rnd() * 15), h: Math.round(rnd() * 10), s: Math.round(rnd() * 3), ss: Math.round(rnd() * 2),
        dy: rnd() < 0.55 ? +(rnd() * 5).toFixed(2) : null, inst: +(30 + rnd() * 60).toFixed(1), etfN: Math.round(rnd() * 5), top: [["Vanguard Total Stock Market Index Fund", 3.1, 1], ["SPDR S&P 500 ETF Trust", 1.2, 1], ["Fidelity Contrafund", 0.9, 0]],
        erd: new Date(Date.now() + Math.round(rnd() * 40) * 864e5).toISOString().slice(0, 10) }; }
      return { asOf: new Date().toISOString(), stocks: out }; }
    case "news": { const out = {}; const now = Math.floor(Date.now() / 1000); for (const line of scanLive().map.slice(0, 700)) { const sym = line.split("|")[0], t = Math.round(rnd() * 4 - 1.5);
      out[sym] = { n48: Math.round(rnd() * 5), n7: Math.round(3 + rnd() * 8), tone48: t, tone7: t + Math.round(rnd() * 2 - 1), st: rnd() < 0.7 ? { bull: Math.round(rnd() * 20), bear: Math.round(rnd() * 8), n: 30, watch: 5000 } : undefined,
        items: [{ t: `${sym} beats estimates and raises guidance`, p: "Wire", ts: now - 3600, l: "https://example.com/" + sym, s: 1 }, { t: `What to watch in ${sym} this week`, p: "Blog", ts: now - 86400, l: "https://example.com/w", s: 0 }] }; }
      return { asOf: new Date().toISOString(), stocks: out }; }
    case "trade": return mockTrade(req);
    case "health": return { ok: true, mode: "mock" };
    default: return null;
  }
}
