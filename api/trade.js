// IC Markets (cTrader) trading bridge for the Strategy page.
//   GET  /api/trade                       → what's configured (no secrets, no balances)
//   POST /api/trade {action, pin, ...}    → account | accounts | find | order | positions | close  (PIN required)
// Secrets live only in Vercel environment variables:
//   CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN, CTRADER_ACCOUNT_ID,
//   CTRADER_ENV (demo | live, default demo), TRADE_PIN (8+ characters), TRADE_MAX_USD (default 2000),
//   CTRADER_SYMBOLS (optional JSON, e.g. {"AAPL":"AAPL.US"} to pin a broker symbol name).
// Safety: market orders only, a stop loss is mandatory, one notional cap per order, live trading needs an extra confirm.
import { createHash, timingSafeEqual } from "node:crypto";
import { CTrader, CTraderError, matchSymbol, toVolume, relDistance, sideName } from "./_lib/ctrader.js";

export function readConfig(E = process.env) {
  let symbols = {}; try { symbols = JSON.parse(E.CTRADER_SYMBOLS || "{}"); } catch { /* ignore bad JSON */ }
  return {
    env: String(E.CTRADER_ENV || "demo").toLowerCase() === "live" ? "live" : "demo",
    clientId: E.CTRADER_CLIENT_ID || "", clientSecret: E.CTRADER_CLIENT_SECRET || "", accessToken: E.CTRADER_ACCESS_TOKEN || "",
    accountId: E.CTRADER_ACCOUNT_ID ? Number(E.CTRADER_ACCOUNT_ID) : null, pin: E.TRADE_PIN || "",
    maxUsd: Math.max(1, +E.TRADE_MAX_USD || 2000), symbols
  };
}
export function status(cfg) {
  const configured = { app: !!(cfg.clientId && cfg.clientSecret), token: !!cfg.accessToken, account: !!cfg.accountId, pin: cfg.pin.length >= 8 };
  return { broker: "IC Markets", platform: "cTrader Open API", env: cfg.env, configured, ready: Object.values(configured).every(Boolean), maxUsd: cfg.maxUsd, asOf: new Date().toISOString() };
}
const hash = s => createHash("sha256").update(String(s)).digest();
export function pinOK(cfg, pin) { return cfg.pin.length >= 8 && typeof pin === "string" && timingSafeEqual(hash(pin), hash(cfg.pin)); }

const FRIENDLY = {
  CH_CLIENT_AUTH_FAILURE: "cTrader rejected the app credentials (check CTRADER_CLIENT_ID / SECRET).",
  CH_ACCESS_TOKEN_INVALID: "Access token expired or invalid: get a new one from the cTrader Open API Playground and update CTRADER_ACCESS_TOKEN.",
  OA_AUTH_TOKEN_EXPIRED: "Access token expired: get a new one from the Playground and update CTRADER_ACCESS_TOKEN.",
  ACCOUNT_NOT_AUTHORIZED: "This token can't trade that account. Check CTRADER_ACCOUNT_ID and that the token has the “trading” scope.",
  CH_CTID_TRADER_ACCOUNT_NOT_FOUND: "Account not found on this server. A demo account needs CTRADER_ENV=demo, a live one CTRADER_ENV=live.",
  MARKET_CLOSED: "Market is closed for this symbol.", SYMBOL_HAS_HOLIDAY: "Symbol is on holiday today.",
  NOT_ENOUGH_MONEY: "Not enough free margin for this order.", TRADING_DISABLED: "Trading is disabled for this symbol or account.",
  TRADING_BAD_VOLUME: "Volume not accepted for this symbol.", TRADING_BAD_STOPS: "Stop loss / take profit too close to the price.",
  POSITION_NOT_FOUND: "That position is no longer open.", CONNECT_TIMEOUT: "Couldn't reach cTrader. Try again in a moment."
};
const friendly = e => FRIENDLY[e && e.code] || (e && e.message) || "cTrader error";
const recent = [];

async function session(cfg, deps, fn, needAccount = true) {
  const c = new CTrader({ env: cfg.env, clientId: cfg.clientId, clientSecret: cfg.clientSecret, accessToken: cfg.accessToken, accountId: cfg.accountId, WS: deps.WS, url: deps.url });
  try { await c.connect(); await c.authApp(); if (needAccount) await c.authAccount(); return await fn(c); }
  finally { c.close(); }
}

async function positions(c) {
  const [{ positions: P }, syms] = await Promise.all([c.reconcile(), c.symbols()]);
  const name = Object.fromEntries(syms.map(s => [String(s.id), s.name]));
  const ids = [...new Set(P.map(p => Number(p.tradeData.symbolId)))].slice(0, 20);
  const px = ids.length ? await c.spots(ids, 1800) : {};
  return P.map(p => {
    const t = p.tradeData || {}, side = sideName(t.tradeSide), units = (t.volume || 0) / 100, q = px[Number(t.symbolId)] || {};
    const now = side === "BUY" ? q.bid : q.ask, pnl = now && p.price ? (side === "BUY" ? now - p.price : p.price - now) * units : null;
    return { id: p.positionId, symbol: name[String(t.symbolId)] || String(t.symbolId), side, units, price: p.price ?? null, sl: p.stopLoss ?? null, tp: p.takeProfit ?? null, now: now ?? null, pnl: pnl != null ? Math.round(pnl * 100) / 100 : null, opened: t.openTimestamp || null, label: t.label || "" };
  });
}

export async function run(action, body, cfg, deps = {}) {
  const num = (x, a, b, d) => { const v = Number(x); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  switch (action) {
    case "check": return { ok: true, ...status(cfg) };
    case "accounts": return { ok: true, env: cfg.env, accounts: await session(cfg, deps, c => c.accounts(), false) };
    case "account": return session(cfg, deps, async c => ({ ok: true, env: cfg.env, account: await c.trader(), positions: await positions(c) }));
    case "positions": return session(cfg, deps, async c => ({ ok: true, env: cfg.env, positions: await positions(c) }));
    case "find": return session(cfg, deps, async c => ({ ok: true, matches: matchSymbol(await c.symbols(), body.symbol, cfg.symbols).map(({ id, name, desc, score }) => ({ id, name, desc, score })) }));
    case "close": {
      const id = Number(body.positionId); if (!id) throw new CTraderError("BAD_REQUEST", "positionId missing");
      return session(cfg, deps, async c => {
        const { positions: P } = await c.reconcile(), p = P.find(x => Number(x.positionId) === id);
        if (!p) throw new CTraderError("POSITION_NOT_FOUND");
        const r = await c.closePosition(id, p.tradeData.volume);
        if (r.error) throw new CTraderError(r.error, r.description);
        return { ok: true, env: cfg.env, closed: id, status: r.status, price: r.deal && r.deal.executionPrice };
      });
    }
    case "order": {
      if (cfg.env === "live" && body.confirmLive !== true) throw new CTraderError("LIVE_CONFIRM", "This is a LIVE account: tick “I understand this is real money” first.");
      const now = Date.now(); while (recent.length && now - recent[0] > 60e3) recent.shift();
      if (recent.length >= 6) throw new CTraderError("RATE_LIMIT", "Too many orders in the last minute. Wait a moment.");
      const symbol = String(body.symbol || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
      if (!symbol) throw new CTraderError("BAD_REQUEST", "symbol missing");
      const slPct = num(body.slPct, 0.2, 15, NaN), tpPct = num(body.tpPct, 0.2, 50, NaN);
      if (!Number.isFinite(slPct)) throw new CTraderError("NO_STOP", "A stop loss is required (0.2%–15%).");
      if (!Number.isFinite(tpPct) && !(+body.tpPrice > 0)) throw new CTraderError("NO_TARGET", "Set a take profit (% or price).");
      const mode = body.mode === "long" ? "long" : "day";
      return session(cfg, deps, async c => {
        const m = matchSymbol(await c.symbols(), symbol, cfg.symbols)[0];
        if (!m || m.score < 60) throw new CTraderError("NO_MATCH", `IC Markets cTrader has no symbol matching ${symbol}. Use “Find symbol”, then pin it with CTRADER_SYMBOLS.`);
        const det = await c.symbolDetail(m.id);
        const sp = (await c.spots([m.id], 4000))[m.id] || {};
        const ask = sp.ask || (+body.refPx > 0 ? +body.refPx : null);
        if (!ask) throw new CTraderError("NO_PRICE", "No live price from cTrader for " + m.name + " (market closed?)");
        let units = +body.units > 0 ? +body.units : +body.usd > 0 ? +body.usd / ask : 0;
        if (!(units > 0)) throw new CTraderError("BAD_SIZE", "Enter a size (shares or $ amount).");
        if (units * ask > cfg.maxUsd * 1.0001) throw new CTraderError("CAP", `That's about $${Math.round(units * ask).toLocaleString("en-US")}, over your per-order cap of $${cfg.maxUsd.toLocaleString("en-US")} (TRADE_MAX_USD).`);
        const volume = toVolume(units, det); units = volume / 100;
        const relSL = relDistance(ask * slPct / 100, det.digits);
        const relTP = +body.tpPrice > ask ? relDistance(+body.tpPrice - ask, det.digits) : relDistance(ask * (Number.isFinite(tpPct) ? tpPct : 2) / 100, det.digits);
        const clientOrderId = "uhe" + now.toString(36) + Math.random().toString(36).slice(2, 6);
        recent.push(now);
        const r = await c.marketOrder({ symbolId: m.id, side: "BUY", volume, relSL, relTP, label: "UHE " + mode, comment: `UHE ${mode} ${symbol}`, clientOrderId });
        if (r.error) throw new CTraderError(r.error, r.description);
        const fill = (r.position && r.position.price) || (r.deal && r.deal.executionPrice) || null;
        return { ok: true, env: cfg.env, status: r.status, note: r.description || "", symbol: m.name, units, ask, notional: Math.round(units * ask * 100) / 100,
          sl: Math.round((ask - relSL / 1e5) * 1e4) / 1e4, tp: Math.round((ask + relTP / 1e5) * 1e4) / 1e4, fill, positionId: r.position ? r.position.positionId : null };
      });
    }
    default: throw new CTraderError("BAD_REQUEST", "Unknown action");
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let s = ""; for await (const ch of req) { s += ch; if (s.length > 10000) throw new CTraderError("BAD_REQUEST", "Body too large"); }
  return s ? JSON.parse(s) : {};
}
function out(res, code, body) { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); }

export default async function handler(req, res, deps = {}) {
  const cfg = deps.cfg || readConfig();
  if (req.method === "GET") return out(res, 200, status(cfg));
  if (req.method !== "POST") return out(res, 405, { ok: false, error: "Use GET or POST" });
  const o = req.headers.origin, host = req.headers["x-forwarded-host"] || req.headers.host;
  if (o) { try { if (new URL(o).host !== host) return out(res, 403, { ok: false, error: "Cross-site request blocked" }); } catch { return out(res, 403, { ok: false, error: "Bad origin" }); } }
  let body; try { body = await readBody(req); } catch { return out(res, 400, { ok: false, error: "Bad JSON" }); }
  if (cfg.pin.length < 8) return out(res, 503, { ok: false, code: "NO_PIN", error: "Trading is locked: set TRADE_PIN (8+ characters) in Vercel first." });
  if (!pinOK(cfg, body.pin)) { await new Promise(r => setTimeout(r, deps.pinDelay ?? 1200)); return out(res, 401, { ok: false, code: "BAD_PIN", error: "Wrong PIN" }); }
  const st = status(cfg);
  if (body.action !== "check" && !(st.configured.app && st.configured.token && (st.configured.account || body.action === "accounts")))
    return out(res, 503, { ok: false, code: "NOT_CONFIGURED", error: "IC Markets isn't connected yet: add the CTRADER_* settings in Vercel.", configured: st.configured });
  try { return out(res, 200, await run(String(body.action || ""), body, cfg, deps)); }
  catch (e) { return out(res, e instanceof CTraderError && !/TIMEOUT|CONNECT|CLOSED/.test(e.code) ? 400 : 502, { ok: false, code: e.code || "ERROR", error: friendly(e) }); }
}
