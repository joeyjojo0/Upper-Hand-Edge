// Server data-layer tests with a fake network (no internet needed):  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../../api/_lib/core.js";
import { applyLive, buildModel, autoBrief, briefPrompt, parseScan, nyOpenUKMin } from "../../public/model.js";

/* ---------------- fake Yahoo & friends ---------------- */
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const DAY = 86400, NOW = Math.floor(Date.now() / 1000);
function series(start, step, n, p0, vol, skipWeekend = true) {
  const t = [], o = [], h = [], l = [], c = [], v = []; let p = p0;
  for (let i = 0; i < n; i++) {
    const ts = start + i * step, wd = new Date(ts * 1000).getUTCDay();
    if (skipWeekend && (wd === 0 || wd === 6)) continue;
    const o1 = p; p = p * (1 + (rnd() - 0.5) * vol); const hi = Math.max(o1, p) * (1 + rnd() * vol / 3), lo = Math.min(o1, p) * (1 - rnd() * vol / 3);
    t.push(ts); o.push(o1); h.push(hi); l.push(lo); c.push(p); v.push(Math.round(1e6 * (0.5 + rnd())));
  }
  return { t, o, h, l, c, v };
}
function chartJSON(sym, range, interval) {
  const p0 = sym === "SPY" ? 660 : sym === "ES=F" ? 6650 : 100 + sym.length * 10;
  let s;
  if (interval === "1d") { const n = range === "1y" ? 365 : range === "6mo" ? 183 : range === "3mo" ? 92 : 14; s = series(NOW - n * DAY, DAY, n, p0, 0.02); }
  else if (interval === "15m") { const n = range === "60d" ? 60 * 96 : 5 * 96; const st = Math.floor((NOW - n * 900) / 900) * 900; s = series(st, 900, n, p0, 0.003); }
  else if (interval === "1m") { const st = Math.floor((NOW - 600 * 60) / 60) * 60; s = series(st, 60, 590, p0, 0.0005, false); if (sym.endsWith("=F")) { s.c = s.c.map((x, i) => (sym === "ES=F" ? 10.07 : 1) * 660 * (1 + i * 1e-5)); } else if (sym === "SPY") { s.c = s.c.map((x, i) => 660 * (1 + i * 1e-5)); } }
  else { const st = Math.floor((NOW - 78 * 300) / 300) * 300; s = series(st, 300, 78, p0, 0.001, false); }
  const last = s.c[s.c.length - 1];
  return { chart: { result: [{ meta: { symbol: sym, regularMarketPrice: last, chartPreviousClose: s.c[0], previousClose: s.c[0], regularMarketTime: s.t[s.t.length - 1], regularMarketDayHigh: Math.max(...s.h.slice(-20)), regularMarketDayLow: Math.min(...s.l.slice(-20)) }, timestamp: s.t, indicators: { quote: [{ open: s.o, high: s.h, low: s.l, close: s.c, volume: s.v }] } }], error: null } };
}
function quoteJSON(symbols) {
  return { quoteResponse: { result: symbols.map(sym => ({ symbol: sym, regularMarketPrice: 100, regularMarketPreviousClose: 99, regularMarketChangePercent: 1.0101, regularMarketTime: NOW - 5, regularMarketDayHigh: 101, regularMarketDayLow: 98, marketState: "PRE", preMarketPrice: 100.5, preMarketChangePercent: 0.5, preMarketTime: NOW - 2, exchangeDataDelayedBy: sym.endsWith("=F") ? 10 : 0, fiftyDayAverage: 95, twoHundredDayAverage: 90, marketCap: 5e11, averageDailyVolume3Month: 5e6, exchange: "NMS", fiftyTwoWeekHigh: 110, earningsTimestamp: NOW + 2 * DAY })) } };
}
const CSV = "Symbol,Security,GICS Sector,GICS Sub-Industry\nAAA,Alpha Inc,Information Technology,X\nBBB,Beta Corp,Financials,Y\nBRK.B,Berkshire Hathaway,Financials,Z\n";
let crumbOK = true, quoteOK = true, calls = [];
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); calls.push(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://fc.yahoo.com")) return new Response("", { status: 404, headers: { "set-cookie": "A3=d=abc; Path=/; Domain=.yahoo.com" } });
  if (url.includes("/v1/test/getcrumb")) return crumbOK ? new Response("crumb123", { status: 200 }) : new Response("Unauthorized", { status: 401 });
  if (url.includes("/v7/finance/quote")) { if (!quoteOK) return json({ finance: { error: "Unauthorized" } }, 401); const syms = decodeURIComponent(new URL(url).searchParams.get("symbols")).split(","); return json(quoteJSON(syms)); }
  if (url.includes("/v8/finance/chart/")) { const u = new URL(url), sym = decodeURIComponent(u.pathname.split("/").pop()); return json(chartJSON(sym, u.searchParams.get("range"), u.searchParams.get("interval"))); }
  if (url.includes("constituents.csv")) return new Response(CSV);
  if (url.includes("wikipedia.org")) { const rows = ["AAA", "NNN"].concat(Array.from({ length: 98 }, (_, i) => "Z" + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))); return json({ parse: { text: '<table id="constituents"><tr><th>Company</th><th>Ticker</th><th>GICS Sector</th></tr>' + rows.map(t => `<tr><td>${t} Co</td><td>${t}</td><td>Information Technology</td></tr>`).join("") + "</table>" } }); }
  if (url.includes("nasdaqlisted.txt")) { const L = ["Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares", "AAA|Alpha Inc - Common Stock|Q|N|N|100|N|N", "NNN|Enn Co - Class A Common Stock|Q|N|N|100|N|N", "QQQ|Invesco QQQ Trust|G|N|N|100|Y|N", "TSTX|Test Co|Q|Y|N|100|N|N", "ABCDW|Abc Corp - Warrant|Q|N|N|100|N|N", "BADD|Bad Co - Common Stock|Q|N|D|100|N|N", "PFDX|Pfd Co - 7.5% Series A Preferred Stock|Q|N|N|100|N|N"]; for (let i = 0; i < 1000; i++) L.push(`Q${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}|Q${i} Holdings - Common Stock|S|N|N|100|N|N`); L.push("File Creation Time: 1007202612:00|||||||"); return new Response(L.join("\n")); }
  if (url.includes("/v10/finance/quoteSummary/")) { const sym = decodeURIComponent(new URL(url).pathname.split("/").pop()); if (sym === "FAIL") return json({}, 404);
    return json({ quoteSummary: { result: [{ financialData: { currentPrice: { raw: 100 }, targetMeanPrice: { raw: 115, fmt: "115" }, recommendationMean: { raw: 1.8 }, recommendationKey: "buy", numberOfAnalystOpinions: { raw: 30 } },
      summaryDetail: { dividendYield: { raw: 0.031 }, exDividendDate: { raw: NOW + 20 * DAY } }, majorHoldersBreakdown: { institutionsPercentHeld: { raw: 0.72 } },
      recommendationTrend: { trend: [{ period: "0m", strongBuy: 10, buy: 12, hold: 6, sell: 1, strongSell: 1 }] }, calendarEvents: { earnings: { earningsDate: [{ raw: NOW + 6 * DAY }] } },
      fundOwnership: { ownershipList: [{ organization: "Vanguard Total Stock Market Index Fund", pctHeld: { raw: 0.031 } }, { organization: "SPDR S&P 500 ETF Trust", pctHeld: { raw: 0.012 } }, { organization: "Fidelity Contrafund", pctHeld: { raw: 0.01 } }] } }] } }); }
  if (url.includes("/v1/finance/search")) return json({ news: [{ title: "Acme beats estimates and raises guidance", publisher: "Wire", providerPublishTime: NOW - 3600, link: "https://x/1" }, { title: "Acme faces probe over accounting", publisher: "Wire", providerPublishTime: NOW - 4 * DAY }, { title: "Acme stock: what to know", publisher: "Blog", providerPublishTime: NOW - 7200 }] });
  if (url.includes("sec.gov/files/company_tickers.json")) return json({ 0: { cik_str: 320193, ticker: "AAA", title: "Alpha" }, 1: { cik_str: 1067983, ticker: "BRK-B", title: "Berkshire" } });
  if (url.includes("data.sec.gov/submissions/CIK0000320193.json")) { const d = n => new Date(Date.now() - n * DAY * 1000).toISOString().slice(0, 10);
    return json({ filings: { recent: { form: ["8-K", "4", "424B5", "SC 13D", "10-Q"], filingDate: [d(0), d(1), d(2), d(3), d(30)], items: ["2.02,9.01", "", "", "", ""], accessionNumber: ["0000320193-26-000001", "a", "b", "c", "d"], primaryDocument: ["x8k.htm", "f4.xml", "p.htm", "s.htm", "q.htm"], acceptanceDateTime: [new Date().toISOString(), "", "", "", ""] } } }); }
  if (url.includes("finnhub.io/api/v1/news")) return json([{ headline: "Stocks rally as yields ease", source: "CNBC", datetime: NOW - 600, url: "https://x/w1", related: "" }, { headline: "Oil slumps on supply", source: "Reuters", datetime: NOW - 1200, url: "https://x/w2", related: "" }]);
  if (url.includes("apewisdom.io")) return json({ count: 3, pages: 1, current_page: 1, results: [{ rank: 1, ticker: "AAA", name: "Alpha", mentions: "120", upvotes: "900", rank_24h_ago: "5", mentions_24h_ago: "30" }, { rank: 2, ticker: "BBB", name: "Beta", mentions: "40", upvotes: "100", rank_24h_ago: "1", mentions_24h_ago: "80" }, { rank: 3, ticker: "ZZZ", name: "Z", mentions: "3", upvotes: "1", rank_24h_ago: "9", mentions_24h_ago: "1" }] });
  if (url.includes("stocktwits") && url.includes("trending")) return json({ symbols: [{ symbol: "AAA", title: "Alpha Inc", watchlist_count: 5000 }, { symbol: "QQQQ", title: "Q", watchlist_count: 10 }] });
  if (url.includes("stocktwits")) return json({ symbol: { watchlist_count: 1234 }, messages: [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: i, entities: { sentiment: i <= 5 ? { basic: "Bullish" } : i === 6 ? { basic: "Bearish" } : null } })) });
  if (url.includes("cdn.finra.org")) { const rows = ["Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market"]; for (const s of ["SPY", "QQQ", "DIA", "IWM", "GLD", "TLT", "HYG", "XLF", "XLK", "SMH"]) rows.push(`x|${s}|${Math.round(5e5 + rnd() * 1e5)}|0|1000000|B,Q,N`); return new Response(rows.join("\n") + "\n" + "#".repeat(1200)); }
  if (url.includes("publicreporting.cftc.gov")) { const out = []; for (let w = 0; w < 60; w++) for (const code of Object.values(core.COT_CODES)) out.push({ report_date_as_yyyy_mm_dd: new Date((NOW - (60 - w) * 7 * DAY) * 1000).toISOString().slice(0, 10) + "T00:00:00.000", cftc_contract_market_code: code, market_and_exchange_names: "TEST - CME", noncomm_positions_long_all: String(1000 + w * 10), noncomm_positions_short_all: "900", open_interest_all: "5000" }); return json(out); }
  if (url.includes("faireconomy")) return json([{ title: "CPI m/m", country: "USD", date: "2026-09-29T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" }, { title: "Bank Holiday", country: "JPY", date: "2026-09-30T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "" }, { title: "Low thing", country: "USD", date: "2026-09-29T10:00:00-04:00", impact: "Low" }]);
  return json({ error: "unexpected " + url }, 404);
};

/* ---------------- tests ---------------- */
test("markets(): every instrument gets sessions, levels and NY-open stats", async () => {
  const m = await core.markets();
  assert.equal(m.instruments.length, 24);
  assert.deepEqual(m.errors, []);
  const x = m.instruments.find(i => i.id === "US500");
  for (const k of ["px", "adr", "atr", "rsi", "sma20", "sma50", "hi20", "lo20", "spark"]) assert.ok(x[k] != null, "missing " + k);
  assert.ok(x.adr > 0 && x.st.n > 20, "stats computed");
  assert.ok(x.pd && x.piv && x.piv.r1 > x.piv.s1);
  assert.equal(m.context.length, 6);
});

test("liveQuotes(): v7 quotes with crumb, ETF prices use the latest session", async () => {
  crumbOK = true;
  const q = await core.liveQuotes();
  assert.equal(q.mode, "quote");
  assert.equal(Object.keys(q.inst).length, 24);
  assert.equal(q.inst.US500.delay, 10);
  assert.equal(q.etf.SPY.px, 100.5, "pre-market print is newer than the regular close");
  assert.ok(q.ctx.VIX);
});

test("liveQuotes(): falls back to chart metadata when the crumb is refused", async () => {
  crumbOK = false; quoteOK = false;
  const q = await core.liveQuotes();
  assert.equal(q.mode, "chart-meta");
  assert.ok(Object.keys(q.inst).length === 24 && typeof q.inst.EURUSD.chgd === "number");
  crumbOK = true; quoteOK = true; await core.crumb(true);
});

test("basis(): futures/ETF ratio from aligned 1-minute bars", async () => {
  const b = await core.basis();
  assert.ok(b.pairs.US500, "US500 pair present");
  assert.ok(Math.abs(b.pairs.US500.ratio - 10.07) < 1e-6);
  assert.equal(Object.keys(b.pairs).length, 7);
});

test("scanHist() + scanLive(): scores, breadth and the heat-map rows", async () => {
  const H = await core.scanHist();
  assert.equal(H.n, 1102, "S&P 500 (3) + Nasdaq-100 (100) + 1000 Nasdaq-only, AAA in all three");
  assert.equal(H.rows.find(r => r.s === "AAA").u, "SNQ"); assert.equal(H.rows.find(r => r.s === "NNN").u, "NQ");
  assert.equal(H.rows.find(r => r.s === "QAAA").u, "Q"); assert.equal(H.rows.find(r => r.s === "QAAA").sec, 11);
  for (const bad of ["QQQ", "TSTX", "ABCDW", "BADD", "PFDX"]) assert.ok(!H.rows.find(r => r.s === bad), bad + " filtered out");
  assert.equal(H.rows.find(r => r.s === "BRK.B").y, "BRK-B");
  const L = await core.scanLive(H);
  assert.equal(L.breadth.n, 3, "headline breadth stays S&P 500"); assert.equal(L.ndx.breadth.n, 100); assert.equal(L.nasdaq.breadth.n, 1100);
  assert.equal(L.moveLabel, "Pre-market");
  assert.equal(L.map.length, 1102);
  const parts = L.map[0].split("|"); assert.equal(parts.length, 12); assert.equal(parts[10], "NASDAQ");
  assert.equal(L.map.find(l => l.startsWith("QAAA|")).split("|")[11], "Q");
  assert.equal(L.er.length, 3, "earnings within 7 days are listed");
  const sp = parseScan(L); assert.equal(sp.rows.length, 3); assert.equal(sp.rows[0].tv, "NASDAQ");
  assert.equal(parseScan(L, "ndx").rows.length, 100); assert.equal(parseScan(L, "nasdaq").rows.length, 1100); assert.equal(parseScan(L, "all").rows.length, 1102);
  assert.equal(parseScan(L, "nasdaq").names[11], "Other Nasdaq");
});

test("strategy data: RSI history, KST, fundamentals, news", async () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3));
  const rs = core.rsiSeries(c); assert.equal(rs.length, 80); assert.equal(rs[10], null); assert.ok(Math.abs(rs[79] - core.rsi(c)) < 1e-9, "series ends at rsi()");
  const k = core.kstSeries(c); assert.equal(k.kst[40], null); assert.ok(k.kst[79] > 0 && k.sig[79] != null, "rising series has positive KST");
  const H = await core.scanHist(); const a = H.rows.find(r => r.s === "AAA");
  assert.equal(a.rsi5.length, 5); assert.equal(a.kst5.length, 5); assert.equal(typeof a.sma20up, "boolean");
  const F = await core.fundamentalsFor(["AAA", "FAIL"]); const f = F.stocks.AAA;
  assert.equal(F.fails, 1); assert.equal(f.rm, 1.8); assert.equal(f.na, 30); assert.equal(f.up, 15); assert.equal(f.dy, 3.1); assert.equal(f.inst, 72);
  assert.equal(f.etfN, 2, "Vanguard index fund + SPDR ETF, not Contrafund"); assert.equal(f.sb, 10); assert.ok(f.erd);
  process.env.FINNHUB_KEY = "test"; const N = await core.newsFor(["AAA"]); const n = N.stocks.AAA;
  assert.equal(n.n48, 2); assert.equal(n.tone48, 1); assert.equal(n.n7, 3); assert.equal(n.tone7, 0); assert.equal(n.items[0].s, 1);
  assert.deepEqual(n.st, { bull: 5, bear: 1, n: 7, watch: 1234 }); assert.equal(N.stocktwits, true);
  assert.equal(core.headlineTone("Shares plunge after downgrade"), -1); assert.equal(core.headlineTone("Record quarter"), 1);
  // SEC EDGAR: earnings 8-K, insider Form 4, share offering (dilution) and a 13D stake; the 30-day-old 10-Q is outside the window
  assert.equal(N.sec, true); assert.equal(n.sec.length, 4); assert.equal(n.sec[0].k, "earn"); assert.match(n.sec[0].l, /Earnings release/);
  assert.equal(n.sec[0].u, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/x8k.htm");
  assert.deepEqual(n.secf, { dil: true, red: false, act: true, ins: 1, n: 3 });
  assert.equal(core.pubTier("Reuters"), "pro"); assert.equal(core.pubTier("Motley Fool"), "op"); assert.equal(core.pubTier("Some Blog"), "");
  assert.equal(core.classifyFiling("8-K", "4.02").k, "red"); assert.equal(core.classifyFiling("S-3ASR").k, "dil"); assert.equal(core.classifyFiling("DEF 14A"), null);
  const P = await core.pulse();
  assert.equal(P.wire.length, 2); assert.equal(P.wire[0].src, "CNBC"); assert.deepEqual(P.reddit.AAA, [1, 120, 30, 900, 5]);
  assert.deepEqual(P.redditTop.map(x => x.s), ["AAA", "BBB"], "ZZZ has too few mentions"); assert.equal(P.redditTop[0].x, 4);
  assert.equal(P.stTrend[0].s, "AAA");
});

test("finra(), cot(), calendar() parse the public files", async () => {
  const f = await core.finra(); assert.equal(f.rows.length, 10); assert.ok(typeof f.rows[0].z === "number");
  const c = await core.cot(); assert.ok(c.report); assert.equal(c.rows.find(r => r.k === "EUR").pct, 100);
  const cal = await core.calendar(); assert.equal(cal.items.length, 2); assert.equal(cal.items[0].t, "13:30"); assert.equal(cal.items[1].t, "All day");
});

test("handle(): caching headers on success, no-store on failure", async () => {
  const mk = () => { const h = {}; return { h, setHeader: (k, v) => { h[k] = v; }, end(b) { this.body = b; } }; };
  const ok = mk(); await core.handle(async () => ({ a: 1 }), 5, 30)({ headers: {} }, ok);
  assert.equal(ok.statusCode, 200); assert.match(ok.h["Cache-Control"], /s-maxage=5, stale-while-revalidate=30/);
  const bad = mk(); await core.handle(async () => { throw new Error("boom"); }, 5, 30)({ headers: {} }, bad);
  assert.equal(bad.statusCode, 502); assert.equal(bad.h["Cache-Control"], "no-store"); assert.match(bad.body, /boom/);
});

test("model: live overlay, ETF nowcast, scoring and briefs", async () => {
  const mk = await core.markets();
  const x = mk.instruments.find(i => i.id === "US500");
  const q = { inst: { US500: { px: x.px, t: NOW, delay: 10 } }, ctx: {}, etf: { SPY: { px: 700, t: NOW - 3 } } };
  const bs = { pairs: { US500: { ratio: 11, t: NOW - 600 } } };
  const L = applyLive(mk, q, bs);
  assert.equal(L.instruments.find(i => i.id === "US500").px, 7700);
  assert.equal(L.live.US500.src, "etf");
  const stale = applyLive(mk, { ...q, etf: { SPY: { px: 700, t: NOW - 3600 } } }, bs);
  assert.equal(stale.live.US500.src, "quote", "stale ETF price falls back to the futures quote");
  const M = buildModel({ ...L, cot: null, finra: null }, null);
  assert.equal(M.rows.length, 24);
  for (const r of M.rows) assert.ok(r.score >= 0 && r.score <= 100);
  assert.match(autoBrief(M, null, null).text, /## Best setups/);
  assert.match(briefPrompt(M, null, null), /Tone, Best setups/);
  assert.ok([810, 870].includes(nyOpenUKMin("2026-10-27")) && nyOpenUKMin("2026-10-27") === 810, "US/UK DST gap week");
});
