import { describe, expect, it } from "vitest";

import {
  envKeyFromSecretRef,
  envSecretResolver,
  OPENSANDBOX_API_KEY_REF,
  OPENSANDBOX_EXECD_ACCESS_TOKEN_REF,
} from "../src/secretResolver.js";
import { SandboxClientError } from "../src/errors.js";

/** Distinct sentinel assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_API_KEY = ["fake-opensandbox-", "api-key-not-real"].join("");

describe("envKeyFromSecretRef", () => {
  it("maps the documented OpenSandbox ref to OIK_SECRET_OPENSANDBOX_API_KEY", () => {
    expect(envKeyFromSecretRef(OPENSANDBOX_API_KEY_REF)).toBe("OIK_SECRET_OPENSANDBOX_API_KEY");
  });

  it("maps the execd token ref through the same secret convention", () => {
    expect(envKeyFromSecretRef(OPENSANDBOX_EXECD_ACCESS_TOKEN_REF)).toBe("OIK_SECRET_OPENSANDBOX_EXECD_ACCESS_TOKEN");
  });

  it("uppercases and underscore-normalizes arbitrary refs", () => {
    expect(envKeyFromSecretRef("secret://opensandbox/some-thing")).toBe("OIK_SECRET_OPENSANDBOX_SOME_THING");
  });
});

describe("envSecretResolver", () => {
  it("resolves the value from the derived env var", async () => {
    const previous = process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
    process.env.OIK_SECRET_OPENSANDBOX_API_KEY = FAKE_API_KEY;
    try {
      await expect(envSecretResolver(OPENSANDBOX_API_KEY_REF)).resolves.toBe(FAKE_API_KEY);
    } finally {
      if (previous === undefined) delete process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
      else process.env.OIK_SECRET_OPENSANDBOX_API_KEY = previous;
    }
  });

  it("throws SECRET_UNSET, naming the ref not a value, when the env var is unset", async () => {
    const previous = process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
    delete process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
    try {
      let caught: unknown;
      try {
        await envSecretResolver(OPENSANDBOX_API_KEY_REF);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SandboxClientError);
      expect((caught as SandboxClientError).code).toBe("SECRET_UNSET");
      expect((caught as SandboxClientError).message).toContain(OPENSANDBOX_API_KEY_REF);
    } finally {
      if (previous === undefined) delete process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
      else process.env.OIK_SECRET_OPENSANDBOX_API_KEY = previous;
    }
  });

  it("throws SECRET_EMPTY when the env var is set to an empty string", async () => {
    const previous = process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
    process.env.OIK_SECRET_OPENSANDBOX_API_KEY = "";
    try {
      await expect(envSecretResolver(OPENSANDBOX_API_KEY_REF)).rejects.toMatchObject({ code: "SECRET_EMPTY" });
    } finally {
      if (previous === undefined) delete process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
      else process.env.OIK_SECRET_OPENSANDBOX_API_KEY = previous;
    }
  });
});
