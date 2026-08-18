import { describe, expect, it } from "vitest";

import { ping, workspaceName } from "../src/index.js";

describe("@oikonomos/evals-harness workspace", () => {
  it("identifies the canary package", () => {
    expect(workspaceName).toBe("evals-harness");
    expect(ping()).toBe("evals-harness");
  });
});
