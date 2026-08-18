/**
 * `mcp_server.url_ref` must be a secret reference (`secret://…`), never a
 * literal URL and never a credential-looking value (Handover §4.4; N4).
 */

export type UrlRefVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const SECRET_REF = /^secret:\/\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

export function inspectUrlRef(value: string): UrlRefVerdict {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "url_ref must be a secret:// reference" };
  }

  const lower = trimmed.toLowerCase();
  const looksLikeUrl = lower.startsWith("http://") || lower.startsWith("https://");
  const hasUserinfo = trimmed.includes("@");
  const hasAssignedSecret = /[?&#/](?:token|key|password|passwd|secret|api[_-]?key)=/i.test(
    trimmed,
  );

  if (looksLikeUrl && (hasUserinfo || hasAssignedSecret)) {
    return {
      ok: false,
      message: "credential-looking literal in mcp_server.url_ref",
    };
  }
  if (looksLikeUrl) {
    return {
      ok: false,
      message: "literal URL rejected; url_ref must be a secret:// reference",
    };
  }
  if (hasUserinfo || hasAssignedSecret || !SECRET_REF.test(trimmed)) {
    return {
      ok: false,
      message: "credential-looking literal in mcp_server.url_ref",
    };
  }
  return { ok: true };
}
