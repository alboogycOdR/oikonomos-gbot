const POLICY_PATH = /(^|[\\/])packages[\\/]policy([\\/]|$)/;

const NODE_IO_MODULES = new Set([
  "fs",
  "net",
  "http",
  "https",
  "dns",
  "child_process",
  "worker_threads",
]);

const DATABASE_MODULES = new Set([
  "pg",
  "postgres",
  "postgres.js",
  "@prisma/client",
  "mysql",
  "mysql2",
  "sqlite3",
  "better-sqlite3",
  "knex",
  "sequelize",
  "mongoose",
]);

function isPolicyFile(filename) {
  return POLICY_PATH.test(filename);
}

function isIoModule(value) {
  if (typeof value !== "string") {
    return false;
  }

  const moduleName = value.startsWith("node:") ? value.slice("node:".length) : value;
  const rootModule = moduleName.split("/")[0];
  return NODE_IO_MODULES.has(rootModule) || DATABASE_MODULES.has(rootModule);
}

function isProcessEnv(node) {
  if (node.object.type !== "Identifier" || node.object.name !== "process") {
    return false;
  }

  return (
    (!node.computed && node.property.type === "Identifier" && node.property.name === "env") ||
    (node.computed && node.property.type === "Literal" && node.property.value === "env")
  );
}

function reportModule(context, node, moduleName) {
  context.report({ node, messageId: "ioImport", data: { moduleName } });
}

export default {
  meta: {
    type: "problem",
    docs: { description: "keep packages/policy pure by prohibiting I/O" },
    schema: [],
    messages: {
      ioImport:
        "packages/policy must be pure: I/O module '{{moduleName}}' is forbidden. Pass required data into a policy function instead.",
      processEnv:
        "packages/policy must be pure: process.env access is forbidden. Pass configuration into a policy function instead.",
    },
  },
  create(context) {
    if (!isPolicyFile(context.filename)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (isIoModule(node.source.value)) {
          reportModule(context, node.source, node.source.value);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal" &&
          isIoModule(node.arguments[0].value)
        ) {
          reportModule(context, node.arguments[0], node.arguments[0].value);
        }
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && isIoModule(node.source.value)) {
          reportModule(context, node.source, node.source.value);
        }
      },
      MemberExpression(node) {
        if (isProcessEnv(node)) {
          context.report({ node, messageId: "processEnv" });
        }
      },
    };
  },
};
