// Claude, editing the UHE code for the /update page. One "round" is one request from Joey, run as a
// tool-use loop over an in-memory copy of the repo (GitHub snapshot + changes staged on the page).
// Nothing here writes to GitHub: pushing is a separate, explicit button.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [input, output, 5-minute cache write, cache read] in $ per million tokens
export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 · fast", price: [2, 10, 2.5, 0.1] },
  { id: "claude-opus-5-5", label: "Opus 5.5 · strongest", price: [4, 20, 5, 0.2] }
];
export const MAX_TOKENS = 12000;

export class ToolError extends Error {}
export class ClaudeError extends Error { constructor(status, message, code = "CLAUDE") { super(message); this.status = status; this.code = code; } }

/* ---------------- workspace: repo snapshot + staged changes ---------------- */
export class Workspace {
  constructor(files, staged = {}) {
    this.base = files;               // Map path -> {content (null if binary), binary, mode, size}
    this.staged = new Map();         // path -> content, null = deleted
    for (const [p, c] of Object.entries(staged || {})) this.staged.set(p, c == null ? null : String(c));
    this.touched = new Set();
    this.checks = {};
  }
  baseContent(p) { const f = this.base.get(p); return f && !f.binary ? f.content : null; }
  exists(p) { return this.staged.has(p) ? this.staged.get(p) != null : this.base.has(p); }
  binary(p) { return !this.staged.has(p) && !!(this.base.get(p) || {}).binary; }
  read(p) { return this.staged.has(p) ? this.staged.get(p) : this.baseContent(p); }
  write(p, c) { this.staged.set(p, c); this.touched.add(p); }
  remove(p) { this.staged.set(p, null); this.touched.add(p); }
  isStaged(p) { return this.staged.has(p) && this.staged.get(p) !== this.baseContent(p); }
  paths() { const s = new Set(this.base.keys()); for (const [p, c] of this.staged) c == null ? s.delete(p) : s.add(p); return [...s].sort(); }
  size(p) { const c = this.read(p); return c != null ? Buffer.byteLength(c) : (this.base.get(p) || {}).size || 0; }
  staging() { return [...this.staged.keys()].filter(p => this.isStaged(p)).sort(); }
}

export function cleanPath(p) {
  const s = String(p == null ? "" : p).trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!s || s.length > 240 || s.split("/").some(x => !x || x === "." || x === "..")) throw new ToolError(`“${p}” isn't a valid path. Use a path from the repo root, e.g. public/app.js.`);
  if (/^(\.git|node_modules|\.vercel)(\/|$)/.test(s)) throw new ToolError(`${s} can't be edited from here.`);
  if (/(^|\/)\.env(\.|$)/.test(s) && !/\.env\.example$/.test(s)) throw new ToolError("Secrets never go in the repo: they live in Vercel environment variables (list new ones in .env.example).");
  return s;
}

const kb = n => n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
const short = s => { s = String(s).replace(/\s+/g, " "); return s.length > 40 ? s.slice(0, 39) + "…" : s; };
const lines = c => { const L = c.split("\n"); if (L.length > 1 && L[L.length - 1] === "") L.pop(); return L; };
const numbered = (L, from) => L.map((l, i) => `${String(from + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + ` …[+${l.length - 2000} chars]` : l}`).join("\n");
export function lineDelta(a, b) {
  const A = a == null ? [] : lines(a), B = b == null ? [] : lines(b);
  let i = 0; while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0; while (j < A.length - i && j < B.length - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  return { add: B.length - i - j, del: A.length - i - j };
}
function notFound(ws, p) {
  const stem = p.split("/").pop().replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const near = stem ? ws.paths().filter(x => x.toLowerCase().includes(stem)).slice(0, 5) : [];
  return `${p} doesn't exist.` + (near.length ? ` Did you mean ${near.join(", ")}?` : " Use list_files to see what's there.");
}
function hint(c, o) {
  const first = o.split("\n").map(s => s.trim()).find(Boolean); if (!first) return "";
  const L = c.split("\n"), i = L.findIndex(l => l.trim() === first);
  if (i >= 0) return ` Its first line matches line ${i + 1}, but the lines after it differ.`;
  const j = L.findIndex(l => l.includes(first.slice(0, 40)));
  return j >= 0 ? ` Something similar is on line ${j + 1}.` : "";
}
const count = (c, o) => { let n = 0, i = 0; while ((i = c.indexOf(o, i)) >= 0) { n++; i += o.length; } return n; };

/* ---------------- syntax checks (node --check for JS, JSON.parse, brace balance for CSS) ---------------- */
let NODE_CHECK = true;
const ok = () => ({ ok: true, text: "Syntax check: OK." });
const bad = e => ({ ok: false, error: e, text: "Syntax check FAILED:\n" + e + "\nFix this before you finish." });
async function nodeCheck(path, src, ext) {
  if (!NODE_CHECK) return { ok: true, skipped: true, text: "" };
  const dir = await mkdtemp(join(tmpdir(), "uhe-chk-"));
  const run = f => new Promise(res => execFile(process.execPath, ["--no-warnings", "--check", f], { timeout: 10000, env: { PATH: process.env.PATH || "" } },
    (err, so, se) => { if (!err) return res(null); const s = String(se || err.message || "error"), at = s.indexOf(dir); res(at > 0 ? s.slice(s.lastIndexOf("\n", at) + 1) : s); }));
  try {
    const f = join(dir, ext === "cjs" ? "check.cjs" : "check.mjs");
    await writeFile(f, src);
    let err = await run(f);
    if (err && ext === "js" && /SyntaxError/.test(err)) { const f2 = join(dir, "check.cjs"); await writeFile(f2, src); if (!(await run(f2))) err = null; }
    if (err == null) return ok();
    if (!/SyntaxError/.test(err)) { if (/ENOENT|EACCES|EPERM|spawn/i.test(err)) NODE_CHECK = false; return { ok: true, skipped: true, text: "" }; }
    return bad(err.split("\n").filter(l => l.trim() && !/^\s+at |^Node\.js v\d/.test(l)).map(l => l.split(dir).join("").replace(/^\/check\.(mjs|cjs)/, path)).slice(0, 6).join("\n"));
  } catch { return { ok: true, skipped: true, text: "" }; }
  finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
function cssCheck(s) {
  let depth = 0, line = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") line++;
    else if (ch === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return bad(`Unclosed /* comment starting on line ${line}.`); line += s.slice(i, e).split("\n").length - 1; i = e + 1; }
    else if (ch === '"' || ch === "'") { let j = i + 1; while (j < s.length && s[j] !== ch) { if (s[j] === "\\") j++; else if (s[j] === "\n") return bad(`Unclosed string on line ${line}.`); j++; } i = j; }
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return bad(`Extra } on line ${line}.`);
  }
  return depth ? bad(`${depth} unclosed { (a } is missing).`) : ok();
}
function htmlCheck(s) {
  for (const t of ["script", "style"]) {
    const open = (s.match(new RegExp(`<${t}[\\s>]`, "gi")) || []).length, close = (s.match(new RegExp(`</${t}>`, "gi")) || []).length;
    if (open !== close) return bad(`${open} <${t}> tag(s) but ${close} </${t}>.`);
  }
  return ok();
}
export async function checkSyntax(path, src) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(path) || [])[1] || "").toLowerCase();
  try {
    if (ext === "json") { JSON.parse(src); return ok(); }
    if (["js", "mjs", "cjs"].includes(ext)) return await nodeCheck(path, src, ext);
    if (ext === "css") return cssCheck(src);
    if (ext === "html" || ext === "htm") return htmlCheck(src);
  } catch (e) { return bad(String((e && e.message) || e)); }
  return { ok: true, skipped: true, text: "" };
}

/* ---------------- tools ---------------- */
export const TOOLS = [
  { name: "list_files", description: "List the repo's files with sizes (staged changes included). Optionally only one folder.",
    input_schema: { type: "object", properties: { dir: { type: "string", description: "Folder to list, e.g. public. Default: whole repo." } } } },
  { name: "read_file", description: "Read a text file with line numbers (the staged version if it was changed). Up to 600 lines per call by default; use offset to read further.",
    input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "First line to read (1-based)." }, limit: { type: "integer", description: "Number of lines (max 1000)." } }, required: ["path"] } },
  { name: "search", description: "Find a string (or a JavaScript regular expression) in the repo's text files. Returns path:line: text for each match.",
    input_schema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean", description: "Treat query as a regular expression." }, path: { type: "string", description: "Only search paths starting with this, e.g. public/ or api/trade.js." }, ignore_case: { type: "boolean" } }, required: ["query"] } },
  { name: "edit_file", description: "Replace an exact piece of text in a file. old_text must appear exactly once (include a few surrounding lines to make it unique) unless replace_all is true. The preferred way to change an existing file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_text", "new_text"] } },
  { name: "write_file", description: "Create a new file, or replace a whole file. Keep each call under about 250 lines: write the first part, then add the rest with append: true.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean", description: "Add to the end of the file instead of replacing it." } }, required: ["path", "content"] } },
  { name: "delete_file", description: "Delete a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
];

export async function runTool(ws, name, input) {
  input = input && typeof input === "object" ? input : {};
  switch (name) {
    case "list_files": {
      const dir = input.dir ? cleanPath(input.dir) : "";
      const all = ws.paths().filter(p => !dir || p === dir || p.startsWith(dir + "/"));
      if (!all.length) throw new ToolError(`No files under ${dir}.`);
      const out = all.slice(0, 500).map(p => `${p}  (${kb(ws.size(p))}${ws.isStaged(p) ? ", staged" : ""}${ws.binary(p) ? ", binary" : ""})`);
      return { text: out.join("\n") + (all.length > 500 ? `\n… ${all.length - 500} more` : ""), label: `Listed ${dir ? dir + "/" : "the repo's"} files (${all.length})` };
    }
    case "read_file": {
      const p = cleanPath(input.path);
      if (ws.binary(p)) throw new ToolError(`${p} is a binary file (${kb(ws.size(p))}); it can't be read here.`);
      const c = ws.read(p); if (c == null) throw new ToolError(notFound(ws, p));
      const L = lines(c), total = L.length;
      const from = Math.max(1, Math.floor(+input.offset || 1)), lim = Math.min(1000, Math.max(1, Math.floor(+input.limit || 600)));
      if (total && from > total) throw new ToolError(`${p} has only ${total} lines.`);
      let chunk = L.slice(from - 1, from - 1 + lim), chars = 0;
      for (let i = 0; i < chunk.length; i++) { chars += Math.min(chunk[i].length, 2000) + 8; if (chars > 80000 && i) { chunk = chunk.slice(0, i); break; } }
      const to = from + chunk.length - 1, part = from > 1 || to < total;
      return { text: `${p} · ${total} lines${ws.isStaged(p) ? " · staged version" : ""}${part ? ` · showing ${from}–${to}` : ""}\n${total ? numbered(chunk, from) : "(empty file)"}${to < total ? `\n… ${total - to} more lines (read again with offset ${to + 1})` : ""}`,
        label: `Read ${p}${part ? ` · lines ${from}–${to} of ${total}` : ""}`, path: p };
    }
    case "search": {
      const q = String(input.query || ""); if (!q || q.length > 300) throw new ToolError("Give a search query (up to 300 characters).");
      let re; try { re = new RegExp(input.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.ignore_case ? "i" : ""); } catch (e) { throw new ToolError("Bad regular expression: " + e.message); }
      const scope = input.path ? String(input.path).trim().replace(/\\/g, "/").replace(/^(\.\/)+|^\/+/g, "") : "";
      const hits = [], files = new Set(); let total = 0;
      for (const p of ws.paths()) {
        if ((scope && !p.startsWith(scope)) || ws.binary(p)) continue;
        const c = ws.read(p); if (c == null || c.length > 1.5e6) continue;
        const L = c.split("\n");
        for (let i = 0; i < L.length; i++) if (re.test(L[i])) { total++; files.add(p); if (hits.length < 80) hits.push(`${p}:${i + 1}: ${L[i].trim().slice(0, 240)}`); }
      }
      if (!total) return { text: `No matches for ${JSON.stringify(q)}${scope ? " in " + scope : ""}.`, label: `Searched “${short(q)}” · no matches` };
      return { text: hits.join("\n") + (total > hits.length ? `\n… ${total - hits.length} more matches (narrow it with path)` : ""),
        label: `Searched “${short(q)}” · ${total} match${total === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}` };
    }
    case "edit_file": {
      const p = cleanPath(input.path);
      if (ws.binary(p)) throw new ToolError(`${p} is a binary file; it can't be edited here.`);
      const c = ws.read(p); if (c == null) throw new ToolError(notFound(ws, p));
      const o = String(input.old_text ?? ""), n = String(input.new_text ?? "");
      if (!o) throw new ToolError("old_text is empty. To add something, put a nearby line in old_text and repeat it in new_text with your addition.");
      if (o === n) throw new ToolError("old_text and new_text are the same, so nothing would change.");
      const k = count(c, o);
      if (!k) throw new ToolError(`old_text wasn't found in ${p}.${hint(c, o)} Read the file again and copy the text exactly, including spaces.`);
      if (k > 1 && !input.replace_all) throw new ToolError(`old_text appears ${k} times in ${p}. Include more surrounding lines so it matches once, or set replace_all: true.`);
      const at = c.indexOf(o), out = input.replace_all ? c.split(o).join(n) : c.slice(0, at) + n + c.slice(at + o.length);
      ws.write(p, out);
      const chk = await checkSyntax(p, out); ws.checks[p] = chk;
      const start = c.slice(0, at).split("\n").length, L = out.split("\n"), a = Math.max(1, start - 3), b = Math.min(L.length, start + n.split("\n").length + 2);
      return { text: `Edited ${p}${k > 1 ? ` (${k} places)` : ""}. Lines ${a}–${b} now:\n${numbered(L.slice(a - 1, b), a)}${chk.text ? "\n" + chk.text : ""}`,
        label: `Edited ${p}`, path: p, ...lineDelta(c, out), check: chk };
    }
    case "write_file": {
      const p = cleanPath(input.path);
      if (ws.binary(p)) throw new ToolError(`${p} is a binary file; it can't be replaced here.`);
      const content = String(input.content ?? ""), old = ws.read(p);
      const out = input.append && old != null ? old + (old && !old.endsWith("\n") ? "\n" : "") + content : content;
      if (out.length > 600000) throw new ToolError("That file would be too big for this page (600,000 characters max).");
      ws.write(p, out);
      const chk = await checkSyntax(p, out); ws.checks[p] = chk;
      const n = lines(out).length, verb = input.append && old != null ? `Added ${lines(content).length} lines to ${p} (now ${n})` : old == null ? `Created ${p} (${n} lines)` : `Replaced ${p} (${n} lines, was ${lines(old).length})`;
      return { text: `${verb}.${chk.text ? "\n" + chk.text + (input.append && !chk.ok ? "\n(If more parts are coming, add them first.)" : "") : ""}`,
        label: verb.replace(/ \(.*$/, ""), path: p, ...lineDelta(old, out), check: chk };
    }
    case "delete_file": {
      const p = cleanPath(input.path);
      if (!ws.exists(p)) throw new ToolError(notFound(ws, p));
      const old = ws.read(p); ws.remove(p); delete ws.checks[p];
      return { text: `Deleted ${p}.`, label: `Deleted ${p}`, path: p, add: 0, del: old ? lines(old).length : 0 };
    }
    default: throw new ToolError(`There's no tool called ${name}.`);
  }
}

/* ---------------- prompts ---------------- */
export function systemPrompt({ repo, branch, sha, ws, now = new Date() }) {
  const readme = (ws.baseContent("README.md") || "").slice(0, 40000), notes = (ws.baseContent("CLAUDE.md") || "").slice(0, 20000);
  const files = [...ws.base.keys()].sort().map(p => `${p} (${kb(ws.base.get(p).size)})`).join("\n");
  const uk = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "full", timeStyle: "short" }).format(now);
  return `You are Claude, working inside the Update page of Joey's Upper Hand Edge (UHE) website. Joey types a request, you change the code, and he reviews the diff and presses "Push to GitHub". That commits to ${branch}, and Vercel puts it live about a minute later. He can also run the data engine (GitHub Actions) afterwards.

## How you work
- You edit an in-memory copy of ${repo} (branch ${branch}, commit ${sha.slice(0, 7)}) plus any changes already staged on the page. Nothing reaches GitHub until Joey pushes.
- Tools: list_files, read_file, search, edit_file, write_file, delete_file. You can't run commands, tests or a browser. JS, JSON, CSS and HTML files are syntax-checked after each change: fix anything it reports before you finish.
- Look before you edit: search for the code involved and read enough around it to fit in. Prefer small, exact edit_file changes to rewriting files. Keep each write_file call under about 250 lines (append: true for the rest).
- Match the existing code: plain HTML, CSS and JavaScript ES modules, no build step, no npm packages, the glass UI in public/styles.css (CSS variables such as --cyan, --long, --short), compact code, UK English copy. Don't reformat or reorder code you aren't changing.
- Keep it working: pages must still load on desktop and phone. Keep exported names that other files import. If you change behaviour covered by dev/tests, update those tests too.
- Safety: never put API keys, tokens or PINs in code (they live in Vercel environment variables) and never send environment variables to the browser. Don't weaken the PIN checks, order limits or safety rules in api/trade.js or api/update.js unless Joey explicitly asks, and point it out if he does. Leave the data branch and dev/fixtures alone unless asked.
- If a request is unclear or risky, ask one short question instead of guessing, and make no edits.

## When you finish
Reply in plain English for Joey, who won't read the code:
- First line: a short commit title (at most 70 characters, no full stop).
- Then 1–4 short bullet points: what changed and where to see it on the site.
- Say if anything else is needed, e.g. "run the data engine after pushing" when you changed scripts/build-data.mjs or the data functions in api/_lib/core.js, or a new Vercel environment variable.
If you only answered a question and changed nothing, just answer it (no title line).

## README.md
${readme}
${notes ? "\n## CLAUDE.md\n" + notes + "\n" : ""}
## Files at ${sha.slice(0, 7)}
${files}

Now: ${uk} (UK time).`;
}

export function roundPrompt({ prompt, history = [], staged = [] }) {
  const clip = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  let s = "";
  const H = (Array.isArray(history) ? history : []).slice(-8).filter(h => h && h.prompt);
  if (H.length) s += "Earlier in this session:\n" + H.map((h, i) => `${i + 1}. Joey asked: ${clip(h.prompt, 1500)}\n   You replied: ${clip(h.summary, 1500) || "(no reply)"}${h.note ? "\n   Since then: " + clip(h.note, 400) : ""}`).join("\n") + "\n\n";
  if (staged.length) s += `Staged changes that aren't pushed yet (reading these files shows the staged version): ${staged.join(", ")}\n\n`;
  return s + "Joey's request:\n" + clip(prompt, 8000);
}

/* ---------------- Claude Messages API (streaming) ---------------- */
async function* sseEvents(body) {
  const reader = body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
      const data = raw.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) { try { yield JSON.parse(data); } catch { /* not JSON */ } }
    }
    if (done) break;
  }
}
function friendlyClaude(status, msg) {
  if (status === 401) return "Claude rejected ANTHROPIC_API_KEY. Check the key in Vercel.";
  if (status === 403) return "This Anthropic API key isn't allowed to do that: " + msg;
  if (status === 404) return "That Claude model isn't available on this API key: " + msg;
  if (/credit balance/i.test(msg)) return "Your Anthropic account is out of credit. Top it up at console.anthropic.com, then try again.";
  if (status === 429) return "Claude's rate limit was hit. Wait a minute and try again.";
  if (status === 529 || status >= 500) return "Claude is busy right now. Try again in a minute.";
  return msg;
}
async function readStream(body, on) {
  const blocks = [], json = {}, cut = new Set(), usage = { in: 0, out: 0, cr: 0, cw: 0 }; let stop = null, tick = 0;
  const finish = i => { // parse a tool call's streamed JSON once its block closes (or the stream ends)
    const b = blocks[i]; if (!b || b.type !== "tool_use" || json[i] == null) return;
    try { b.input = json[i] ? JSON.parse(json[i]) : {}; } catch { b.input = {}; cut.add(b.id); }
    delete json[i];
  };
  try { for await (const ev of sseEvents(body)) {
    switch (ev.type) {
      case "message_start": { const u = (ev.message && ev.message.usage) || {}; usage.in = u.input_tokens || 0; usage.cr = u.cache_read_input_tokens || 0; usage.cw = u.cache_creation_input_tokens || 0; usage.out = u.output_tokens || 0; break; }
      case "content_block_start": {
        const b = { ...ev.content_block }; blocks[ev.index] = b;
        if (b.type === "tool_use") { json[ev.index] = ""; on({ t: "tool_start", id: b.id, name: b.name }); }
        else if (b.type === "thinking") on({ t: "think_start" });
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index], d = ev.delta || {}; if (!b) break;
        if (d.type === "text_delta") { b.text = (b.text || "") + d.text; on({ t: "text", d: d.text }); }
        else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + d.thinking; if (d.thinking) on({ t: "think", d: d.thinking }); }
        else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
        else if (d.type === "input_json_delta") { json[ev.index] += d.partial_json || ""; const now = Date.now(); if (now - tick > 600) { tick = now; on({ t: "tool_input", id: b.id, n: json[ev.index].length }); } }
        break;
      }
      case "content_block_stop": { finish(ev.index); break; }
      case "message_delta": {
        if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
        const u = ev.usage || {}; if (u.output_tokens != null) usage.out = u.output_tokens;
        if (u.cache_read_input_tokens) usage.cr = u.cache_read_input_tokens; if (u.cache_creation_input_tokens) usage.cw = u.cache_creation_input_tokens; if (u.input_tokens) usage.in = u.input_tokens;
        break;
      }
      case "error": throw new ClaudeError(529, friendlyClaude(529, (ev.error && ev.error.message) || "stream error"));
    }
  } } catch (e) { if (e instanceof ClaudeError || (e && e.name === "AbortError")) throw e; throw new ClaudeError(502, "The connection to Claude dropped mid-reply.", "CUT"); }
  if (!stop) throw new ClaudeError(502, "Claude's reply was cut off mid-way.", "CUT");
  for (const i of Object.keys(json)) finish(+i);
  for (const b of blocks) if (b && b.type === "tool_use" && (!b.input || typeof b.input !== "object")) b.input = {};
  const content = blocks.filter(b => b && !(b.type === "text" && !b.text));
  return { content, stop, usage, cut };
}
const PLAIN = new Set(); // models that turned down the thinking/caching options: send them plain requests from then on
export async function callClaude({ key, model, system, messages, signal, fetchImpl = fetch, on = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), minimal = PLAIN.has(model) }) {
  const body = { model, max_tokens: MAX_TOKENS, stream: true, system, tools: TOOLS, messages };
  if (!minimal) { body.cache_control = { type: "ephemeral" }; body.thinking = { type: "adaptive", display: "summarized" }; }
  for (let attempt = 0; ; attempt++) {
    const r = await fetchImpl("https://api.anthropic.com/v1/messages", { method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
      const msg = (j && j.error && j.error.message) || `Claude API HTTP ${r.status}`;
      if (r.status === 400 && !minimal && /thinking|display|cache_control/i.test(msg)) { PLAIN.add(model); return callClaude({ key, model, system, messages, signal, fetchImpl, on, sleep, minimal: true }); }
      if ([429, 500, 502, 503, 529].includes(r.status) && attempt < 2) {
        const s = Math.min(20, +r.headers.get("retry-after") || 4 * (attempt + 1));
        on({ t: "wait", s, why: r.status === 429 ? "rate limit" : "busy" }); await sleep(s * 1000); continue;
      }
      throw new ClaudeError(r.status, friendlyClaude(r.status, msg));
    }
    return readStream(r.body, on);
  }
}

// Runs tool turns until Claude finishes, the time budget runs out ("continue": the page calls again with
// the messages so far) or the step limit is hit. Emits events for the page as it goes.
export async function runRound({ key, model, system, messages, ws, emit, signal, fetchImpl, deadline = Infinity, maxTurns = 40, sleep, known = new Set() }) {
  const sent = new Set(known);
  const files = () => {
    if (!ws.touched.size) return;
    const out = {};
    for (const p of ws.touched) {
      const c = ws.checks[p];
      out[p] = { content: ws.read(p), mode: (ws.base.get(p) || {}).mode, ...(sent.has(p) ? {} : { base: ws.baseContent(p) }), ...(c && !c.skipped ? { check: { ok: c.ok, error: c.error || null } } : {}) };
      sent.add(p);
    }
    ws.touched.clear();
    emit({ t: "files", files: out });
  };
  for (;;) {
    if (signal && signal.aborted) return { status: "stopped" };
    const turns = messages.filter(m => m.role === "assistant").length;
    if (turns >= maxTurns) return { status: "limit", summary: `Stopped after ${maxTurns} steps without finishing. Send “carry on” to continue, or push what's staged.` };
    if (Date.now() > deadline) return { status: "continue" };
    emit({ t: "turn", n: turns + 1 });
    const res = await callClaude({ key, model, system, messages, signal, fetchImpl, on: emit, sleep });
    emit({ t: "usage", u: res.usage });
    const assistant = { role: "assistant", content: res.content };
    messages.push(assistant);
    const uses = res.content.filter(b => b.type === "tool_use");
    if (uses.length) {
      const results = [];
      for (const b of uses) {
        if (res.cut.has(b.id)) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "This tool call was cut off because the reply hit the length limit. Send smaller pieces: under ~250 lines per call, using append: true for the rest." });
          emit({ t: "tool", id: b.id, name: b.name, ok: false, label: "Step was too long, retrying in smaller parts" });
          continue;
        }
        try {
          const r = await runTool(ws, b.name, b.input);
          results.push({ type: "tool_result", tool_use_id: b.id, content: r.text });
          emit({ t: "tool", id: b.id, name: b.name, ok: true, label: r.label, path: r.path, add: r.add, del: r.del, check: r.check && !r.check.skipped ? { ok: r.check.ok, error: r.check.error || null } : undefined });
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : "Tool error: " + ((e && e.message) || e);
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: msg });
          emit({ t: "tool", id: b.id, name: b.name, ok: false, label: msg.slice(0, 160), error: msg });
        }
      }
      const user = { role: "user", content: results };
      messages.push(user);
      emit({ t: "msgs", add: [assistant, user] });
      files();
      continue;
    }
    emit({ t: "msgs", add: [assistant] });
    if (res.stop === "pause_turn") continue;
    if (res.stop === "refusal") return { status: "refused", summary: "Claude declined this request." };
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
    return { status: "done", summary: text + (res.stop === "max_tokens" ? "\n\n(The reply hit the length limit.)" : "") };
  }
}
