import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// E9.1a: minimal Vite + React SPA, API-driven against control-api. No SSR.
export default defineConfig({
  plugins: [react()],
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
