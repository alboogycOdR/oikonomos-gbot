import { parse as parseYaml } from "yaml";

import {
  connectorManifestSchema,
  type ConnectorManifest,
} from "./schema.js";

export interface ManifestIssue {
  readonly field: string;
  readonly message: string;
}

export type ValidateManifestResult =
  | { readonly ok: true; readonly manifest: ConnectorManifest }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "(root)";
  }
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (out.length === 0) {
      out += String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out;
}

function zodIssuesToManifestIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ManifestIssue[] {
  return issues.map((issue) => ({
    field: formatPath(issue.path),
    message: issue.message,
  }));
}

/**
 * Parse a YAML document and validate it as a connector manifest.
 * Never throws on bad input — every failure is a named-field issue.
 */
export function validateManifest(raw: string): ValidateManifestResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "YAML parse failed";
    return { ok: false, issues: [{ field: "(yaml)", message }] };
  }

  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      issues: [{ field: "(root)", message: "manifest is empty" }],
    };
  }

  const result = connectorManifestSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  return { ok: false, issues: zodIssuesToManifestIssues(result.error.issues) };
}
