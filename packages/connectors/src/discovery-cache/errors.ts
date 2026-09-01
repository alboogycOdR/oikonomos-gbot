export type DiscoveryErrorCode =
  | "SOLE_SOURCE_FAILED"
  | "ALL_SOURCES_FAILED"
  | "INVALID_SERVER_SET";

/**
 * Named discovery-cache failure. Messages name server identifiers only;
 * they never interpolate tool payloads, URLs, or secrets (N4).
 */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  readonly servers: readonly string[];

  constructor(message: string, code: DiscoveryErrorCode, servers: readonly string[]) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
    this.servers = Object.freeze([...servers]);
  }
}
