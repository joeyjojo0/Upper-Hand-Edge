// Optional NY-open brief written by Claude. Enabled when ANTHROPIC_API_KEY is set in the Vercel project.
// The prompt is built on the server from the dashboard's own data (no user-supplied prompts), and the
// result is cached at the edge for 30 minutes so the key is used at most a couple of times an hour.
import { send, origin } from "./_lib/core.js";
import { applyLive, buildModel, briefPrompt, parseScan, clock } from "../public/model.js";

async function get(base, path, ms) {
  try {
    const r = await fetch(base + path, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return send(res, 200, { ai: false, reason: "ANTHROPIC_API_KEY is not set" }, 3600, 86400);
  try {
    const base = origin(req);
    const [mk, q, bs, fl, cal, sc] = await Promise.all([
      get(base, "/data/markets.json", 15000), get(base, "/api/quotes", 10000), get(base, "/data/basis.json", 10000),
      get(base, "/data/flow.json", 10000), get(base, "/data/calendar.json", 10000), get(base, "/data/scan.json", 10000)
    ]);
    if (!mk) throw new Error("market data unavailable");
    const live = applyLive(mk, q, bs);
    const M = buildModel({ ...live, cot: fl && fl.cot, finra: fl && fl.finra }, null);
    const prompt = briefPrompt(M, cal, parseScan(sc));
    if (!prompt) throw new Error("no model");
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(40000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j && j.error && j.error.message) || "Anthropic HTTP " + r.status);
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (!text) throw new Error("empty brief");
    send(res, 200, { ai: true, text, day: clock().day, at: new Date().toISOString(), by: "Claude (" + model + ")" }, 1800, 3600);
  } catch (e) {
    send(res, 502, { ai: false, error: String((e && e.message) || e) });
  }
}
