import test from "node:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "../rules/policy-no-io.mjs";

test("policy-no-io RuleTester cases", () => {
  const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
  });

  ruleTester.run("policy-no-io", rule, {
    valid: [
      { code: "export const resolveTier = (tier) => tier;", filename: "packages/policy/src/tier.ts" },
      { code: 'import fs from "node:fs";', filename: "packages/broker/src/file.ts" },
    ],
    invalid: [
      { code: 'import fs from "fs";', filename: "packages/policy/src/fs.ts", errors: [{ messageId: "ioImport", data: { moduleName: "fs" } }] },
      { code: 'import net from "net";', filename: "packages/policy/src/net.ts", errors: [{ messageId: "ioImport", data: { moduleName: "net" } }] },
      { code: 'import http from "node:http";', filename: "packages/policy/src/http.ts", errors: [{ messageId: "ioImport", data: { moduleName: "node:http" } }] },
      { code: 'import childProcess from "child_process";', filename: "packages/policy/src/process.ts", errors: [{ messageId: "ioImport", data: { moduleName: "child_process" } }] },
      { code: 'import { Client } from "pg";', filename: "packages/policy/src/db.ts", errors: [{ messageId: "ioImport", data: { moduleName: "pg" } }] },
      { code: "const setting = process.env.POLICY_MODE;", filename: "packages/policy/src/env.ts", errors: [{ messageId: "processEnv" }] },
      { code: 'const setting = process["env"].POLICY_MODE;', filename: "packages/policy/src/env-computed.ts", errors: [{ messageId: "processEnv" }] },
      { code: 'const database = require("postgres");', filename: "packages/policy/src/require.ts", errors: [{ messageId: "ioImport", data: { moduleName: "postgres" } }] },
    ],
  });
});
