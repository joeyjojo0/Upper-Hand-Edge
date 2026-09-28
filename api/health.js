// Quick check that the deployment can reach Yahoo Finance.
import { quoteMap, handle } from "./_lib/core.js";
export default handle(async () => {
  const t = Date.now();
  const { mode, q } = await quoteMap(["ES=F", "EURUSD=X", "SPY"]);
  if (!Object.keys(q).length) throw new Error("Yahoo Finance is not reachable from this deployment");
  return { ok: Object.keys(q).length > 0, mode, symbols: Object.keys(q), ms: Date.now() - t, node: process.version, region: process.env.VERCEL_REGION || null };
}, 0, 0);
