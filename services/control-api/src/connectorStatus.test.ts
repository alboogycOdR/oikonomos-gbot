import { describe, expect, it } from "vitest";

import { createConnectorStatusResolver } from "./connectorStatus.js";

const GMAIL_URL_KEY = "OIK_SECRET_MCP_GMAIL_URL";

describe("createConnectorStatusResolver", () => {
  it("uses the connector package mapping and treats unset or empty values as unconfigured", async () => {
    const previous = process.env[GMAIL_URL_KEY];
    const status = createConnectorStatusResolver({ sharedEnvironment: true });
    try {
      process.env[GMAIL_URL_KEY] = "configured-only-for-test";
      await expect(status.getStatus("gmail")).resolves.toBe(true);
      delete process.env[GMAIL_URL_KEY];
      await expect(status.getStatus("gmail")).resolves.toBe(false);
      process.env[GMAIL_URL_KEY] = "";
      await expect(status.getStatus("gmail")).resolves.toBe(false);
      await expect(status.getStatus("builtin")).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[GMAIL_URL_KEY];
      else process.env[GMAIL_URL_KEY] = previous;
    }
  });

  it("returns unknown when the control API cannot observe the worker environment", async () => {
    const status = createConnectorStatusResolver({
      sharedEnvironment: false,
    });

    await expect(status.getStatus("gmail")).resolves.toBe("unknown");
  });

  it("returns unknown rather than leaking manifest-loading errors", async () => {
    const status = createConnectorStatusResolver({
      sharedEnvironment: true,
      manifestLoader: async () => { throw new Error("manifest source unavailable"); },
    });

    await expect(status.getStatus("gmail")).resolves.toBe("unknown");
  });
});
