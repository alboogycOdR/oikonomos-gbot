import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// TASK-240: embed the git SHA of the build so the running dashboard can
// report exactly which candidate it is (spec OIKONOMOS_WORKSPACE_WAVE §6.2).
// OIKONOMOS_BUILD_SHA wins when the release runbook sets it; otherwise the
// checkout's HEAD; "unknown" outside a git checkout.
function buildSha(): string {
  if (process.env.OIKONOMOS_BUILD_SHA) return process.env.OIKONOMOS_BUILD_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

// E9.1a: minimal Vite + React SPA, API-driven against control-api. No SSR.
const sha = buildSha();

export default defineConfig({
  plugins: [
    react(),
    {
      // Emit dist/build.json so the running build is identifiable from the
      // release origin (GET /build.json) even before any UI references the
      // define below — an unreferenced `define` is tree-shaken out of the
      // bundle, which is why the rollback drill checks this file instead.
      name: "oikonomos-build-info",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: JSON.stringify({ buildSha: sha, builtAt: new Date().toISOString() }),
        });
      },
    },
  ],
  define: {
    __OIKONOMOS_BUILD_SHA__: JSON.stringify(sha),
  },
  build: {
    outDir: "dist",
  },
  // Dev-only same-origin proxy to control-api. control-api registers no
  // CORS policy (deliberately — see TASK-101's dossier), so a browser
  // client on a different origin/port cannot call it directly in dev.
  // Production serves the dashboard from the same origin as control-api
  // (the deferred static-hosting question TASK-102 flagged); this proxy
  // is the dev-time equivalent of that, not a security boundary change.
  server: {
    proxy: {
      "/auth": "http://localhost:3000",
      "/runs": "http://localhost:3000",
      "/approvals": "http://localhost:3000",
      "/tasks": "http://localhost:3000",
      "/roles": "http://localhost:3000",
      "/threads": "http://localhost:3000",
    },
  },
});
