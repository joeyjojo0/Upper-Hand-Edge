// Positioning and flow: CFTC Commitments of Traders (weekly) and FINRA off-exchange short volume (daily).
import { finra, cot, handle } from "./_lib/core.js";
export default handle(async () => {
  const [f, c] = await Promise.allSettled([finra(), cot()]);
  const val = r => r.status === "fulfilled" ? r.value : { error: String((r.reason && r.reason.message) || r.reason) };
  const out = { asOf: new Date().toISOString(), finra: val(f), cot: val(c) };
  if (out.finra.error && out.cot.error) throw new Error("FINRA: " + out.finra.error + " · CFTC: " + out.cot.error);
  return out;
}, 21600, 86400);
