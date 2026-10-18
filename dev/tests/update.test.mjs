// /update page backend tests: repo snapshot (tar), Claude's tools, the streaming tool loop against a scripted
// fake of the Claude Messages API, and Push / Undo / data engine against a fake GitHub API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import handler, { readConfig, status } from "../../api/update.js";
import { untar, filesFromTar, pushFiles, undoCommit, runEngine, cleanForce, ghConfig } from "../../api/_lib/github.js";
import { Workspace, runTool, checkSyntax, runRound, roundPrompt, lineDelta, TOOLS } from "../../api/_lib/agent.js";
import { diffLines, hunks, stats } from "../../public/diff.js";

/* ---------------- helpers: tarballs, SSE, fake APIs ---------------- */
function hdr(name, size, type = "0", mode = 0o644) {
  const b = Buffer.alloc(512);
  b.write(name.slice(0, 100), 0, "utf8"); b.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  b.write("0000000\0", 108); b.write("0000000\0", 116); b.write(size.toString(8).padStart(11, "0") + "\0", 124); b.write("00000000000\0", 136);
  b.write("        ", 148); b.write(type, 156); b.write("ustar\0", 257); b.write("00", 263);
  let sum = 0; for (const x of b) sum += x; b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return b;
}
const pad = buf => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
function paxRec(k, v) { const body = ` ${k}=${v}\n`; let n = body.length + 1; while (String(n).length + body.length !== n) n++; return n + body; }
function tarOf(files, top = "joeyjojo0-Upper-Hand-Edge-abc1234") {
  const parts = [hdr("pax_global_header", 52, "g"), pad(Buffer.from(paxRec("comment", "a".repeat(40))))];
  parts.push(hdr(top + "/", 0, "5", 0o755));
  for (const [p, c] of Object.entries(files)) {
    const data = Buffer.isBuffer(c) ? c : Buffer.from(c), full = `${top}/${p}`;
    if (full.length > 99) { const rec = Buffer.from(paxRec("path", full)); parts.push(hdr("PaxHeader", rec.length, "x"), pad(rec)); }
    parts.push(hdr(full.slice(0, 99), data.length, "0", p.endsWith(".sh") ? 0o755 : 0o644), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const REPO = {
  "README.md": "# UHE\nTest repo.\n",
  "public/app.js": 'import { x } from "./model.js";\nconst ring = "cyan";\nexport function draw() {\n  return ring;\n}\n',
  "public/styles.css": ":root{--cyan:#00E5FF}\n.ring{color:var(--cyan)}\n",
  "public/aio-logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]),
  ["deep/" + "nested/".repeat(14) + "long-file-name.txt"]: "pax path\n",
  "tools/run.sh": "#!/bin/sh\necho hi\n"
};
const TARBALL = gzipSync(tarOf(REPO));
const HEAD = "1".repeat(40), NEXT = "2".repeat(40), NEW = "3".repeat(40);

function sseResponse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const enc = new TextEncoder().encode(text); let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i >= enc.length) return c.close(); const n = 1 + Math.floor(Math.random() * 90); c.enqueue(enc.slice(i, i + n)); i += n; } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
// A scripted Claude turn: blocks are streamed the way the Messages API does.
function turn(blocks, stop = "tool_use", usage = { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 300, output_tokens: 90 }) {
  const ev = [{ type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [], usage } }];
  blocks.forEach((b, i) => {
    if (b.type === "thinking") { ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } }, { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } }, { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: b.signature } }); }
    if (b.type === "text") { ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); for (const part of b.text.match(/.{1,7}/gs)) ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } }); }
    if (b.type === "tool_use") { const js = b.raw ?? JSON.stringify(b.input); ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); for (const part of js.match(/.{1,11}/gs) || []) ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: part } }); }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } }, { type: "message_stop" });
  return ev;
}
function fakeClaude(turns, { errors = [] } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    calls.push(JSON.parse(opts.body));
    if (errors.length) { const [st, msg] = errors.shift(); return new Response(JSON.stringify({ type: "error", error: { message: msg } }), { status: st }); }
    const t = turns.shift(); assert.ok(t, "unexpected extra Claude call");
    return sseResponse(t);
  };
  f.calls = calls;
  return f;
}
function fakeGitHub({ head = HEAD, compareFiles = [], dispatch = "run", raceOnce = false } = {}) {
  const calls = []; let tip = head, raced = !raceOnce;
  const json = (b, st = 200, h = {}) => new Response(b == null ? null : JSON.stringify(b), { status: st, headers: { "content-type": "application/json", ...h } });
  const f = async (url, opts = {}) => {
    const u = new URL(url), p = u.pathname.replace("/repos/joeyjojo0/Upper-Hand-Edge", ""), m = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ m, p: p + u.search, body });
    if (m === "GET" && p === "/git/ref/heads/main") return json({ object: { sha: tip } });
    if (m === "GET" && p.startsWith("/tarball/")) return new Response(TARBALL, { status: 200 });
    if (m === "GET" && p.startsWith("/compare/")) return json({ status: "ahead", files: compareFiles.map(filename => ({ filename })) });
    if (m === "GET" && p.startsWith("/git/commits/")) return json({ sha: p.split("/").pop(), tree: { sha: "tree-" + p.split("/").pop().slice(0, 6) } });
    if (m === "POST" && p === "/git/trees") return json({ sha: body.tree.length ? "newtree" : "tree-" + tip.slice(0, 6) });
    if (m === "POST" && p === "/git/commits") return json({ sha: NEW });
    if (m === "PATCH" && p === "/git/refs/heads/main") { if (!raced) { raced = true; tip = NEXT; return json({ message: "Update is not a fast forward" }, 422); } tip = body.sha; return json({ object: { sha: body.sha } }); }
    if (m === "GET" && p === `/commits/${HEAD}`) return json({ sha: HEAD, parents: [{ sha: "0".repeat(40) }], commit: { message: "Gold ring\n\nbody" }, files: [{ filename: "public/app.js", status: "modified" }, { filename: "public/new.js", status: "added" }, { filename: "public/b.js", previous_filename: "public/a.js", status: "renamed" }] });
    if (m === "GET" && p.startsWith("/git/trees/")) return json({ truncated: false, tree: [{ path: "public/app.js", mode: "100644", type: "blob", sha: "blob-app" }, { path: "public/a.js", mode: "100644", type: "blob", sha: "blob-a" }] });
    if (m === "POST" && p === "/actions/workflows/data.yml/dispatches") {
      if (dispatch === "old" && "return_run_details" in body) return json({ message: "Invalid request.\n\n\"return_run_details\" is not a permitted key." }, 422);
      return dispatch === "run" ? json({ workflow_run_id: 77, run_url: "x", html_url: "https://github.com/run/77" }) : new Response(null, { status: 204 });
    }
    if (m === "GET" && p === "/actions/workflows/data.yml/runs") return json({ workflow_runs: [{ id: 78, status: "queued", conclusion: null, event: "workflow_dispatch", created_at: new Date().toISOString(), html_url: "https://github.com/run/78", head_sha: tip }] });
    if (m === "GET" && p === `/commits/${NEW}/status`) return json({ state: "pending", statuses: [{ context: "Vercel", state: "pending", target_url: "https://vercel.com/d/1", description: "Building" }] });
    return json({ message: "Not Found" }, 404);
  };
  f.calls = calls;
  return f;
}
const ENV = { ANTHROPIC_API_KEY: "sk-test", GITHUB_TOKEN: "ghp-test", UPDATE_PIN: "correct horse", GITHUB_REPO: "joeyjojo0/Upper-Hand-Edge", VERCEL_GIT_COMMIT_SHA: HEAD };
function call(body, { method = "POST", env = ENV, headers = {}, deps = {} } = {}) {
  return new Promise(resolve => {
    let raw = "";
    const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, write(s) { raw += s; return true; }, on() {}, off() {},
      end(s) { if (s) raw += s; const ct = this.h["Content-Type"] || ""; resolve({ code: this.statusCode, ct, body: ct.includes("ndjson") ? raw.trim().split("\n").map(l => JSON.parse(l)) : JSON.parse(raw) }); } };
    const req = { method, headers: { host: "uhe.test", ...headers }, body };
    handler(req, res, { pinDelay: 0, sleep: async () => {}, cfg: readConfig(env), ...deps });
  });
}
const files = () => filesFromTar(untar(gunzipSync(TARBALL)));

/* ---------------- tests ---------------- */
test("tarball: GitHub layout, pax long paths, binary detection, modes", () => {
  const F = files();
  assert.deepEqual([...F.keys()].sort(), Object.keys(REPO).sort());
  assert.equal(F.get("public/app.js").content, REPO["public/app.js"]);
  assert.equal(F.get("public/aio-logo.png").binary, true);
  assert.equal(F.get("public/aio-logo.png").content, null);
  assert.equal(F.get("tools/run.sh").mode, "100755");
  assert.ok(F.has("deep/" + "nested/".repeat(14) + "long-file-name.txt"));
});

test("tools: list, read, search, edit, write, delete, guards", async () => {
  const ws = new Workspace(files(), {});
  assert.match((await runTool(ws, "list_files", { dir: "public" })).text, /public\/app\.js .*\npublic\/styles\.css/s);
  const r = await runTool(ws, "read_file", { path: "public/app.js", offset: 2, limit: 2 });
  assert.match(r.text, /showing 2–3\n {5}2\tconst ring = "cyan";\n {5}3\texport function draw/);
  assert.equal(r.label, "Read public/app.js · lines 2–3 of 5");
  assert.match((await runTool(ws, "search", { query: "ring" })).label, /3 matches in 2 files/);
  assert.match((await runTool(ws, "search", { query: "RING", ignore_case: true, path: "public/styles" })).text, /public\/styles\.css:2:/);
  await assert.rejects(runTool(ws, "edit_file", { path: "public/app.js", old_text: "ring", new_text: "x" }), /appears 2 times/);
  await assert.rejects(runTool(ws, "edit_file", { path: "public/app.js", old_text: "const ring = 'cyan';", new_text: "x" }), /wasn't found/);
  const e = await runTool(ws, "edit_file", { path: "public/app.js", old_text: 'const ring = "cyan";', new_text: 'const ring = "gold";\nconst glow = 1;' });
  assert.deepEqual([e.add, e.del, e.check.ok], [2, 1, true]);
  assert.ok(ws.isStaged("public/app.js"));
  const broken = await runTool(ws, "edit_file", { path: "public/app.js", old_text: "return ring;", new_text: "return ring;;)" });
  assert.equal(broken.check.ok, false); assert.match(broken.text, /Syntax check FAILED[\s\S]*public\/app\.js:/);
  await runTool(ws, "edit_file", { path: "public/app.js", old_text: "return ring;;)", new_text: "return ring;" });
  const w = await runTool(ws, "write_file", { path: "public/new.js", content: "export const a = 1;\n" });
  assert.equal(w.label, "Created public/new.js");
  await runTool(ws, "write_file", { path: "public/new.js", content: "export const b = 2;", append: true });
  assert.equal(ws.read("public/new.js"), "export const a = 1;\nexport const b = 2;");
  assert.equal((await runTool(ws, "delete_file", { path: "README.md" })).label, "Deleted README.md");
  assert.equal(ws.exists("README.md"), false);
  await assert.rejects(runTool(ws, "read_file", { path: "README.md" }), /doesn't exist/);
  await assert.rejects(runTool(ws, "read_file", { path: "public/aio-logo.png" }), /binary/);
  await assert.rejects(runTool(ws, "write_file", { path: "../x.js", content: "" }), /isn't a valid path/);
  await assert.rejects(runTool(ws, "write_file", { path: ".git/config", content: "" }), /can't be edited/);
  await assert.rejects(runTool(ws, "write_file", { path: "api/.env.local", content: "KEY=1" }), /Secrets never go in the repo/);
  assert.equal((await runTool(ws, "write_file", { path: ".env.example", content: "NEW_KEY=\n" })).label, "Created .env.example");
  assert.deepEqual(ws.staging(), [".env.example", "README.md", "public/app.js", "public/new.js"]);
  assert.deepEqual(lineDelta("a\nb\nc\n", "a\nX\nY\nc\n"), { add: 2, del: 1 });
  assert.equal((await checkSyntax("a.json", "{\"a\":1}")).ok, true);
  assert.equal((await checkSyntax("a.css", "a{b:c}}")).ok, false);
  assert.equal((await checkSyntax("a.html", "<script>x</script><script>")).ok, false);
  assert.equal((await checkSyntax("a.js", "const a = ;")).ok, false);
  assert.equal((await checkSyntax("a.md", "anything")).skipped, true);
  assert.deepEqual(TOOLS.map(t => t.name), ["list_files", "read_file", "search", "edit_file", "write_file", "delete_file"]);
});

test("round prompt carries earlier requests and staged files", () => {
  const p = roundPrompt({ prompt: "Make it gold", history: [{ prompt: "Add a button", summary: "Added it", note: "Joey discarded public/x.js" }], staged: ["public/app.js"] });
  assert.match(p, /1\. Joey asked: Add a button\n {3}You replied: Added it\n {3}Since then: Joey discarded public\/x\.js/);
  assert.match(p, /Staged changes .*: public\/app\.js/);
  assert.ok(p.endsWith("Joey's request:\nMake it gold"));
});

test("tool loop: streams, runs tools, passes thinking back unchanged, tracks files and usage", async () => {
  const claude = fakeClaude([
    turn([{ type: "thinking", thinking: "Find the ring colour.", signature: "SIG-1" }, { type: "text", text: "Looking for the ring." },
      { type: "tool_use", id: "t1", name: "search", input: { query: "ring" } }, { type: "tool_use", id: "t2", name: "read_file", input: { path: "public/app.js" } }]),
    turn([{ type: "tool_use", id: "t3", name: "edit_file", input: { path: "public/app.js", old_text: '"cyan"', new_text: '"gold"' } }, { type: "tool_use", id: "t4", name: "read_file", input: { path: "nope.js" } }]),
    turn([{ type: "text", text: "Ring is gold now\n- Changed public/app.js" }], "end_turn")
  ]);
  const ws = new Workspace(files(), {}), ev = [], messages = [{ role: "user", content: "Make the ring gold" }];
  const r = await runRound({ key: "k", model: "claude-sonnet-5-5", system: "SYS", messages, ws, emit: e => ev.push(e), fetchImpl: claude, sleep: async () => {} });
  assert.equal(r.status, "done"); assert.match(r.summary, /^Ring is gold now/);
  assert.equal(ws.read("public/app.js").includes('"gold"'), true);
  assert.equal(claude.calls.length, 3);
  const [c1, c2] = claude.calls;
  assert.deepEqual(c1.thinking, { type: "adaptive", display: "summarized" }); assert.deepEqual(c1.cache_control, { type: "ephemeral" });
  assert.equal(c1.stream, true); assert.equal(c1.system, "SYS"); assert.equal(c1.tools.length, 6); assert.equal(c1.temperature, undefined);
  assert.deepEqual(c2.messages[1].content[0], { type: "thinking", thinking: "Find the ring colour.", signature: "SIG-1" }, "thinking block passed back unchanged");
  assert.deepEqual(c2.messages[1].content.slice(2).map(b => [b.type, b.id, b.name, b.input]), [["tool_use", "t1", "search", { query: "ring" }], ["tool_use", "t2", "read_file", { path: "public/app.js" }]]);
  assert.deepEqual(c2.messages[2].content.map(b => [b.type, b.tool_use_id]), [["tool_result", "t1"], ["tool_result", "t2"]]);
  assert.equal(claude.calls[2].messages[4].content[1].is_error, true);
  const tools = ev.filter(e => e.t === "tool");
  assert.deepEqual(tools.map(t => [t.ok, t.label]), [[true, "Searched “ring” · 3 matches in 2 files"], [true, "Read public/app.js"], [true, "Edited public/app.js"], [false, "nope.js doesn't exist. Use list_files to see what's there."]]);
  const f = ev.find(e => e.t === "files").files["public/app.js"];
  assert.equal(f.base, REPO["public/app.js"]); assert.match(f.content, /gold/); assert.deepEqual(f.check, { ok: true, error: null });
  assert.equal(ev.filter(e => e.t === "usage").length, 3);
  assert.equal(ev.filter(e => e.t === "text").map(e => e.d).join(""), "Looking for the ring.Ring is gold now\n- Changed public/app.js");
  assert.equal(ev.filter(e => e.t === "msgs").flatMap(e => e.add).length, messages.length - 1);
  assert.equal(messages.length, 6);
});

test("tool loop: cut-off tool call, time budget and API fallbacks", async () => {
  // a tool call cut off by the output limit gets an error result instead of running
  let claude = fakeClaude([turn([{ type: "tool_use", id: "c1", name: "write_file", raw: '{"path":"public/x.js","content":"abc' }], "max_tokens"), turn([{ type: "text", text: "Done in parts" }], "end_turn")]);
  let ev = [], ws = new Workspace(files(), {});
  let r = await runRound({ key: "k", model: "m", system: "S", messages: [{ role: "user", content: "x" }], ws, emit: e => ev.push(e), fetchImpl: claude, sleep: async () => {} });
  assert.equal(r.status, "done"); assert.equal(ws.exists("public/x.js"), false);
  assert.match(claude.calls[1].messages[2].content[0].content, /cut off/); assert.deepEqual(claude.calls[1].messages[1].content[0].input, {});
  // out of time before the first turn: hand back to the page
  r = await runRound({ key: "k", model: "m", system: "S", messages: [{ role: "user", content: "x" }], ws, emit: () => {}, fetchImpl: fakeClaude([]), deadline: Date.now() - 1 });
  assert.equal(r.status, "continue");
  // thinking settings rejected → retried without them; overloaded → waits and retries
  claude = fakeClaude([turn([{ type: "text", text: "ok" }], "end_turn")], { errors: [[400, "thinking.display: unknown value"], [529, "Overloaded"]] });
  ev = [];
  r = await runRound({ key: "k", model: "m", system: "S", messages: [{ role: "user", content: "x" }], ws, emit: e => ev.push(e), fetchImpl: claude, sleep: async () => {} });
  assert.equal(r.status, "done"); assert.equal(claude.calls.length, 3);
  assert.equal(claude.calls[1].thinking, undefined); assert.equal(claude.calls[1].cache_control, undefined);
  assert.ok(ev.some(e => e.t === "wait"));
  // a bad key is a clear error
  await assert.rejects(runRound({ key: "k", model: "m", system: "S", messages: [{ role: "user", content: "x" }], ws, emit: () => {}, fetchImpl: fakeClaude([], { errors: [[401, "invalid x-api-key"]] }) }), /rejected ANTHROPIC_API_KEY/);
});

test("handler: GET is public but secret-free; PIN, origin and settings gates", async () => {
  const g = await call(undefined, { method: "GET" });
  assert.equal(g.code, 200); assert.equal(g.body.ready, true); assert.equal(g.body.deployed.sha, HEAD);
  assert.ok(!/sk-test|ghp-test|correct horse/.test(JSON.stringify(g.body)));
  assert.equal(status(readConfig({ TRADE_PIN: "12345678" })).pinVar, "TRADE_PIN");
  assert.equal((await call({ action: "check", pin: "nope" })).code, 401);
  assert.equal((await call({ action: "check", pin: "correct horse" }, { headers: { origin: "https://evil.example" } })).code, 403);
  assert.equal((await call({ action: "check", pin: "x" }, { env: { ...ENV, UPDATE_PIN: "short" } })).body.code, "NO_PIN");
  assert.equal((await call({ action: "step", pin: "correct horse", prompt: "x" }, { env: { ...ENV, ANTHROPIC_API_KEY: "" } })).body.code, "NO_CLAUDE");
  assert.equal((await call({ action: "push", pin: "correct horse" }, { env: { ...ENV, GITHUB_TOKEN: "" } })).body.code, "NO_GITHUB");
  assert.equal((await call({ action: "nope", pin: "correct horse" }, { deps: { fetch: fakeGitHub() } })).code, 400);
});

test("handler: step streams a whole round as NDJSON from a GitHub snapshot", async () => {
  const gh = fakeGitHub(), claude = fakeClaude([
    turn([{ type: "tool_use", id: "a", name: "edit_file", input: { path: "public/styles.css", old_text: ".ring{color:var(--cyan)}", new_text: ".ring{color:var(--amber)}" } }]),
    turn([{ type: "text", text: "Amber ring\n- styles.css" }], "end_turn")]);
  const fetch = (url, o) => url.startsWith("https://api.anthropic.com") ? claude(url, o) : gh(url, o);
  const r = await call({ action: "step", pin: "correct horse", prompt: "Make the ring amber", model: "claude-opus-5-5", files: { "public/app.js": "export const x = 1;\n" } }, { deps: { fetch } });
  assert.equal(r.code, 200); assert.match(r.ct, /ndjson/);
  const t = r.body.map(e => e.t);
  assert.deepEqual([t[0], t[1], t.at(-1)], ["base", "round", "done"]);
  assert.equal(r.body[0].sha, HEAD);
  assert.equal(r.body[1].model, "claude-opus-5-5"); assert.match(r.body[1].system, /Upper Hand Edge/); assert.match(r.body[1].first.content, /Staged changes .*public\/app\.js[\s\S]*Make the ring amber/);
  assert.match(claude.calls[0].system, /## Files at 1111111\n[\s\S]*public\/styles\.css \(/);
  const f = r.body.find(e => e.t === "files").files["public/styles.css"];
  assert.equal(f.base, REPO["public/styles.css"]); assert.match(f.content, /--amber/);
  assert.equal(r.body.at(-1).summary, "Amber ring\n- styles.css");
  // continuing a round: the page sends the messages back
  const claude2 = fakeClaude([turn([{ type: "text", text: "Finished" }], "end_turn")]);
  const round = { model: "claude-opus-5-5", system: "S", messages: [{ role: "user", content: "x" }] };
  const r2 = await call({ action: "step", pin: "correct horse", baseSha: HEAD, round }, { deps: { fetch: (u, o) => u.startsWith("https://api.anthropic.com") ? claude2(u, o) : gh(u, o) } });
  assert.equal(r2.body.at(-1).summary, "Finished"); assert.equal(claude2.calls[0].model, "claude-opus-5-5");
  const r3 = await call({ action: "step", pin: "correct horse", baseSha: HEAD, round: { system: 5 } }, { deps: { fetch: gh } });
  assert.equal(r3.body.at(-1).t, "error"); assert.match(r3.body.at(-1).error, /can't be continued/);
});

test("push: builds a commit on the branch tip, keeps modes, retries a race, refuses conflicts", async () => {
  const cfg = ghConfig({ GITHUB_TOKEN: "t", GITHUB_REPO: "joeyjojo0/Upper-Hand-Edge" });
  let gh = fakeGitHub({ raceOnce: true });
  const out = await pushFiles(cfg, { baseSha: HEAD, message: "Gold ring", files: [{ path: "public/app.js", content: "x" }, { path: "old.js", content: null }, { path: "tools/run.sh", content: "y", mode: "100755" }] }, { fetch: gh });
  assert.equal(out.sha, NEW); assert.equal(out.parent, NEXT, "rebuilt on the new tip after the race");
  const trees = gh.calls.filter(c => c.p === "/git/trees");
  assert.deepEqual(trees[0].body.tree, [{ path: "public/app.js", mode: "100644", type: "blob", content: "x" }, { path: "old.js", mode: "100644", type: "blob", sha: null }, { path: "tools/run.sh", mode: "100755", type: "blob", content: "y" }]);
  assert.equal(gh.calls.filter(c => c.m === "PATCH").at(-1).body.force, false);
  gh = fakeGitHub({ head: NEXT, compareFiles: ["public/app.js"] });
  await assert.rejects(pushFiles(cfg, { baseSha: HEAD, message: "m", files: [{ path: "public/app.js", content: "x" }] }, { fetch: gh }), e => e.code === "CONFLICT" && e.conflicts[0] === "public/app.js");
  const forced = await pushFiles(cfg, { baseSha: HEAD, message: "m", overwrite: true, files: [{ path: "public/app.js", content: "x" }] }, { fetch: fakeGitHub({ head: NEXT, compareFiles: ["public/app.js"] }) });
  assert.equal(forced.sha, NEW);
  // through the handler: modes come from the snapshot, binary files are refused
  gh = fakeGitHub();
  const r = await call({ action: "push", pin: "correct horse", baseSha: HEAD, message: "Run script", files: [{ path: "tools/run.sh", content: "echo" }] }, { deps: { fetch: gh } });
  assert.equal(r.code, 200); assert.equal(gh.calls.find(c => c.p === "/git/trees").body.tree[0].mode, "100755");
  const b = await call({ action: "push", pin: "correct horse", baseSha: HEAD, message: "x", files: [{ path: "public/aio-logo.png", content: "x" }] }, { deps: { fetch: fakeGitHub() } });
  assert.equal(b.code, 400); assert.match(b.body.error, /binary/);
  const c = await call({ action: "push", pin: "correct horse", baseSha: HEAD, message: "x", files: [{ path: "public/app.js", content: "x" }] }, { deps: { fetch: fakeGitHub({ head: NEXT, compareFiles: ["public/app.js"] }) } });
  assert.equal(c.code, 409); assert.deepEqual(c.body.conflicts, ["public/app.js"]);
});

test("undo: puts back modified, added and renamed files on top of the tip", async () => {
  const gh = fakeGitHub(), cfg = ghConfig({ GITHUB_TOKEN: "t", GITHUB_REPO: "joeyjojo0/Upper-Hand-Edge" });
  const out = await undoCommit(cfg, HEAD, { fetch: gh });
  assert.equal(out.sha, NEW);
  assert.deepEqual(gh.calls.find(c => c.p === "/git/trees").body.tree, [
    { path: "public/app.js", mode: "100644", type: "blob", sha: "blob-app" },
    { path: "public/new.js", mode: "100644", type: "blob", sha: null },
    { path: "public/b.js", mode: "100644", type: "blob", sha: null },
    { path: "public/a.js", mode: "100644", type: "blob", sha: "blob-a" }]);
  assert.match(gh.calls.find(c => c.p === "/git/commits").body.message, /^Undo: Gold ring\n/);
});

test("data engine: dispatch with run id, fallback lookup, job list cleaning, deploy status", async () => {
  const cfg = ghConfig({ GITHUB_TOKEN: "t", GITHUB_REPO: "joeyjojo0/Upper-Hand-Edge" });
  let gh = fakeGitHub();
  assert.deepEqual(await runEngine(cfg, "news, fund ,bogus", { fetch: gh }), { ok: true, id: 77, url: "https://github.com/run/77", force: "news,fund" });
  assert.deepEqual(gh.calls[0].body, { ref: "main", inputs: { force: "news,fund" }, return_run_details: true });
  gh = fakeGitHub({ dispatch: "204" });
  const r = await runEngine(cfg, "", { fetch: gh, sleep: async () => {} });
  assert.equal(r.id, 78); assert.deepEqual(gh.calls[0].body.inputs, {});
  gh = fakeGitHub({ dispatch: "old" });
  assert.equal((await runEngine(cfg, "all", { fetch: gh, sleep: async () => {} })).id, 78);
  assert.deepEqual(gh.calls.filter(c => c.m === "POST").map(c => Object.keys(c.body)), [["ref", "inputs", "return_run_details"], ["ref", "inputs"]]);
  assert.equal(cleanForce("calendar,ALL"), "all");
  const d = await call({ action: "deploy", pin: "correct horse", sha: NEW }, { deps: { fetch: fakeGitHub() } });
  assert.deepEqual(d.body, { ok: true, github: { state: "pending", url: "https://vercel.com/d/1", text: "Building" }, live: HEAD });
});

test("diff: Myers line diff, hunks and stats", () => {
  const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n", b = "a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
  const ops = diffLines(a, b);
  assert.deepEqual(stats(ops), { add: 2, del: 1 });
  const H = hunks(ops, 2);
  assert.equal(H.length, 2); assert.deepEqual(H[0].lines.map(l => l.t + l.s), [" a", " b", "-c", "+C", " d", " e"]); assert.deepEqual([H[0].a, H[0].b], [1, 1]);
  assert.deepEqual(H[1].lines.map(l => l.t + l.s), [" j", " k", "+l"]);
  assert.deepEqual(stats(diffLines(null, "x\ny\n")), { add: 2, del: 0 });
  assert.deepEqual(stats(diffLines("x\ny\n", null)), { add: 0, del: 2 });
  for (let n = 0; n < 200; n++) { // replaying the ops always rebuilds the new text from the old
    const rnd = () => Array.from({ length: Math.floor(Math.random() * 14) }, () => "abcde"[Math.floor(Math.random() * 5)]);
    const A = rnd(), B = rnd(), o = diffLines(A.join("\n"), B.join("\n"));
    assert.deepEqual(o.filter(x => x.t !== "-").map(x => x.s), B);
    assert.deepEqual(o.filter(x => x.t !== "+").map(x => x.s), A);
  }
});
