// UHE data engine. Runs on GitHub Actions (Yahoo and Forex Factory block Vercel's servers) and writes
// JSON snapshots into OUT (the `data` branch). The website reads them through /data/*.
// Each file has its own refresh age so the heavy jobs (500-stock history, COT/FINRA) run rarely.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { markets, liveQuotes, basis, scanHist, scanLive, finra, cot, calendar, optionsFor, fundamentalsFor, newsFor, pulse } from "../api/_lib/core.js";
import { patternsFor, FAST, SLOW } from "../api/_lib/patterns-data.js";
import { rank, normRules } from "../public/strategy-model.js";

const OUT = process.argv[2] || "out";
const MIN = 60e3;
const AGE = { quotes: 0, basis: 0, markets: 0, scan: 0, "scan-hist": 6 * 60 * MIN, flow: 6 * 60 * MIN, calendar: 30 * MIN, deep: 0, options: 8 * 60 * MIN, fund: 12 * 60 * MIN, news: 60 * MIN, pulse: 0 };
// Option chains refresh every ~20 min in the pre-open window (12:00-15:30 UK, weekdays), otherwise a few times a day.
const ukNow = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
const ukMin = (+ukNow.hour) * 60 + (+ukNow.minute);
if (!["Sat", "Sun"].includes(ukNow.weekday) && ukMin >= 720 && ukMin <= 930) { AGE.options = 18 * MIN; AGE.news = 18 * MIN; }
const force = new Set((process.env.FORCE || "").split(",").filter(Boolean));
await mkdir(OUT, { recursive: true });
const read = async n => { try { return JSON.parse(await readFile(`${OUT}/${n}.json`, "utf8")); } catch { return null; } };
const due = (n, prev) => force.has(n) || force.has("all") || !prev || !prev.asOf || Date.now() - Date.parse(prev.asOf) >= AGE[n];
const log = [];
async function job(n, fn) {
  const prev = await read(n);
  if (!due(n, prev)) { log.push(`${n}: fresh (${prev.asOf})`); return prev; }
  const t = Date.now();
  try {
    const v = await fn();
    await writeFile(`${OUT}/${n}.json`, JSON.stringify(v));
    log.push(`${n}: ok in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    return v;
  } catch (e) { log.push(`${n}: FAILED ${e.message}`); return prev; }
}
await job("quotes", liveQuotes);
await job("basis", basis);
await job("markets", markets);
const H = await job("scan-hist", scanHist);
let SC = null;
if (H && H.rows) SC = await job("scan", async () => { const v = await scanLive(H); const { deep, ...rest } = v; await writeFile(`${OUT}/deep.json`, JSON.stringify({ asOf: v.asOf, stocks: deep })); return rest; });
// Options for index members plus Nasdaq names trading over ~$100M a day (keeps each run to ~700 chains).
const CAND = H && H.rows ? H.rows.filter(r => /[SN]/.test(r.u || "S") || r.adv20 * r.pdc >= 1e8) : [];
if (CAND.length) await job("options", () => optionsFor(CAND.map(r => r.s)));
// Strategy page inputs: analysts, fund/ETF holders, dividends, earnings date (twice a day) and
// headlines + retail sentiment for a technical shortlist (hourly, every ~20 min before the open).
if (CAND.length) await job("fund", () => fundamentalsFor(CAND.map(r => r.s)));
// Market pulse (wire headlines, Reddit mention leaders, StockTwits trending): a handful of calls, every run.
const PULSE = await job("pulse", pulse);
if (CAND.length) await job("news", async () => {
  const deep = (await read("deep")) || {}, D = deep.stocks || {};
  const hot = new Set([...((PULSE && PULSE.redditTop) || []).map(x => x.s), ...((PULSE && PULSE.stTrend) || []).map(x => x.s)]);
  const all5 = (a, f) => Array.isArray(a) && a.length === 5 && a.every(f);
  const pick = CAND.filter(r => { const d = D[r.s]; if (!d) return false;
    const day = d.rsi >= 50 && (d.rvol || 0) >= 1 && d.px > (d.sma20 || Infinity);
    const long = all5(d.rsi5, v => v >= 50) || (Array.isArray(d.kst5) && Array.isArray(d.kstSig5) && d.kst5.every((v, i) => v != null && d.kstSig5[i] != null && v > d.kstSig5[i]));
    return day || long || hot.has(r.s); }).sort((a, b) => (hot.has(b.s) - hot.has(a.s)) || b.adv20 * b.pdc - a.adv20 * a.pdc).slice(0, 220).map(r => r.s);
  return newsFor(pick.length ? pick : CAND.slice(0, 100).map(r => r.s), { prev: await read("news") });
});
// Chart patterns on 1m–1w for the checklist shortlist. Intraday timeframes every run while US stocks trade
// (pre-market included); 1h/4h/1d/1w hourly. Names new to the list get every timeframe straight away.
if (H && H.rows) {
  const t0 = Date.now(), prev = await read("patterns"), ageMin = tf => prev && prev.tfAsOf && prev.tfAsOf[tf] ? (Date.now() - Date.parse(prev.tfAsOf[tf])) / 60e3 : Infinity;
  const session = !["Sat", "Sun"].includes(ukNow.weekday) && ukMin >= 540 && ukMin <= 1275, forced = force.has("patterns") || force.has("all");
  const fastDue = forced || ageMin("1m") >= (session ? 0 : 180), slowDue = forced || ageMin("1d") >= (session ? 55 : 360);
  try {
    const D = ((await read("deep")) || {}).stocks || {}, O = ((await read("options")) || {}).chains || {}, F = ((await read("fund")) || {}).stocks || {};
    const N = { ...(((await read("news")) || {}).stocks || {}) }, P = (await read("pulse")) || {};
    for (const [s, rd] of Object.entries(P.reddit || {})) N[s] = { ...(N[s] || {}), rd };
    const R = normRules({}), best = (mode, take) => [...new Map(["S", "Q"].flatMap(u => rank(mode, D, O, F, N, R, { u, minPass: 5 })).map(r => [r.s, r])).values()]
      .sort((a, b) => b.pass - a.pass || (b.d.score || 0) - (a.d.score || 0)).slice(0, take).map(r => r.s);
    const hot = [...(P.redditTop || []), ...(P.stTrend || [])].map(x => x.s).filter(s => D[s]).slice(0, 15);
    const list = [...new Set([...best("day", 70), ...best("long", 30), ...hot])].slice(0, 110);
    if (!list.length || (!fastDue && !slowDue && list.every(s => prev && prev.stocks && prev.stocks[s]))) log.push(`patterns: fresh (${prev && prev.asOf})`);
    else {
      let out = prev && prev.stocks ? { ...prev, stocks: Object.fromEntries(list.filter(s => prev.stocks[s]).map(s => [s, prev.stocks[s]])) } : null;
      const newNames = list.filter(s => !(out && out.stocks[s]));
      out = await patternsFor(fastDue ? list : newNames, { tfs: FAST, prev: out });
      if (!fastDue && prev && prev.tfAsOf) for (const tf of FAST) out.tfAsOf[tf] = prev.tfAsOf[tf] || out.tfAsOf[tf];
      const slowList = slowDue ? list : list.filter(s => !(out.stocks[s] && out.stocks[s]["1d"]));
      if (slowList.length) out = await patternsFor(slowList, { tfs: SLOW, prev: out });
      if (!slowDue && prev && prev.tfAsOf) for (const tf of SLOW) out.tfAsOf[tf] = prev.tfAsOf[tf] || out.tfAsOf[tf];
      out.list = list;
      await writeFile(`${OUT}/patterns.json`, JSON.stringify(out));
      log.push(`patterns: ok in ${((Date.now() - t0) / 1000).toFixed(1)}s (${list.length} stocks${fastDue ? ", 1m–30m" : ""}${slowDue ? ", 1h–1w" : ""})`);
    }
  } catch (e) { log.push("patterns: FAILED " + e.message); }
}
await job("flow", async () => {
  const [f, c] = await Promise.allSettled([finra(), cot()]);
  const v = r => r.status === "fulfilled" ? r.value : { error: String(r.reason && r.reason.message || r.reason) };
  const out = { asOf: new Date().toISOString(), finra: v(f), cot: v(c) };
  if (out.finra.error && out.cot.error) throw new Error(out.finra.error);
  return out;
});
await job("calendar", calendar);
await writeFile(`${OUT}/status.json`, JSON.stringify({ asOf: new Date().toISOString(), log }));
console.log(log.join("\n"));
if (log.every(l => l.includes("FAILED"))) process.exit(1);
