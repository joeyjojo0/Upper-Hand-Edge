// UHE Strategy page: Joey's day-trade and long-term checklists on every scanned stock,
// plus a PIN-locked IC Markets (cTrader) order ticket. Data comes from the GitHub data engine (/data/*).
import { fp, isNum, UK, NY, fmtT } from "./model.js";
import { normRules, DAY_RULES, LONG_RULES, rank, dayPhase } from "./strategy-model.js";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
};
const money = (x, ccy = "$") => isNum(x) ? (x < 0 ? "−" : "") + ccy + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const pct = (x, d = 1) => isNum(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%" : "—";
const ago = iso => { if (!iso) return "—"; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
function toast(msg, ms = 3800) { const t = $("#toast"); t.innerHTML = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }

const S = {
  mode: ["day", "long"].includes(store.get("uhe.strat.mode")) ? store.get("uhe.strat.mode") : "day",
  u: ["S", "N", "Q", "W"].includes(store.get("uhe.strat.u")) ? store.get("uhe.strat.u") : "S",
  min: [0, 4, 5, 6, 7].includes(store.get("uhe.strat.min")) ? store.get("uhe.strat.min") : 5,
  q: "", rules: normRules(store.get("uhe.strat", {})), D: {}, feeds: {}, show: 60, open: null,
  pin: null, broker: null, acct: null, acctErr: "", lastPhase: null
};

/* ---------------- clocks ---------------- */
const clocks = () => { $("#clkUK").textContent = fmtT(new Date(), UK); $("#clkNY").textContent = fmtT(new Date(), NY); };
clocks(); setInterval(clocks, 1000);

/* ---------------- data feeds ---------------- */
const FEEDS = {
  deep: { url: "/data/deep.json", every: 120e3, name: "Scan" },
  options: { url: "/data/options.json", every: 300e3, name: "Options" },
  fund: { url: "/data/fund.json", every: 1800e3, name: "Analysts & holders" },
  news: { url: "/data/news.json", every: 300e3, name: "News" }
};
async function load(k) {
  try {
    const r = await fetch(FEEDS[k].url, { cache: "no-cache" }); if (!r.ok) throw new Error("HTTP " + r.status);
    S.D[k] = await r.json(); S.feeds[k] = "ok";
  } catch (e) { S.feeds[k] = S.D[k] ? "stale" : "missing"; }
}
function renderChips() {
  $("#feedChips").innerHTML = Object.entries(FEEDS).map(([k, f]) => {
    const st = S.feeds[k], d = S.D[k], cls = st === "ok" ? "ok" : st === "stale" ? "warn" : st === "missing" ? "bad" : "";
    const txt = st === "missing" ? (k === "fund" || k === "news" ? "after next engine run" : "not loaded") : d && d.asOf ? fmtT(new Date(d.asOf), UK) : "…";
    return `<span class="chip ${cls}" title="${esc(f.name)}${d && d.asOf ? " · updated " + ago(d.asOf) : ""}"><span class="dot"></span>${esc(f.name)} ${esc(txt)}</span>`;
  }).join("");
  const live = $("#liveChip"), ok = S.feeds.deep === "ok";
  live.className = "live" + (ok ? " on" : ""); live.querySelector("span").textContent = ok ? "STRATEGY" : "WAITING";
}

/* ---------------- phase card ---------------- */
function renderPhase() {
  const ph = dayPhase(new Date()), steps = [["pre", "Pre-market check", "Ticks + gap up on volume"], ["open", "Open", "Buy strength or wait for the first dip"], ["session", "Dip-buys", "Reclaim of yesterday's close · sell before prior high"]];
  const at = steps.findIndex(s => s[0] === ph.k);
  $("#phase").innerHTML = `<div class="eyebrow">Day-trade routine · UK time</div><div class="ph-title">${esc(ph.t)}</div><p class="ph-d">${esc(ph.d)}</p>
    <ol class="ph-steps">${steps.map((s, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><b>${esc(s[1])}</b><span>${esc(s[2])}</span></li>`).join("")}</ol>`;
  if (S.lastPhase && S.lastPhase !== ph.k && (ph.k === "pre" || ph.k === "open")) notifyPhase(ph);
  S.lastPhase = ph.k;
}
function notifyPhase(ph) {
  if (!store.get("uhe.notify", false) || !("Notification" in window) || Notification.permission !== "granted") return;
  const top = currentRows("day", "S").filter(r => r.pass >= 6).slice(0, 4);
  try { new Notification(`UHE Strategy · ${ph.t}`, { body: top.length ? top.map(r => `${r.s}: ${r.pass}/7 ticks`).join("\n") : "No day-trade setup has 6+ ticks right now.", icon: "/favicon.svg", tag: "uhe-strat" }); } catch { /* ignore */ }
}

/* ---------------- ranking + list ---------------- */
function currentRows(mode = S.mode, u = S.u, minPass = S.min) {
  const D = (S.D.deep && S.D.deep.stocks) || {}, O = (S.D.options && S.D.options.chains) || {}, F = (S.D.fund && S.D.fund.stocks) || {}, N = (S.D.news && S.D.news.stocks) || {};
  const watch = u === "W" ? new Set(store.get("uhe.watch", []) || []) : null;
  return rank(mode, D, O, F, N, S.rules, { u, watch, minPass, q: S.q.trim().toUpperCase() });
}
const RULES = () => S.mode === "day" ? DAY_RULES : LONG_RULES;
const SHORT = { rsi: "RSI", vol: "Vol", news: "News", etf: "ETF", trend: "Trend", opts: "C>P", analysts: "Analysts", rsi5: "RSI×5", kst5: "KST×5", earn: "Earnings", div: "Div" };
const mark = p => p === true ? "✓" : p === false ? "✕" : "–";
const ckCls = p => p === true ? "ok" : p === false ? "no" : "na";

function planText(r) {
  const p = r.plan; if (!p) return "—";
  return `Buy ${fp(p.entry, 2)} → <span class="up">${fp(p.tp, 2)}</span> <small>(${pct(p.tpPct)}${p.capped ? " · before prior high" : ""})</small> · stop <span class="down">${fp(p.sl, 2)}</span>`;
}
function renderList() {
  const el = $("#list");
  if (!S.D.deep) { el.innerHTML = `<div class="empty"><strong>${S.feeds.deep === "missing" ? "No scan yet" : "Loading the scan…"}</strong>${S.feeds.deep === "missing" ? "The data engine hasn't published deep.json yet. Run it from GitHub Actions." : ""}</div>`; return; }
  const watchN = (store.get("uhe.watch", []) || []).length;
  if (S.u === "W" && !watchN) { el.innerHTML = `<div class="empty"><strong>Your watchlist is empty</strong>Tick ✓ any stock here or on the Stocks page to follow it.</div>`; return; }
  const rows = currentRows(), R = RULES(), watch = new Set(store.get("uhe.watch", []) || []);
  const head = `<div class="st-row st-head" aria-hidden="true"><span></span><span>Stock</span><div class="st-checks">${R.map(([k, l]) => `<span title="${esc(l)}">${esc(SHORT[k] || l)}</span>`).join("")}</div><span>Ticks</span><span>${S.mode === "day" ? "Plan: 1–3%, before prior high" : "Plan"}</span><span></span></div>`;
  if (!rows.length) { el.innerHTML = head + `<div class="empty"><strong>Nothing passes ${S.min ? S.min + "+ ticks" : "the filters"} right now</strong>Try a lower minimum, another universe, or check back nearer the open.</div>`; return; }
  const shown = rows.slice(0, S.show);
  el.innerHTML = head + shown.map(r => {
    const d = r.d, open = S.open === r.s;
    return `<div class="st-row${open ? " open" : ""}" data-s="${esc(r.s)}">
      <button class="tick" data-w="${esc(r.s)}" aria-pressed="${watch.has(r.s)}" title="${watch.has(r.s) ? "Remove from" : "Add to"} watchlist" aria-label="Watch ${esc(r.s)}">✓</button>
      <button class="st-main" aria-expanded="${open}"><b>${esc(r.s)}</b><span>${esc((d.name || "").slice(0, 26))} · <span class="num">${fp(d.px, 2)}</span> <span class="${d.chg > 0 ? "up" : d.chg < 0 ? "down" : ""}">${pct(d.chg, 2)}</span></span></button>
      <div class="st-checks">${R.map(([k, l]) => `<span class="ck ${ckCls(r.c[k].pass)}" title="${esc(l)}: ${esc(r.c[k].val)}"><i>${mark(r.c[k].pass)}</i><em>${esc(SHORT[k] || l)}</em></span>`).join("")}</div>
      <div class="st-score ${r.pass >= 6 ? "hi" : r.pass >= 5 ? "mid" : ""}"><b>${r.pass}</b>/${R.length}</div>
      <div class="st-plan num">${planText(r)}</div>
      <button class="btn sm prime st-trade" data-t="${esc(r.s)}">Buy</button>
    </div>${open ? detailHTML(r) : ""}`;
  }).join("") + (rows.length > shown.length ? `<div class="st-more"><button class="btn sm" id="more">Show more (${rows.length - shown.length} left)</button></div>` : "")
    + `<div class="st-foot">${rows.length.toLocaleString("en-US")} stocks with ${S.min ? S.min + "+ ticks" : "any ticks"} · ${S.mode === "day" ? "day-trade" : "long-term"} rules</div>`;
}
function detailHTML(r) {
  const R = RULES(), d = r.d, F = r.F || {}, N = r.N, tv = d.tv ? `${d.tv}-${r.s.replace(".", "_")}` : r.s;
  const crit = R.map(([k, l]) => `<div class="dt-c ${ckCls(r.c[k].pass)}"><i>${mark(r.c[k].pass)}</i><div><b>${esc(l)}</b><span>${esc(r.c[k].val)}</span></div></div>`).join("");
  const news = N && N.items && N.items.length ? `<div class="dt-sec"><h4>Latest headlines</h4><ul class="dt-news">${N.items.map(n => `<li class="${n.s > 0 ? "up" : n.s < 0 ? "down" : ""}"><a href="${esc(/^https?:\/\//.test(n.l) ? n.l : "#")}" target="_blank" rel="noopener noreferrer">${esc(n.t)}</a><small>${esc(n.p)} · ${ago(new Date(n.ts * 1000).toISOString())}</small></li>`).join("")}</ul></div>` : "";
  const hold = F.top && F.top.length ? `<div class="dt-sec"><h4>Top fund holders</h4><ul class="dt-hold">${F.top.map(([n, p, e]) => `<li><span class="nm">${e ? '<span class="pill cyan">ETF</span> ' : ""}${esc(n)}</span><b class="num">${isNum(p) ? p.toFixed(2) + "%" : "—"}</b></li>`).join("")}</ul></div>` : "";
  const an = F.rm != null ? `<div class="dt-sec"><h4>Analysts</h4><div class="dt-an">${[["Strong buy", F.sb], ["Buy", F.b], ["Hold", F.h], ["Sell", F.s], ["Strong sell", F.ss]].map(([n, v]) => `<span><b class="num">${v ?? "—"}</b>${n}</span>`).join("")}</div>${F.tgt ? `<p class="note">Average target ${fp(F.tgt, 2)} (${pct(F.up)}).${F.erd ? " Next earnings " + esc(F.erd) + "." : ""}</p>` : ""}</div>` : "";
  const p = r.plan, plan = p ? (S.mode === "day"
    ? `<p><b>Entry:</b> buy around ${fp(p.entry, 2)}. Take ${pct(p.tpPct)} at ${fp(p.tp, 2)}${p.capped ? `, just under yesterday's high (${fp(d.pdh, 2)})` : ""}. Stop ${fp(p.sl, 2)} (−${p.slPct}%).</p><p class="note">If it sells off first, wait for it to reclaim yesterday's close${isNum(p.dipLevel) ? " (" + fp(p.dipLevel, 2) + ")" : ""} before buying, then sell before yesterday's high.</p>`
    : `<p>Buy around ${fp(p.entry, 2)}, target ${fp(p.tp, 2)} (${pct(p.tpPct)}), stop ${fp(p.sl, 2)} (−${p.slPct}%).</p>`) : "";
  return `<div class="st-detail"><div class="dt-grid">${crit}</div><div class="dt-cols"><div class="dt-sec"><h4>Plan</h4>${plan}<p><a href="https://www.tradingview.com/symbols/${esc(tv)}/" target="_blank" rel="noopener">Open ${esc(r.s)} on TradingView</a></p></div>${an}${hold}${news}</div></div>`;
}

/* ---------------- rules editor ---------------- */
const RULE_FIELDS = {
  day: [["rsiMin", "RSI from"], ["rsiMax", "RSI up to"], ["rvolMin", "Volume ≥ × 20-day avg"], ["stBull", "StockTwits bullish ≥ %"], ["instMin", "Institutions hold ≥ %"], ["etfMin", "…or index funds in top holders ≥"], ["pcrMax", "Put/call below"], ["recMax", "Analyst rating ≤ (1 = strong buy)"], ["analystsMin", "Min. analysts"], ["tpPct", "Take profit % (1–3)"], ["slPct", "Stop loss %"]],
  long: [["rsiMin", "RSI ≥ on each of 5 days"], ["erFrom", "Earnings window from (days)"], ["erTo", "…to (days)"], ["instMin", "Institutions hold ≥ %"], ["etfMin", "…or index funds in top holders ≥"], ["recMax", "Analyst rating ≤"], ["analystsMin", "Min. analysts"], ["upsideMin", "Analyst target upside ≥ %"], ["divMin", "Dividend yield ≥ %"], ["tpPct", "Take profit %"], ["slPct", "Stop loss %"]]
};
const RULE_TEXT = {
  day: ["RSI in range and rising", "Yesterday's volume above its 20-day average", "Positive headline tone (48h) or bullish StockTwits", "Big institutions or index ETFs hold it", "Price above 20-day, 20-day above 50-day and rising", "More call volume than puts", "Analysts at Buy or better"],
  long: ["RSI ≥ 50 on each of the last 5 days", "KST above its signal on each of the last 5 days", "Earnings 2–10 days away (the week-before buying window) with no bad news", "Big institutions or index ETFs hold it", "More call open interest than puts", "Analysts at Buy with target upside", "Dividend yield above your minimum"]
};
function renderRules() {
  const R = S.rules[S.mode];
  $("#rules").innerHTML = `<div class="rules-grid"><div><div class="eyebrow">${S.mode === "day" ? "Day trade" : "Long term"} checklist</div><ol class="rules-list">${RULE_TEXT[S.mode].map(t => `<li>${esc(t)}</li>`).join("")}</ol></div>
    <form class="form" id="rulesForm" novalidate>${RULE_FIELDS[S.mode].map(([k, l]) => `<label>${esc(l)}<input class="inp num" type="number" step="any" name="${k}" value="${R[k]}"></label>`).join("")}
    <div class="full" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm prime" type="submit">Save rules</button><button class="btn sm" type="button" id="rulesReset">Reset to defaults</button></div></form></div>`;
}
$("#rules").addEventListener("submit", e => {
  e.preventDefault(); const f = new FormData(e.target), saved = store.get("uhe.strat", {}) || {};
  saved[S.mode] = Object.fromEntries([...f.entries()].map(([k, v]) => [k, +v]));
  S.rules = normRules(saved); store.set("uhe.strat", saved); renderRules(); renderList(); toast("Rules saved on this device.");
});
$("#rules").addEventListener("click", e => {
  if (e.target.id !== "rulesReset") return; const saved = store.get("uhe.strat", {}) || {}; delete saved[S.mode];
  store.set("uhe.strat", saved); S.rules = normRules(saved); renderRules(); renderList();
});
$("#rulesBtn").addEventListener("click", () => { const r = $("#rules"), open = r.hidden; r.hidden = !open; $("#rulesBtn").setAttribute("aria-expanded", String(open)); if (open) renderRules(); });

/* ---------------- controls ---------------- */
function syncTabs() {
  $$("#modeTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === S.mode)));
  $$("#univTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.u === S.u)));
  $("#minPass").value = String(S.min);
}
$("#modeTabs").addEventListener("click", e => { const b = e.target.closest("button[data-m]"); if (!b) return; S.mode = b.dataset.m; S.open = null; S.show = 60; store.set("uhe.strat.mode", S.mode); syncTabs(); renderList(); if (!$("#rules").hidden) renderRules(); });
$("#univTabs").addEventListener("click", e => { const b = e.target.closest("button[data-u]"); if (!b) return; S.u = b.dataset.u; S.open = null; S.show = 60; store.set("uhe.strat.u", S.u); syncTabs(); renderList(); });
$("#minPass").addEventListener("change", e => { S.min = +e.target.value; store.set("uhe.strat.min", S.min); renderList(); });
$("#q").addEventListener("input", e => { S.q = e.target.value; S.show = 60; renderList(); });
$("#list").addEventListener("click", e => {
  const w = e.target.closest("[data-w]");
  if (w) { const s = w.dataset.w; let l = store.get("uhe.watch", []) || []; l = l.includes(s) ? l.filter(x => x !== s) : l.concat(s).slice(-25); store.set("uhe.watch", l); renderList(); return; }
  const t = e.target.closest("[data-t]"); if (t) { openTicket(t.dataset.t); return; }
  if (e.target.id === "more") { S.show += 60; renderList(); return; }
  const m = e.target.closest(".st-main"); if (m) { const s = m.closest(".st-row").dataset.s; S.open = S.open === s ? null : s; renderList(); }
});

/* ---------------- broker (IC Markets via cTrader) ---------------- */
async function api(action, extra = {}) {
  let r, j;
  try { r = await fetch("/api/trade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, pin: S.pin, ...extra }) }); }
  catch { return { ok: false, error: "Can't reach the trading bridge." }; }
  try { j = await r.json(); } catch { j = { ok: false, error: "HTTP " + r.status }; }
  if (r.status === 401) S.pin = null;
  return j;
}
async function brokerStatus() {
  try { const r = await fetch("/api/trade", { cache: "no-store" }); if (!r.ok) throw new Error(); S.broker = await r.json(); } catch { S.broker = { error: true }; }
  renderBroker();
}
const envPill = env => `<span class="pill ${env === "live" ? "short" : "cyan"}">${env === "live" ? "LIVE · real money" : "DEMO"}</span>`;
function renderBroker() {
  const b = S.broker, el = $("#broker");
  if (!b) return;
  if (b.error) { el.innerHTML = `<div class="eyebrow">IC Markets · cTrader</div><div class="empty"><strong>Trading bridge offline</strong>The /api/trade function didn't answer. Redeploy on Vercel and refresh.</div>`; return; }
  const c = b.configured || {}, head = `<div class="br-head"><div><div class="eyebrow">IC Markets · cTrader Open API</div><b class="br-title">${S.acct ? "Connected" : b.ready ? "Ready" : "Not connected"}</b></div>${envPill(b.env)}</div>`;
  if (!b.ready) {
    const item = (ok, t) => `<li class="${ok ? "ok" : ""}"><i>${ok ? "✓" : "•"}</i>${t}</li>`;
    el.innerHTML = head + `<ul class="br-setup">${item(c.app, "cTrader app: <code>CTRADER_CLIENT_ID</code> + <code>CTRADER_CLIENT_SECRET</code>")}${item(c.token, "Access token: <code>CTRADER_ACCESS_TOKEN</code>")}${item(c.account, "Account: <code>CTRADER_ACCOUNT_ID</code>")}${item(c.pin, "Trading PIN: <code>TRADE_PIN</code> (8+ characters)")}</ul>
      <p class="note">Add these in Vercel → Settings → Environment Variables, then redeploy. Start on a demo account (<code>CTRADER_ENV=demo</code>).</p>
      ${c.app && c.token && c.pin && !c.account ? `<form class="br-unlock" id="acctForm"><input class="inp" type="password" id="pinIn" placeholder="Trading PIN" autocomplete="off" aria-label="Trading PIN"><button class="btn sm prime">Find my account IDs</button></form><div id="acctList" class="note"></div>` : ""}`;
    return;
  }
  if (!S.pin || !S.acct) {
    el.innerHTML = head + `<p class="br-sub">Unlock with your trading PIN to see your balance and positions and to place orders. The PIN stays in this tab only.</p>
      <form class="br-unlock" id="unlockForm"><input class="inp" type="password" id="pinIn" placeholder="Trading PIN" autocomplete="off" aria-label="Trading PIN"><button class="btn sm prime">Unlock</button></form>
      <div class="form-msg" id="brMsg">${esc(S.acctErr)}</div><p class="note">Max per order: $${b.maxUsd.toLocaleString("en-US")} · stop loss always attached.</p>`;
    return;
  }
  const a = S.acct.account || {}, P = S.acct.positions || [], ccy = a.ccy === "USD" ? "$" : a.ccy === "GBP" ? "£" : a.ccy === "EUR" ? "€" : (a.ccy ? a.ccy + " " : "");
  el.innerHTML = head + `<div class="kv br-kv"><div><span>Balance</span><b>${money(a.balance, ccy)}</b></div><div><span>Open P&amp;L</span><b class="${P.reduce((t, p) => t + (p.pnl || 0), 0) >= 0 ? "up" : "down"}">${money(P.reduce((t, p) => t + (p.pnl || 0), 0), "$")}</b></div><div><span>Leverage</span><b>${a.leverage ? "1:" + a.leverage : "—"}</b></div></div>
    <div class="br-pos">${P.length ? P.map(p => `<div class="br-p"><div><b>${esc(p.symbol)}</b> <small class="muted">${esc(p.side)} ${p.units} @ ${fp(p.price, 2)}</small><small class="muted">SL ${fp(p.sl, 2)} · TP ${fp(p.tp, 2)}${p.label ? " · " + esc(p.label) : ""}</small></div><b class="num ${p.pnl >= 0 ? "up" : "down"}">${p.pnl == null ? "—" : money(p.pnl, "$")}</b><button class="btn sm" data-close="${esc(p.id)}">Close</button></div>`).join("") : `<div class="empty" style="padding:12px">No open positions</div>`}</div>
    <div class="br-actions"><button class="btn sm" id="brRefresh">Refresh</button><button class="btn sm" id="brLock">Lock</button><span class="muted" style="font-size:11.5px">Login ${esc(a.login || "—")} · cap $${b.maxUsd.toLocaleString("en-US")}/order</span></div>`;
}
async function refreshAccount(quiet) {
  const j = await api("account");
  if (j.ok) { S.acct = j; S.acctErr = ""; }
  else { if (!S.pin) S.acct = null; S.acctErr = j.error || "Couldn't load the account."; if (!quiet) toast(esc(S.acctErr)); }
  renderBroker();
}
$("#broker").addEventListener("submit", async e => {
  e.preventDefault(); const pin = ($("#pinIn") || {}).value || ""; if (!pin) return;
  S.pin = pin; const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Checking…";
  if (e.target.id === "acctForm") {
    const j = await api("accounts"); btn.disabled = false; btn.textContent = "Find my account IDs";
    $("#acctList").innerHTML = j.ok ? (j.accounts.length ? j.accounts.map(a => `Account ID <b class="num">${esc(a.id)}</b> · login ${esc(a.login)} · ${a.live ? "LIVE" : "demo"} · ${esc(a.broker)}`).join("<br>") + "<br>Put the ID in <code>CTRADER_ACCOUNT_ID</code> and redeploy." : "No accounts on this token.") : esc(j.error);
    return;
  }
  await refreshAccount(true);
});
$("#broker").addEventListener("click", async e => {
  if (e.target.id === "brRefresh") return refreshAccount();
  if (e.target.id === "brLock") { S.pin = null; S.acct = null; renderBroker(); return; }
  const c = e.target.closest("[data-close]"); if (!c) return;
  if (c.dataset.armed !== "1") { c.dataset.armed = "1"; c.textContent = "Confirm close"; c.classList.add("warn"); setTimeout(() => { if (c.isConnected) { c.dataset.armed = ""; c.textContent = "Close"; c.classList.remove("warn"); } }, 4000); return; }
  c.disabled = true; c.textContent = "Closing…";
  const j = await api("close", { positionId: c.dataset.close });
  toast(j.ok ? `Closed position ${esc(j.closed)}${j.price ? " at " + fp(j.price, 2) : ""}` : esc(j.error || "Close failed"));
  refreshAccount(true);
});
setInterval(() => { if (S.pin && S.acct && document.visibilityState === "visible") refreshAccount(true); }, 30e3);

/* ---------------- order ticket ---------------- */
const T = {};
function openTicket(sym) {
  const r = currentRows(S.mode, S.u, 0).find(x => x.s === sym) || rank(S.mode, { [sym]: S.D.deep.stocks[sym] }, (S.D.options || {}).chains || {}, (S.D.fund || {}).stocks || {}, (S.D.news || {}).stocks || {}, S.rules, { watch: new Set([sym]) })[0];
  if (!r || !r.plan) return toast("No price for " + esc(sym) + " yet.");
  const R = S.rules[S.mode];
  Object.assign(T, { r, s: sym, mode: S.mode, usd: store.get("uhe.tk.usd", 1000), tpPct: R.tpPct, slPct: R.slPct, cap: S.mode === "day" && !!r.plan.capped, live: false, busy: false, result: "" });
  T.lastFocus = document.activeElement;
  renderTicket(); $("#scrim").hidden = false; $("#ticket").hidden = false; document.body.style.overflow = "hidden";
  setTimeout(() => { const i = $("#tkUsd"); if (i) i.focus(); }, 30);
}
function closeTicket() { $("#scrim").hidden = true; $("#ticket").hidden = true; document.body.style.overflow = ""; if (T.lastFocus && T.lastFocus.focus) T.lastFocus.focus(); }
function calc() {
  const p = T.r.plan, d = T.r.d, entry = p.entry, units = T.usd > 0 ? T.usd / entry : 0;
  let tp = entry * (1 + T.tpPct / 100), capped = false;
  if (T.cap && isNum(d.pdh) && d.pdh > entry * 1.003 && d.pdh * 0.998 < tp) { tp = d.pdh * 0.998; capped = true; }
  const sl = entry * (1 - T.slPct / 100);
  return { entry, units, tp, sl, capped, reward: (tp - entry) * units, risk: (entry - sl) * units, rr: (tp - entry) / (entry - sl) };
}
function renderTicket() {
  const r = T.r, d = r.d, b = S.broker || {}, k = calc(), R = RULES(), miss = R.filter(([key]) => r.c[key].pass !== true).map(([, l]) => l);
  const ready = b.ready, env = b.env || "demo";
  $("#tkBody").innerHTML = `<div class="eyebrow">${T.mode === "day" ? "Day trade" : "Long term"} · market order</div>
    <h3 id="tkTitle" class="tk-title">Buy ${esc(r.s)} ${envPill(env)}</h3>
    <p class="muted" style="margin:2px 0 12px">${esc(d.name || "")} · last ${fp(d.px, 2)} · ${r.pass}/${R.length} ticks${miss.length ? " · missing: " + esc(miss.join(", ")) : " · all rules pass"}</p>
    <form class="form" id="tkForm" novalidate>
      <label>Amount ($)<input class="inp num" id="tkUsd" type="number" min="1" step="any" value="${T.usd}"></label>
      <label>Stop loss %<input class="inp num" id="tkSl" type="number" min="0.2" max="15" step="any" value="${T.slPct}"></label>
      <label class="full">Take profit ${T.mode === "day" ? "(1–3%)" : "%"} · <span class="num" id="tkTpV">${T.tpPct.toFixed(2)}%</span>
        <input id="tkTp" type="range" min="${T.mode === "day" ? 1 : 2}" max="${T.mode === "day" ? 3 : 30}" step="${T.mode === "day" ? 0.25 : 0.5}" value="${T.tpPct}"></label>
      ${T.mode === "day" && isNum(d.pdh) ? `<label class="full tk-check"><input type="checkbox" id="tkCap" ${T.cap ? "checked" : ""}> Sell before yesterday's high (${fp(d.pdh, 2)})</label>` : ""}
      <div class="full kv tk-kv"><div><span>Shares ≈</span><b>${k.units ? k.units.toFixed(2) : "—"}</b></div><div><span>Target</span><b class="up">${fp(k.tp, 2)}</b></div><div><span>Stop</span><b class="down">${fp(k.sl, 2)}</b></div>
        <div><span>Reward ≈</span><b class="up">${money(k.reward)}</b></div><div><span>Risk ≈</span><b class="down">${money(-k.risk)}</b></div><div><span>Reward : risk</span><b>${isNum(k.rr) ? k.rr.toFixed(2) : "—"}</b></div></div>
      <p class="full note" style="margin:0">Fills at the live IC Markets price; the stop and target are set as distances from the fill${k.capped ? ", with the target just under yesterday's high" : ""}.</p>
      ${env === "live" ? `<label class="full tk-check tk-live"><input type="checkbox" id="tkLive" ${T.live ? "checked" : ""}> I understand this is my LIVE account and real money</label>` : ""}
      ${!S.pin ? `<label class="full">Trading PIN<input class="inp" id="tkPin" type="password" autocomplete="off"></label>` : ""}
      <div class="full tk-go">${ready ? `<button class="btn prime" id="tkSend" ${T.busy ? "disabled" : ""}>${T.busy ? "Sending…" : `Buy ${esc(r.s)} · ${env === "live" ? "LIVE" : "DEMO"}`}</button>` : `<span class="warnline">IC Markets isn't connected yet. Finish the setup in the panel above.</span>`}
        <button class="btn sm" type="button" id="tkFind">Check IC symbol</button></div>
      <div class="full form-msg" id="tkMsg">${T.result}</div>
    </form>`;
}
$("#ticket").addEventListener("input", e => {
  const id = e.target.id;
  if (id === "tkUsd") { T.usd = Math.max(0, +e.target.value || 0); store.set("uhe.tk.usd", T.usd); }
  else if (id === "tkSl") T.slPct = Math.min(15, Math.max(0.2, +e.target.value || T.slPct));
  else if (id === "tkTp") T.tpPct = +e.target.value;
  else if (id === "tkCap") T.cap = e.target.checked;
  else if (id === "tkLive") T.live = e.target.checked;
  else return;
  const k = calc(), kv = $(".tk-kv");
  if (id === "tkTp") $("#tkTpV").textContent = T.tpPct.toFixed(2) + "%";
  if (kv) kv.innerHTML = `<div><span>Shares ≈</span><b>${k.units ? k.units.toFixed(2) : "—"}</b></div><div><span>Target</span><b class="up">${fp(k.tp, 2)}</b></div><div><span>Stop</span><b class="down">${fp(k.sl, 2)}</b></div><div><span>Reward ≈</span><b class="up">${money(k.reward)}</b></div><div><span>Risk ≈</span><b class="down">${money(-k.risk)}</b></div><div><span>Reward : risk</span><b>${isNum(k.rr) ? k.rr.toFixed(2) : "—"}</b></div>`;
});
$("#ticket").addEventListener("click", async e => {
  if (e.target.id !== "tkFind") return;
  const pin = ($("#tkPin") || {}).value; if (pin) S.pin = pin;
  if (!S.pin) { $("#tkMsg").textContent = "Enter your trading PIN first."; return; }
  $("#tkMsg").textContent = "Looking up…";
  const j = await api("find", { symbol: T.s });
  $("#tkMsg").innerHTML = j.ok ? (j.matches.length ? "IC Markets symbol: " + j.matches.slice(0, 3).map(m => `<b>${esc(m.name)}</b>${m.desc ? " (" + esc(m.desc) + ")" : ""}`).join(", ") : "No matching symbol on your cTrader account.") : `<span class="down">${esc(j.error)}</span>`;
});
$("#ticket").addEventListener("submit", async e => {
  e.preventDefault(); if (T.busy) return;
  const pin = ($("#tkPin") || {}).value; if (pin) S.pin = pin;
  if (!S.pin) { $("#tkMsg").textContent = "Enter your trading PIN."; return; }
  if ((S.broker || {}).env === "live" && !T.live) { $("#tkMsg").innerHTML = `<span class="down">Tick the live-account box first.</span>`; return; }
  const k = calc(); if (!(T.usd > 0)) { $("#tkMsg").textContent = "Enter an amount."; return; }
  T.busy = true; T.result = ""; renderTicket();
  const j = await api("order", { symbol: T.s, usd: T.usd, tpPct: T.tpPct, slPct: T.slPct, tpPrice: k.capped ? +k.tp.toFixed(4) : undefined, refPx: k.entry, mode: T.mode, confirmLive: T.live });
  T.busy = false;
  T.result = j.ok
    ? `<span class="up">${j.status === "ORDER_FILLED" ? "Filled" : "Sent"}: ${esc(j.units)} ${esc(j.symbol)}${j.fill ? " at " + fp(j.fill, 2) : ""} · stop ${fp(j.sl, 2)} · target ${fp(j.tp, 2)} (${esc((j.env || "").toUpperCase())})</span>${j.note ? `<br><span class="muted">${esc(j.note)}</span>` : ""}`
    : `<span class="down">${esc(j.error || "Order failed")}</span>`;
  renderTicket();
  if (j.ok) { toast(`${esc(j.symbol)} order ${j.status === "ORDER_FILLED" ? "filled" : "sent"} (${esc((j.env || "").toUpperCase())})`); refreshAccount(true); }
});
$("#tkClose").addEventListener("click", closeTicket);
$("#scrim").addEventListener("click", closeTicket);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#ticket").hidden) closeTicket(); });

/* ---------------- boot ---------------- */
{ const a = $("nav.jump a[aria-current=page]"); if (a) a.parentElement.scrollLeft = a.offsetLeft - 16; }
syncTabs(); renderPhase(); setInterval(renderPhase, 30e3);
(async () => {
  await Promise.all(Object.keys(FEEDS).map(load));
  renderChips(); renderList();
  for (const [k, f] of Object.entries(FEEDS)) setInterval(async () => { if (document.visibilityState !== "visible") return; await load(k); renderChips(); if (!$("#ticket").hidden) return; renderList(); }, f.every);
})();
brokerStatus();
