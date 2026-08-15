import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    includeSource: ["src/**/*.ts"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      thresholds: {
        branches: 100,
      },
    },
  },
});
