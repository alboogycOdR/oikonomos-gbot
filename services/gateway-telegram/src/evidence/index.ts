import { redactPayload } from "@oikonomos/audit";

import type { RunEvidence } from "../index.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATION_MARKER = "\n\n[TRUNCATED — full evidence remains available from control-api]";

/** Renders an approval plus redacted control-api evidence for plain-text Telegram. */
export function renderApprovalEvidence(actionRender: string, evidence: readonly RunEvidence[]): string {
  const redacted = redactPayload({ actionRender, evidence }) ?? {};
  const safeActionRender = typeof redacted.actionRender === "string" ? redacted.actionRender : "[REDACTED]";
  const safeEvidence = Array.isArray(redacted.evidence) ? redacted.evidence : [];
  const artifactUris = collectArtifactUris(safeEvidence);
  const lines = [safeActionRender, "", "Evidence:"];

  lines.push(safeEvidence.length === 0 ? "No recorded run evidence." : JSON.stringify(safeEvidence));
  if (artifactUris.length > 0) lines.push("", "Artifacts:", ...artifactUris);
  return truncateForTelegram(lines.join("\n"));
}

/** Keeps Telegram's hard limit visible to the operator rather than silent. */
export function truncateForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function collectArtifactUris(values: readonly unknown[]): string[] {
  const uris = new Set<string>();
  for (const value of values) visit(value, uris);
  return [...uris].sort();
}

function visit(value: unknown, uris: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, uris);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidenceUri" && typeof entry === "string") addUri(entry, uris);
    if ((key === "artifactUris" || key === "artifact_uris") && Array.isArray(entry)) {
      for (const uri of entry) if (typeof uri === "string") addUri(uri, uris);
    }
    if ((key === "artifactUri" || key === "artifact_uri") && typeof entry === "string") addUri(entry, uris);
    visit(entry, uris);
  }
}

function addUri(value: string, uris: Set<string>): void {
  const uri = value.trim();
  if (uri.length > 0) uris.add(uri);
}
