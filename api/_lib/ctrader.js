// Minimal cTrader Open API client (JSON over WebSocket, port 5036) for IC Markets cTrader accounts.
// Docs: https://help.ctrader.com/open-api/  ·  message ids from spotware/openapi-proto-messages.
// One short-lived connection per request: connect → app auth → account auth → do the thing → close.
export const PT = {
  HEARTBEAT: 51, ERROR_COMMON: 50,
  APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101, ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106, CLOSE_POSITION_REQ: 2111, ASSET_LIST_REQ: 2112, ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115, SYMBOL_BY_ID_REQ: 2116, SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121, TRADER_RES: 2122, RECONCILE_REQ: 2124, RECONCILE_RES: 2125, EXECUTION_EVENT: 2126,
  SUBSCRIBE_SPOTS_REQ: 2127, SUBSCRIBE_SPOTS_RES: 2128, UNSUBSCRIBE_SPOTS_REQ: 2129, SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132, ERROR_RES: 2142, GET_ACCOUNTS_REQ: 2149, GET_ACCOUNTS_RES: 2150
};
const EXEC = { 2: "ORDER_ACCEPTED", 3: "ORDER_FILLED", 4: "ORDER_REPLACED", 5: "ORDER_CANCELLED", 6: "ORDER_EXPIRED", 7: "ORDER_REJECTED", 8: "ORDER_CANCEL_REJECTED", 11: "ORDER_PARTIAL_FILL" };
const SIDE = { 1: "BUY", 2: "SELL" };
export const execName = v => typeof v === "number" ? EXEC[v] || String(v) : String(v || "");
export const sideName = v => typeof v === "number" ? SIDE[v] || String(v) : String(v || "");
export const hostFor = env => `wss://${env === "live" ? "live" : "demo"}.ctraderapi.com:5036`;

export class CTraderError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

export class CTrader {
  constructor({ env = "demo", clientId, clientSecret, accessToken, accountId, WS = globalThis.WebSocket, url } = {}) {
    Object.assign(this, { env, clientId, clientSecret, accessToken, accountId: accountId != null ? Number(accountId) : null, WS, url: url || hostFor(env) });
    this.pending = new Map(); this.listeners = new Set(); this.seq = 0; this.ws = null; this.hb = null;
  }
  async connect(timeoutMs = 8000) {
    if (!this.WS) throw new CTraderError("NO_WEBSOCKET", "This server has no WebSocket support (needs Node 22+)");
    await new Promise((resolve, reject) => {
      const ws = new this.WS(this.url); this.ws = ws;
      const t = setTimeout(() => reject(new CTraderError("CONNECT_TIMEOUT", "Could not reach cTrader (" + this.url + ")")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new CTraderError("CONNECT_FAILED", "cTrader connection failed")); });
      ws.addEventListener("message", ev => this.onMessage(ev.data));
      ws.addEventListener("close", () => { for (const [, p] of this.pending) p.reject(new CTraderError("CLOSED", "cTrader closed the connection")); this.pending.clear(); });
    });
    this.hb = setInterval(() => this.raw({ payloadType: PT.HEARTBEAT, payload: {} }), 9000);
    if (this.hb.unref) this.hb.unref();
  }
  async onMessage(data) {
    let m; try { m = JSON.parse(typeof data === "string" ? data : data && data.text ? await data.text() : String(data)); } catch { return; }
    if (!m || m.payloadType === PT.HEARTBEAT) return;
    if (!m.clientMsgId && (m.payloadType === PT.ERROR_RES || m.payloadType === PT.ERROR_COMMON) && this.pending.size) {
      const e = m.payload || {}, err = new CTraderError(e.errorCode || "ERROR", e.description || e.errorCode || "cTrader error");
      for (const [, q] of this.pending) q.reject(err); this.pending.clear();
    }
    const p = m.clientMsgId && this.pending.get(m.clientMsgId);
    if (p && (m.payloadType === PT.ERROR_RES || m.payloadType === PT.ERROR_COMMON || m.payloadType === PT.ORDER_ERROR_EVENT)) {
      this.pending.delete(m.clientMsgId); const e = m.payload || {};
      return p.reject(new CTraderError(e.errorCode || "ERROR", e.description || e.errorCode || "cTrader error"));
    }
    if (p && (!p.expect || p.expect.includes(m.payloadType))) { this.pending.delete(m.clientMsgId); p.resolve(m.payload || {}); }
    for (const fn of this.listeners) fn(m);
  }
  raw(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  request(payloadType, payload, expect, timeoutMs = 10000) {
    const clientMsgId = "uhe_" + (++this.seq) + "_" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(clientMsgId); reject(new CTraderError("TIMEOUT", "cTrader did not answer in time")); }, timeoutMs);
      this.pending.set(clientMsgId, { expect: expect ? [].concat(expect) : null, resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.raw({ clientMsgId, payloadType, payload });
    });
  }
  // Resolves with the first message that `test` accepts (or null on timeout).
  waitFor(test, timeoutMs) {
    return new Promise(resolve => {
      const fn = m => { const v = test(m); if (v) { this.listeners.delete(fn); clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => { this.listeners.delete(fn); resolve(null); }, timeoutMs);
      this.listeners.add(fn);
    });
  }
  close() { clearInterval(this.hb); try { this.ws && this.ws.close(); } catch { /* ignore */ } }

  async authApp() { await this.request(PT.APP_AUTH_REQ, { clientId: this.clientId, clientSecret: this.clientSecret }, PT.APP_AUTH_RES); }
  async authAccount() {
    if (!this.accountId) throw new CTraderError("NO_ACCOUNT", "CTRADER_ACCOUNT_ID is not set. Use “Find my accounts” to get it.");
    await this.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.accessToken }, PT.ACCOUNT_AUTH_RES);
  }
  async accounts() {
    const r = await this.request(PT.GET_ACCOUNTS_REQ, { accessToken: this.accessToken }, PT.GET_ACCOUNTS_RES);
    return (r.ctidTraderAccount || []).map(a => ({ id: a.ctidTraderAccountId, login: a.traderLogin, live: !!a.isLive, broker: a.brokerTitleShort || "" }));
  }
  async symbols() {
    if (this._syms) return this._syms;
    const r = await this.request(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: this.accountId, includeArchivedSymbols: false }, PT.SYMBOLS_LIST_RES, 15000);
    return (this._syms = (r.symbol || []).map(x => ({ id: x.symbolId, name: x.symbolName || "", desc: x.description || "", enabled: x.enabled !== false })));
  }
  async symbolDetail(id) {
    const r = await this.request(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId: this.accountId, symbolId: [id] }, PT.SYMBOL_BY_ID_RES);
    const s = (r.symbol || [])[0]; if (!s) throw new CTraderError("NO_SYMBOL", "Symbol details not found");
    return s;
  }
  // First bid/ask for each symbol (prices arrive in 1/100000 of a unit).
  async spots(ids, timeoutMs = 4000) {
    const want = new Set(ids.map(Number)), got = {};
    const done = this.waitFor(m => {
      if (m.payloadType !== PT.SPOT_EVENT || !m.payload) return null;
      const p = m.payload, id = Number(p.symbolId); if (!want.has(id)) return null;
      const g = got[id] = got[id] || {}; if (p.bid) g.bid = p.bid / 1e5; if (p.ask) g.ask = p.ask / 1e5;
      return [...want].every(k => got[k] && got[k].bid && got[k].ask) ? got : null;
    }, timeoutMs);
    await this.request(PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: this.accountId, symbolId: [...want] }, PT.SUBSCRIBE_SPOTS_RES).catch(() => null);
    await done;
    this.raw({ clientMsgId: "uhe_unsub", payloadType: PT.UNSUBSCRIBE_SPOTS_REQ, payload: { ctidTraderAccountId: this.accountId, symbolId: [...want] } });
    return got;
  }
  async trader() {
    const r = await this.request(PT.TRADER_REQ, { ctidTraderAccountId: this.accountId }, PT.TRADER_RES);
    const t = r.trader || {}, md = t.moneyDigits ?? 2;
    let ccy = "";
    try { const a = await this.request(PT.ASSET_LIST_REQ, { ctidTraderAccountId: this.accountId }, PT.ASSET_LIST_RES); const x = (a.asset || []).find(z => z.assetId === t.depositAssetId); ccy = x ? (x.displayName || x.name) : ""; } catch { /* optional */ }
    return { balance: t.balance != null ? t.balance / 10 ** md : null, ccy, leverage: t.leverageInCents ? t.leverageInCents / 100 : null, login: t.traderLogin || null, broker: t.brokerName || "", type: t.accountType || null };
  }
  async reconcile() {
    const r = await this.request(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId }, PT.RECONCILE_RES);
    return { positions: r.position || [], orders: r.order || [] };
  }
  async marketOrder({ symbolId, side, volume, relSL, relTP, label, comment, clientOrderId }) {
    const ack = this.waitFor(m => {
      const p = m.payload || {};
      if (m.payloadType === PT.ORDER_ERROR_EVENT || ((m.payloadType === PT.ERROR_RES || m.payloadType === PT.ERROR_COMMON) && m.clientMsgId === "uhe_ord_" + clientOrderId)) return { error: p.errorCode || "ORDER_ERROR", description: p.description || "" };
      if (m.payloadType !== PT.EXECUTION_EVENT) return null;
      const mine = (p.order && p.order.clientOrderId === clientOrderId) || (p.order && p.order.tradeData && p.order.tradeData.label === label && Number(p.order.tradeData.symbolId) === Number(symbolId));
      if (!mine) return null;
      const t = execName(p.executionType);
      if (t === "ORDER_FILLED" || t === "ORDER_PARTIAL_FILL") return { status: t, position: p.position, deal: p.deal, order: p.order };
      if (t === "ORDER_REJECTED" || t === "ORDER_CANCELLED" || t === "ORDER_EXPIRED") return { error: t, description: p.errorCode || "" };
      return null;
    }, 12000);
    const payload = { ctidTraderAccountId: this.accountId, symbolId, orderType: 1, tradeSide: side === "SELL" ? 2 : 1, volume, label, comment, clientOrderId };
    if (relSL) payload.relativeStopLoss = relSL; if (relTP) payload.relativeTakeProfit = relTP;
    this.raw({ clientMsgId: "uhe_ord_" + clientOrderId, payloadType: PT.NEW_ORDER_REQ, payload });
    return (await ack) || { status: "SENT", description: "No fill confirmation within 12s. Check cTrader before retrying." };
  }
  async closePosition(positionId, volume) {
    const ack = this.waitFor(m => {
      const p = m.payload || {};
      if (m.payloadType === PT.ORDER_ERROR_EVENT && (!p.positionId || Number(p.positionId) === Number(positionId))) return { error: p.errorCode || "ORDER_ERROR", description: p.description || "" };
      if (m.payloadType === PT.ERROR_RES) return { error: p.errorCode || "ERROR", description: p.description || "" };
      if (m.payloadType !== PT.EXECUTION_EVENT || !p.position || Number(p.position.positionId) !== Number(positionId)) return null;
      const t = execName(p.executionType);
      return t === "ORDER_FILLED" || t === "ORDER_PARTIAL_FILL" ? { status: t, deal: p.deal } : t === "ORDER_REJECTED" ? { error: t } : null;
    }, 12000);
    this.raw({ clientMsgId: "uhe_close_" + positionId, payloadType: PT.CLOSE_POSITION_REQ, payload: { ctidTraderAccountId: this.accountId, positionId: Number(positionId), volume: Number(volume) } });
    return (await ack) || { status: "SENT", description: "No confirmation within 12s. Check cTrader." };
  }
}

// Ticker → broker symbol. IC Markets names US shares differently per platform (AAPL.US, AAPL.NAS, "Apple Inc (AAPL.O)"…),
// so match by name first, then by the ticker in the description. CTRADER_SYMBOLS can pin names: {"AAPL":"AAPL.US"}.
export function matchSymbol(list, ticker, overrides = {}) {
  const T = String(ticker || "").toUpperCase().trim(); if (!T) return [];
  const pin = overrides[T] && String(overrides[T]).toUpperCase();
  const alt = [T, T.replace(/\./g, ""), T.replace(/\./g, "_"), T.replace(/\./g, "-")];
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scored = [];
  for (const s of list) {
    const N = s.name.toUpperCase(), D = s.desc.toUpperCase(); let sc = 0;
    if (pin && N === pin) sc = 200;
    else if (alt.includes(N)) sc = 100;
    else if (alt.some(a => new RegExp(`^${esc(a)}[._ -](US|USA|NAS|NASDAQ|NYSE|NYQ|O|OQ|N|ARCA|AMEX)$`).test(N))) sc = 90;
    else if (alt.some(a => new RegExp(`^${esc(a)}[._ -]`).test(N))) sc = 60;
    else if (alt.some(a => new RegExp(`\\(${esc(a)}([.)\\s]|$)`).test(D) || new RegExp(`\\(${esc(a)}([.)\\s]|$)`).test(N))) sc = 70;
    if (sc && !s.enabled) sc -= 30;
    if (sc > 0) scored.push({ ...s, score: sc });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, 8);
}

// Shares → protocol volume (0.01 units), snapped to the symbol's step and checked against min/max.
export function toVolume(units, sym) {
  const step = Number(sym.stepVolume) || 100, min = Number(sym.minVolume) || step, max = Number(sym.maxVolume) || Infinity;
  const v = Math.floor(Math.round(units * 100) / step) * step;
  if (!(v >= min)) throw new CTraderError("TOO_SMALL", `Order too small: minimum is ${(min / 100).toLocaleString("en-US")} units`);
  if (v > max) throw new CTraderError("TOO_LARGE", `Order too large: maximum is ${(max / 100).toLocaleString("en-US")} units`);
  return v;
}
// Price distance → protocol relative distance (1/100000 of a unit), rounded to the symbol's digits.
export function relDistance(dist, digits) {
  const step = 10 ** Math.max(0, 5 - (Number.isFinite(+digits) ? +digits : 2));
  return Math.max(step, Math.round(dist * 1e5 / step) * step);
}
