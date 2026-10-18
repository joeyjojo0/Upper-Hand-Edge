// Multi-timeframe chart patterns for the Strategy shortlist (runs in the GitHub data engine).
// Yahoo intervals: 1m, 5m (→ 10m), 30m, 60m (→ 1h and 4h), 1d, 1wk. Pattern logic lives in public/patterns.js.
import { chart, bars, pool, et } from "./core.js";
import { findPatterns, aggregate } from "../../public/patterns.js";

export const FAST = ["1m", "5m", "10m", "30m"], SLOW = ["1h", "4h", "1d", "1w"];
const FETCH = { // one Yahoo call can feed two timeframes
  "1m": { range: "2d", interval: "1m", pre: true, make: b => ({ "1m": b }) },
  "5m": { range: "5d", interval: "5m", pre: true, make: b => ({ "5m": b, "10m": aggregate(b, t => Math.floor(t / 600)) }) },
  "30m": { range: "1mo", interval: "30m", make: b => ({ "30m": b }) },
  "60m": { range: "6mo", interval: "60m", make: b => ({ "1h": b, "4h": aggregate(b, t => { const e = et(t); return e.d + (e.m < 13 * 60 + 30 ? "a" : "b"); }) }) },
  "1d": { range: "1y", interval: "1d", make: b => ({ "1d": b }) },
  "1wk": { range: "5y", interval: "1wk", make: b => ({ "1w": b }) }
};
const NEED = { "1m": "1m", "5m": "5m", "10m": "5m", "30m": "30m", "1h": "60m", "4h": "60m", "1d": "1d", "1w": "1wk" };

export async function patternsFor(syms, { tfs = FAST.concat(SLOW), prev = null, width = 6 } = {}) {
  const want = new Set(tfs), fetches = [...new Set(tfs.map(t => NEED[t]))];
  const res = await pool(syms, async s => {
    const y = s.replace(/\./g, "-"), out = { ...((prev && prev.stocks && prev.stocks[s]) || {}) };
    for (const f of fetches) {
      const F = FETCH[f];
      try {
        const got = F.make(bars(await chart(y, F.range, F.interval, !!F.pre)));
        for (const [tf, b] of Object.entries(got)) if (want.has(tf)) out[tf] = findPatterns(b.slice(-260), { limit: 2 });
      } catch (e) { /* keep the previous result for this timeframe */ }
    }
    return [s, out];
  }, width);
  const stocks = { ...((prev && prev.stocks) || {}) }; let fails = 0;
  for (const r of res) { if (r && !r.__err) stocks[r[0]] = r[1]; else fails++; }
  const now = new Date().toISOString(), tfAsOf = { ...((prev && prev.tfAsOf) || {}) }; for (const t of tfs) tfAsOf[t] = now;
  return { asOf: now, tfAsOf, n: Object.keys(stocks).length, fails, stocks };
}
