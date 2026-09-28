const F = process.env.FINNHUB_KEY || "", TD = process.env.TWELVEDATA_KEY || "";
const now = Math.floor(Date.now() / 1000), wk = now - 7 * 86400;
const T = [
  ["yahoo chart", "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=5m"],
  ["fh quote SPY", `https://finnhub.io/api/v1/quote?symbol=SPY&token=${F}`],
  ["fh quote OANDA EURUSD", `https://finnhub.io/api/v1/quote?symbol=OANDA:EUR_USD&token=${F}`],
  ["fh stock candle SPY 15m", `https://finnhub.io/api/v1/stock/candle?symbol=SPY&resolution=15&from=${wk}&to=${now}&token=${F}`],
  ["fh forex candle EURUSD 15m", `https://finnhub.io/api/v1/forex/candle?symbol=OANDA:EUR_USD&resolution=15&from=${wk}&to=${now}&token=${F}`],
  ["fh crypto candle BTC 15m", `https://finnhub.io/api/v1/crypto/candle?symbol=BINANCE:BTCUSDT&resolution=15&from=${wk}&to=${now}&token=${F}`],
  ["fh forex symbols OANDA", `https://finnhub.io/api/v1/forex/symbol?exchange=oanda&token=${F}`],
  ["td EUR/USD 15min", `https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=15min&outputsize=3&apikey=${TD}`],
  ["td SPY 1day", `https://api.twelvedata.com/time_series?symbol=SPY&interval=1day&outputsize=3&apikey=${TD}`],
  ["td XAU/USD quote", `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${TD}`],
  ["td SPX index", `https://api.twelvedata.com/time_series?symbol=SPX&interval=1day&outputsize=3&apikey=${TD}`],
  ["td FTSE index", `https://api.twelvedata.com/time_series?symbol=UKX&interval=1day&outputsize=3&apikey=${TD}`],
  ["td batch quote", `https://api.twelvedata.com/quote?symbol=AAPL,MSFT,GBP/USD&apikey=${TD}`],
  ["td usage", `https://api.twelvedata.com/api_usage?apikey=${TD}`]
];
export default async function handler(req, res) {
  const out = await Promise.all(T.map(async ([name, url]) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" }, signal: AbortSignal.timeout(12000) });
      let body = (await r.text()).replace(F || "\u0000", "KEY").replace(TD || "\u0000", "KEY");
      return { name, status: r.status, ms: Date.now() - t, bytes: body.length, body: body.slice(0, 220) };
    } catch (e) { return { name, error: String(e.message || e), ms: Date.now() - t }; }
  }));
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ region: process.env.VERCEL_REGION || null, finnhubKey: !!F, twelveDataKey: !!TD, results: out }, null, 1));
}
