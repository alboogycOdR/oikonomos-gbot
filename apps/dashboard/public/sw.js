/**
 * TASK-104 / OIK-091 — PWA service worker: offline app-shell caching ONLY.
 *
 * Deliberately does NOT cache anything under `API_PATH_PREFIXES` (control-api
 * calls made from `src/lib/api.ts`: runs, approvals, auth, evidence). This
 * dashboard is the operator's approval surface — serving a stale cached
 * `GET /approvals` or `GET /runs/:id/evidence` response after a real
 * decision was already made elsewhere would show wrong state on exactly the
 * screen operators trust to be current. Every request under those prefixes
 * falls straight through to the network, uncached, unconditionally, per
 * this task's Description.
 *
 * Only the static app shell (the HTML entry point, JS/CSS bundles, fonts,
 * images) is cached, so the app still boots offline; once booted it still
 * needs a live network for any real data.
 */
const SHELL_CACHE = "oikonomos-dashboard-shell-v1";
const SHELL_PRECACHE = ["/", "/index.html", "/manifest.json"];

// Keep this in sync with control-api's routes mounted at the dashboard's
// own origin (see src/lib/api.ts) — anything reachable through `request()`
// or the raw `fetch` calls in that file must be listed here.
const API_PATH_PREFIXES = ["/runs", "/approvals", "/auth"];

function isApiRequest(url) {
  return API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return; // never intercept writes (approval decisions, login, etc.)
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return; // cross-origin: let the browser handle it normally
  }

  if (isApiRequest(url)) {
    return; // live data — always network, never cached, never intercepted
  }

  if (request.mode === "navigate") {
    // Offline app-shell fallback for SPA navigations; online, always prefer
    // the network so a fresh deploy is picked up immediately.
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (["script", "style", "image", "font", "manifest"].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached !== undefined) {
          return cached;
        }
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
