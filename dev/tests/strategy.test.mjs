// Strategy checklist tests (public/strategy-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RULE_DEFAULTS, normRules, evalDay, evalLong, dayPlan, rank, dayPhase } from "../../public/strategy-model.js";

const R = normRules({});
const good = { px: 100, ext: 101, chg: 1.2, rsi: 61, rsiP: 57, rvol: 1.5, sma20: 97, sma50: 93, sma20up: true, pdh: 102.5, pdc: 99.5, u: "SNQ", score: 70, mcap: 500,
  rsi5: [52, 55, 58, 60, 61], kst5: [4, 5, 6, 7, 8], kstSig5: [2, 3, 4, 5, 6] };
const O = { cv: 9000, pv: 4000, coi: 50000, poi: 30000, pcr: 0.44 };
const F = { rm: 1.8, na: 25, up: 12, inst: 74, etfN: 3, dy: 3.2, exd: "2026-11-01", erd: "2026-10-14", top: [] };
const N = { n48: 3, tone48: 2, n7: 6, tone7: 1, st: { bull: 14, bear: 3, n: 30 }, items: [] };
const NOW = new Date("2026-10-08T12:00:00Z");

test("day checklist: all seven pass on a clean setup", () => {
  const c = evalDay(good, O, F, N, R.day);
  for (const k of ["rsi", "vol", "news", "etf", "trend", "opts", "analysts"]) assert.equal(c[k].pass, true, k + ": " + c[k].val);
  assert.match(c.rsi.val, /rising/); assert.match(c.news.val, /StockTwits 82% bullish/);
});

test("day checklist: each rule can fail, missing data is neutral", () => {
  const c = evalDay({ ...good, rsi: 78, rvol: 0.7, sma20: 103, sma20up: false }, { cv: 100, pv: 300, pcr: 3 }, { rm: 3.1, na: 12, inst: 20, etfN: 0 }, { n48: 2, tone48: -1, st: null }, R.day);
  for (const k of ["rsi", "vol", "news", "etf", "trend", "opts", "analysts"]) assert.equal(c[k].pass, false, k);
  const m = evalDay({ px: 10 }, undefined, undefined, undefined, R.day);
  for (const k of ["rsi", "vol", "news", "etf", "trend", "opts", "analysts"]) assert.equal(m[k].pass, null, k);
});

test("news check: SEC filings and Reddit buzz", () => {
  const base = { n48: 1, tone48: 0, pro48: 1, st: null };
  assert.equal(evalDay(good, O, F, { ...base, rd: [8, 60, 20, 300, 30] }, R.day).news.pass, true, "Reddit mentions 3× yesterday");
  assert.match(evalDay(good, O, F, { ...base, rd: [8, 60, 20, 300, 30] }, R.day).news.val, /Reddit #8 · 60 mentions \(3\.0× yesterday\)/);
  assert.equal(evalDay(good, O, F, { ...base, rd: [8, 60, 55, 300, 9] }, R.day).news.pass, false, "busy but not spiking, flat tone");
  assert.equal(evalDay(good, O, F, { ...N, secf: { dil: true } }, R.day).news.pass, false, "share offering overrides good news");
  assert.equal(evalDay(good, O, F, { ...base, secf: { act: true } }, R.day).news.pass, true, "13D stake counts as a positive");
  assert.equal(evalDay(good, O, F, { rd: [3, 40, 10] }, R.day).news.pass, true, "Reddit alone is enough data");
  assert.equal(evalLong(good, O, F, { ...N, secf: { red: true } }, R.long, NOW).earn.pass, false);
});

test("tick 8: insiders & firms; tick 9: chart pattern (up to 9 confluences)", () => {
  const now = Date.parse("2026-10-08T12:00:00Z"), day = n => new Date(now - n * 864e5).toISOString().slice(0, 10);
  // nothing known → neutral; known but quiet → fail
  assert.equal(evalDay(good, O, undefined, undefined, R.day, null, now).firms.pass, null);
  assert.equal(evalDay(good, O, { whales: [["Vanguard", 8, 1, "2026-06-30"]] }, {}, R.day, null, now).firms.pass, false);
  // a CFO buys $100k on the open market (SEC Form 4)
  const N1 = { f4: [{ a: "1", n: "SMITH JOHN", role: "Chief Financial Officer", buy: { sh: 2500, v: 100000, px: 40, d: day(3) }, u: "https://www.sec.gov/x" }] };
  const f1 = evalDay(good, O, {}, N1, R.day, null, now).firms; assert.equal(f1.pass, true); assert.match(f1.val, /Chief Financial Officer bought \$100k/);
  // two insiders = cluster; tiny buys and 40-day-old buys don't count
  const N2 = { f4: [N1.f4[0], { a: "2", n: "DOE JANE", role: "Director", buy: { sh: 100, v: 60000, px: 40, d: day(10) } }, { a: "3", n: "OLD MAN", role: "Director", buy: { v: 900000, d: day(40) } }] };
  assert.match(evalDay(good, O, {}, N2, R.day, null, now).firms.val, /2 insiders bought \$160k/);
  assert.equal(evalDay(good, O, {}, { f4: [{ a: "4", n: "X", role: "Director", buy: { v: 5000, d: day(1) } }] }, R.day, null, now).firms.pass, false);
  // firms: 3 of the top 10 added 5%+ last quarter, a whale (10% owner) buy, a 13D
  assert.equal(evalDay(good, O, { whales: [["A", 5, 6], ["B", 4, 9], ["C", 3, 12], ["D", 2, -3]] }, {}, R.day, null, now).firms.pass, true);
  assert.equal(evalDay(good, O, {}, { f4: [{ a: "5", n: "BIG FUND LP", role: "10% owner", ten: true, buy: { v: 5e6, d: day(2) } }] }, R.day, null, now).firms.pass, true);
  assert.equal(evalDay(good, O, {}, { secf: { act: true } }, R.day, null, now).firms.pass, true);
  // patterns: bullish 5m flag passes; a fresher bearish breakdown on a higher timeframe vetoes; long term reads 4h–1w only
  const bull = { "5m": [{ id: "bflag", name: "Bull flag", bias: "bull", status: "forming", conf: 70 }] };
  assert.equal(evalDay(good, O, F, N, R.day, null, now).pattern.pass, null);
  assert.match(evalDay(good, O, F, N, R.day, bull, now).pattern.val, /Bull flag on 5m · forming/);
  assert.equal(evalDay(good, O, F, N, R.day, { ...bull, "1h": [{ id: "dt", name: "Double top", bias: "bear", status: "breakdown", conf: 75 }] }, now).pattern.pass, false);
  assert.equal(evalDay(good, O, F, N, R.day, { "5m": [{ ...bull["5m"][0], conf: 40 }] }, now).pattern.pass, false, "below the quality bar");
  assert.equal(evalLong(good, O, F, N, R.long, new Date(now), bull).pattern.pass, false, "a 5m flag is not a long-term signal");
  assert.equal(evalLong(good, O, F, N, R.long, new Date(now), { "1w": [{ id: "cup", name: "Cup & handle", bias: "bull", status: "breakout", conf: 80 }] }).pattern.pass, true);
  // the screen now scores out of 9 on both lists
  const rows = rank("day", { AAA: good }, { AAA: O }, { AAA: { ...F, whales: [["A", 5, 6], ["B", 4, 9], ["C", 3, 12]] } }, { AAA: N }, R, { pat: { AAA: bull } });
  assert.equal(rows[0].pass, 9); assert.equal(Object.keys(rows[0].c).length, 9);
  assert.equal(Object.keys(rank("long", { AAA: good }, { AAA: O }, { AAA: F }, { AAA: N }, R, { now: NOW })[0].c).length, 9);
});

test("day plan: 1–3% target, capped just under the previous high", () => {
  const p = dayPlan(good, R.day);
  assert.equal(p.entry, 101); assert.ok(p.capped, "2% target (103.02) is above the prior high 102.5");
  assert.ok(Math.abs(p.tp - 102.5 * 0.998) < 1e-9); assert.ok(Math.abs(p.sl - 101 * 0.985) < 1e-9);
  const q = dayPlan({ ...good, pdh: 110 }, R.day); assert.equal(q.capped, false); assert.ok(Math.abs(q.tp - 103.02) < 1e-9);
  assert.equal(normRules({ day: { tpPct: 9 } }).day.tpPct, 3, "day target is held to 1–3%");
});

test("long checklist: 5-day RSI, KST, pre-earnings window, dividend", () => {
  const c = evalLong(good, O, F, N, R.long, NOW);
  for (const k of ["rsi5", "kst5", "earn", "etf", "opts", "analysts", "div"]) assert.equal(c[k].pass, true, k + ": " + c[k].val);
  assert.match(c.earn.val, /Earnings in 6d/);
  const bad = evalLong({ ...good, rsi5: [52, 49, 58, 60, 61], kst5: [4, 5, 6, 7, 5] }, { coi: 1, poi: 9 }, { ...F, erd: "2026-11-20", dy: 0.4, up: 2 }, { ...N, tone7: -2 }, R.long, NOW);
  for (const k of ["rsi5", "kst5", "earn", "opts", "analysts", "div"]) assert.equal(bad[k].pass, false, k);
  assert.match(bad.earn.val, /window opens/);
});

test("rank: universe filter, min ticks, sort order, watchlist", () => {
  const D = { AAA: good, BBB: { ...good, u: "Q", rsi: 80, score: 90 }, CCC: { ...good, u: "S", rvol: 0.5, score: 99 } };
  const Os = { AAA: O, BBB: O, CCC: O }, Fs = { AAA: F, BBB: F, CCC: F }, Ns = { AAA: N, BBB: N, CCC: N };
  const s = rank("day", D, Os, Fs, Ns, R, { u: "S" }); assert.deepEqual(s.map(r => r.s), ["AAA", "CCC"], "7/7 before 6/7 even with a lower score");
  assert.deepEqual(rank("day", D, Os, Fs, Ns, R, { u: "Q" }).map(r => r.s), ["AAA", "BBB"]);
  assert.deepEqual(rank("day", D, Os, Fs, Ns, R, { u: "S", minPass: 7 }).map(r => r.s), ["AAA"]);
  assert.deepEqual(rank("long", D, Os, Fs, Ns, R, { watch: new Set(["BBB"]), now: NOW }).map(r => r.s), ["BBB"]);
  assert.equal(RULE_DEFAULTS.day.tpPct, 2);
});

test("day phase follows the UK clock around the 14:30 open", () => {
  assert.equal(dayPhase(new Date("2026-10-08T11:00:00Z")).k, "build");
  assert.equal(dayPhase(new Date("2026-10-08T13:10:00Z")).k, "pre", "14:10 UK");
  assert.match(dayPhase(new Date("2026-10-08T13:10:00Z")).t, /14:00/);
  assert.equal(dayPhase(new Date("2026-10-08T13:35:00Z")).k, "open", "14:35 UK");
  assert.equal(dayPhase(new Date("2026-10-08T15:00:00Z")).k, "session");
  assert.equal(dayPhase(new Date("2026-10-08T21:30:00Z")).k, "closed");
  assert.equal(dayPhase(new Date("2026-10-10T13:10:00Z")).k, "closed", "Saturday");
  assert.match(dayPhase(new Date("2026-10-27T13:10:00Z")).t, /13:00/, "US clocks change first: the open is 13:30 UK that week");
});
