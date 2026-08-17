import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    includeSource: ["src/**/*.ts"],
    passWithNoTests: false,
  },
});
