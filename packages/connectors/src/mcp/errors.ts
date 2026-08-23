export type McpManifestConfigErrorCode =
  | "SECRET_UNSET"
  | "SECRET_EMPTY"
  | "OWNERSHIP_NOT_BASILEIA"
  | "UNSUPPORTED_TRANSPORT"
  | "INVALID_SERVER_NAME";

/**
 * Named failure for manifest → MCP config. Messages name the secret REF
 * and/or the field; they never interpolate a resolved value (N4).
 */
export class McpManifestConfigError extends Error {
  readonly code: McpManifestConfigErrorCode;
  readonly ref: string | undefined;
  readonly field: string | undefined;

  constructor(
    message: string,
    code: McpManifestConfigErrorCode,
    options: { readonly ref?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "McpManifestConfigError";
    this.code = code;
    this.ref = options.ref;
    this.field = options.field;
  }
}
