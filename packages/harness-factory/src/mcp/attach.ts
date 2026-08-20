import type { AgentSdkQueryFn } from "../ports.js";
import type { SdkMcpServers } from "./types.js";

/**
 * Bind resolved MCP servers onto every Agent SDK query() options object.
 * Called only from composeHarness (N9).
 */
export function attachMcpServersToQuery(
  query: AgentSdkQueryFn,
  mcpServers: SdkMcpServers,
): AgentSdkQueryFn {
  return (input) => {
    const callerOptions =
      input.options && typeof input.options === "object" && !Array.isArray(input.options)
        ? input.options
        : {};
    return query({
      prompt: input.prompt,
      options: {
        ...callerOptions,
        mcpServers,
      },
    });
  };
}
