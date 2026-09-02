import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: ["../.."],
    },
  },
  test: {
    includeSource: ["src/**/*.ts"],
    passWithNoTests: false,
  },
});
