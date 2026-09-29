// Live quotes. Base snapshot comes from the GitHub data engine (every ~10 min, all markets);
// on top, real-time US ETF prices from Finnhub (drives the futures nowcast) and crypto from Coinbase.
import { handle } from "./_lib/core.js";
const DATA = process.env.DATA_URL || "https://raw.githubusercontent.com/joeyjojo0/Upper-Hand-Edge/data";
const ETFS = ["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"];
const CRYPTO = { BTCUSD: "BTC-USD", ETHUSD: "ETH-USD" };
const get = async (url, ms = 6000) => { const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "uhe" }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(url.split("?")[0] + " HTTP " + r.status); return r.json(); };
export default handle(async () => {
  let base = null;
  try { base = await get(DATA + "/quotes.json"); } catch (e) { /* snapshot missing */ }
  const q = base ? { ...base, inst: { ...base.inst }, etf: { ...(base.etf || {}) }, ctx: base.ctx || {} } : { inst: {}, ctx: {}, etf: {} };
  q.snapshotAsOf = base && base.asOf; q.asOf = new Date().toISOString(); q.mode = "snapshot+live";
  const key = process.env.FINNHUB_KEY;
  const jobs = [];
  if (key) for (const s of ETFS) jobs.push(get(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${key}`).then(j => { if (j && j.c) q.etf[s] = { px: j.c, t: j.t, state: null, delay: 0 }; }));
  for (const [id, p] of Object.entries(CRYPTO)) jobs.push(get(`https://api.exchange.coinbase.com/products/${p}/ticker`).then(j => {
    const px = +j.price; if (!px) return; const old = q.inst[id] || {};
    q.inst[id] = { ...old, px, t: Math.floor(Date.parse(j.time) / 1000) || Math.floor(Date.now() / 1000), delay: 0, chgd: old.prev ? Math.round((px / old.prev - 1) * 1e4) / 100 : old.chgd };
  }));
  await Promise.allSettled(jobs);
  if (!Object.keys(q.inst).length && !Object.keys(q.etf).length) throw new Error("no quotes yet (data engine has not run)");
  return q;
}, 10, 60);
