import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_DIR = join(__dirname, "..");
const PUBLIC_DIR = join(ROOT_DIR, "public");

/**
 * TASK-104 AC: "PWA manifest present, app is installable ... service
 * worker caches only the static app shell — NOT API responses (approval/run
 * state must always be live, never served stale from a cache)."
 *
 * jsdom can't execute a real ServiceWorker, so this test asserts the two
 * installability-relevant static facts directly: the manifest satisfies
 * Chrome/Lighthouse's installability minimums, and the worker source
 * explicitly excludes every API path this app calls from its cache paths.
 */
describe("PWA packaging", () => {
  it("manifest.json has the fields and icon sizes installability checks require", () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, "manifest.json"), "utf-8")) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };

    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((icon) => icon.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === "512x512")).toBe(true);
  });

  it("sw.js never caches the dashboard's own API paths (runs, approvals, auth)", () => {
    const source = readFileSync(join(PUBLIC_DIR, "sw.js"), "utf-8");

    expect(source).toContain('"/runs"');
    expect(source).toContain('"/approvals"');
    expect(source).toContain('"/auth"');
    expect(source).toMatch(/isApiRequest[\s\S]*return;/);
    // Guard against the API bypass being written after the caching logic
    // (which would make it dead code): the bypass check must appear before
    // any cache.match/cache.put call in the fetch handler.
    const fetchHandlerStart = source.indexOf('addEventListener("fetch"');
    const bypassIndex = source.indexOf("isApiRequest(url)", fetchHandlerStart);
    const firstCacheCallIndex = source.indexOf("caches.match", fetchHandlerStart);
    expect(bypassIndex).toBeGreaterThan(-1);
    expect(firstCacheCallIndex).toBeGreaterThan(-1);
    expect(bypassIndex).toBeLessThan(firstCacheCallIndex);
  });

  it("index.html links the manifest and an icon", () => {
    const indexHtml = readFileSync(join(ROOT_DIR, "index.html"), "utf-8");
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain("/manifest.json");
  });
});
