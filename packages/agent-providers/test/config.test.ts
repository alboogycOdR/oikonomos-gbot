import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234567890abcdefghijklmno",
  TELEGRAM_ALLOWED_USER_IDS: "111111111,222222222",
};

describe("loadConfig", () => {
  it("loads valid minimal config with defaults applied", () => {
    const config = loadConfig(baseEnv);
    expect(config.DEFAULT_PROVIDER).toBe("claude-code");
    expect(config.allowedUserIds).toEqual(new Set([111111111, 222222222]));
    expect(config.CLAUDE_MODEL).toBe("claude-sonnet-5");
    expect(config.CODEX_SANDBOX).toBe("workspace-write");
    expect(config.GROK_MODEL).toBe("grok-4.5");
  });

  it("throws ConfigError when TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() => loadConfig({ TELEGRAM_ALLOWED_USER_IDS: "1" })).toThrow(ConfigError);
  });

  it("throws ConfigError when TELEGRAM_BOT_TOKEN is too short", () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_BOT_TOKEN: "short" })).toThrow(ConfigError);
  });

  it("throws ConfigError when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    const { TELEGRAM_ALLOWED_USER_IDS, ...rest } = baseEnv;
    void TELEGRAM_ALLOWED_USER_IDS;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
  });

  it("throws ConfigError when TELEGRAM_ALLOWED_USER_IDS contains a non-numeric entry", () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: "111,not-a-number" })).toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError when TELEGRAM_ALLOWED_USER_IDS contains a negative or zero id", () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: "-5" })).toThrow(ConfigError);
  });

  it("deduplicates allowed user IDs", () => {
    const config = loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: "111,111,222" });
    expect(config.allowedUserIds.size).toBe(2);
  });

  it("rejects an invalid DEFAULT_PROVIDER", () => {
    expect(() => loadConfig({ ...baseEnv, DEFAULT_PROVIDER: "not-a-provider" })).toThrow(ConfigError);
  });

  it("accepts a valid CODEX_SANDBOX override", () => {
    const config = loadConfig({ ...baseEnv, CODEX_SANDBOX: "read-only" });
    expect(config.CODEX_SANDBOX).toBe("read-only");
  });

  it("rejects an invalid CODEX_SANDBOX value", () => {
    expect(() => loadConfig({ ...baseEnv, CODEX_SANDBOX: "yolo" })).toThrow(ConfigError);
  });

  it("coerces numeric env vars from strings", () => {
    const config = loadConfig({ ...baseEnv, MESSAGE_EDIT_INTERVAL_MS: "2000", TASK_LIMIT: "5" });
    expect(config.MESSAGE_EDIT_INTERVAL_MS).toBe(2000);
    expect(config.TASK_LIMIT).toBe(5);
  });
});
