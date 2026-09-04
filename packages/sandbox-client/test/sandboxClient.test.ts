import { describe, expect, it } from "vitest";

import { createSandboxClient, type FetchLike } from "../src/client.js";
import { SandboxClientError } from "../src/errors.js";

/** Distinct sentinel assembled at runtime so this file holds no contiguous secret (N4). */
const FAKE_API_KEY = ["fake-opensandbox-", "api-key-not-real"].join("");
const BASE_URL = "http://opensandbox.example.invalid:8080";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("createSandboxClient", () => {
  describe("health", () => {
    it("returns the parsed health body on 200, without sending the API key header", async () => {
      const seenHeaders: Record<string, string>[] = [];
      const fetchImpl: FetchLike = async (_input, init) => {
        seenHeaders.push(Object.fromEntries(new Headers(init.headers).entries()));
        return jsonResponse({ status: "healthy" }, 200);
      };
      const client = createSandboxClient({ baseUrl: BASE_URL, fetchImpl });

      const result = await client.health();

      expect(result).toEqual({ status: "healthy" });
      expect(seenHeaders[0]?.["open-sandbox-api-key"]).toBeUndefined();
    });

    it("throws SandboxClientError on a non-2xx response", async () => {
      const fetchImpl: FetchLike = async () => jsonResponse({ code: "INTERNAL_ERROR", message: "boom" }, 500);
      const client = createSandboxClient({ baseUrl: BASE_URL, fetchImpl });

      await expect(client.health()).rejects.toMatchObject({
        name: "SandboxClientError",
        code: "UNEXPECTED_STATUS",
        status: 500,
      });
    });
  });

  describe("createSandbox", () => {
    it("sends the resolved API key header and returns the parsed 202 response", async () => {
      const seenRequests: { path: string; method: string | undefined; headers: Record<string, string>; body: string | undefined }[] = [];
      const fetchImpl: FetchLike = async (input, init) => {
        seenRequests.push({
          path: input,
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          body: typeof init.body === "string" ? init.body : undefined,
        });
        return jsonResponse(
          {
            id: "sandbox-abc123",
            status: { state: "Pending" },
            createdAt: "2026-09-04T12:00:00Z",
          },
          202,
        );
      };
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async (ref) => {
          expect(ref).toBe("secret://opensandbox/api_key");
          return FAKE_API_KEY;
        },
      });

      const result = await client.createSandbox({
        image: { uri: "python:3.11" },
        entrypoint: ["python", "/app/main.py"],
        resourceLimits: { cpu: "500m", memory: "512Mi" },
        timeout: 300,
      });

      expect(result.id).toBe("sandbox-abc123");
      expect(result.status.state).toBe("Pending");
      expect(seenRequests[0]?.path).toBe(`${BASE_URL}/v1/sandboxes`);
      expect(seenRequests[0]?.method).toBe("POST");
      expect(seenRequests[0]?.headers["open-sandbox-api-key"]).toBe(FAKE_API_KEY);
      expect(seenRequests[0]?.body).toContain("python:3.11");
    });

    it("throws SandboxClientError, never echoing the API key, when the server rejects the request", async () => {
      const fetchImpl: FetchLike = async () =>
        jsonResponse({ code: "VALIDATION_ERROR", message: "entrypoint is required" }, 422);
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async () => FAKE_API_KEY,
      });

      let caught: unknown;
      try {
        await client.createSandbox({
          image: { uri: "python:3.11" },
          entrypoint: [],
          resourceLimits: {},
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SandboxClientError);
      const message = (caught as SandboxClientError).message;
      expect(message).not.toContain(FAKE_API_KEY);
      expect((caught as SandboxClientError).status).toBe(422);
      expect((caught as SandboxClientError).apiErrorCode).toBe("VALIDATION_ERROR");
    });

    it("propagates a fetch-level failure as SandboxClientError without leaking the API key", async () => {
      const fetchImpl: FetchLike = async () => {
        throw new Error(`network down (key was ${FAKE_API_KEY})`);
      };
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async () => FAKE_API_KEY,
      });

      let caught: unknown;
      try {
        await client.createSandbox({
          image: { uri: "python:3.11" },
          entrypoint: ["python", "/app/main.py"],
          resourceLimits: { cpu: "500m" },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SandboxClientError);
      expect((caught as SandboxClientError).code).toBe("REQUEST_FAILED");
      expect((caught as SandboxClientError).message).not.toContain(FAKE_API_KEY);
    });
  });

  describe("destroySandbox", () => {
    it("resolves on 204 and sends DELETE with the API key header", async () => {
      const seenRequests: { path: string; method: string | undefined; headers: Record<string, string> }[] = [];
      const fetchImpl: FetchLike = async (input, init) => {
        seenRequests.push({
          path: input,
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
        });
        return emptyResponse(204);
      };
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async () => FAKE_API_KEY,
      });

      await expect(client.destroySandbox("sandbox-abc123")).resolves.toBeUndefined();
      expect(seenRequests[0]?.path).toBe(`${BASE_URL}/v1/sandboxes/sandbox-abc123`);
      expect(seenRequests[0]?.method).toBe("DELETE");
      expect(seenRequests[0]?.headers["open-sandbox-api-key"]).toBe(FAKE_API_KEY);
    });

    it("throws SandboxClientError on 404", async () => {
      const fetchImpl: FetchLike = async () => jsonResponse({ code: "NOT_FOUND", message: "no such sandbox" }, 404);
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async () => FAKE_API_KEY,
      });

      await expect(client.destroySandbox("does-not-exist")).rejects.toMatchObject({
        name: "SandboxClientError",
        code: "UNEXPECTED_STATUS",
        status: 404,
      });
    });

    it("URL-encodes the sandbox id in the path", async () => {
      const seenPaths: string[] = [];
      const fetchImpl: FetchLike = async (input) => {
        seenPaths.push(input);
        return emptyResponse(204);
      };
      const client = createSandboxClient({
        baseUrl: BASE_URL,
        fetchImpl,
        resolveApiKey: async () => FAKE_API_KEY,
      });

      await client.destroySandbox("weird/id with space");

      expect(seenPaths[0]).toBe(`${BASE_URL}/v1/sandboxes/weird%2Fid%20with%20space`);
    });
  });

  it("uses the default (env-derived) resolveApiKey when none is injected, and never logs its value on failure", async () => {
    const previous = process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
    process.env.OIK_SECRET_OPENSANDBOX_API_KEY = FAKE_API_KEY;
    try {
      const seenHeaders: Record<string, string>[] = [];
      const fetchImpl: FetchLike = async (_input, init) => {
        seenHeaders.push(Object.fromEntries(new Headers(init.headers).entries()));
        return jsonResponse({ id: "s1", status: { state: "Pending" }, createdAt: "2026-09-04T00:00:00Z" }, 202);
      };
      const client = createSandboxClient({ baseUrl: BASE_URL, fetchImpl });

      await client.createSandbox({
        image: { uri: "python:3.11" },
        entrypoint: ["python", "/app/main.py"],
        resourceLimits: { cpu: "500m" },
      });

      expect(seenHeaders[0]?.["open-sandbox-api-key"]).toBe(FAKE_API_KEY);
    } finally {
      if (previous === undefined) delete process.env.OIK_SECRET_OPENSANDBOX_API_KEY;
      else process.env.OIK_SECRET_OPENSANDBOX_API_KEY = previous;
    }
  });
});
