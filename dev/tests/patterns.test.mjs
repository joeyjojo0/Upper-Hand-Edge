// Chart-pattern finder tests on synthetic price paths (public/patterns.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findPatterns, zigzag, aggregate, patternSummary, PATTERNS, TIMEFRAMES } from "../../public/patterns.js";

// Bars along straight-line waypoints with a little deterministic noise.
function make(wp, { noise = 0.35, seed = 3, vol } = {}) {
  let sd = seed; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647 - 0.5; };
  const path = []; for (let k = 1; k < wp.length; k++) { const [i0, p0] = wp[k - 1], [i1, p1] = wp[k]; for (let i = i0; i < i1; i++) path.push(p0 + (p1 - p0) * (i - i0) / (i1 - i0)); } path.push(wp[wp.length - 1][1]);
  const b = []; let prev = path[0];
  path.forEach((p, i) => { const c = p + rnd() * noise * 2, o = prev; b.push({ t: 1e9 + i * 60, o, c, h: Math.max(o, c) + Math.abs(rnd()) * 0.3, l: Math.min(o, c) - Math.abs(rnd()) * 0.3, v: vol ? vol(i) : 1000 }); prev = c; });
  return b;
}
const CASES = {
  "double top, forming": [[[0, 80], [40, 100], [60, 90], [80, 100], [92, 94]], "dt", "forming"],
  "double top, broken": [[[0, 80], [40, 100], [60, 90], [80, 100], [96, 88]], "dt", "breakdown"],
  "double bottom, broken": [[[0, 120], [40, 100], [60, 110], [80, 100], [96, 112]], "db", "breakout"],
  "head & shoulders, broken": [[[0, 80], [30, 100], [45, 92], [65, 108], [85, 92], [100, 100], [118, 89]], "hs", "breakdown"],
  "inverse H&S, forming": [[[0, 120], [30, 100], [45, 108], [65, 92], [85, 108], [100, 100], [112, 105]], "ihs", "forming"],
  "inverse H&S, broken": [[[0, 120], [30, 100], [45, 108], [65, 92], [85, 108], [100, 100], [116, 111]], "ihs", "breakout"],
  "ascending triangle, forming": [[[0, 90], [10, 100], [22, 92], [34, 100], [46, 95], [58, 100], [68, 97.5], [76, 99.5]], "asc", "forming"],
  "ascending triangle, broken": [[[0, 90], [10, 100], [22, 92], [34, 100], [46, 95], [58, 100], [68, 97.5], [72, 99.5], [76, 104]], "asc", "breakout"],
  "descending triangle, broke up": [[[0, 110], [10, 100], [22, 108], [34, 100], [46, 105], [58, 100], [68, 102.5], [72, 101], [76, 106]], "desc", "breakout"],
  "bull flag, forming": [[[0, 100], [40, 100], [52, 120], [72, 114.5]], "bflag", "forming"],
  "bull flag, broken": [[[0, 100], [40, 100], [52, 120], [68, 115.5], [72, 122]], "bflag", "breakout"],
  "bear flag, forming": [[[0, 120], [40, 120], [52, 100], [70, 105]], "sflag", "forming"],
  "cup & handle, forming": [[[0, 100], [10, 120], [30, 104], [45, 101], [60, 104], [80, 119], [88, 115], [92, 116]], "cup", "forming"],
  "cup & handle, broken": [[[0, 100], [10, 120], [30, 104], [45, 101], [60, 104], [80, 119], [88, 115], [94, 123]], "cup", "breakout"],
  "falling wedge, broke up": [[[0, 130], [10, 120], [20, 126], [32, 112], [42, 118], [54, 108], [64, 112], [72, 106], [78, 109]], "fwedge", "breakout"],
  "rising wedge, broke down": [[[0, 70], [10, 80], [20, 74], [32, 88], [42, 82], [54, 92], [64, 88], [72, 94], [78, 91]], "rwedge", "breakdown"],
  "symmetrical wedge, forming": [[[0, 100], [10, 120], [22, 102], [34, 116], [46, 105], [58, 113], [68, 107], [76, 110]], "sym", "forming"]
};
for (const [name, [wp, id, status]] of Object.entries(CASES)) {
  test("finds " + name, () => {
    const f = findPatterns(make(wp)), p = f.find(x => x.id === id);
    assert.ok(p, `${id} not found; got ${f.map(x => x.id + ":" + x.status).join(", ") || "nothing"}`);
    assert.equal(p.status, status);
    assert.ok(p.conf >= 50 && p.conf <= 95);
    assert.ok(Number.isFinite(p.level) && Number.isFinite(p.target));
    assert.ok(p.sk.px.length >= 5 && p.sk.px.length <= 50, "sketch is down-sampled");
    if (status === "breakout") assert.ok(p.target > p.level, "bullish target above the breakout level");
    if (status === "breakdown") assert.ok(p.target < p.level, "bearish target below the breakdown level");
  });
}
test("biases follow the poster: bullish, bearish and break-decides", () => {
  assert.equal(PATTERNS.ihs.bias, "bull"); assert.equal(PATTERNS.hs.bias, "bear"); assert.equal(PATTERNS.cup.bias, "bull");
  assert.equal(PATTERNS.desc.bias, "watch");
  const d = findPatterns(make(CASES["descending triangle, broke up"][0])).find(x => x.id === "desc"); assert.equal(d.bias, "bull", "an upside break turns it bullish");
  assert.equal(TIMEFRAMES.join(","), "1m,5m,10m,30m,1h,4h,1d,1w");
});
test("quiet or short series give nothing; old breakouts are dropped", () => {
  assert.deepEqual(findPatterns(make([[0, 100], [120, 100]], { noise: 0.05 })), []);
  assert.deepEqual(findPatterns(make([[0, 100], [20, 101]])), [], "under 30 bars");
  const stale = findPatterns(make([[0, 80], [40, 100], [60, 90], [80, 100], [96, 88], [160, 70]]));
  assert.ok(!stale.find(x => x.id === "dt"), "a double top that broke 60+ bars ago is history");
});
test("zigzag confirms swings only from later bars", () => {
  const P = zigzag(make([[0, 100], [20, 110], [40, 100], [60, 110]]), 3);
  assert.deepEqual(P.map(p => p.t), ["L", "H", "L", "H"]); assert.ok(P[P.length - 1].live);
  for (let i = 1; i < P.length; i++) assert.ok(P[i].i > P[i - 1].i);
});
test("aggregate builds 10-minute bars from 5-minute bars", () => {
  const b = [0, 300, 600, 900, 1200].map((t, i) => ({ t, o: i, h: i + 2, l: i - 1, c: i + 1, v: 10 }));
  const a = aggregate(b, t => Math.floor(t / 600));
  assert.equal(a.length, 3); assert.deepEqual(a[0], { t: 0, o: 0, h: 3, l: -1, c: 2, v: 20 }); assert.equal(a[2].c, 5);
});
test("patternSummary picks the best bullish setup across timeframes", () => {
  const s = patternSummary({ "5m": [{ id: "bflag", bias: "bull", status: "forming", conf: 80 }], "1h": [{ id: "ihs", bias: "bull", status: "breakout", conf: 65 }, { id: "hs", bias: "bear", status: "forming", conf: 70 }] });
  assert.equal(s.bull.length, 2); assert.equal(s.bear.length, 1); assert.equal(s.bestBull.id, "ihs", "a confirmed break beats a forming pattern"); assert.equal(s.bestBull.tf, "1h");
});
