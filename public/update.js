// UHE Update page: ask Claude to change the site, review the diff, push it to GitHub, run the data engine.
// Talks to /api/update (PIN-locked). The conversation and staged changes are kept in this browser until pushed.
import { diffLines, hunks, stats } from "./diff.js";
import { UK, NY, fmtT } from "./model.js";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
const tab = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const short = sha => (sha || "").slice(0, 7);
const kb = n => n < 1024 ? n + " B" : (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
const ago = iso => { if (!iso) return "—"; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
const when = iso => { const d = new Date(iso), today = new Date().toDateString() === d.toDateString(); return (today ? "" : d.toLocaleDateString("en-GB", { timeZone: UK, day: "numeric", month: "short" }) + " ") + fmtT(d, UK); };
const span = (a, b) => { if (!a || !b) return ""; const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"; };
function toast(msg, ms = 4200) { const t = $("#toast"); t.innerHTML = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
function arm(btn, label) { // two-tap confirm, like the Strategy page's Close button
  if (btn.dataset.armed === "1") return true;
  const was = btn.textContent; btn.dataset.armed = "1"; btn.textContent = label; btn.classList.add("warn");
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = was; btn.classList.remove("warn"); } }, 4000);
  return false;
}

const S = {
  st: null, info: null, pin: tab.get("uhe.update.pin"), busy: false, ctrl: null, round: null, live: null, status: "",
  s: (() => {
    const s = store.get("uhe.update.session", null);
    if (!(s && s.v === 1)) return { v: 1, baseSha: null, files: {}, rounds: [], cost: 0 };
    for (const r of s.rounds) for (const a of r.acts) a.live = false;
    for (const r of s.rounds) if (r.status === "running") { r.status = "stopped"; r.acts.push({ k: "note", s: "Interrupted: the page was closed or reloaded. Anything Claude changed before that is kept in step 2." }); }
    return s;
  })(),
  open: new Set(), conflict: null, push: store.get("uhe.update.push", null), commits: null,
  eng: { mode: store.get("uhe.update.engMode", "due"), jobs: store.get("uhe.update.engJobs", []), runs: null, cur: null, log: null, polling: false }
};
let saveT = 0;
function save(now) {
  clearTimeout(saveT);
  const go = () => { if (!store.set("uhe.update.session", S.s)) { S.s.rounds = S.s.rounds.slice(-4).map(r => ({ ...r, acts: r.acts.filter(a => a.k !== "think").slice(-30) })); store.set("uhe.update.session", S.s); } };
  if (now) go(); else saveT = setTimeout(go, 400);
}

/* ---------------- clocks ---------------- */
const clocks = () => { $("#clkUK").textContent = fmtT(new Date(), UK); $("#clkNY").textContent = fmtT(new Date(), NY); };
clocks(); setInterval(clocks, 1000);

/* ---------------- API ---------------- */
async function api(action, extra = {}) {
  let r, j;
  try { r = await fetch("/api/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, pin: S.pin, ...extra }) }); }
  catch { return { ok: false, error: "Can't reach the update service. Check your connection." }; }
  try { j = await r.json(); } catch { j = { ok: false, error: "HTTP " + r.status }; }
  if (r.status === 401 && S.info) lock("Wrong PIN. Unlock again.");
  return j;
}
const model = id => ((S.st && S.st.models) || []).find(m => m.id === id);
const modelName = id => { const m = model(id); return m ? m.label.split(" · ")[0] : id || "Claude"; };
const cost = (u, id) => { const p = (model(id) || {}).price; return p ? (u.in * p[0] + u.out * p[1] + u.cw * p[2] + u.cr * p[3]) / 1e6 : 0; };

/* ---------------- lock screen & chips ---------------- */
function setupHTML(c) {
  const repo = (S.st && S.st.repo) || "joeyjojo0/Upper-Hand-Edge", owner = repo.split("/")[0];
  const url = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({ name: "UHE update page", description: "Lets the UHE update page push code changes and run the data engine", target_name: owner, expires_in: "366", contents: "write", actions: "write", workflows: "write", statuses: "read" });
  const li = (ok, html) => `<li class="${ok ? "ok" : ""}"><i>${ok ? "✓" : "•"}</i><div>${html}</div></li>`;
  return `<ul class="br-setup upd-setup">
    ${li(c.pin, `<code>UPDATE_PIN</code>: a passphrase of 8+ characters that you type here to unlock.${S.st && S.st.pinVar === "TRADE_PIN" ? " Your trading PIN works until you set one." : ""}`)}
    ${li(c.claude, `<code>ANTHROPIC_API_KEY</code>: a key from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>, so Claude can edit the site.`)}
    ${li(c.github, `<code>GITHUB_TOKEN</code>: <a href="${esc(url)}" target="_blank" rel="noopener">create a fine-grained token</a> (permissions are pre-filled). Under Repository access pick <b>Only select repositories → ${esc(repo.split("/")[1])}</b>, then Generate.`)}
  </ul><p class="note">Add them in Vercel → your project → Settings → Environment Variables, then redeploy.</p>`;
}
function renderLock(err) {
  const el = $("#lock"); el.hidden = false; $("#app").hidden = true;
  if (!S.st) { el.innerHTML = `<div class="empty"><strong>The update service didn't answer</strong>Redeploy the site on Vercel, then refresh this page.</div>`; return; }
  const c = S.st.configured;
  el.innerHTML = c.pin
    ? `<div class="upd-lock-in"><div><div class="eyebrow">Locked</div><h3 class="upd-lock-t">Enter your PIN</h3><p class="upd-sub">This page can change the live site, so it's PIN-protected. The PIN stays in this tab only.</p>
        <form class="br-unlock" id="unlockForm"><label class="sr" for="pinIn">PIN</label><input class="inp" type="password" id="pinIn" placeholder="Update PIN" autocomplete="current-password"><button class="btn prime">Unlock</button></form>
        <div class="form-msg down" id="lockMsg">${esc(err || "")}</div></div>
        ${c.claude && c.github ? "" : `<div><div class="eyebrow">Still to set up</div>${setupHTML(c)}</div>`}</div>`
    : `<div class="eyebrow">Set up the Update page</div><h3 class="upd-lock-t">Three settings in Vercel</h3>${setupHTML(c)}`;
  const f = $("#unlockForm");
  if (f) { f.addEventListener("submit", async e => { e.preventDefault(); const pin = $("#pinIn").value; if (!pin) return; const b = f.querySelector("button"); b.disabled = true; b.textContent = "Checking…"; if (!(await unlock(pin))) { b.disabled = false; b.textContent = "Unlock"; } }); setTimeout(() => $("#pinIn") && $("#pinIn").focus(), 50); }
  renderChips();
}
function renderChips() {
  const st = S.st, el = $("#chips"), live = $("#liveChip");
  live.className = "live" + (S.info ? " on" : ""); live.querySelector("span").textContent = !S.info ? "LOCKED" : S.busy ? "CLAUDE WORKING" : "UNLOCKED";
  if (!st) { el.innerHTML = `<span class="chip bad"><span class="dot"></span>Update service offline</span>`; return; }
  const chip = (ok, t, tip) => `<span class="chip ${ok ? "ok" : "bad"}" title="${esc(tip)}"><span class="dot"></span>${t}</span>`;
  el.innerHTML = chip(st.configured.claude, "Claude", st.configured.claude ? "ANTHROPIC_API_KEY is set" : "Add ANTHROPIC_API_KEY in Vercel")
    + chip(st.configured.github, "GitHub", st.configured.github ? "GITHUB_TOKEN is set" : "Add GITHUB_TOKEN in Vercel")
    + (st.deployed && st.deployed.sha ? `<span class="chip ok" title="The commit the live site is running"><span class="dot"></span>Live ${esc(short(st.deployed.sha))}</span>` : "")
    + (S.info ? `<button class="btn sm ghost" type="button" id="lockBtn">Lock</button>` : "");
}
async function unlock(pin, quiet) {
  S.pin = pin;
  const j = await api("check");
  if (!j.ok) { S.pin = null; tab.set("uhe.update.pin", null); const m = $("#lockMsg"); if (m) m.textContent = j.error || "Couldn't unlock."; else if (!quiet) renderLock(j.error); return false; }
  tab.set("uhe.update.pin", pin); S.info = j; S.st = { ...S.st, ...j };
  S.commits = j.commits; S.eng.runs = j.runs;
  if (j.githubError) toast(esc(j.githubError), 7000);
  showApp();
  return true;
}
function lock(msg) {
  if (S.ctrl) S.ctrl.abort();
  S.pin = null; S.info = null; tab.set("uhe.update.pin", null);
  renderLock(msg);
}

/* ---------------- app ---------------- */
function showApp() {
  $("#lock").hidden = true; $("#app").hidden = false;
  const sel = $("#model"), pick = store.get("uhe.update.model", S.st.model);
  sel.innerHTML = (S.st.models || []).map(m => `<option value="${esc(m.id)}"${m.id === pick ? " selected" : ""}>${esc(m.label)}</option>`).join("");
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  $("#prompt").value = store.get("uhe.update.draft", "") || "";
  S.scrollFeed = true; render();
  const active = (S.eng.runs || []).find(r => r.status !== "completed");
  if (active && !S.eng.cur) { S.eng.cur = active; pollRun(); }
  loadLog();
  if (S.push && !["live", "failed", "unknown"].includes(S.push.state) && Date.now() - S.push.at < 15 * 60e3) watchDeploy(S.push.sha);
}
function render() { renderChips(); renderFeed(); renderChanges(); renderPushResult(); renderCommits(); renderEngine(); }

/* ---------------- step 1: Claude ---------------- */
const IDEAS = ["Make the countdown ring turn amber in the last 10 minutes before the NY open", "Add a “Copy plan” button to each stock on the Strategy page",
  "Show when the data engine last refreshed in the dashboard header", "Explain how the edge score is worked out (no changes)"];
const ICON = { list_files: "▤", read_file: "◱", search: "⌕", edit_file: "✎", write_file: "✚", delete_file: "✕" };
const PENDING = { list_files: "Looking at the files", read_file: "Reading a file", search: "Searching the code", edit_file: "Editing", write_file: "Writing a file", delete_file: "Deleting a file" };
function md(s) {
  const inline = t => t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  let html = "", list = false, code = null;
  for (const l of esc(s).split("\n")) {
    if (/^\s*```/.test(l)) { if (code == null) { if (list) { html += "</ul>"; list = false; } code = ""; } else { html += `<pre><code>${code}</code></pre>`; code = null; } continue; }
    if (code != null) { code += l + "\n"; continue; }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    if (!l.trim()) continue;
    const h = /^#{1,4}\s+(.*)$/.exec(l);
    html += `<p>${h ? "<b>" + inline(h[1]) + "</b>" : inline(l)}</p>`;
  }
  if (code != null) html += `<pre><code>${code}</code></pre>`;
  return html + (list ? "</ul>" : "");
}
function actHTML(a, key) {
  if (a.k === "think") return `<details class="upd-think" data-k="${key}"${S.openThink === key ? " open" : ""}><summary>${a.live ? "Thinking…" : "Thinking"}</summary><div>${md(a.s || "…")}</div></details>`;
  if (a.k === "text") return `<div class="upd-say${a.final ? " final" : ""}">${md(a.s)}</div>`;
  if (a.k === "tool") return `<div class="upd-act ${a.ok === false ? "bad" : a.ok ? "ok" : "run"}"><i aria-hidden="true">${ICON[a.name] || "•"}</i><span>${esc(a.label)}</span>${a.add || a.del ? `<b class="num"><em class="up">+${a.add || 0}</em> <em class="down">−${a.del || 0}</em></b>` : ""}${a.check && a.check.ok === false ? `<small class="down" title="${esc(a.check.error)}">syntax error</small>` : ""}</div>`;
  if (a.k === "err") return `<div class="upd-err">${esc(a.s)}</div>`;
  return `<div class="upd-note">${esc(a.s)}</div>`;
}
function roundHTML(r, i) {
  const live = r === S.live, files = r.acts.filter(a => a.k === "tool" && a.ok && /^(Edited|Created|Replaced|Added|Deleted)/.test(a.label)).length;
  const tail = live ? `<div class="upd-typing" role="status"><i></i><i></i><i></i><span>${esc(S.status || "Working")}</span></div>`
    : r.status === "done" && files && !r.pushed ? `<button class="btn sm ghost upd-goto" type="button" data-goto="review">Review the changes ↓</button>`
    : r.pushed ? `<small class="muted upd-pushed-tag">Pushed in ${esc(short(r.pushed))}</small>` : "";
  const u = r.usage || {}, toks = (u.in || 0) + (u.out || 0) + (u.cr || 0) + (u.cw || 0);
  return `<article class="upd-round${live ? " is-live" : ""}">
    <div class="upd-me"><p>${esc(r.prompt)}</p><small>${fmtT(new Date(r.at), UK)} · ${esc(modelName(r.model))}${toks ? ` · ${Math.round(toks / 1000)}k tokens` : ""}</small></div>
    <div class="upd-claude">${r.acts.map((a, j) => actHTML(a, i + "-" + j)).join("")}${tail}</div>
  </article>`;
}
let feedRaf = 0;
function renderFeed() {
  cancelAnimationFrame(feedRaf);
  feedRaf = requestAnimationFrame(() => {
    const el = $("#feed"), atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    const R = S.s.rounds;
    el.innerHTML = R.length ? R.map(roundHTML).join("")
      : S.st.configured.claude && S.st.configured.github ? `<div class="upd-hello"><b>What should Claude change?</b><p>Describe it the way you'd tell a developer: what, where on the site, and how it should look or behave. Claude reads the code, makes the edits and explains them. Nothing goes live until you push in step 2.</p></div>`
      : `<div class="upd-hello"><b>Almost there</b><p>Claude needs two more settings before it can edit the site:</p>${setupHTML(S.st.configured)}</div>`;
    if (atEnd || S.scrollFeed) { el.scrollTop = el.scrollHeight; S.scrollFeed = false; }
    $("#ideas").innerHTML = !R.length && !$("#prompt").value ? IDEAS.map(t => `<button type="button" class="upd-idea">${esc(t)}</button>`).join("") : "";
    const tot = R.reduce((s, r) => s + cost(r.usage || {}, r.model), 0);
    $("#cost").textContent = tot >= 0.005 ? `≈ $${tot.toFixed(2)} so far` : "";
    $("#send").disabled = S.busy || !(S.st && S.st.configured.claude) || !(S.st.configured.github);
    $("#send").textContent = S.busy ? "Working…" : "Send to Claude";
    $("#stop").hidden = !S.busy; $("#newChat").hidden = S.busy || !R.length;
    $("#prompt").disabled = S.busy;
    renderChips();
  });
}
const staged = () => { const o = {}; for (const [p, f] of Object.entries(S.s.files)) if (f.content !== f.base) o[p] = f.content; return o; };
const act = (r, a) => { r.acts.push(a); return a; };
const lastAct = (r, k) => { const a = r.acts[r.acts.length - 1]; return a && a.k === k && a.live ? a : null; };
function closeLive(r) { for (const a of r.acts) if (a.live) a.live = false; }
function onEvent(ev, r) {
  switch (ev.t) {
    case "base": S.s.baseSha = ev.sha; break;
    case "round": S.round = { model: ev.model, system: ev.system, messages: [ev.first] }; break;
    case "turn": S.status = "Thinking"; break;
    case "think_start": closeLive(r); act(r, { k: "think", s: "", live: true }); S.status = "Thinking"; break;
    case "think": { const a = lastAct(r, "think") || act(r, { k: "think", s: "", live: true }); a.s += ev.d; break; }
    case "text": { let a = lastAct(r, "text"); if (!a) { closeLive(r); a = act(r, { k: "text", s: "", live: true }); } a.s += ev.d; S.status = "Writing"; break; }
    case "tool_start": closeLive(r); act(r, { k: "tool", id: ev.id, name: ev.name, label: PENDING[ev.name] || "Working", ok: null }); S.status = PENDING[ev.name] || "Working"; break;
    case "tool_input": { const a = r.acts.find(x => x.id === ev.id); if (a && a.ok == null) { a.label = (PENDING[a.name] || "Working") + " · " + kb(ev.n); S.status = a.label; } break; }
    case "tool": { const a = r.acts.find(x => x.id === ev.id) || act(r, { k: "tool", id: ev.id, name: ev.name }); Object.assign(a, { label: ev.label, ok: ev.ok, add: ev.add, del: ev.del, check: ev.check || null }); S.status = "Working"; break; }
    case "msgs": if (S.round) S.round.messages.push(...ev.add); S.progress = true; save(); break;
    case "files":
      for (const [p, f] of Object.entries(ev.files)) { const cur = S.s.files[p] || {}; S.s.files[p] = { content: f.content, base: "base" in f ? f.base : cur.base ?? null, mode: f.mode || cur.mode, check: f.check || null }; }
      S.conflict = null; save(); renderChanges(); break;
    case "usage": { const u = r.usage = r.usage || { in: 0, out: 0, cr: 0, cw: 0 }; for (const k in u) u[k] += ev.u[k] || 0; break; }
    case "wait": act(r, { k: "note", s: `Claude is ${ev.why === "rate limit" ? "rate-limited" : "busy"}; trying again in ${ev.s}s.` }); break;
    case "done": case "continue": case "error": return ev;
  }
  return null;
}
async function stream(req, r) {
  S.ctrl = new AbortController();
  const res = await fetch("/api/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...req, pin: S.pin }), signal: S.ctrl.signal });
  if (!/ndjson/.test(res.headers.get("content-type") || "")) {
    let j = {}; try { j = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401) lock("Wrong PIN. Unlock again.");
    return { t: "error", error: j.error || "The update service answered HTTP " + res.status };
  }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "", end = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      end = onEvent(ev, r) || end;
    }
    renderFeed();
    if (done) break;
  }
  return end || { t: "error", retry: true, error: "The connection dropped, so Claude is picking up from its last finished step." };
}
async function send(prompt) {
  prompt = prompt.trim();
  if (S.busy || !prompt) return;
  if (!S.st.configured.claude) return toast("Add ANTHROPIC_API_KEY in Vercel first.");
  const mdl = $("#model").value || S.st.model, files = staged();
  if (!Object.keys(files).length) S.s.baseSha = null; // nothing staged: start from the latest code on GitHub
  const history = S.s.rounds.filter(x => x.status !== "running").slice(-8).map(x => ({ prompt: x.prompt, note: [x.pushed ? `pushed in ${short(x.pushed)}` : "", x.note || ""].filter(Boolean).join("; "),
    summary: x.summary || (x.status === "stopped" ? "(stopped before finishing)" : x.status === "error" ? "(failed: " + (x.error || "error") + ")" : "") }));
  const r = { prompt, model: mdl, at: Date.now(), acts: [], status: "running", usage: { in: 0, out: 0, cr: 0, cw: 0 } };
  S.s.rounds.push(r); S.s.rounds = S.s.rounds.slice(-12);
  S.live = r; S.busy = true; S.round = null; S.status = "Starting";
  $("#prompt").value = ""; store.set("uhe.update.draft", null); save(true); S.scrollFeed = true; renderFeed();
  let req = { action: "step", prompt, model: mdl, history, baseSha: S.s.baseSha, files }, retries = 0;
  const cont = () => ({ action: "step", baseSha: S.s.baseSha, files: staged(), round: S.round });
  try {
    for (let hop = 0; hop < 20; hop++) {
      S.progress = false;
      let end;
      try { end = await stream(req, r); }
      catch (e) { if (e.name === "AbortError" || !S.round) throw e; end = { t: "error", retry: true, error: "The connection dropped, so Claude is picking up from its last finished step." }; await wait(1500); }
      closeLive(r);
      if (S.progress) retries = 0; // a cut-off request that got somewhere doesn't count against the retries
      if (end.t === "continue" && S.round) { req = cont(); continue; }
      if (end.t === "error" && end.retry && S.round && retries < 2) { retries++; act(r, { k: "note", s: end.error }); req = cont(); continue; }
      if (end.t === "done") {
        r.status = end.status === "done" ? "done" : end.status || "done"; r.summary = end.summary || "";
        const last = [...r.acts].reverse().find(a => a.k === "text");
        if (r.status === "done" && last) last.final = true; else if (end.summary) act(r, { k: r.status === "done" ? "text" : "note", s: end.summary, final: r.status === "done" });
      } else { r.status = "error"; r.error = end.error; act(r, { k: "err", s: end.error || "Something went wrong." }); }
      break;
    }
  } catch (e) {
    closeLive(r);
    if (e.name === "AbortError") { r.status = "stopped"; act(r, { k: "note", s: "Stopped. Anything Claude changed before that is kept in step 2." }); }
    else { r.status = "error"; r.error = e.message; act(r, { k: "err", s: "Lost the connection: " + e.message }); }
  } finally {
    if (r.status === "running") r.status = "error";
    S.busy = false; S.live = null; S.ctrl = null; S.round = null; S.status = "";
    save(true); renderFeed(); renderChanges();
    if (r.status === "done" && changes().length) toast(`Claude is done. ${changes().length} file${changes().length === 1 ? "" : "s"} ready to review in step 2.`);
  }
}
$("#askForm").addEventListener("submit", e => { e.preventDefault(); send($("#prompt").value); });
$("#prompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send($("#prompt").value); } });
$("#prompt").addEventListener("input", () => { store.set("uhe.update.draft", $("#prompt").value || null); if (!S.s.rounds.length) $("#ideas").innerHTML = $("#prompt").value ? "" : IDEAS.map(t => `<button type="button" class="upd-idea">${esc(t)}</button>`).join(""); });
$("#ideas").addEventListener("click", e => { const b = e.target.closest(".upd-idea"); if (!b) return; $("#prompt").value = b.textContent; $("#prompt").focus(); $("#ideas").innerHTML = ""; });
$("#model").addEventListener("change", () => store.set("uhe.update.model", $("#model").value));
$("#stop").addEventListener("click", () => { if (S.ctrl) S.ctrl.abort(); });
$("#newChat").addEventListener("click", e => {
  if (!arm(e.target, "Clear chat?")) return;
  S.s.rounds = []; save(true); renderFeed();
  toast(Object.keys(staged()).length ? "Chat cleared. Staged changes are still in step 2." : "Chat cleared.");
});
$("#feed").addEventListener("click", e => { const g = e.target.closest("[data-goto]"); if (g) $("#" + g.dataset.goto).scrollIntoView({ behavior: "smooth", block: "start" }); });
$("#feed").addEventListener("toggle", e => { const d = e.target; if (d.matches && d.matches("details.upd-think")) S.openThink = d.open ? d.dataset.k : S.openThink === d.dataset.k ? null : S.openThink; }, true);
addEventListener("beforeunload", e => { if (S.busy) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- step 2: review & push ---------------- */
function changes() {
  return Object.entries(S.s.files).filter(([, f]) => f.content !== f.base)
    .map(([path, f]) => ({ path, ...f, kind: f.base == null ? "new" : f.content == null ? "deleted" : "edited" })).sort((a, b) => a.path.localeCompare(b.path));
}
const DC = new Map(), fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
function diffOf(f) {
  const key = f.path + "\0" + fnv(f.base || "") + "\0" + fnv(f.content == null ? "\u0000deleted" : f.content);
  if (!DC.has(key)) { const ops = diffLines(f.base, f.content); DC.set(key, { ops, ...stats(ops) }); if (DC.size > 60) DC.delete(DC.keys().next().value); }
  return DC.get(key);
}
function diffHTML(f) {
  const d = diffOf(f), H = hunks(d.ops, 3), max = S.showAll === f.path ? Infinity : 600; let n = 0, cut = false;
  const rows = H.map(h => {
    if (n >= max) { cut = true; return ""; }
    const L = h.lines.slice(0, max - n); n += L.length; if (L.length < h.lines.length) cut = true;
    return `<div class="upd-hunk"><div class="upd-hh">${f.kind === "new" ? "New file" : f.kind === "deleted" ? "Deleted file" : `Line ${h.b || h.a}`}</div>${L.map(l => `<div class="dl${l.t === "+" ? " add" : l.t === "-" ? " del" : ""}"><span class="ln">${l.a ?? ""}</span><span class="ln">${l.b ?? ""}</span><code>${esc(l.s) || " "}</code></div>`).join("")}</div>`;
  }).join("");
  return `<div class="upd-diff">${rows || `<div class="empty">No line changes</div>`}</div>${cut ? `<button class="btn sm ghost" type="button" data-all="${esc(f.path)}">Show the whole diff</button>` : ""}`;
}
function defaultTitle() {
  const R = S.s.rounds.filter(r => !r.pushed && r.status === "done");
  for (const r of R.slice().reverse()) {
    const first = String(r.summary || "").split("\n").map(s => s.trim()).find(Boolean) || "";
    if (first && first.length <= 72 && !/^[-*•#]/.test(first) && !/[.:?]$/.test(first)) return first.replace(/\*\*/g, "");
  }
  const p = (R.length ? R[R.length - 1].prompt : (S.s.rounds.at(-1) || {}).prompt) || "Update from the UHE update page";
  return p.replace(/\s+/g, " ").slice(0, 68) + (p.length > 68 ? "…" : "");
}
function commitMessage(title) {
  const R = S.s.rounds.filter(r => !r.pushed && r.status !== "running");
  const asks = R.map(r => "- " + r.prompt.replace(/\s+/g, " ").slice(0, 240)).join("\n"), who = [...new Set(R.map(r => modelName(r.model)))].join(", ");
  return `${title}\n\n${asks ? "Asked on the UHE update page:\n" + asks + "\n\n" : ""}Edited by Claude${who ? " (" + who + ")" : ""}.`;
}
function renderChanges() {
  const C = changes(), el = $("#changes");
  $("#revCount").textContent = C.length + " file" + (C.length === 1 ? "" : "s");
  $("#revCount").className = "pill " + (C.length ? "cyan" : "neutral");
  if (!C.length) {
    el.innerHTML = `<div class="empty"><strong>No changes waiting</strong>Claude's edits appear here, file by file, before anything is pushed.</div>`;
    $("#pushBox").innerHTML = ""; return;
  }
  el.innerHTML = C.map(f => {
    const d = diffOf(f), open = S.open.has(f.path);
    return `<div class="upd-file${open ? " open" : ""}">
      <button class="upd-file-h" type="button" data-toggle="${esc(f.path)}" aria-expanded="${open}"><span class="pill ${f.kind === "new" ? "long" : f.kind === "deleted" ? "short" : "cyan"}">${f.kind}</span><b class="upd-path">${esc(f.path)}</b>${f.check && f.check.ok === false ? `<span class="pill short" title="${esc(f.check.error)}">syntax error</span>` : ""}<span class="num upd-pm"><em class="up">+${d.add}</em> <em class="down">−${d.del}</em></span><i class="upd-chev" aria-hidden="true"></i></button>
      ${open ? diffHTML(f) + `<div class="upd-file-a"><button class="btn sm ghost danger" type="button" data-discard="${esc(f.path)}">Discard this file</button></div>` : ""}
    </div>`;
  }).join("");
  if (!$("#msg")) {
    $("#pushBox").innerHTML = `<div class="upd-push"><label class="upd-lbl" for="msg">Describe the change</label><input class="inp" id="msg" maxlength="120" autocomplete="off">
      <div id="pushWarn"></div><div id="conflict"></div>
      <div class="upd-push-bar"><button class="btn sm ghost" type="button" id="discardAll">Discard all</button><button class="btn prime" type="button" id="pushBtn">Push to GitHub</button></div>
      <p class="note">Commits to <b>${esc(S.st.branch || "main")}</b> on GitHub. Vercel puts it live in about a minute, and you can undo it here.</p></div>`;
    $("#msg").addEventListener("input", () => { S.msgDraft = $("#msg").value; });
  }
  const msg = $("#msg"); msg.placeholder = defaultTitle(); if (document.activeElement !== msg) msg.value = S.msgDraft ?? defaultTitle();
  const errs = C.filter(f => f.check && f.check.ok === false);
  $("#pushWarn").innerHTML = errs.length ? `<p class="upd-warn">${errs.map(f => esc(f.path)).join(", ")} ${errs.length === 1 ? "has" : "have"} a syntax error, so ${errs.length === 1 ? "that page" : "those pages"} would break. Ask Claude to fix it before pushing.</p>` : "";
  $("#conflict").innerHTML = S.conflict ? `<div class="upd-conflict"><b>GitHub changed underneath these edits</b><p>${esc(S.conflict.error)}</p><p class="note">Push anyway replaces ${S.conflict.conflicts.length === 1 ? "that file" : "those files"} with Claude's version. Or discard and ask again, so Claude starts from the latest code.</p><div class="upd-push-bar"><button class="btn sm ghost" type="button" id="freshStart">Discard and start again</button><button class="btn sm danger" type="button" id="pushAnyway">Push anyway</button></div></div>` : "";
  $("#pushBtn").disabled = S.busy;
}
async function doPush(overwrite) {
  const C = changes(); if (!C.length) return;
  const title = (($("#msg") || {}).value || "").trim() || defaultTitle(), btn = $("#pushBtn");
  btn.disabled = true; btn.textContent = "Pushing…";
  const j = await api("push", { baseSha: S.s.baseSha, message: commitMessage(title), overwrite, files: C.map(f => ({ path: f.path, content: f.content })) });
  btn.disabled = false; btn.textContent = "Push to GitHub"; btn.dataset.armed = ""; btn.classList.remove("warn");
  if (j.ok) {
    S.s.files = {}; S.s.baseSha = j.sha; S.conflict = null; S.msgDraft = null; S.open.clear();
    if (j.noop) { save(true); $("#pushBox").innerHTML = ""; render(); toast("Those files already match GitHub, so there was nothing to push."); return; }
    for (const r of S.s.rounds) if (!r.pushed) r.pushed = j.sha;
    save(true);
    S.push = { sha: j.sha, url: j.url, files: j.files, title, at: Date.now(), state: "building", kind: "push" }; store.set("uhe.update.push", S.push);
    $("#pushBox").innerHTML = ""; render(); toast(`Pushed ${esc(short(j.sha))} to GitHub. Vercel is deploying it.`);
    watchDeploy(j.sha); loadCommits();
  } else if (j.code === "CONFLICT") { S.conflict = j; renderChanges(); }
  else toast(esc(j.error || "Push failed"), 7000);
}
async function doUndo(sha, title) {
  const j = await api("undo", { sha });
  if (!j.ok) return toast(esc(j.error || "Undo failed"), 7000);
  if (!Object.keys(staged()).length) S.s.baseSha = null;
  S.push = { sha: j.sha, url: j.url, files: j.files, title: title || "the last push", at: Date.now(), state: "building", kind: "undo" }; store.set("uhe.update.push", S.push);
  const r = S.s.rounds.at(-1); if (r) r.note = [r.note, `Joey undid commit ${short(sha)}`].filter(Boolean).join("; ");
  save(true); render(); toast(`Undone in ${esc(short(j.sha))}. Vercel is putting the previous version back.`);
  watchDeploy(j.sha); loadCommits();
}
function discardAll() {
  S.s.files = {}; S.s.rounds = []; S.s.baseSha = null; S.conflict = null; S.msgDraft = null; S.open.clear(); save(true);
  $("#pushBox").innerHTML = ""; render(); toast("Discarded. Your next request starts from the latest code on GitHub.");
}
$("#review").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.toggle) { const p = b.dataset.toggle; S.open.has(p) ? S.open.delete(p) : S.open.add(p); renderChanges(); return; }
  if (b.dataset.all) { S.showAll = b.dataset.all; renderChanges(); return; }
  if (b.dataset.discard) {
    if (!arm(b, "Confirm discard")) return;
    const p = b.dataset.discard; delete S.s.files[p]; S.open.delete(p);
    const r = S.s.rounds.filter(x => !x.pushed).at(-1); if (r) r.note = [r.note, `Joey discarded the changes to ${p}`].filter(Boolean).join("; ");
    save(true); renderChanges(); return;
  }
  if (b.id === "discardAll") { if (arm(b, "Discard everything?")) discardAll(); return; }
  if (b.id === "freshStart") { discardAll(); return; }
  if (b.id === "pushBtn") { if (arm(b, "Tap again to push live")) doPush(false); return; }
  if (b.id === "pushAnyway") { if (arm(b, "Overwrite on GitHub?")) doPush(true); return; }
  if (b.id === "undoPush") { if (arm(b, "Tap again to undo")) doUndo(S.push.sha, S.push.title); return; }
  if (b.id === "hidePush") { S.push = null; store.set("uhe.update.push", null); renderPushResult(); return; }
  if (b.dataset.undo) { if (arm(b, "Undo it?")) doUndo(b.dataset.undo, b.dataset.title); return; }
});

async function watchDeploy(sha) {
  if (S.watching === sha) return; S.watching = sha;
  const t0 = Date.now(); let built = 0;
  try {
    while (S.push && S.push.sha === sha && Date.now() - t0 < 10 * 60e3) {
      await wait(5000);
      if (document.hidden || !S.info) continue;
      const [d, st] = await Promise.all([api("deploy", { sha }), fetch("/api/update", { cache: "no-store" }).then(r => r.json()).catch(() => null)]);
      if (!S.push || S.push.sha !== sha) return;
      if (d && d.ok && d.github) {
        S.push.vercel = d.github.url || S.push.vercel;
        if (d.github.state === "failure" || d.github.state === "error") { S.push.state = "failed"; break; }
        if (d.github.state === "success" && S.push.state !== "deployed") { S.push.state = "deployed"; built = Date.now(); }
      }
      if (st && st.deployed) S.st.deployed = st.deployed;
      const live = st && st.deployed && st.deployed.sha;
      if (live === sha || (S.push.state === "deployed" && (!live || Date.now() - built > 60e3))) { S.push.state = "live"; break; }
      store.set("uhe.update.push", S.push); renderPushResult();
    }
    if (S.push && S.push.sha === sha) {
      if (!["live", "failed"].includes(S.push.state)) S.push.state = "unknown";
      store.set("uhe.update.push", S.push); renderPushResult(); renderChips(); renderCommits();
      if (S.push.state === "live") toast(S.push.kind === "undo" ? "The previous version is live again." : "Live ✓ The site is running your change.");
      if (S.push.state === "failed") toast("Vercel couldn't build that version, so the site is unchanged.", 8000);
    }
  } finally { if (S.watching === sha) S.watching = null; }
}
function renderPushResult() {
  const p = S.push, el = $("#pushResult");
  if (!p) { el.innerHTML = ""; return; }
  const ST = { building: ["warn", "Vercel is building it…"], deployed: ["warn", "Built · switching the live site…"], live: ["ok", "Live on the site"], failed: ["bad", "Vercel build failed"], unknown: ["warn", "Couldn't confirm the deploy"] };
  const [cls, txt] = ST[p.state] || ST.building;
  el.innerHTML = `<div class="upd-pushed ${cls}">
    <div class="upd-pushed-h"><span class="chip ${cls}"><span class="dot"></span>${txt}</span><a class="num" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(short(p.sha))}</a></div>
    <b>${p.kind === "undo" ? "Undo: " : ""}${esc(p.title)}</b>
    <small class="muted">${p.files ? p.files.length + " file" + (p.files.length === 1 ? "" : "s") + " · " : ""}${when(new Date(p.at).toISOString())}</small>
    ${p.state === "failed" ? `<p class="upd-warn">The live site is still on the previous version. Open Vercel to see the error, then ask Claude to fix it, or undo this push.</p>` : ""}
    ${p.state === "unknown" ? `<p class="note">GitHub has the commit. Check the deploy on Vercel.</p>` : ""}
    <div class="upd-push-bar">${p.state === "live" ? `<a class="btn sm" href="/" target="_blank" rel="noopener">Open the site</a>` : ""}${p.vercel ? `<a class="btn sm ghost" href="${esc(p.vercel)}" target="_blank" rel="noopener">Vercel</a>` : ""}${p.kind !== "undo" ? `<button class="btn sm ghost danger" type="button" id="undoPush">Undo this push</button>` : ""}<button class="btn sm ghost" type="button" id="hidePush">Hide</button></div>
  </div>`;
}
async function loadCommits() { const j = await api("commits"); if (j.ok) { S.commits = j.commits; renderCommits(); } }
function renderCommits() {
  const el = $("#commits"), C = S.commits;
  if (!C) { el.innerHTML = `<div class="empty">${S.st && S.st.configured.github ? "Couldn't load commits." : "Add GITHUB_TOKEN to see them."}</div>`; return; }
  const live = S.st && S.st.deployed && S.st.deployed.sha;
  el.innerHTML = C.map(c => `<div class="upd-commit"><div class="upd-commit-t"><b>${esc(c.title)}</b><small class="muted"><span class="num">${esc(short(c.sha))}</span> · ${ago(c.date)}${c.author ? " · " + esc(c.author) : ""}${c.sha === live ? ' · <span class="up">live now</span>' : ""}</small></div>
    <div class="upd-commit-a"><a class="btn sm ghost" href="${esc(c.url)}" target="_blank" rel="noopener">View</a>${c.parents === 1 ? `<button class="btn sm ghost" type="button" data-undo="${esc(c.sha)}" data-title="${esc(c.title)}">Undo</button>` : ""}</div></div>`).join("")
    + `<p class="note">Undo makes a new commit that puts back the files that commit changed.</p>`;
}

/* ---------------- step 3: data engine ---------------- */
const JOBS = [["scan-hist", "Stock history"], ["options", "Options"], ["fund", "Analysts & holders"], ["news", "News & filings"], ["patterns", "Chart patterns"], ["flow", "COT & FINRA"], ["calendar", "Calendar"]];
const RUN_ST = r => r.status !== "completed" ? (r.status === "in_progress" ? ["warn", "Running…"] : ["warn", "Queued"]) : r.conclusion === "success" ? ["ok", "Done"] : r.conclusion === "cancelled" ? ["bad", "Cancelled"] : r.conclusion === "skipped" ? ["bad", "Skipped"] : ["bad", "Failed"];
function renderEngine() {
  const E = S.eng, gh = S.st && S.st.configured.github;
  $$("#engMode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === E.mode)));
  const jobs = $("#engJobs"); jobs.hidden = E.mode !== "pick";
  jobs.innerHTML = JOBS.map(([k, t]) => `<button type="button" class="upd-job" data-j="${k}" aria-pressed="${E.jobs.includes(k)}">${t}</button>`).join("") + `<p class="note">Quotes, markets, the scanner and the market pulse refresh on every run anyway.</p>`;
  const running = E.cur && E.cur.status !== "completed", btn = $("#engRun");
  btn.disabled = !gh || !!E.starting; btn.textContent = E.starting ? "Starting…" : running ? "Queue another run" : "Run data engine";
  const R = E.cur;
  if (!R) $("#engNow").innerHTML = "";
  else {
    const [cls, txt] = RUN_ST(R), steps = (R.steps || []).filter(s => !/^(Set up job|Complete job|Post )/.test(s.name));
    $("#engNow").innerHTML = `<div class="upd-run ${cls}"><div class="upd-pushed-h"><span class="chip ${cls}"><span class="dot"></span>${txt}</span>${R.url ? `<a href="${esc(R.url)}" target="_blank" rel="noopener">Open on GitHub</a>` : ""}</div>
      ${steps.length ? `<ol class="upd-steps">${steps.map(s => `<li class="${s.conclusion === "success" ? "ok" : s.conclusion === "failure" ? "bad" : s.status === "in_progress" ? "run" : s.conclusion === "skipped" ? "skip" : ""}"><i aria-hidden="true"></i><span>${esc(s.name)}</span><small class="num">${s.started && s.done ? span(s.started, s.done) : ""}</small></li>`).join("")}</ol>`
        : R.status !== "completed" ? `<p class="note">${R.status === "in_progress" ? "Starting up…" : "Waiting for GitHub to start it. If a scheduled run is going, this one starts after it."}</p>` : ""}
      <small class="muted">${R.event === "schedule" ? "Scheduled run" : "Manual run"} · started ${R.created ? when(R.created) : "now"}${R.status === "completed" ? " · took " + span(R.started || R.created, R.updated) : ""}</small></div>`;
  }
  const L = E.log;
  $("#engLog").innerHTML = L && L.log ? `<div class="upd-log"><div class="eyebrow">Last refresh · ${esc(when(L.asOf))} (${ago(L.asOf)})</div><ul>${L.log.map(l => `<li class="${/FAILED/.test(l) ? "bad" : /: fresh/.test(l) ? "fresh" : "ok"}">${esc(l.replace(/ \((\d{4}-[^)]+)\)$/, (m, iso) => ` (from ${when(iso)})`))}</li>`).join("")}</ul></div>` : "";
  const RS = E.runs;
  $("#engRuns").innerHTML = !gh ? `<div class="empty">Add GITHUB_TOKEN to see runs.</div>` : !RS ? `<div class="empty">Couldn't load runs.</div>` : !RS.length ? `<div class="empty">No runs yet.</div>`
    : RS.map(r => { const [cls, txt] = RUN_ST(r); return `<a class="upd-runrow" href="${esc(r.url)}" target="_blank" rel="noopener"><span class="chip ${cls}"><span class="dot"></span>${txt}</span><span>${r.event === "schedule" ? "Scheduled" : r.event === "workflow_dispatch" ? "Manual" : esc(r.event)}</span><span class="num muted">${esc(when(r.created))}</span><span class="num muted">${r.status === "completed" ? span(r.started || r.created, r.updated) : ""}</span></a>`; }).join("")
      + `<p class="note">GitHub runs the schedule (every 10 minutes) on a best-effort basis, so it's often much less frequent. Run it here before the open for fresh numbers.</p>`;
}
async function loadRuns() { const j = await api("runs"); if (j.ok) { S.eng.runs = j.runs; renderEngine(); } }
async function loadLog() { if (!(S.st && S.st.configured.github)) return; const j = await api("log"); if (j.ok) { S.eng.log = j.log; renderEngine(); } }
async function pollRun() {
  if (S.eng.polling) return; S.eng.polling = true;
  try {
    while (S.eng.cur && S.eng.cur.id && S.eng.cur.status !== "completed" && S.info) {
      await wait(4000);
      if (document.hidden) continue;
      const j = await api("run", { id: S.eng.cur.id });
      if (j.ok) { S.eng.cur = j.run; renderEngine(); }
    }
    if (S.eng.cur && S.eng.cur.status === "completed") {
      await Promise.all([loadLog(), loadRuns()]);
      const c = S.eng.cur.conclusion;
      if (S.eng.mine === S.eng.cur.id) toast(c === "success" ? "Data engine finished ✓ Fresh data is live." : `Data engine ${c === "cancelled" ? "was cancelled" : "failed"}. Open it on GitHub for details.`, 6000);
    }
  } finally { S.eng.polling = false; }
}
$("#engMode").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; S.eng.mode = b.dataset.m; store.set("uhe.update.engMode", S.eng.mode); renderEngine(); });
$("#engJobs").addEventListener("click", e => { const b = e.target.closest("[data-j]"); if (!b) return; const k = b.dataset.j, J = S.eng.jobs; S.eng.jobs = J.includes(k) ? J.filter(x => x !== k) : [...J, k]; store.set("uhe.update.engJobs", S.eng.jobs); renderEngine(); });
$("#engRun").addEventListener("click", async () => {
  const E = S.eng, force = E.mode === "all" ? "all" : E.mode === "pick" ? E.jobs.join(",") : "";
  if (E.mode === "pick" && !force) return toast("Choose at least one thing to refresh.");
  E.starting = true; renderEngine();
  const j = await api("engine", { force });
  E.starting = false;
  if (!j.ok) { renderEngine(); return toast(esc(j.error || "Couldn't start the data engine."), 7000); }
  E.cur = { id: j.id, url: j.url, status: "queued", event: "workflow_dispatch", created: new Date().toISOString(), steps: null }; E.mine = j.id;
  renderEngine(); toast("Data engine started on GitHub.");
  if (j.id) pollRun(); else setTimeout(loadRuns, 5000);
});
setInterval(() => { if (S.info && !document.hidden && !S.eng.polling) loadRuns(); }, 60e3);

/* ---------------- boot ---------------- */
$("#chips").addEventListener("click", e => { if (e.target.id === "lockBtn") lock(); });
(async () => {
  try { const r = await fetch("/api/update", { cache: "no-store" }); S.st = r.ok ? await r.json() : null; } catch { S.st = null; }
  if (S.st && S.st.configured && S.pin && await unlock(S.pin, true)) return;
  renderLock();
})();
