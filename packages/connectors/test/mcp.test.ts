import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  envKeyFromSecretRef,
  envSecretResolver,
  mcpConfigFromManifest,
  McpManifestConfigError,
  type ManifestMcpInput,
  type McpServerConfig,
  type SecretResolver,
} from "../src/mcp/index.js";
import { validateManifest, type ConnectorManifest } from "../src/index.js";
import { handoverGmailYaml } from "./helpers.js";

const mcpSrcRoot = fileURLToPath(new URL("../src/mcp", import.meta.url));

/** Distinct sentinel assembled at runtime so the source file holds no contiguous secret (N4). */
const RESOLVED_URL = ["https://", "mcp-unique-", "sentinel.invalid/", "gmail"].join("");
const GMAIL_REF = "secret://mcp/gmail/url";
const GMAIL_ENV_KEY = "OIK_SECRET_MCP_GMAIL_URL";

function requireGmailManifest(): ConnectorManifest {
  const result = validateManifest(handoverGmailYaml());
  if (!result.ok) {
    throw new Error("gmail handover fixture must validate");
  }
  return result.manifest;
}

function manifestSlice(
  overrides: Partial<ManifestMcpInput> & {
    mcp_server?: Partial<ManifestMcpInput["mcp_server"]>;
  } = {},
): ManifestMcpInput {
  const base = requireGmailManifest();
  return {
    account_ownership: overrides.account_ownership ?? base.account_ownership,
    mcp_server: {
      name: overrides.mcp_server?.name ?? base.mcp_server.name,
      transport: overrides.mcp_server?.transport ?? base.mcp_server.transport,
      url_ref: overrides.mcp_server?.url_ref ?? base.mcp_server.url_ref,
    },
  };
}

function resolverOf(map: Readonly<Record<string, string>>): SecretResolver["resolve"] {
  return async (ref) => {
    if (!Object.prototype.hasOwnProperty.call(map, ref)) {
      throw new McpManifestConfigError(`secret ref is unset: ${ref}`, "SECRET_UNSET", {
        ref,
        field: "mcp_server.url_ref",
      });
    }
    return map[ref] ?? "";
  };
}

function assertNoSecret(material: string, secret: string): void {
  expect(material).not.toContain(secret);
  expect(material).not.toContain("mcp-unique-sentinel");
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function serialization(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const json = JSON.stringify(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  return `${message}\n${json}\n${stack}`;
}

describe("envKeyFromSecretRef (Handover §4.4)", () => {
  it("maps secret://mcp/gmail/url to OIK_SECRET_MCP_GMAIL_URL", () => {
    expect(envKeyFromSecretRef(GMAIL_REF)).toBe(GMAIL_ENV_KEY);
  });
});

describe("mcpConfigFromManifest — McpServerConfig shape (TASK-052 / Handover §4.4)", () => {
  it("returns http transport + resolved url for the gmail handover manifest", async () => {
    const manifest = requireGmailManifest();
    const config = await mcpConfigFromManifest(manifest, {
      resolve: resolverOf({ [GMAIL_REF]: RESOLVED_URL }),
    });

    expect(config).toEqual({
      transport: "http",
      url: RESOLVED_URL,
    } satisfies McpServerConfig);
    expect(config.transport).toBe("http");
    expect("url_ref" in config).toBe(false);
    expect("command" in config).toBe(false);

    const mcpServers = { [manifest.mcp_server.name]: config };
    expect(Object.keys(mcpServers)).toEqual(["gmail"]);
    expect(mcpServers.gmail).toEqual(config);
  });

  it("maps transport: http the same way as remote", async () => {
    const config = await mcpConfigFromManifest(
      manifestSlice({ mcp_server: { transport: "http" } }),
      { resolve: resolverOf({ [GMAIL_REF]: RESOLVED_URL }) },
    );
    expect(config.transport).toBe("http");
  });

  it("resolves via the injected port, not process.env", async () => {
    const previous = process.env[GMAIL_ENV_KEY];
    process.env[GMAIL_ENV_KEY] = "https://must-not-be-read.invalid/";
    const resolve = vi.fn(resolverOf({ [GMAIL_REF]: RESOLVED_URL }));
    try {
      const config = await mcpConfigFromManifest(manifestSlice(), { resolve });
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith(GMAIL_REF);
      expect(config).toMatchObject({ transport: "http", url: RESOLVED_URL });
    } finally {
      if (previous === undefined) {
        delete process.env[GMAIL_ENV_KEY];
      } else {
        process.env[GMAIL_ENV_KEY] = previous;
      }
    }
  });
});

describe("unset / empty secret — named error, ref only (N4)", () => {
  it("throws naming the REF and not a resolved value when the secret is unset", async () => {
    expect.assertions(8);
    try {
      await mcpConfigFromManifest(manifestSlice(), { resolve: resolverOf({}) });
      expect.unreachable("unset secret must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpManifestConfigError);
      const named = err as McpManifestConfigError;
      expect(named.code).toBe("SECRET_UNSET");
      expect(named.ref).toBe(GMAIL_REF);
      expect(named.field).toBe("mcp_server.url_ref");
      expect(named.message).toContain(GMAIL_REF);
      const dumped = serialization(err);
      assertNoSecret(dumped, RESOLVED_URL);
      expect(dumped).not.toContain(GMAIL_ENV_KEY);
    }
  });

  it("fails closed when the injected resolver returns an empty string", async () => {
    expect.assertions(6);
    try {
      await mcpConfigFromManifest(manifestSlice(), {
        resolve: resolverOf({ [GMAIL_REF]: "" }),
      });
      expect.unreachable("empty secret must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpManifestConfigError);
      const named = err as McpManifestConfigError;
      expect(named.code).toBe("SECRET_EMPTY");
      expect(named.ref).toBe(GMAIL_REF);
      expect(named.message).toContain(GMAIL_REF);
      assertNoSecret(serialization(err), RESOLVED_URL);
    }
  });

  it("does not return an empty config on the unset path (mutation control)", async () => {
    await expect(
      mcpConfigFromManifest(manifestSlice(), { resolve: resolverOf({}) }),
    ).rejects.toBeInstanceOf(McpManifestConfigError);

    await expect(
      mcpConfigFromManifest(manifestSlice(), { resolve: resolverOf({}) }),
    ).rejects.toMatchObject({ code: "SECRET_UNSET", ref: GMAIL_REF });
  });

  it("wraps a generic resolver throw as SECRET_UNSET naming the REF, not the cause", async () => {
    const resolve: SecretResolver["resolve"] = async () => {
      throw new Error(`leaked ${RESOLVED_URL}`);
    };
    try {
      await mcpConfigFromManifest(manifestSlice(), { resolve });
      expect.unreachable("generic throw must be wrapped");
    } catch (err) {
      expect(err).toBeInstanceOf(McpManifestConfigError);
      const named = err as McpManifestConfigError;
      expect(named.code).toBe("SECRET_UNSET");
      expect(named.ref).toBe(GMAIL_REF);
      assertNoSecret(serialization(err), RESOLVED_URL);
      expect(named.message).not.toContain("leaked");
    }
  });
});

describe("N4 — no resolved secret in errors, reports, logs, or fixtures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("error serialization never contains the resolved secret value", async () => {
    const resolve: SecretResolver["resolve"] = async () => RESOLVED_URL;
    try {
      await mcpConfigFromManifest(
        manifestSlice({ mcp_server: { transport: "stdio" } }),
        { resolve },
      );
      expect.unreachable("stdio is unsupported for url_ref manifests");
    } catch (err) {
      const dumped = serialization(err);
      assertNoSecret(dumped, RESOLVED_URL);
      expect(dumped).toContain("mcp_server.transport");
    }
  });

  it("does not log the resolved url", async () => {
    const spies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));

    const config = await mcpConfigFromManifest(manifestSlice(), {
      resolve: resolverOf({ [GMAIL_REF]: RESOLVED_URL }),
    });
    expect(config.url).toBe(RESOLVED_URL);

    for (const spy of spies) {
      for (const args of spy.mock.calls) {
        const rendered = args.map((value) => JSON.stringify(value)).join(" ");
        assertNoSecret(rendered, RESOLVED_URL);
      }
    }
  });

  it("fromManifest source never interpolates a resolved value into errors", () => {
    const fromManifest = readFileSync(join(mcpSrcRoot, "fromManifest.ts"), "utf8");
    expect(fromManifest).not.toContain("process.env");
    expect(fromManifest).not.toMatch(/new McpManifestConfigError\([^)]*\burl\b/);
    expect(fromManifest).not.toMatch(/\$\{url\}/);
    expect(fromManifest).not.toMatch(/\$\{value\}/);
  });
});

describe("account_ownership (N5, defence in depth)", () => {
  it("refuses to build a config when ownership is not basileia", async () => {
    const resolve = vi.fn(resolverOf({ [GMAIL_REF]: RESOLVED_URL }));
    try {
      await mcpConfigFromManifest(
        manifestSlice({ account_ownership: "client" }),
        { resolve },
      );
      expect.unreachable("non-basileia must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(McpManifestConfigError);
      const named = err as McpManifestConfigError;
      expect(named.code).toBe("OWNERSHIP_NOT_BASILEIA");
      expect(named.field).toBe("account_ownership");
      expect(named.message).toContain("account_ownership");
      expect(named.message).toContain("basileia");
      assertNoSecret(serialization(err), RESOLVED_URL);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("envSecretResolver (default port)", () => {
  afterEach(() => {
    delete process.env[GMAIL_ENV_KEY];
  });

  it("reads the derived env var and returns it", async () => {
    process.env[GMAIL_ENV_KEY] = RESOLVED_URL;
    await expect(envSecretResolver(GMAIL_REF)).resolves.toBe(RESOLVED_URL);
  });

  it("throws naming the REF when the env var is unset", async () => {
    delete process.env[GMAIL_ENV_KEY];
    try {
      await envSecretResolver(GMAIL_REF);
      expect.unreachable("unset env must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpManifestConfigError);
      const named = err as McpManifestConfigError;
      expect(named.code).toBe("SECRET_UNSET");
      expect(named.ref).toBe(GMAIL_REF);
      expect(named.message).toContain(GMAIL_REF);
      assertNoSecret(serialization(err), RESOLVED_URL);
    }
  });

  it("mcpConfigFromManifest + envSecretResolver round-trips the gmail ref", async () => {
    process.env[GMAIL_ENV_KEY] = RESOLVED_URL;
    const config = await mcpConfigFromManifest(requireGmailManifest(), {
      resolve: envSecretResolver,
    });
    expect(config).toEqual({ transport: "http", url: RESOLVED_URL });
  });
});

describe("mcp src — no secret literals in the module", () => {
  it("does not contain a credential-looking literal", () => {
    for (const file of walkTs(mcpSrcRoot)) {
      const body = readFileSync(file, "utf8");
      expect(body).not.toMatch(/https?:\/\/[^\s"']+/);
      expect(body).not.toMatch(/api[_-]?key\s*=/i);
    }
  });
});
