# Upper Hand Edge · NY Open Command

A live, 24/7 glass-style dashboard for trading the **New York open (14:30 UK)** across US and European indices, forex majors and crosses, gold, silver, oil, crypto and all **S&P 500** stocks. Every market gets a transparent 0–100 edge score, a NY-open playbook (trigger, stop, two targets) and the history behind it.

It runs as a small website on Vercel: static front end in `public/`, serverless data functions in `api/`. No database and no paid data feed.

## What's on the page

| Section | What it gives you | Refresh |
| --- | --- | --- |
| Countdown, regime, next events, session timeline | Time to the NY open (DST-aware), risk tone from US futures, VIX curve, dollar, yields, Asia | every second / 5 s |
| **Top edges** | The four highest-conviction markets with trigger and first target | ticks every 5 s, re-ranked each minute |
| **Pre-open snapshot** | At 14:20 UK (10 min before the open) the page refreshes every feed and freezes the top setups, then grades each one against the live price. Optional browser alert. | 14:20 UK |
| **Live chart** | TradingView chart for any market, CFD (real-time) or the futures contract the levels are built on | streaming |
| **Markets** | 24 cards with live price, source badge, sparkline, ADR used, London drive; tap for the full drawer with live chart, playbook, key-level ladder, NY first-hour stats, COT and FINRA context | 5 s |
| **S&P 500 scanner** | Breadth, cap-weighted heat map (pre-market / today / after hours, last session, edge score) or TradingView's live heat map, stocks in play, long and short setups, sectors, earnings in the next 7 days; tap any stock for its opening plan and live chart | 60 s |
| **Strategy** (`/strategy`) | Your day-trade and long-term checklists scored on every stock (S&P 500, Nasdaq-100, all Nasdaq or your watchlist), with a plan per stock and one-click IC Markets (cTrader) orders behind a PIN. See "Strategy & IC Markets trading" below | 2–30 min |
| **NY open brief** | Auto brief built from the live model; optionally written by Claude | 1 min / 30 min |
| Edge lab, positioning & flow, calendar | First-hour behaviour over ~55 sessions, CFTC speculator positioning, FINRA off-exchange short share (DIX-style), this week's high/medium impact events | 2 min / 3 h / 15 min |
| Journal & model | R-based trade journal with equity curve, adjustable model weights. Saved in your browser, with export and import | instant |

## Data and latency

| Source | Used for |
| --- | --- |
| Yahoo Finance (unofficial chart and quote endpoints) | Live quotes, 15-minute session bars, daily bars, S&P 500 quotes and history |
| TradingView widgets | Ticker tape, live charts, live S&P 500 heat map (keep their attribution) |
| CFTC Commitments of Traders | Weekly speculator positioning |
| FINRA Reg SHO daily files | Off-exchange short volume for SPY, QQQ, DIA, IWM, GLD, TLT, HYG, XLF, XLK, SMH |
| Forex Factory weekly export | Economic calendar |
| datasets/s-and-p-500-companies | Index members and sectors |

Forex and crypto quotes are real-time. **CME futures (US indices, gold, silver, oil) are delayed about 10 minutes on free feeds**, and FTSE / DAX / Euro Stoxx about 15. To keep the NY open live, the dashboard **nowcasts** the futures from real-time ETFs while US stocks trade (09:00–01:00 UK): `future ≈ ETF price × (future / ETF)` with the ratio measured on the latest 1-minute bar both traded (SPY→ES, QQQ→NQ, DIA→YM, IWM→RTY, GLD→GC, SLV→SI, USO→CL). Each card shows its source: `Live`, `Live · SPY`, `10m delay` or `Closed`. The TradingView tape and charts stream real-time CFD prices throughout.

Levels for US indices, gold, silver and oil are on the front-month futures, so a broker CFD can sit a few points away. Use the drawer's "Futures · levels" chart to see them on the exact contract.

## Deploy (about 2 minutes)

1. Go to [vercel.com/new](https://vercel.com/new), sign in with GitHub and **Import** `joeyjojo0/Upper-Hand-Edge`.
2. Leave the settings as they are (Framework preset: **Other**, no build command; `vercel.json` sets the output folder to `public`). Click **Deploy**.
3. Open `https://<your-project>.vercel.app/api/health`. `"ok": true` means the deployment can reach Yahoo Finance. Then open the site.

Optional environment variables (Project → Settings → Environment Variables, then redeploy):

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Turns on the Claude-written NY open brief (built server-side from the dashboard's own data, cached 30 minutes). Without it the auto brief is used. |
| `ANTHROPIC_MODEL` | Claude model id for the brief. Defaults to `claude-sonnet-4-5`. |

The site works on the free Hobby plan. Every `api/` response is cached at Vercel's edge (quotes 4 s, basis 60 s, markets 5 min, S&P scan 60 s, S&P history 3 h, calendar 15 min, flow 6 h), so many open tabs still make only a handful of upstream calls, and nothing is fetched while nobody is viewing.

Or from a terminal: `npx vercel --prod`.

## API

| Endpoint | Returns | Edge cache |
| --- | --- | --- |
| `/api/quotes` | Live quotes for the 24 markets, 6 context series (DXY, US10Y, VIX, VIX3M, Nikkei, Hang Seng) and the 7 nowcast ETFs | 4 s |
| `/api/basis` | Futures/ETF ratios for the nowcast | 60 s |
| `/api/markets` | Sessions (Asia, London, NY), prior day, pivots, week open, ADR/ATR/RSI/SMAs and first-hour NY statistics | 5 min |
| `/api/scan` | Live S&P 500 scanner (breadth, sectors, lists, heat-map rows, earnings) | 60 s |
| `/api/scan-hist` | Daily-bar metrics for every member (used by `/api/scan`) | 3 h |
| `/api/flow` | CFTC COT + FINRA short volume | 6 h |
| `/api/calendar` | This week's events in UK time | 15 min |
| `/api/brief` | Claude brief (if `ANTHROPIC_API_KEY` is set) | 30 min |
| `/api/health` | Connectivity check | none |
| `/api/trade` | IC Markets (cTrader) bridge. `GET` shows what's configured; `POST {action, pin}` with `account`, `accounts`, `find`, `order`, `positions`, `close` | none |

## Local development

```bash
npm run dev:mock   # offline: mock data from saved snapshots, prices random-walk (http://localhost:3000)
npm run dev        # real data (needs internet access to the sources above)
npm test           # server data-layer tests with a fake network
```

UI smoke tests (Playwright for Python): start `MOCK=1 PORT=3100 node dev/server.mjs`, then `python3 dev/ui/shots.py` and `python3 dev/ui/strategy.py` (mock trading PIN: `demo-pin-123`).

## Project layout

```
api/_lib/core.js   data layer: Yahoo, FINRA, CFTC, calendar, S&P scanner, caching helpers
api/*.js           one serverless function per endpoint
public/index.html  page markup
public/styles.css  glass UI
public/model.js    shared scoring, playbooks, live overlay and briefs (browser + /api/brief)
public/app.js      live polling, rendering, TradingView embeds, journal, snapshot
public/strategy.*  Strategy page; strategy-model.js holds the checklist rules (shared with the tests)
api/_lib/ctrader.js  cTrader Open API client (JSON over WebSocket) used by api/trade.js
dev/               local server, mock API, fixtures, tests
```

## Notes

- Yahoo's endpoints are unofficial and can rate-limit or change. The quote path falls back from the batch quote API to per-symbol chart metadata; if Yahoo blocks the deployment's IPs for long, a keyed provider can be swapped into `api/_lib/core.js`.
- The journal, model weights and snapshots live in your browser's local storage. Use **Export backup** to move them to another device.
- The score ranks setups. It does not predict price and it is not investment advice.

## Earth View

`/earth` embeds [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT, by Bilawal Sidhu) inside the UHE shell. It needs its own Node server for its live-data proxies, so it runs as a separate free Render service:

1. Fork `bilawalsidhu/gods-eye-view`. In `build/vite.js`, replace the two header lines under `headers: {` with
   ``'Content-Security-Policy': `frame-ancestors 'self' ${process.env.GEV_FRAME_ANCESTORS || ''}`.trim(),``
2. Render → New Web Service → the fork. Build `npm ci && npm run build`, start `npx vite preview --host 0.0.0.0 --port $PORT`, env `HOST=0.0.0.0`, `PUPPETEER_SKIP_DOWNLOAD=true`, `GEV_FRAME_ANCESTORS=https://upper-hand-edge.vercel.app`.
3. In Vercel set `EARTH_VIEW_URL` to the Render URL and redeploy.

Free Render services sleep when idle; the page shows a loader while it wakes (up to a minute).


## Strategy & IC Markets trading

The Strategy page (`/strategy`) scores every stock against two checklists. A tick means that signal lines up on public data; it is not a prediction.

**Day trade** (around the New York open, 14:30 UK; 13:30 for the two weeks a year when the UK and US clocks change on different dates):
RSI 50–72 and rising · volume above its 20-day average · positive headline tone or bullish StockTwits · big institutions or index ETFs hold it · price above the 20-day, 20-day above the 50-day and rising · more call volume than puts · analysts at Buy or better.
Plan: pre-market check at 14:00, buy the 14:30 open or the first dip that reclaims yesterday's close, take 1–3% and sell before yesterday's high.

**Long term:** RSI ≥ 50 on each of the last 5 days · KST above its signal on each of the last 5 days · earnings 2–10 days away (the week-before buying window) with no bad news · institutions/index ETFs hold it · more call open interest than puts · analysts at Buy with target upside · dividend yield ≥ 2.5%.

Every threshold can be changed under **Rules & thresholds** (saved in your browser).

### News and retail sources

| Layer | Source | What it adds |
| --- | --- | --- |
| Primary source | **SEC EDGAR** filings (free) | 8-K events (earnings, deals, restatements, delisting notices), share offerings (S-1/S-3/424B: dilution warning), 13D/13G big stakes, Form 4 insider filings, with links to the filing |
| Newswires | **Yahoo Finance** headlines | Reuters, Dow Jones/MarketWatch, Business Wire, GlobeNewswire, PR Newswire, Benzinga and more. Major wires count 1.5× in the tone score, opinion sites (Motley Fool, Zacks…) 0.5× |
| Market wire | **Finnhub** general news (uses `FINNHUB_KEY`) | Market-wide headlines for the Market pulse panel |
| Retail crowd | **Reddit** via ApeWisdom | Mention counts and 24-hour change across r/wallstreetbets, r/stocks and other stock subreddits |
| Retail crowd | **StockTwits** | Bullish/bearish tags per stock and the trending list |

The **News & retail** tick passes on positive wire tone, bullish StockTwits, a Reddit mention spike (1.5× the day before, 10+ mentions) or a new 13D stake, and fails on negative tone, bearish StockTwits, a share offering in the last 5 days or a red-flag 8-K. The Market pulse panel also links the desks pros keep open (FinancialJuice, Benzinga Pro, EDGAR latest filings, Finviz news, ApeWisdom, StockTwits).

Add a GitHub secret `SEC_CONTACT` with a contact email: the SEC asks automated users to identify themselves and may block requests without it.

Data comes from new data-engine jobs: `fund` (analysts, fund holders, dividends, earnings date; twice a day), `news` (headlines, SEC filings and StockTwits for a technical shortlist plus Reddit/StockTwits trending names; hourly, every ~20 min from 12:00–15:30 UK), `pulse` (market wire, Reddit, StockTwits trending; every run) and the existing `scan`, `deep` and `options` jobs. KST and 5-day RSI arrive with the next `scan-hist` run.

### Connect IC Markets (cTrader Open API)

Only **cTrader** accounts have an API that the site can use. MT4/MT5 accounts can't be connected this way; you can add a cTrader account (demo or live) in the IC Markets client area.

1. Sign in at **https://openapi.ctrader.com** with your cTrader ID and create an application. Approval can take a little while.
2. When it's approved, open the app's **Playground**, choose the **trading** scope and press **Get token**. Copy the access token.
3. In Vercel → your project → Settings → Environment Variables, add:

| Variable | Value |
| --- | --- |
| `CTRADER_CLIENT_ID` | the app's Client ID |
| `CTRADER_CLIENT_SECRET` | the app's Secret |
| `CTRADER_ACCESS_TOKEN` | the Playground access token (lasts ~30 days) |
| `CTRADER_ENV` | `demo` to start (`live` later) |
| `TRADE_PIN` | a passphrase of 8+ characters you'll type to unlock trading |
| `TRADE_MAX_USD` | largest order you allow, e.g. `1000` (default 2000) |
| `CTRADER_ACCOUNT_ID` | leave empty for now |

4. Redeploy, open `/strategy`, type your PIN in the IC Markets panel and press **Find my account IDs**. Put the demo account's ID into `CTRADER_ACCOUNT_ID` and redeploy again.
5. Unlock with your PIN. You'll see the balance and open positions. Press **Buy** on any stock, check the ticket, and send a demo order. Use **Check IC symbol** if a ticker doesn't match IC's naming; you can pin a name with `CTRADER_SYMBOLS`, e.g. `{"AAPL":"AAPL.US"}`.
6. Once demo orders, stops and targets look right in cTrader, switch `CTRADER_ENV` to `live`, set `CTRADER_ACCOUNT_ID` to the live account and redeploy. Live orders need an extra "real money" tick on every ticket.

Safety rules built into `/api/trade`: every action needs the PIN (wrong PINs are slowed down); market buy orders only; a stop loss is always attached; one order is capped at `TRADE_MAX_USD`; at most 6 orders a minute; requests from other websites are refused; secrets never leave Vercel. The access token expires after about 30 days: get a new one from the Playground and update `CTRADER_ACCESS_TOKEN`.
