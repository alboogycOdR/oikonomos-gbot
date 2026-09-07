import { SEALED_SECRET_ROOT } from "@oikonomos/shared";

export const STEEL_BROWSER_BASE_URL = "http://127.0.0.1:3000";
export const STEEL_MCP_ENTRYPOINT = "/opt/oikonomos/steel-mcp/dist/stdio.js";
export const STEEL_BROWSER_PROFILE_ROOT = `${SEALED_SECRET_ROOT}/browser-profiles`;

export type HumanTakeoverKind = "captcha" | "two_factor" | "login_wall" | "payment";

export class HumanTakeoverRequiredError extends Error {
  readonly code = "HUMAN_TAKEOVER_REQUIRED";

  constructor(
    readonly kind: HumanTakeoverKind,
    readonly detail: string,
  ) {
    super(`human takeover required: ${kind}`);
    this.name = "HumanTakeoverRequiredError";
  }
}

export interface SteelMcpServerConfig {
  readonly command: "node";
  readonly args: readonly [string];
  readonly env: Readonly<{
    STEEL_LOCAL: "true";
    STEEL_BASE_URL: string;
    STEEL_PROFILE: "browse";
  }>;
}

export interface SteelSessionConfig {
  readonly roleId: string;
  readonly profileDirectory: string;
  readonly profileOwnership: "bot_private";
  readonly profileMode: 0o700;
  readonly browserBaseUrl: string;
  readonly egressAllowlist: readonly string[];
  readonly stealth: false;
  readonly antiDetection: false;
  readonly mcpServer: SteelMcpServerConfig;
}

export interface CreateSteelSessionConfigOptions {
  readonly roleId: string;
  readonly allowedHosts: readonly string[];
  readonly browserBaseUrl?: string;
  readonly mcpEntrypoint?: string;
}

const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;

/**
 * Builds the local Steel MCP configuration.  The profile path deliberately
 * stays below D3's sealed root: a model process runs as `sandbox`, whereas
 * the browser service owns this root-only directory.
 */
export function createSteelSessionConfig(options: CreateSteelSessionConfigOptions): SteelSessionConfig {
  if (!ROLE_ID.test(options.roleId)) {
    throw new Error("steel browser roleId must be a safe identifier");
  }
  const browserBaseUrl = options.browserBaseUrl ?? STEEL_BROWSER_BASE_URL;
  if (!isLoopbackHttpUrl(browserBaseUrl)) {
    throw new Error("steel browser base URL must be a loopback HTTP URL");
  }
  const allowedHosts = uniqueHosts(options.allowedHosts);
  const mcpEntrypoint = options.mcpEntrypoint ?? STEEL_MCP_ENTRYPOINT;
  if (!mcpEntrypoint.startsWith("/opt/oikonomos/")) {
    throw new Error("steel MCP entrypoint must be under /opt/oikonomos");
  }

  return Object.freeze({
    roleId: options.roleId,
    profileDirectory: `${STEEL_BROWSER_PROFILE_ROOT}/${options.roleId}`,
    profileOwnership: "bot_private",
    profileMode: 0o700,
    browserBaseUrl,
    egressAllowlist: Object.freeze(allowedHosts),
    stealth: false,
    antiDetection: false,
    mcpServer: Object.freeze({
      command: "node",
      args: Object.freeze([mcpEntrypoint]) as readonly [string],
      env: Object.freeze({
        STEEL_LOCAL: "true",
        STEEL_BASE_URL: browserBaseUrl,
        STEEL_PROFILE: "browse",
      }),
    }),
  });
}

/** Converts known challenge-page content into a typed, non-retryable signal. */
export function assertNoHumanTakeoverRequired(pageContent: string): void {
  const detected = detectHumanTakeover(pageContent);
  if (detected !== undefined) throw new HumanTakeoverRequiredError(detected.kind, detected.detail);
}

export function detectHumanTakeover(
  pageContent: string,
): { readonly kind: HumanTakeoverKind; readonly detail: string } | undefined {
  const normalized = pageContent.toLowerCase();
  const patterns: readonly [HumanTakeoverKind, RegExp][] = [
    ["captcha", /captcha|recaptcha|hcaptcha|verify you are human/],
    ["two_factor", /two[- ]factor|2fa|one[- ]time (?:code|password)|authenticator app/],
    ["login_wall", /sign in to continue|log in to continue|login required/],
    ["payment", /payment required|checkout|confirm (?:payment|purchase)/],
  ];
  for (const [kind, pattern] of patterns) {
    if (pattern.test(normalized)) return { kind, detail: `detected ${kind.replaceAll("_", " ")} page` };
  }
  return undefined;
}

function uniqueHosts(hosts: readonly string[]): string[] {
  const result = new Set<string>();
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase();
    if (!HOSTNAME.test(normalized)) throw new Error(`steel egress allowlist contains invalid host: ${host}`);
    result.add(normalized);
  }
  return [...result].sort();
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}
