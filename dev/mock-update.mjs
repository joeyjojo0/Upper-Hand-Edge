// Offline mock of /api/update for the dev server and UI tests. PIN: "demo-pin-123".
// "step" streams a scripted Claude round that edits public/styles.css. A prompt containing "long" also hands
// back mid-round ("continue") and edits public/app.js on the second call; "fail" returns an error.
import { readFileSync } from "node:fs";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const hex = () => Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const PIN = "demo-pin-123";
const MODELS = [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5 · fast", price: [2, 10, 2.5, 0.1] }, { id: "claude-opus-5-5", label: "Opus 5.5 · strongest", price: [4, 20, 5, 0.2] }];
const M = {
  live: "e666ddfe2c099ff68c82facbcf24c883708a4efc", pushedAt: {}, pending: null, run: null, n: 0,
  commits: [["e666ddfe2c099ff68c82facbcf24c883708a4efc", "Engine: actions on Node 24", 70], ["5403b4c33da468115320372182c531b69a96c691", "9 confluences: insiders, firms, chart patterns", 82],
    ["7cafb61aa2d3d8ff1e88f7b24b51f0a6cfe6b3c1", "Pro news + retail sources", 13400]].map(([sha, title, m]) => ({ sha, title, date: new Date(Date.now() - m * 60e3).toISOString(), author: "joeyjojo0", parents: 1, url: "https://github.com/joeyjojo0/Upper-Hand-Edge/commit/" + sha })),
  runs: [{ id: 39131008229, status: "completed", conclusion: "success", event: "schedule", created: new Date(Date.now() - 55 * 60e3).toISOString(), started: new Date(Date.now() - 55 * 60e3).toISOString(), updated: new Date(Date.now() - 54 * 60e3).toISOString(), url: "https://github.com/joeyjojo0/Upper-Hand-Edge/actions/runs/39131008229" },
    { id: 39128948633, status: "completed", conclusion: "success", event: "workflow_dispatch", created: new Date(Date.now() - 84 * 60e3).toISOString(), started: new Date(Date.now() - 84 * 60e3).toISOString(), updated: new Date(Date.now() - 76 * 60e3).toISOString(), url: "https://github.com/joeyjojo0/Upper-Hand-Edge/actions/runs/39128948633" }]
};
const STEPS = ["Set up job", "Run actions/checkout@v5", "Run actions/setup-node@v5", "Run actions/setup-python@v6", "Start Yahoo relay", "Fetch previous snapshots", "Build data", "Publish to data branch", "Complete job"];
function runNow(r) {
  const t = (Date.now() - Date.parse(r.created)) / 1000;
  if (t < 3) return { ...r, status: "queued", steps: [] };
  const done = Math.min(STEPS.length, Math.floor((t - 3) / 1.6));
  const steps = STEPS.map((name, i) => ({ name, status: i < done ? "completed" : i === done ? "in_progress" : "queued", conclusion: i < done ? "success" : null,
    started: i <= done ? new Date(Date.parse(r.created) + (3 + i * 1.6) * 1000).toISOString() : null, done: i < done ? new Date(Date.parse(r.created) + (4.6 + i * 1.6) * 1000).toISOString() : null }));
  return done >= STEPS.length ? { ...r, status: "completed", conclusion: "success", updated: now(), steps } : { ...r, status: "in_progress", steps };
}
const status = () => ({ configured: { claude: true, github: true, pin: true }, ready: true, pinVar: "UPDATE_PIN", repo: "joeyjojo0/Upper-Hand-Edge", branch: "main", workflow: "data.yml",
  models: MODELS, model: MODELS[0].id, deployed: { sha: M.live, ref: "main", env: "production" }, asOf: now() });

async function step(res, b) {
  const send = o => res.write(JSON.stringify(o) + "\n");
  res.statusCode = 200; res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  const say = async (t, text, ms = 18) => { for (const part of text.match(/.{1,6}/gs)) { send({ t, d: part }); await sleep(ms); } };
  const prompt = b.prompt || "", long = /long/i.test(prompt) || (b.round && /long/i.test(JSON.stringify(b.round.messages[0])));
  send({ t: "base", sha: b.baseSha || M.live, branch: "main" });
  if (prompt) send({ t: "round", model: b.model || MODELS[0].id, system: "(mock system prompt)", first: { role: "user", content: prompt } });
  await sleep(250);
  if (/fail/i.test(prompt)) { send({ t: "error", code: "CLAUDE", error: "Claude rejected ANTHROPIC_API_KEY. Check the key in Vercel." }); return res.end(); }
  const usage = () => send({ t: "usage", u: { in: 2400, out: 380, cr: 5200, cw: 1800 } });
  const msgs = n => send({ t: "msgs", add: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "mock" }] })) });
  if (!b.round) {
    send({ t: "turn", n: 1 }); send({ t: "think_start" });
    await say("think", "Joey wants the countdown ring to change colour near the open. The ring is drawn in public/app.js and styled in public/styles.css, so I'll look there.");
    await say("text", "I'll find where the countdown ring is styled first.");
    send({ t: "tool_start", id: "m1", name: "search" }); await sleep(300); send({ t: "tool_start", id: "m2", name: "read_file" }); usage(); await sleep(200);
    send({ t: "tool", id: "m1", name: "search", ok: true, label: "Searched “ring” · 14 matches in 3 files" });
    send({ t: "tool", id: "m2", name: "read_file", ok: true, label: "Read public/styles.css · lines 90–120 of 545", path: "public/styles.css" });
    msgs(2); await sleep(300);
    if (long) { send({ t: "continue", status: "continue" }); return res.end(); }
  }
  send({ t: "turn", n: 2 }); send({ t: "tool_start", id: "m3", name: "edit_file" });
  for (let n = 200; n <= 900; n += 350) { await sleep(250); send({ t: "tool_input", id: "m3", n }); }
  const css = read("public/styles.css"), anchor = ".ring-sub{font-size:12.5px;color:var(--ink-2)}";
  const cssNew = css.replace(anchor, anchor + "\n.ring.late .t{color:var(--amber);text-shadow:0 0 24px rgba(255,200,87,.6)}\n.ring.late .cap{color:var(--amber)}");
  usage(); await sleep(200);
  send({ t: "tool", id: "m3", name: "edit_file", ok: true, label: "Edited public/styles.css", path: "public/styles.css", add: 2, del: 0, check: { ok: true, error: null } });
  const files = { "public/styles.css": { content: cssNew, base: css, mode: "100644", check: { ok: true, error: null } } };
  if (long) {
    const js = read("public/app.js"), a = '$("#ringEyebrow").textContent = eyebrow;';
    files["public/app.js"] = { content: js.replace(a, a + '\n  $("#ring").classList.toggle("late", c.state !== "open" && c.open - Date.now() < 10 * 60e3);'), base: js, mode: "100644", check: { ok: true, error: null } };
    send({ t: "tool", id: "m4", name: "edit_file", ok: true, label: "Edited public/app.js", path: "public/app.js", add: 1, del: 0, check: { ok: true, error: null } });
  }
  send({ t: "files", files }); msgs(2); await sleep(300);
  send({ t: "turn", n: 3 });
  await say("text", "Amber countdown ring in the last 10 minutes\n- The countdown ring on the dashboard turns amber 10 minutes before the NY open (from 14:20 UK).\n- Changed `public/styles.css`" + (long ? " and `public/app.js`." : "."));
  usage(); msgs(1);
  send({ t: "done", status: "done", summary: "Amber countdown ring in the last 10 minutes\n- The countdown ring on the dashboard turns amber 10 minutes before the NY open (from 14:20 UK).\n- Changed public/styles.css." });
  res.end();
}

export async function handleUpdate(req) {
  if (!req || req.method !== "POST") {
    if (M.pending && Date.now() - M.pushedAt[M.pending] > 9000) { M.live = M.pending; M.pending = null; }
    return status();
  }
  let s = ""; for await (const ch of req) s += ch; const b = JSON.parse(s || "{}");
  if (b.pin !== PIN) { await sleep(400); return { ok: false, code: "BAD_PIN", error: "Wrong PIN", __status: 401 }; }
  switch (b.action) {
    case "check": return { ok: true, ...status(), commits: M.commits, runs: M.run ? [runNow(M.run), ...M.runs] : M.runs };
    case "step": return { __stream: res => step(res, b) };
    case "commits": return { ok: true, commits: M.commits };
    case "push": case "undo": {
      await sleep(700);
      if (b.action === "push" && /conflict/i.test(b.message || "") && !b.overwrite) return { ok: false, code: "CONFLICT", error: "This file was changed on GitHub after Claude started: public/styles.css.", conflicts: ["public/styles.css"], __status: 409 };
      const sha = hex(), title = b.action === "undo" ? "Undo: " + ((M.commits.find(c => c.sha === b.sha) || {}).title || "change") : String(b.message || "").split("\n")[0];
      M.commits.unshift({ sha, title, date: now(), author: "joeyjojo0", parents: 1, url: "https://github.com/joeyjojo0/Upper-Hand-Edge/commit/" + sha });
      M.pushedAt[sha] = Date.now(); M.pending = sha;
      return { ok: true, sha, parent: M.live, url: "https://github.com/joeyjojo0/Upper-Hand-Edge/commit/" + sha, files: b.action === "undo" ? ["public/styles.css"] : (b.files || []).map(f => f.path), ...(b.action === "undo" ? { undid: b.sha } : {}) };
    }
    case "deploy": { const t = Date.now() - (M.pushedAt[b.sha] || 0); return { ok: true, github: t < 6000 ? { state: "pending", url: "https://vercel.com/mock/deploy", text: "Building" } : { state: "success", url: "https://vercel.com/mock/deploy", text: "Deployment has completed" }, live: M.live }; }
    case "engine": M.run = { id: 40000000000 + ++M.n, status: "queued", conclusion: null, event: "workflow_dispatch", created: now(), started: now(), updated: now(), url: "https://github.com/joeyjojo0/Upper-Hand-Edge/actions" }; return { ok: true, id: M.run.id, url: M.run.url, force: b.force || "" };
    case "runs": { if (M.run) { const r = runNow(M.run); if (r.status === "completed") { M.runs.unshift(r); M.run = null; } return { ok: true, runs: r.status === "completed" ? M.runs : [r, ...M.runs] }; } return { ok: true, runs: M.runs }; }
    case "run": { const r = M.run && M.run.id === +b.id ? runNow(M.run) : M.runs.find(x => x.id === +b.id); return r ? { ok: true, run: { steps: [], ...r } } : { ok: false, error: "No such run" }; }
    case "log": return { ok: true, log: { asOf: new Date(Date.now() - (M.runs[0] && M.runs[0].event === "workflow_dispatch" ? 1 : 54) * 60e3).toISOString(), log: ["quotes: ok in 0.2s", "basis: ok in 1.2s", "markets: ok in 2.4s", "scan-hist: fresh (2026-10-18T12:54:46.200Z)", "scan: ok in 2.9s", "options: ok in 17.9s", "fund: fresh (2026-10-18T12:56:32.363Z)", "pulse: ok in 0.6s", "news: FAILED Yahoo HTTP 429", "patterns: ok in 2.1s (105 stocks)", "flow: fresh (2026-10-18T12:57:46.089Z)", "calendar: fresh (2026-10-18T12:58:01.000Z)"] } };
    default: return { ok: false, error: "Unknown action", __status: 400 };
  }
}
