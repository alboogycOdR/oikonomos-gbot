export type SandboxClientErrorCode =
  | "SECRET_UNSET"
  | "SECRET_EMPTY"
  | "REQUEST_FAILED"
  | "UNEXPECTED_STATUS"
  | "INVALID_RESPONSE";

/**
 * Named failure for the OpenSandbox client. Messages describe the failing
 * operation/endpoint and, for HTTP failures, the response `code`/status —
 * never the API key or any other credential (CLAUDE.md non-negotiable 4).
 */
export class SandboxClientError extends Error {
  readonly code: SandboxClientErrorCode;
  readonly status: number | undefined;
  readonly apiErrorCode: string | undefined;

  constructor(
    message: string,
    code: SandboxClientErrorCode,
    options: { readonly status?: number; readonly apiErrorCode?: string } = {},
  ) {
    super(message);
    this.name = "SandboxClientError";
    this.code = code;
    this.status = options.status;
    this.apiErrorCode = options.apiErrorCode;
  }
}
