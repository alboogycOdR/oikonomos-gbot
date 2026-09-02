import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// E9.1a: minimal Vite + React SPA, API-driven against control-api. No SSR.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
