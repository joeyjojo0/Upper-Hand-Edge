import { UA } from "./_lib/core.js";
const T = [
  ["yahoo chart q1", "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=5m"],
  ["yahoo chart q2", "https://query2.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d&interval=5m"],
  ["yahoo cookie", "https://fc.yahoo.com/"],
  ["stooq quote", "https://stooq.com/q/l/?s=spy.us+eurusd&f=sd2t2ohlc&h&e=csv"],
  ["finra", "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260925.txt"],
  ["forex factory", "https://nfs.faireconomy.media/ff_calendar_thisweek.json"]
];
export default async function handler(req, res) {
  const out = await Promise.all(T.map(async ([name, url]) => {
    const t = Date.now();
    try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "manual", signal: AbortSignal.timeout(10000) }); const body = (await r.text()).slice(0, 160); return { name, status: r.status, ms: Date.now() - t, body }; }
    catch (e) { return { name, error: String(e.message || e), ms: Date.now() - t }; }
  }));
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ region: process.env.VERCEL_REGION || null, results: out }, null, 1));
}
