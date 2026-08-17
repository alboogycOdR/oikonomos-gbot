import path from "node:path";
import os from "node:os";
import { isProviderId, type ProviderId } from "./types.js";

/**
 * All environment configuration for the extracted providers (plus the
 * Telegram-bot fields the original config tests still assert). Validated up
 * front so the process fails fast with a clear message.
 *
 * Validation is hand-rolled (no zod) so this package adds no lockfile
 * dependencies. Banned Agent SDK permission-mode tokens are not accepted.
 */

export type ClaudePermissionMode = "default" | "plan" | "dontAsk";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type GrokSandbox = "workspace" | "read-only" | "strict" | "devbox" | "off";
export type LogLevel = "debug" | "info" | "warn" | "error";

const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = ["default", "plan", "dontAsk"];
const CODEX_SANDBOXES: readonly CodexSandbox[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const GROK_SANDBOXES: readonly GrokSandbox[] = ["workspace", "read-only", "strict", "devbox", "off"];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  DEFAULT_PROVIDER: ProviderId;
  DEFAULT_CWD: string;
  CLAUDE_MODEL: string;
  CLAUDE_PERMISSION_MODE: ClaudePermissionMode;
  ANTHROPIC_API_KEY: string | undefined;
  CODEX_BIN: string;
  CODEX_MODEL: string;
  CODEX_SANDBOX: CodexSandbox;
  CODEX_API_KEY: string | undefined;
  GROK_BIN: string;
  GROK_MODEL: string;
  GROK_SANDBOX: GrokSandbox;
  GROK_ALWAYS_APPROVE: boolean;
  XAI_API_KEY: string | undefined;
  BOT_LOCALE: string;
  MESSAGE_EDIT_INTERVAL_MS: number;
  MAX_TELEGRAM_MESSAGE_CHARS: number;
  CODE_FILE_MAX_SIZE_KB: number;
  STATE_DIR: string;
  TASK_LIMIT: number;
  SCHEDULED_TASK_TIMEOUT_MINUTES: number;
  LOG_LEVEL: LogLevel;
}

export interface AppConfig extends Env {
  /** Parsed, deduplicated, sorted set of allowed Telegram numeric user IDs. */
  allowedUserIds: Set<number>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

interface Issue {
  path: string;
  message: string;
}

function readRaw(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  return value;
}

function requireString(
  source: Record<string, string | undefined>,
  key: string,
  issues: Issue[],
  minLength = 1,
): string | undefined {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) {
    issues.push({ path: key, message: "Required" });
    return undefined;
  }
  if (value.length < minLength) {
    issues.push({
      path: key,
      message:
        key === "TELEGRAM_BOT_TOKEN"
          ? "TELEGRAM_BOT_TOKEN looks too short to be valid"
          : `String must contain at least ${minLength} character(s)`,
    });
    return undefined;
  }
  return value;
}

function optionalString(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

function stringWithDefault(
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) return fallback;
  return value;
}

function enumWithDefault<T extends string>(
  source: Record<string, string | undefined>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  issues: Issue[],
): T {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) return fallback;
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  issues.push({ path: key, message: `Invalid enum value. Expected ${allowed.join(" | ")}, received '${value}'` });
  return fallback;
}

function coercePositiveInt(
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
  issues: Issue[],
): number {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    issues.push({ path: key, message: "Expected a positive integer" });
    return fallback;
  }
  return n;
}

function coerceBoolean(
  source: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const value = readRaw(source, key);
  if (value === undefined || value.length === 0) return fallback;
  const lowered = value.trim().toLowerCase();
  if (lowered === "false" || lowered === "0" || lowered === "no") return false;
  if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
  return Boolean(value);
}

function parseAllowedUserIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(
          `TELEGRAM_ALLOWED_USER_IDS contains an invalid entry: "${s}". Expected positive integers, comma-separated.`,
        );
      }
      return n;
    });

  if (ids.length === 0) {
    throw new ConfigError("TELEGRAM_ALLOWED_USER_IDS must contain at least one user ID.");
  }

  return new Set(ids);
}

/**
 * Load and validate configuration from a plain key/value record (typically
 * `process.env`). Pure function — no I/O — so it is trivially unit-testable.
 */
export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const issues: Issue[] = [];

  const TELEGRAM_BOT_TOKEN = requireString(source, "TELEGRAM_BOT_TOKEN", issues, 20);
  const TELEGRAM_ALLOWED_USER_IDS = requireString(source, "TELEGRAM_ALLOWED_USER_IDS", issues, 1);

  const defaultProviderRaw = stringWithDefault(source, "DEFAULT_PROVIDER", "claude-code");
  let DEFAULT_PROVIDER: ProviderId = "claude-code";
  if (isProviderId(defaultProviderRaw)) {
    DEFAULT_PROVIDER = defaultProviderRaw;
  } else {
    issues.push({
      path: "DEFAULT_PROVIDER",
      message: `Invalid enum value. Expected claude-code | codex | grok, received '${defaultProviderRaw}'`,
    });
  }

  const DEFAULT_CWD = stringWithDefault(source, "DEFAULT_CWD", path.join(os.homedir(), "projects"));
  const CLAUDE_MODEL = stringWithDefault(source, "CLAUDE_MODEL", "claude-sonnet-5");
  const CLAUDE_PERMISSION_MODE = enumWithDefault(
    source,
    "CLAUDE_PERMISSION_MODE",
    CLAUDE_PERMISSION_MODES,
    "default",
    issues,
  );
  const ANTHROPIC_API_KEY = optionalString(source, "ANTHROPIC_API_KEY");
  const CODEX_BIN = stringWithDefault(source, "CODEX_BIN", "codex");
  const CODEX_MODEL = stringWithDefault(source, "CODEX_MODEL", "gpt-5.4");
  const CODEX_SANDBOX = enumWithDefault(source, "CODEX_SANDBOX", CODEX_SANDBOXES, "workspace-write", issues);
  const CODEX_API_KEY = optionalString(source, "CODEX_API_KEY");
  const GROK_BIN = stringWithDefault(source, "GROK_BIN", "grok");
  const GROK_MODEL = stringWithDefault(source, "GROK_MODEL", "grok-4.5");
  const GROK_SANDBOX = enumWithDefault(source, "GROK_SANDBOX", GROK_SANDBOXES, "workspace", issues);
  const GROK_ALWAYS_APPROVE = coerceBoolean(source, "GROK_ALWAYS_APPROVE", true);
  const XAI_API_KEY = optionalString(source, "XAI_API_KEY");
  const BOT_LOCALE = stringWithDefault(source, "BOT_LOCALE", "en");
  const MESSAGE_EDIT_INTERVAL_MS = coercePositiveInt(source, "MESSAGE_EDIT_INTERVAL_MS", 900, issues);
  const MAX_TELEGRAM_MESSAGE_CHARS = coercePositiveInt(source, "MAX_TELEGRAM_MESSAGE_CHARS", 3500, issues);
  const CODE_FILE_MAX_SIZE_KB = coercePositiveInt(source, "CODE_FILE_MAX_SIZE_KB", 200, issues);
  const STATE_DIR = stringWithDefault(source, "STATE_DIR", path.join(os.homedir(), ".cc-telegram-bot"));
  const TASK_LIMIT = coercePositiveInt(source, "TASK_LIMIT", 10, issues);
  const SCHEDULED_TASK_TIMEOUT_MINUTES = coercePositiveInt(
    source,
    "SCHEDULED_TASK_TIMEOUT_MINUTES",
    60,
    issues,
  );
  const LOG_LEVEL = enumWithDefault(source, "LOG_LEVEL", LOG_LEVELS, "info", issues);

  if (issues.length > 0) {
    const rendered = issues.map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${rendered}`);
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALLOWED_USER_IDS) {
    throw new ConfigError("Invalid configuration: required fields missing.");
  }

  const allowedUserIds = parseAllowedUserIds(TELEGRAM_ALLOWED_USER_IDS);

  return {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_ALLOWED_USER_IDS,
    DEFAULT_PROVIDER,
    DEFAULT_CWD,
    CLAUDE_MODEL,
    CLAUDE_PERMISSION_MODE,
    ANTHROPIC_API_KEY,
    CODEX_BIN,
    CODEX_MODEL,
    CODEX_SANDBOX,
    CODEX_API_KEY,
    GROK_BIN,
    GROK_MODEL,
    GROK_SANDBOX,
    GROK_ALWAYS_APPROVE,
    XAI_API_KEY,
    BOT_LOCALE,
    MESSAGE_EDIT_INTERVAL_MS,
    MAX_TELEGRAM_MESSAGE_CHARS,
    CODE_FILE_MAX_SIZE_KB,
    STATE_DIR,
    TASK_LIMIT,
    SCHEDULED_TASK_TIMEOUT_MINUTES,
    LOG_LEVEL,
    allowedUserIds,
  };
}

/** Convenience wrapper that loads from `process.env`. */
export async function loadConfigFromEnv(): Promise<AppConfig> {
  return loadConfig(process.env);
}
