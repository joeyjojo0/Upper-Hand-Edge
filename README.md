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

## Local development

```bash
npm run dev:mock   # offline: mock data from saved snapshots, prices random-walk (http://localhost:3000)
npm run dev        # real data (needs internet access to the sources above)
npm test           # server data-layer tests with a fake network
```

UI smoke test (Playwright for Python): start `MOCK=1 PORT=3100 node dev/server.mjs`, then `python3 dev/ui/shots.py`.

## Project layout

```
api/_lib/core.js   data layer: Yahoo, FINRA, CFTC, calendar, S&P scanner, caching helpers
api/*.js           one serverless function per endpoint
public/index.html  page markup
public/styles.css  glass UI
public/model.js    shared scoring, playbooks, live overlay and briefs (browser + /api/brief)
public/app.js      live polling, rendering, TradingView embeds, journal, snapshot
dev/               local server, mock API, fixtures, tests
```

## Notes

- Yahoo's endpoints are unofficial and can rate-limit or change. The quote path falls back from the batch quote API to per-symbol chart metadata; if Yahoo blocks the deployment's IPs for long, a keyed provider can be swapped into `api/_lib/core.js`.
- The journal, model weights and snapshots live in your browser's local storage. Use **Export backup** to move them to another device.
- The score ranks setups. It does not predict price and it is not investment advice.
