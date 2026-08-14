import test from "node:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "../rules/no-direct-agent-sdk-query.mjs";

test("no-direct-agent-sdk-query RuleTester cases", () => {
  const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
  });

  ruleTester.run("no-direct-agent-sdk-query", rule, {
    valid: [
      { code: 'import { query } from "@anthropic-ai/claude-agent-sdk";', filename: "packages/harness-factory/src/run.ts" },
      { code: 'const sdk = require("@anthropic-ai/claude-agent-sdk");', filename: "packages/harness-factory/src/run.ts" },
      { code: 'import { query } from "another-sdk"; query();', filename: "packages/broker/src/run.ts" },
    ],
    invalid: [
      {
        code: 'import { query } from "@anthropic-ai/claude-agent-sdk"; query();',
        filename: "packages/broker/src/run.ts",
        errors: [{ messageId: "outsideHarnessFactory" }],
      },
      {
        code: 'const sdk = require("@anthropic-ai/claude-agent-sdk/client");',
        filename: "packages/agent-providers/src/run.ts",
        errors: [{ messageId: "outsideHarnessFactory" }],
      },
      {
        code: 'await import("@anthropic-ai/claude-agent-sdk");',
        filename: "services/worker/src/run.ts",
        errors: [{ messageId: "outsideHarnessFactory" }],
      },
    ],
  });
});
