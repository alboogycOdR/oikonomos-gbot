import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createChatRunWorkspace, removeChatRunWorkspace } from "./runWorkspace.js";

// TASK-175 carve: pure filesystem-seam coverage for the extracted module.
// The real end-to-end proof that a chat run actually receives this
// workspace as its Bash/Read cwd with an empty environment (TASK-153) stays
// in chatRunDriver.test.ts's real-Postgres integration suite.
describe("chat run workspace", () => {
  it("creates a fresh directory under the OS tmpdir, sanitising the run id", async () => {
    const workspace = await createChatRunWorkspace("run/../unsafe id");
    try {
      expect(workspace.startsWith(tmpdir())).toBe(true);
      expect(workspace).toContain("oikonomos-chat-run----unsafe-id-");
      await expect(access(workspace)).resolves.toBeUndefined();
    } finally {
      await removeChatRunWorkspace(workspace);
    }
  });

  it("removes the workspace directory, tolerating an already-removed path", async () => {
    const workspace = await createChatRunWorkspace("cleanup-test");
    await removeChatRunWorkspace(workspace);
    await expect(access(workspace)).rejects.toThrow();
    // force: true means a second removal of an already-gone path is a no-op,
    // not an error.
    await expect(removeChatRunWorkspace(workspace)).resolves.toBeUndefined();
  });
});
