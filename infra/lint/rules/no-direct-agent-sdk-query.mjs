const SDK_PACKAGE_PREFIX = "@anthropic-ai/claude-agent-sdk";
const HARNESS_FACTORY_PATH = /(^|[\\/])packages[\\/]harness-factory([\\/]|$)/;

function isAgentSdkModule(value) {
  return (
    typeof value === "string" &&
    (value === SDK_PACKAGE_PREFIX || value.startsWith(`${SDK_PACKAGE_PREFIX}/`))
  );
}

function isHarnessFactory(filename) {
  return HARNESS_FACTORY_PATH.test(filename);
}

function report(context, node) {
  context.report({ node, messageId: "outsideHarnessFactory" });
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "restrict Agent SDK query and client entry points to packages/harness-factory",
    },
    schema: [],
    messages: {
      outsideHarnessFactory:
        "Agent SDK query() and client entry points are only sanctioned in packages/harness-factory. Route harness invocations through that package.",
    },
  },
  create(context) {
    if (isHarnessFactory(context.filename)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (isAgentSdkModule(node.source.value)) {
          report(context, node.source);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal" &&
          isAgentSdkModule(node.arguments[0].value)
        ) {
          report(context, node.arguments[0]);
        }
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && isAgentSdkModule(node.source.value)) {
          report(context, node.source);
        }
      },
    };
  },
};
