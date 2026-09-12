// TASK-240 — minimal static server for the built dashboard (apps/dashboard/dist)
// with SPA fallback. Deliberately dependency-free: the release origin is
// Tailscale Serve (infra/compose/tailscale-serve.ps1), which mounts `/` on this
// process and every API prefix on control-api. Tailscale's own directory
// serving has no SPA fallback, so `/workspace/<id>` would 404 on reload; this
// 60-line server exists for exactly that reason and nothing else.
//
// Binds 127.0.0.1 only. Never serves anything outside DIST. No caching of
// index.html (so a new build is picked up on the next reload); hashed assets
// are immutable and cached for a year.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(HERE, "..", "..", "apps", "dashboard", "dist");
const PORT = Number(process.env.DASHBOARD_STATIC_PORT ?? 5174);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

async function fileOrNull(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? path : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Resolve inside DIST only; a traversal attempt resolves outside and is refused.
  const candidate = resolve(DIST, "." + normalize(decodeURIComponent(url.pathname)));
  if (!candidate.startsWith(DIST + sep) && candidate !== DIST) {
    res.writeHead(403).end();
    return;
  }
  let file = await fileOrNull(candidate);
  if (!file && !extname(candidate)) file = await fileOrNull(join(DIST, "index.html")); // SPA fallback
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const isIndex = file.endsWith(sep + "index.html");
  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
  });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dashboard-static] serving ${DIST} on http://127.0.0.1:${PORT}`);
});
