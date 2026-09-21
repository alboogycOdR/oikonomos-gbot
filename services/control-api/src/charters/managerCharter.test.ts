import { describe, expect, it, vi } from "vitest";

import { buildManagerCharter, MANAGER_CHARTER_DUTIES, runStatusRoutine, statusChanged, statusDigest } from "./managerCharter.js";

describe("create-bot-via-approval guidance", () => {
  it("tells the manager to request via workspace.create_bot, wait for approval, and not work around denial", () => {
    const text = buildManagerCharter({ projectName: "L", goal: "g", doneCriterion: "d" });
    expect(text).toContain("workspace.create_bot");
    expect(text).toContain("parks for the human's approval");
    expect(text).toContain("State why the bot is needed");
    expect(text).toContain("Never retry, rename around, or otherwise work around a denial");
    expect(text).toContain("Retiring a bot is not available to you");
  });
});

describe("manager charter", () => {
  it("contains every §7.1 duty and the project goal", () => {
    const text = buildManagerCharter({ projectName: "Launch", goal: "ship it", doneCriterion: "shipped" });
    for (const duty of MANAGER_CHARTER_DUTIES) expect(text).toContain(duty);
    expect(text).toContain("STATUS.md");
    expect(text).toContain("ship it");
    expect(MANAGER_CHARTER_DUTIES).toHaveLength(7);
  });
});

describe("changes-only status routine (§11)", () => {
  it("sends nothing when STATUS.md is unchanged, notifies when it changes", async () => {
    const notify = vi.fn(async () => undefined);
    const first = await runStatusRoutine({ readStatus: async () => "# Status\nall good\n", lastReportedDigest: null, notify });
    expect(first.notified).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    const same = await runStatusRoutine({ readStatus: async () => "# Status\r\nall good  \r\n", lastReportedDigest: first.digest, notify });
    expect(same.notified).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    const changed = await runStatusRoutine({ readStatus: async () => "# Status\n1 blocked\n", lastReportedDigest: same.digest, notify });
    expect(changed.notified).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(changed.digest).not.toBe(first.digest);
  });

  it("sends nothing when there is no STATUS.md yet", async () => {
    const notify = vi.fn(async () => undefined);
    const result = await runStatusRoutine({ readStatus: async () => null, lastReportedDigest: null, notify });
    expect(result.notified).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(statusChanged(statusDigest("a"), "a")).toBe(false);
  });
});
