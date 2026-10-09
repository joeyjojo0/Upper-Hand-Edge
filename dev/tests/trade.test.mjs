// IC Markets / cTrader bridge tests against an in-memory fake of the cTrader Open API (JSON over WebSocket).
import { test } from "node:test";
import assert from "node:assert/strict";
import handler, { readConfig, status, run } from "../../api/trade.js";
import { matchSymbol, toVolume, relDistance } from "../../api/_lib/ctrader.js";

const SYMS = [
  { symbolId: 1, symbolName: "EURUSD", description: "Euro vs US Dollar", enabled: true },
  { symbolId: 101, symbolName: "AAPL.US", description: "Apple Inc", enabled: true },
  { symbolId: 102, symbolName: "Microsoft Corp (MSFT.O)", description: "Microsoft", enabled: true },
  { symbolId: 103, symbolName: "AAPLX", description: "Some other thing", enabled: true },
  { symbolId: 104, symbolName: "BRK_B.US", description: "Berkshire Hathaway B", enabled: true }
];
let LOG = [], POS = [], BAD_TOKEN = false, REJECT = null;
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.h = {}; setTimeout(() => { this.readyState = 1; this.emit("open", {}); }, 1); }
  addEventListener(k, fn) { (this.h[k] = this.h[k] || []).push(fn); }
  emit(k, ev) { for (const fn of this.h[k] || []) fn(ev); }
  reply(m) { setTimeout(() => this.emit("message", { data: JSON.stringify(m) }), 1); }
  close() { this.readyState = 3; }
  send(s) {
    const m = JSON.parse(s), p = m.payload || {}, id = m.clientMsgId, A = p.ctidTraderAccountId; LOG.push(m);
    switch (m.payloadType) {
      case 51: return;
      case 2100: return this.reply({ clientMsgId: id, payloadType: 2101, payload: {} });
      case 2102: return BAD_TOKEN ? this.reply({ clientMsgId: id, payloadType: 2142, payload: { errorCode: "CH_ACCESS_TOKEN_INVALID", description: "bad" } }) : this.reply({ clientMsgId: id, payloadType: 2103, payload: { ctidTraderAccountId: A } });
      case 2149: return this.reply({ clientMsgId: id, payloadType: 2150, payload: { ctidTraderAccount: [{ ctidTraderAccountId: 4242, isLive: false, traderLogin: 9001, brokerTitleShort: "IC Markets" }] } });
      case 2114: return this.reply({ clientMsgId: id, payloadType: 2115, payload: { ctidTraderAccountId: A, symbol: SYMS } });
      case 2116: return this.reply({ clientMsgId: id, payloadType: 2117, payload: { ctidTraderAccountId: A, symbol: [{ symbolId: p.symbolId[0], digits: 2, pipPosition: 2, minVolume: 100, stepVolume: 100, maxVolume: 1e7 }] } });
      case 2127: this.reply({ clientMsgId: id, payloadType: 2128, payload: { ctidTraderAccountId: A } });
        for (const s of p.symbolId) { this.reply({ payloadType: 2131, payload: { ctidTraderAccountId: A, symbolId: s, bid: 19990000 } }); this.reply({ payloadType: 2131, payload: { ctidTraderAccountId: A, symbolId: s, ask: 20000000 } }); }
        return;
      case 2129: return;
      case 2121: return this.reply({ clientMsgId: id, payloadType: 2122, payload: { trader: { ctidTraderAccountId: A, balance: 1234567, moneyDigits: 2, depositAssetId: 7, leverageInCents: 3000, traderLogin: 9001, brokerName: "IC Markets" } } });
      case 2112: return this.reply({ clientMsgId: id, payloadType: 2113, payload: { asset: [{ assetId: 7, name: "USD", displayName: "USD" }] } });
      case 2124: return this.reply({ clientMsgId: id, payloadType: 2125, payload: { ctidTraderAccountId: A, position: POS } });
      case 2106:
        if (REJECT) return this.reply({ clientMsgId: id, payloadType: 2132, payload: { ctidTraderAccountId: A, errorCode: REJECT, description: "nope" } });
        this.reply({ clientMsgId: id, payloadType: 2126, payload: { ctidTraderAccountId: A, executionType: "ORDER_ACCEPTED", order: { clientOrderId: p.clientOrderId, tradeData: { symbolId: p.symbolId, label: p.label } } } });
        POS.push({ positionId: 555, tradeData: { symbolId: p.symbolId, volume: p.volume, tradeSide: p.tradeSide, label: p.label, openTimestamp: Date.now() }, price: 200, stopLoss: 200 - p.relativeStopLoss / 1e5, takeProfit: 200 + p.relativeTakeProfit / 1e5 });
        return this.reply({ clientMsgId: id, payloadType: 2126, payload: { ctidTraderAccountId: A, executionType: 3, order: { clientOrderId: p.clientOrderId, tradeData: { symbolId: p.symbolId, label: p.label } }, position: { positionId: 555, price: 200.01 }, deal: { executionPrice: 200.01 } } });
      case 2111: { const x = POS.find(q => q.positionId === p.positionId); POS = POS.filter(q => q !== x);
        return this.reply({ clientMsgId: id, payloadType: 2126, payload: { ctidTraderAccountId: A, executionType: "ORDER_FILLED", position: { positionId: p.positionId }, deal: { executionPrice: 201.5 } } }); }
      default: return this.reply({ clientMsgId: id, payloadType: 2142, payload: { errorCode: "UNSUPPORTED" } });
    }
  }
}
const ENV = { CTRADER_CLIENT_ID: "id", CTRADER_CLIENT_SECRET: "sec", CTRADER_ACCESS_TOKEN: "tok", CTRADER_ACCOUNT_ID: "4242", TRADE_PIN: "correct horse", TRADE_MAX_USD: "5000" };
const deps = { WS: FakeWS, pinDelay: 0 };
function call(body, method = "POST", cfgEnv = ENV, headers = {}) {
  return new Promise(resolve => {
    const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, end(b) { resolve({ code: this.statusCode, body: JSON.parse(b) }); } };
    const req = { method, headers: { host: "uhe.test", ...headers }, body };
    handler(req, res, { ...deps, cfg: readConfig(cfgEnv) });
  });
}

test("symbol matching handles IC Markets naming styles", () => {
  const L = SYMS.map(s => ({ id: s.symbolId, name: s.symbolName, desc: s.description, enabled: true }));
  assert.equal(matchSymbol(L, "AAPL")[0].name, "AAPL.US");
  assert.equal(matchSymbol(L, "MSFT")[0].name, "Microsoft Corp (MSFT.O)");
  assert.equal(matchSymbol(L, "BRK.B")[0].name, "BRK_B.US");
  assert.equal(matchSymbol(L, "AAPL", { AAPL: "AAPLX" })[0].name, "AAPLX", "CTRADER_SYMBOLS pin wins");
  assert.equal(matchSymbol(L, "ZZZZ").length, 0);
  assert.equal(toVolume(10.4, { stepVolume: 100, minVolume: 100 }), 1000);
  assert.throws(() => toVolume(0.4, { stepVolume: 100, minVolume: 100 }), /minimum/);
  assert.equal(relDistance(3.004, 2), 300000);
});

test("GET shows configuration without secrets", async () => {
  const r = await call(undefined, "GET");
  assert.equal(r.code, 200); assert.equal(r.body.env, "demo"); assert.equal(r.body.ready, true);
  assert.ok(!JSON.stringify(r.body).includes("sec") && !JSON.stringify(r.body).includes("correct horse"));
  const s = status(readConfig({ TRADE_PIN: "short" })); assert.equal(s.ready, false); assert.equal(s.configured.pin, false);
});

test("PIN, origin and lock checks", async () => {
  assert.equal((await call({ action: "check", pin: "nope" })).code, 401);
  assert.equal((await call({ action: "check", pin: "correct horse" }, "POST", ENV, { origin: "https://evil.example" })).code, 403);
  assert.equal((await call({ action: "check", pin: "x" }, "POST", { ...ENV, TRADE_PIN: "" })).body.code, "NO_PIN");
  const nc = await call({ action: "account", pin: "correct horse" }, "POST", { TRADE_PIN: "correct horse" });
  assert.equal(nc.body.code, "NOT_CONFIGURED");
  assert.equal((await call({ action: "check", pin: "correct horse" }, "POST", ENV, { origin: "https://uhe.test" })).body.ok, true);
});

test("accounts, account + balance, find", async () => {
  const a = await call({ action: "accounts", pin: "correct horse" }); assert.equal(a.body.accounts[0].id, 4242);
  const b = await call({ action: "account", pin: "correct horse" }); assert.equal(b.body.account.balance, 12345.67); assert.equal(b.body.account.ccy, "USD"); assert.equal(b.body.account.leverage, 30);
  const f = await call({ action: "find", pin: "correct horse", symbol: "msft" }); assert.equal(f.body.matches[0].id, 102);
});

test("market order: size, stop, target capped at prior high, fill, then close", async () => {
  LOG = []; POS = [];
  const r = await call({ action: "order", pin: "correct horse", symbol: "AAPL", usd: 2000, slPct: 1.5, tpPct: 3, tpPrice: 204, mode: "day" });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true); assert.equal(r.body.status, "ORDER_FILLED");
  assert.equal(r.body.units, 10); assert.equal(r.body.fill, 200.01); assert.equal(r.body.positionId, 555);
  const o = LOG.find(m => m.payloadType === 2106).payload;
  assert.equal(o.orderType, 1); assert.equal(o.tradeSide, 1); assert.equal(o.volume, 1000); assert.equal(o.symbolId, 101);
  assert.equal(o.relativeStopLoss, 300000, "1.5% of 200 = 3.00"); assert.equal(o.relativeTakeProfit, 400000, "target capped at 204 (prior high), not +3%");
  const p = await call({ action: "positions", pin: "correct horse" }); assert.equal(p.body.positions.length, 1); assert.equal(p.body.positions[0].symbol, "AAPL.US");
  assert.equal(p.body.positions[0].units, 10); assert.ok(Math.abs(p.body.positions[0].pnl - (199.9 - 200) * 10) < 1e-6);
  const c = await call({ action: "close", pin: "correct horse", positionId: 555 }); assert.equal(c.body.ok, true); assert.equal(c.body.price, 201.5);
  assert.equal(LOG.find(m => m.payloadType === 2111).payload.volume, 1000);
});

test("order guards: cap, stop required, live confirm, broker rejection, bad token", async () => {
  assert.equal((await call({ action: "order", pin: "correct horse", symbol: "AAPL", usd: 9000, slPct: 1, tpPct: 2 })).body.code, "CAP");
  assert.equal((await call({ action: "order", pin: "correct horse", symbol: "AAPL", usd: 500, tpPct: 2 })).body.code, "NO_STOP");
  assert.equal((await call({ action: "order", pin: "correct horse", symbol: "AAPL", usd: 500, slPct: 1, tpPct: 2 }, "POST", { ...ENV, CTRADER_ENV: "live" })).body.code, "LIVE_CONFIRM");
  REJECT = "NOT_ENOUGH_MONEY";
  const r = await call({ action: "order", pin: "correct horse", symbol: "AAPL", usd: 500, slPct: 1, tpPct: 2 }); REJECT = null;
  assert.equal(r.body.code, "NOT_ENOUGH_MONEY"); assert.match(r.body.error, /margin/);
  BAD_TOKEN = true; const t = await call({ action: "account", pin: "correct horse" }); BAD_TOKEN = false;
  assert.equal(t.body.code, "CH_ACCESS_TOKEN_INVALID"); assert.match(t.body.error, /Playground/);
  assert.equal((await call({ action: "order", pin: "correct horse", symbol: "ZZZZ", usd: 500, slPct: 1, tpPct: 2 })).body.code, "NO_MATCH");
});

test("run() is usable directly", async () => {
  const r = await run("check", {}, readConfig(ENV), deps); assert.equal(r.ok, true);
});
