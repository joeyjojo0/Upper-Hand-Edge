// GitHub side of the /update page: a read-only copy of the repo for Claude to work on, commits through
// the Git Data API ("Push to GitHub" and "Undo"), Vercel's deploy status, and the data engine runs.
// Auth: GITHUB_TOKEN, a fine-grained token for this repo only (Contents + Actions read/write,
// Commit statuses read, Workflows read/write only if Claude may edit .github/workflows).
import { gunzipSync } from "node:zlib";

export class GitHubError extends Error {
  constructor(status, message, code = "GITHUB", extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

export function ghConfig(E = process.env) {
  const s = v => String(v || "").trim();
  const vercelRepo = E.VERCEL_GIT_REPO_OWNER && E.VERCEL_GIT_REPO_SLUG ? `${E.VERCEL_GIT_REPO_OWNER}/${E.VERCEL_GIT_REPO_SLUG}` : "";
  return {
    token: s(E.GITHUB_TOKEN || E.GH_TOKEN),
    repo: s(E.GITHUB_REPO) || vercelRepo || "joeyjojo0/Upper-Hand-Edge",
    branch: s(E.GITHUB_BRANCH) || "main",
    workflow: s(E.ENGINE_WORKFLOW) || "data.yml",
    dataBranch: s(E.DATA_BRANCH) || "data"
  };
}

export const isSha = s => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const ref = b => b.split("/").map(encodeURIComponent).join("/");
const PERM = { contents: "Contents", actions: "Actions", workflows: "Workflows", statuses: "Commit statuses", metadata: "Metadata", deployments: "Deployments" };

function ghError(status, j, headers, path) {
  const msg = (j && j.message) || `GitHub HTTP ${status}`;
  if (status === 401) return new GitHubError(401, "GitHub rejected GITHUB_TOKEN (expired or wrong). Make a new token and update it in Vercel.", "GH_AUTH");
  if (/workflow/i.test(msg) && /scope|permission|refusing/i.test(msg))
    return new GitHubError(403, "The GitHub token isn't allowed to change files in .github/workflows. Give it “Workflows: Read and write”, or ask Claude to leave that file alone.", "GH_PERM");
  if (/rate limit/i.test(msg)) return new GitHubError(429, "GitHub's rate limit was hit. Try again in a few minutes.", "GH_RATE");
  const need = headers && headers.get && headers.get("x-accepted-github-permissions");
  if ((status === 403 || status === 404) && need) {
    const list = [...new Set(need.split(/[;,]/).map(x => x.trim()).filter(Boolean).map(x => { const [k, v] = x.split("="); return `${PERM[k] || k}: ${v === "write" ? "Read and write" : "Read-only"}`; }))];
    return new GitHubError(403, `The GitHub token needs ${list.join(" or ")} on this repo. Edit the token on GitHub, then try again.`, "GH_PERM");
  }
  if (status === 404) return new GitHubError(404, `GitHub couldn't find ${path.split("?")[0]}. Check GITHUB_REPO and that the token can see this repo.`, "GH_NOT_FOUND");
  return new GitHubError(status >= 400 && status < 600 ? status : 502, msg, "GITHUB");
}

export function client(cfg, deps = {}) {
  const f = deps.fetch || fetch, base = deps.githubApi || "https://api.github.com";
  return async function api(path, { method = "GET", body, raw = false, timeout = 25000 } = {}) {
    const headers = { Authorization: "Bearer " + cfg.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "uhe-update" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try { r = await f(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); }
    catch (e) { throw new GitHubError(502, "Couldn't reach GitHub: " + ((e && e.message) || e), "GH_NET"); }
    if (raw && r.ok) return r;
    if (r.status === 204) return null;
    const text = await r.text(); let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw ghError(r.status, j, r.headers, path);
    return j;
  };
}

/* ---------------- repo snapshot (one tarball, kept in memory per commit) ---------------- */
export function parsePax(buf) {
  const out = {}; let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i); if (sp < 0) break;
    const len = parseInt(buf.toString("utf8", i, sp), 10); if (!(len > 0)) break;
    const rec = buf.toString("utf8", sp + 1, i + len - 1), eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}
export function untar(buf) {
  const entries = []; let i = 0, pax = null, long = null;
  const str = (a, b) => { const s = buf.toString("utf8", a, b), z = s.indexOf("\0"); return z < 0 ? s : s.slice(0, z); };
  while (i + 512 <= buf.length) {
    if (buf[i] === 0 && buf.subarray(i, i + 512).every(b => b === 0)) break;
    let name = str(i, i + 100);
    const mode = parseInt(str(i + 100, i + 108).trim() || "0", 8), size = parseInt(str(i + 124, i + 136).trim() || "0", 8);
    const type = buf[i + 156] ? String.fromCharCode(buf[i + 156]) : "0", magic = str(i + 257, i + 263), prefix = magic.startsWith("ustar") ? str(i + 345, i + 500) : "";
    if (prefix) name = prefix + "/" + name;
    const data = buf.subarray(i + 512, i + 512 + size);
    i += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    if (type === "L") { long = data.toString("utf8").replace(/\0+$/, ""); continue; }
    if (pax && pax.path) name = pax.path;
    if (long) name = long;
    pax = null; long = null;
    if (type === "0" || type === "7") entries.push({ name, mode, data });
  }
  return entries;
}
const BINARY = /\.(png|jpe?g|gif|webp|avif|bmp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp3|mp4|mov|wav|wasm)$/i;
export function filesFromTar(entries) {
  const files = new Map();
  for (const e of entries) {
    const path = e.name.split("/").slice(1).join("/"); // GitHub wraps the repo in <owner>-<repo>-<sha>/
    if (!path) continue;
    const binary = BINARY.test(path) || e.data.subarray(0, 8000).includes(0);
    files.set(path, { mode: e.mode & 0o111 ? "100755" : "100644", size: e.data.length, binary, content: binary ? null : e.data.toString("utf8") });
  }
  return files;
}
const SNAP = new Map();
export async function snapshot(cfg, sha, deps = {}) {
  const key = cfg.repo + "@" + sha;
  if (SNAP.has(key)) return SNAP.get(key);
  const r = await client(cfg, deps)(`/repos/${cfg.repo}/tarball/${sha}`, { raw: true, timeout: 45000 });
  const files = filesFromTar(untar(gunzipSync(Buffer.from(await r.arrayBuffer()))));
  if (!files.size) throw new GitHubError(502, "GitHub sent an empty copy of the repo.", "GH_EMPTY");
  const snap = { sha, files };
  SNAP.set(key, snap);
  while (SNAP.size > 3) SNAP.delete(SNAP.keys().next().value);
  return snap;
}

/* ---------------- commits ---------------- */
export async function head(cfg, deps = {}) {
  const j = await client(cfg, deps)(`/repos/${cfg.repo}/git/ref/heads/${ref(cfg.branch)}`);
  return j.object.sha;
}
const view = c => ({ sha: c.sha, title: String(c.commit.message || "").split("\n")[0].slice(0, 140), date: (c.commit.committer || c.commit.author || {}).date || null,
  author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || "", parents: (c.parents || []).length, url: c.html_url });
export async function recentCommits(cfg, deps = {}, n = 6) {
  return (await client(cfg, deps)(`/repos/${cfg.repo}/commits?sha=${ref(cfg.branch)}&per_page=${n}`)).map(view);
}
async function changedSince(api, cfg, from, to) {
  const cmp = await api(`/repos/${cfg.repo}/compare/${from}...${to}`);
  return { status: cmp.status, files: new Set((cmp.files || []).flatMap(f => [f.filename, f.previous_filename]).filter(Boolean)) };
}

// files: [{path, content (null = delete), mode?}]. Builds on the branch tip; refuses if a file was changed
// on GitHub after baseSha unless overwrite is set. Retries if the branch moves underneath us.
export async function pushFiles(cfg, { baseSha, files, message, overwrite = false }, deps = {}) {
  const api = client(cfg, deps);
  if (!files.length) throw new GitHubError(400, "Nothing to push.", "EMPTY");
  for (let attempt = 0; ; attempt++) {
    const parent = await head(cfg, deps);
    if (baseSha && parent !== baseSha && !overwrite) {
      const later = (await changedSince(api, cfg, baseSha, parent)).files;
      const clash = files.map(f => f.path).filter(p => later.has(p));
      if (clash.length) throw new GitHubError(409, `${clash.length === 1 ? "This file was" : "These files were"} changed on GitHub after Claude started: ${clash.join(", ")}.`, "CONFLICT", { conflicts: clash, head: parent });
    }
    const pc = await api(`/repos/${cfg.repo}/git/commits/${parent}`);
    const tree = await api(`/repos/${cfg.repo}/git/trees`, { method: "POST", body: { base_tree: pc.tree.sha,
      tree: files.map(f => f.content == null ? { path: f.path, mode: f.mode || "100644", type: "blob", sha: null } : { path: f.path, mode: f.mode || "100644", type: "blob", content: f.content }) } });
    if (tree.sha === pc.tree.sha) return { ok: true, noop: true, sha: parent };
    const c = await api(`/repos/${cfg.repo}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [parent] } });
    try { await api(`/repos/${cfg.repo}/git/refs/heads/${ref(cfg.branch)}`, { method: "PATCH", body: { sha: c.sha, force: false } }); }
    catch (e) { if (e.status === 422 && /fast.?forward/i.test(e.message) && attempt < 2) continue; throw e; }
    return { ok: true, sha: c.sha, parent, url: `https://github.com/${cfg.repo}/commit/${c.sha}`, files: files.map(f => f.path) };
  }
}

// A new commit on top of the branch that puts back every file the given commit changed.
export async function undoCommit(cfg, sha, deps = {}) {
  const api = client(cfg, deps);
  const c = await api(`/repos/${cfg.repo}/commits/${sha}`);
  if ((c.parents || []).length !== 1) throw new GitHubError(400, "That commit can't be undone from here (it's a merge or the very first commit).", "BAD_REQUEST");
  const files = c.files || [];
  if (!files.length) throw new GitHubError(400, "That commit didn't change any files.", "BAD_REQUEST");
  if (files.length >= 300) throw new GitHubError(400, "That commit is too big to undo from here. Use GitHub instead.", "BAD_REQUEST");
  const tip = await head(cfg, deps);
  if (tip !== sha) {
    const since = await changedSince(api, cfg, sha, tip);
    if (since.status === "behind" || since.status === "diverged") throw new GitHubError(400, `That commit isn't on ${cfg.branch}.`, "BAD_REQUEST");
    const clash = [...new Set(files.flatMap(f => [f.filename, f.previous_filename]).filter(p => p && since.files.has(p)))];
    if (clash.length) throw new GitHubError(409, `Can't undo it automatically: ${clash.join(", ")} changed again afterwards.`, "CONFLICT", { conflicts: clash });
  }
  const parentTree = (await api(`/repos/${cfg.repo}/git/commits/${c.parents[0].sha}`)).tree.sha;
  const pt = await api(`/repos/${cfg.repo}/git/trees/${parentTree}?recursive=1`);
  if (pt.truncated) throw new GitHubError(400, "The repo is too big to undo from here. Use GitHub instead.", "BAD_REQUEST");
  const P = new Map(pt.tree.filter(t => t.type === "blob").map(t => [t.path, t]));
  const entries = [], drop = p => entries.push({ path: p, mode: "100644", type: "blob", sha: null });
  const restore = p => { const t = P.get(p); if (t) entries.push({ path: p, mode: t.mode, type: "blob", sha: t.sha }); else drop(p); };
  for (const f of files) {
    if (f.status === "renamed") { drop(f.filename); restore(f.previous_filename); }
    else if (f.status === "added" || f.status === "copied") drop(f.filename);
    else restore(f.filename);
  }
  const tipTree = (await api(`/repos/${cfg.repo}/git/commits/${tip}`)).tree.sha;
  const tree = await api(`/repos/${cfg.repo}/git/trees`, { method: "POST", body: { base_tree: tipTree, tree: entries } });
  const title = String(c.commit.message || "").split("\n")[0];
  const nc = await api(`/repos/${cfg.repo}/git/commits`, { method: "POST", body: { message: `Undo: ${title}\n\nPuts back the files changed in ${sha.slice(0, 7)} (from the UHE update page).`, tree: tree.sha, parents: [tip] } });
  await api(`/repos/${cfg.repo}/git/refs/heads/${ref(cfg.branch)}`, { method: "PATCH", body: { sha: nc.sha, force: false } });
  return { ok: true, sha: nc.sha, parent: tip, undid: sha, url: `https://github.com/${cfg.repo}/commit/${nc.sha}`, files: files.map(f => f.filename) };
}

// Vercel reports each deployment back to GitHub as a commit status named "Vercel".
export async function deployStatus(cfg, sha, deps = {}) {
  const j = await client(cfg, deps)(`/repos/${cfg.repo}/commits/${sha}/status`);
  const v = (j.statuses || []).find(s => /vercel/i.test(s.context || ""));
  return v ? { state: v.state, url: v.target_url || null, text: v.description || "" } : { state: "waiting", url: null, text: "" };
}

/* ---------------- data engine (GitHub Actions) ---------------- */
export const ENGINE_JOBS = ["markets", "scan-hist", "scan", "options", "fund", "news", "pulse", "patterns", "flow", "calendar"];
export function cleanForce(x) {
  const s = String(x || "").toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
  return s.includes("all") ? "all" : [...new Set(s.filter(t => ENGINE_JOBS.includes(t)))].join(",");
}
const runView = r => ({ id: r.id, status: r.status, conclusion: r.conclusion, event: r.event, created: r.created_at, started: r.run_started_at || r.created_at,
  updated: r.updated_at, url: r.html_url, sha: r.head_sha, attempt: r.run_attempt || 1 });
export async function engineRuns(cfg, deps = {}, n = 6) {
  const j = await client(cfg, deps)(`/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/runs?per_page=${n}`);
  return (j.workflow_runs || []).map(runView);
}
export async function engineRun(cfg, id, deps = {}) {
  const api = client(cfg, deps);
  const [r, jobs] = await Promise.all([api(`/repos/${cfg.repo}/actions/runs/${id}`), api(`/repos/${cfg.repo}/actions/runs/${id}/jobs?per_page=10`)]);
  return { ...runView(r), steps: (jobs.jobs || []).flatMap(jb => (jb.steps || []).map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion, started: s.started_at, done: s.completed_at }))) };
}
export async function runEngine(cfg, force, deps = {}) {
  const api = client(cfg, deps), t0 = Date.now(), sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const f = cleanForce(force);
  const path = `/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`, body = { ref: cfg.branch, inputs: f ? { force: f } : {} };
  let j;
  try { j = await api(path, { method: "POST", body: { ...body, return_run_details: true } }); }
  catch (e) { if (e.status === 422 && /return_run_details/i.test(e.message)) j = await api(path, { method: "POST", body }); else throw e; }
  if (j && j.workflow_run_id) return { ok: true, id: j.workflow_run_id, url: j.html_url || null, force: f };
  for (let k = 0; k < 5; k++) { // older API answer (204, no run id): find the run we just started
    await sleep(1500);
    const mine = (await engineRuns(cfg, deps, 5)).find(r => r.event === "workflow_dispatch" && Date.parse(r.created) >= t0 - 20000);
    if (mine) return { ok: true, id: mine.id, url: mine.url, force: f };
  }
  return { ok: true, id: null, url: `https://github.com/${cfg.repo}/actions/workflows/${cfg.workflow}`, force: f };
}
// The engine writes status.json (what each job did) to the data branch.
export async function engineLog(cfg, deps = {}) {
  const j = await client(cfg, deps)(`/repos/${cfg.repo}/contents/status.json?ref=${ref(cfg.dataBranch)}`);
  return JSON.parse(Buffer.from((j && j.content) || "", "base64").toString("utf8") || "null");
}
