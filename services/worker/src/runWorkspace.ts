import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh disposable working directory prevents one chat run seeing another. */
export async function createChatRunWorkspace(runId: string): Promise<string> {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return mkdtemp(join(tmpdir(), `oikonomos-chat-${safeRunId}-`));
}

export async function removeChatRunWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
}
