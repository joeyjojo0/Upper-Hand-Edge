// Backend for the /update page: Claude edits the site's code, then "Push to GitHub", "Undo" and the data engine.
//   GET  /api/update                     → what's configured (never secrets) + the commit this deployment runs
//   POST /api/update {action, pin, ...}  → check | step (streams NDJSON) | push | undo | deploy | commits | engine | runs | run | log
// Settings (Vercel → Environment Variables): ANTHROPIC_API_KEY, GITHUB_TOKEN, UPDATE_PIN (falls back to TRADE_PIN);
// optional UPDATE_MODEL, GITHUB_REPO, GITHUB_BRANCH, ENGINE_WORKFLOW.
// Safety: every action needs the PIN (wrong PINs are slowed down; 30 in 15 minutes lock the page for a while),
// requests from other websites are refused, and Claude only edits an in-memory copy: nothing reaches GitHub
// until "Push to GitHub" is pressed.
import { createHash, timingSafeEqual } from "node:crypto";
import { ghConfig, isSha, head, snapshot, pushFiles, undoCommit, deployStatus, recentCommits, runEngine, engineRuns, engineRun, engineLog } from "./_lib/github.js";
import { MODELS, Workspace, cleanPath, systemPrompt, roundPrompt, runRound, ToolError } from "./_lib/agent.js";

export const config = { maxDuration: 300 };

class HttpError extends Error { constructor(status, message, code = "BAD_REQUEST") { super(message); this.status = status; this.code = code; } }
const bad = m => new HttpError(400, m);

export function readConfig(E = process.env) {
  return {
    key: String(E.ANTHROPIC_API_KEY || "").trim(), pin: String(E.UPDATE_PIN || E.TRADE_PIN || ""), pinVar: E.UPDATE_PIN ? "UPDATE_PIN" : E.TRADE_PIN ? "TRADE_PIN" : null,
    gh: ghConfig(E), model: String(E.UPDATE_MODEL || "").trim() || MODELS[0].id,
    deployed: { sha: E.VERCEL_GIT_COMMIT_SHA || null, ref: E.VERCEL_GIT_COMMIT_REF || null, env: E.VERCEL_ENV || null }
  };
}
const models = cfg => MODELS.some(m => m.id === cfg.model) ? MODELS : [...MODELS, { id: cfg.model, label: cfg.model, price: null }];
const pickModel = (cfg, m) => models(cfg).some(x => x.id === m) ? m : cfg.model;
export function status(cfg) {
  const configured = { claude: !!cfg.key, github: !!cfg.gh.token, pin: cfg.pin.length >= 8 };
  return { configured, ready: configured.pin && configured.claude && configured.github, pinVar: cfg.pinVar, repo: cfg.gh.repo, branch: cfg.gh.branch,
    workflow: cfg.gh.workflow, models: models(cfg), model: cfg.model, deployed: cfg.deployed, asOf: new Date().toISOString() };
}
const hash = s => createHash("sha256").update(String(s)).digest();
export const pinOK = (pin, given) => pin.length >= 8 && typeof given === "string" && timingSafeEqual(hash(given), hash(pin));
const fails = [];
const lockedOut = () => { const now = Date.now(); while (fails.length && now - fails[0] > 15 * 60e3) fails.shift(); return fails.length >= 30; };

function cleanStaged(files) {
  const out = {};
  if (files && typeof files === "object" && !Array.isArray(files))
    for (const [p, c] of Object.entries(files)) { try { out[cleanPath(p)] = c == null ? null : String(c); } catch { /* skip bad paths */ } }
  return out;
}
function checkRound(round, cfg) {
  const ok = round && typeof round === "object" && typeof round.system === "string" && round.system.length < 200000 && Array.isArray(round.messages) && round.messages.length
    && round.messages.length < 600 && round.messages.every(m => m && (m.role === "user" || m.role === "assistant") && m.content != null);
  if (!ok) throw bad("This Claude session can't be continued. Send your request again.");
  return { model: pickModel(cfg, round.model), system: round.system, messages: round.messages };
}

async function step(res, body, cfg, deps) {
  const t0 = Date.now(), soft = deps.softMs ?? 170e3, hard = deps.hardMs ?? 285e3;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Accel-Buffering", "no");
  const emit = o => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + "\n"); };
  const ac = new AbortController(), gone = () => { if (!res.writableEnded) ac.abort(new Error("gone")); };
  if (res.on) res.on("close", gone);
  const ping = setInterval(() => emit({ t: "ping" }), 10000), kill = setTimeout(() => ac.abort(new Error("time")), hard);
  try {
    const gh = cfg.gh, baseSha = isSha(body.baseSha) ? body.baseSha : await head(gh, deps);
    emit({ t: "base", sha: baseSha, branch: gh.branch });
    const snap = await snapshot(gh, baseSha, deps), staged = cleanStaged(body.files), ws = new Workspace(snap.files, staged);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    let round;
    if (prompt) {
      round = { model: pickModel(cfg, body.model), system: systemPrompt({ repo: gh.repo, branch: gh.branch, sha: baseSha, ws }),
        messages: [{ role: "user", content: roundPrompt({ prompt, history: body.history, staged: ws.staging() }) }] };
      emit({ t: "round", model: round.model, system: round.system, first: round.messages[0] });
    } else round = checkRound(body.round, cfg);
    const r = await runRound({ key: cfg.key, model: round.model, system: round.system, messages: round.messages, ws, emit, signal: ac.signal,
      fetchImpl: deps.fetch, sleep: deps.sleep, deadline: t0 + soft, maxTurns: deps.maxTurns, known: new Set(Object.keys(staged)) });
    emit({ t: r.status === "continue" ? "continue" : "done", status: r.status, summary: r.summary || "" });
  } catch (e) {
    const why = ac.signal.aborted && ac.signal.reason && ac.signal.reason.message;
    if (why === "time") emit({ t: "error", code: "TIME", retry: true, error: "That step took too long, so it's picking up from the last finished step." });
    else if (why !== "gone") emit({ t: "error", code: e.code || "ERROR", retry: e.code === "CUT" || e.status === 529 || e.status >= 500, error: String((e && e.message) || e) });
  } finally { clearInterval(ping); clearTimeout(kill); if (res.off) res.off("close", gone); res.end(); }
}

export async function run(action, body, cfg, deps = {}) {
  const gh = cfg.gh;
  switch (action) {
    case "check": {
      const out = { ok: true, ...status(cfg) };
      if (gh.token) {
        const [c, r] = await Promise.allSettled([recentCommits(gh, deps, 6), engineRuns(gh, deps, 6)]);
        out.commits = c.status === "fulfilled" ? c.value : null; out.runs = r.status === "fulfilled" ? r.value : null;
        const err = [c, r].find(x => x.status === "rejected"); if (err) out.githubError = String(err.reason && err.reason.message || err.reason);
      }
      return out;
    }
    case "commits": return { ok: true, commits: await recentCommits(gh, deps, 6) };
    case "push": {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw bad("Nothing to push.");
      if (files.length > 100) throw bad("Too many files for one push (100 max).");
      const baseSha = isSha(body.baseSha) ? body.baseSha : null;
      let snap = null; if (baseSha) { try { snap = await snapshot(gh, baseSha, deps); } catch { /* file modes default to 100644 */ } }
      const list = files.map(f => {
        let path; try { path = cleanPath(f && f.path); } catch (e) { throw bad(e.message); }
        const was = snap && snap.files.get(path);
        if (was && was.binary) throw bad(`${path} is a binary file and can't be pushed from here.`);
        return { path, content: f.content == null ? null : String(f.content), mode: was ? was.mode : "100644" };
      });
      const message = String(body.message || "").trim().slice(0, 6000) || "Update from the UHE update page";
      return pushFiles(gh, { baseSha, files: list, message, overwrite: body.overwrite === true }, deps);
    }
    case "undo": if (!isSha(body.sha)) throw bad("Which commit should be undone?"); return undoCommit(gh, body.sha, deps);
    case "deploy": if (!isSha(body.sha)) throw bad("Which commit?"); return { ok: true, github: await deployStatus(gh, body.sha, deps), live: cfg.deployed.sha };
    case "engine": return runEngine(gh, body.force, deps);
    case "runs": return { ok: true, runs: await engineRuns(gh, deps, 6) };
    case "run": { const id = Number(body.id); if (!(id > 0)) throw bad("Which run?"); return { ok: true, run: await engineRun(gh, id, deps) }; }
    case "log": return { ok: true, log: await engineLog(gh, deps) };
    default: throw bad("Unknown action");
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let s = ""; for await (const ch of req) { s += ch; if (s.length > 6e6) throw new HttpError(413, "That's too much to send in one go."); }
  return s ? JSON.parse(s) : {};
}
function out(res, code, body) { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); }

export default async function handler(req, res, deps = {}) {
  const cfg = deps.cfg || readConfig();
  if (req.method === "GET") return out(res, 200, status(cfg));
  if (req.method !== "POST") return out(res, 405, { ok: false, error: "Use GET or POST" });
  const o = req.headers.origin, host = req.headers["x-forwarded-host"] || req.headers.host;
  if (o) { try { if (new URL(o).host !== host) return out(res, 403, { ok: false, error: "Cross-site request blocked" }); } catch { return out(res, 403, { ok: false, error: "Bad origin" }); } }
  let body; try { body = await readBody(req); } catch (e) { return out(res, e.status || 400, { ok: false, error: e.status ? e.message : "Bad JSON" }); }
  if (cfg.pin.length < 8) return out(res, 503, { ok: false, code: "NO_PIN", error: "The update page is locked: set UPDATE_PIN (8+ characters) in Vercel first." });
  if (lockedOut()) return out(res, 429, { ok: false, code: "LOCKED", error: "Too many wrong PINs. Try again in 15 minutes." });
  if (!pinOK(cfg.pin, body.pin)) { fails.push(Date.now()); await new Promise(r => setTimeout(r, deps.pinDelay ?? 1200)); return out(res, 401, { ok: false, code: "BAD_PIN", error: "Wrong PIN" }); }
  const action = String(body.action || "");
  if (action === "step" && !cfg.key) return out(res, 503, { ok: false, code: "NO_CLAUDE", error: "Add ANTHROPIC_API_KEY in Vercel so Claude can edit the site." });
  if (action !== "check" && !cfg.gh.token) return out(res, 503, { ok: false, code: "NO_GITHUB", error: "Add GITHUB_TOKEN in Vercel (the setup steps are on this page)." });
  if (action === "step") return step(res, body, cfg, deps);
  try { return out(res, 200, await run(action, body, cfg, deps)); }
  catch (e) {
    const code = e instanceof ToolError ? 400 : e.status >= 400 && e.status < 600 ? e.status : 502;
    return out(res, code, { ok: false, code: e.code || "ERROR", error: String((e && e.message) || e), ...(e.conflicts ? { conflicts: e.conflicts } : {}) });
  }
}
