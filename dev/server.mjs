// Local dev server: serves /public and runs the /api functions like Vercel does.
//   npm run dev        -> real data (needs internet access to Yahoo, FINRA, CFTC, Forex Factory)
//   npm run dev:mock   -> offline mock data built from saved real snapshots (prices random-walk every tick)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = +process.env.PORT || 3000, MOCK = process.env.MOCK === "1";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
const mock = MOCK ? await import("./mock.mjs") : null;

async function api(name, req, res) {
  if (mock) {
    const body = await mock.handle(name);
    if (body == null) { res.statusCode = 404; return res.end("{}"); }
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(body));
  }
  const file = join(ROOT, "api", name + ".js");
  try { await stat(file); } catch { res.statusCode = 404; return res.end("{}"); }
  const mod = await import(pathToFileURL(file).href);
  await mod.default(req, res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(url.pathname.slice(5).replace(/\/$/, ""), req, res);
    if (url.pathname.startsWith("/data/")) {
      const name = url.pathname.slice(6).replace(/\.json$/, "");
      if (mock) return await api(name, req, res);
      const r = await fetch("https://raw.githubusercontent.com/joeyjojo0/Upper-Hand-Edge/data/" + name + ".json");
      res.statusCode = r.status; res.setHeader("Content-Type", "application/json"); return res.end(await r.text());
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, "public", p);
    const buf = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.end(buf);
  } catch (e) {
    res.statusCode = e.code === "ENOENT" ? 404 : 500;
    res.end(e.code === "ENOENT" ? "Not found" : String(e.stack || e));
  }
}).listen(PORT, () => console.log(`UHE dev server on http://localhost:${PORT}${MOCK ? " (mock data)" : ""}`));
