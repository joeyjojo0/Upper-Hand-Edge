// Live S&P 500 scanner: cached daily history + fresh quotes for all members.
import { scanHistCached, scanLive, handle, origin } from "./_lib/core.js";

async function history(req) {
  // Prefer the edge-cached history endpoint; fall back to computing it here (e.g. on protected preview deployments).
  try {
    const r = await fetch(origin(req) + "/api/scan-hist", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45000) });
    if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.rows) && j.rows.length > 100) return j; }
  } catch (e) { /* fall through */ }
  return scanHistCached();
}
export default handle(async req => scanLive(await history(req)), 60, 600);
