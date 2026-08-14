import tsParser from "@typescript-eslint/parser";
import noDirectAgentSdkQuery from "./infra/lint/rules/no-direct-agent-sdk-query.mjs";
import policyNoIo from "./infra/lint/rules/policy-no-io.mjs";

const sourceFiles = ["**/*.{js,mjs,cjs,ts,mts,cts}"];

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
  },
  {
    files: sourceFiles,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      oikonomos: {
        rules: {
          "no-direct-agent-sdk-query": noDirectAgentSdkQuery,
          "policy-no-io": policyNoIo,
        },
      },
    },
    rules: {
      "oikonomos/no-direct-agent-sdk-query": "error",
      "oikonomos/policy-no-io": "error",
    },
  },
];
