/**
 * TASK-104 / OIK-091 — registers `public/sw.js` (offline app-shell caching
 * only, see that file's header) so the dashboard is installable per
 * OIK-091. Split out from `main.tsx` so it's independently testable: the
 * only behaviour worth asserting here is "call `register` iff the browser
 * supports it," everything else lives in the worker script itself, which
 * jsdom cannot execute.
 */
export function registerServiceWorker(nav: Pick<Navigator, "serviceWorker"> | undefined = typeof navigator === "undefined" ? undefined : navigator): void {
  if (nav?.serviceWorker === undefined) {
    return;
  }
  window.addEventListener("load", () => {
    void nav.serviceWorker.register("/sw.js").catch(() => {
      // Installability/offline support degrades gracefully; a failed SW
      // registration must never block the app itself from loading and
      // working online.
    });
  });
}
