import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig, listDeviceTokens, registerDeviceToken, removeDeviceToken } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const migrationDirectory = fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url));

integration("packages/db device tokens (TASK-145)", () => {
  let pool: Pool;
  const target = "task-145-test-target";

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    // Match the package's real-Postgres migration-test convention: exercise
    // the additive migration before asserting its accessors against it.
    await pool.query(await readFile(`${migrationDirectory}010_device_tokens.up.sql`, "utf8"));
    await pool.query("DELETE FROM device_tokens WHERE token = $1", [target]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM device_tokens WHERE token = $1", [target]);
    await pool.end();
  });

  it("registers idempotently, lists, and removes a permanently-invalid target", async () => {
    const options = { connectionString: connectionString! };
    const created = await registerDeviceToken(options, { token: target, platform: "android" });
    const refreshed = await registerDeviceToken(options, { token: target, platform: "ios" });

    expect(refreshed.token).toBe(target);
    expect(refreshed.platform).toBe("ios");
    expect(refreshed.createdAt).toEqual(created.createdAt);
    expect((await listDeviceTokens(options)).filter((entry) => entry.token === target)).toEqual([refreshed]);

    await removeDeviceToken(options, target);
    expect((await listDeviceTokens(options)).some((entry) => entry.token === target)).toBe(false);
  });
});
