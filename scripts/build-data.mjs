// UHE data engine. Runs on GitHub Actions (Yahoo and Forex Factory block Vercel's servers) and writes
// JSON snapshots into OUT (the `data` branch). The website reads them through /data/*.
// Each file has its own refresh age so the heavy jobs (500-stock history, COT/FINRA) run rarely.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { markets, liveQuotes, basis, scanHist, scanLive, finra, cot, calendar, optionsFor } from "../api/_lib/core.js";

const OUT = process.argv[2] || "out";
const MIN = 60e3;
const AGE = { quotes: 0, basis: 0, markets: 0, scan: 0, "scan-hist": 6 * 60 * MIN, flow: 6 * 60 * MIN, calendar: 30 * MIN, deep: 0, options: 8 * 60 * MIN };
// Option chains refresh every ~20 min in the pre-open window (12:00-15:30 UK, weekdays), otherwise a few times a day.
const ukNow = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
const ukMin = (+ukNow.hour) * 60 + (+ukNow.minute);
if (!["Sat", "Sun"].includes(ukNow.weekday) && ukMin >= 720 && ukMin <= 930) AGE.options = 18 * MIN;
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
if (H && H.rows) await job("options", () => optionsFor(H.rows.map(r => r.s)));
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
