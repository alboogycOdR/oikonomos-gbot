import { describe, expect, it } from "vitest";

import { issueApproval } from "../src/issue.js";
import { sweepExpiredApprovals } from "../src/sweep.js";
import {
  createMemoryStore,
  FIXTURE_RUN_ID,
  fixtureRequest,
  grantMemoryRow,
} from "./helpers.js";

describe("sweepExpiredApprovals — pending → expired (OIK-024)", () => {
  it("expires pending rows whose expires_at has elapsed", async () => {
    const memory = createMemoryStore();
    const expired = await issueApproval(
      fixtureRequest({ expiresAt: new Date(Date.now() - 1_000) }),
      { store: memory.store },
    );
    const live = await issueApproval(
      fixtureRequest({ expiresAt: new Date(Date.now() + 60_000) }),
      { store: memory.store },
    );

    const first = await sweepExpiredApprovals({ store: memory.store });
    expect(first).toEqual({ expired: 1 });
    expect(memory.rows.get(expired.nonce)!.status).toBe("expired");
    expect(memory.rows.get(live.nonce)!.status).toBe("pending");
  });

  it("is idempotent — a second run transitions nothing", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(
      fixtureRequest({ expiresAt: new Date(Date.now() - 5_000) }),
      { store: memory.store },
    );

    expect(await sweepExpiredApprovals({ store: memory.store })).toEqual({ expired: 1 });
    expect(await sweepExpiredApprovals({ store: memory.store })).toEqual({ expired: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("expired");
  });

  it("does not expire granted rows, even when past expires_at", async () => {
    const memory = createMemoryStore();
    const signal = await issueApproval(
      fixtureRequest({ expiresAt: new Date(Date.now() - 1_000) }),
      { store: memory.store },
    );
    memory.rows.set(
      signal.nonce,
      grantMemoryRow(memory.rows.get(signal.nonce)!, new Date(Date.now() - 1_000)),
    );

    const result = await sweepExpiredApprovals({ store: memory.store });
    expect(result).toEqual({ expired: 0 });
    expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
  });

  it("scoped sweep does not expire another run's pending rows", async () => {
    const memory = createMemoryStore();
    const ours = await issueApproval(
      fixtureRequest({ expiresAt: new Date(Date.now() - 1_000) }),
      { store: memory.store },
    );
    const foreign = await issueApproval(
      fixtureRequest({
        runId: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        expiresAt: new Date(Date.now() - 1_000),
      }),
      { store: memory.store },
    );

    const first = await sweepExpiredApprovals(
      { store: memory.store },
      { runId: FIXTURE_RUN_ID },
    );
    expect(first).toEqual({ expired: 1 });
    expect(memory.rows.get(ours.nonce)!.status).toBe("expired");
    expect(memory.rows.get(foreign.nonce)!.status).toBe("pending");
  });

  it("fails closed if the store returns a nonsense count", async () => {
    const backing = createMemoryStore();
    await expect(
      sweepExpiredApprovals({
        store: {
          ...backing.store,
          expirePending: async () => -1,
        },
      }),
    ).rejects.toThrow(/invalid count/);
  });
});
