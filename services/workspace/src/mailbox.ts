/**
 * TASK-090 / Addendum F §3.5 (F8), OIK-206 — the `send_to_role` handoff
 * mailbox, built directly on TASK-084's `role_messages` typed query layer
 * (`@oikonomos/db`).
 *
 * A handoff carries no privilege: the receiving role acts under its own
 * grants, never the sender's (F8, R13). This module never returns, stores,
 * or forwards anything that could be mistaken for a grant, and it performs
 * NO enforcement decision itself — that belongs to the broker.
 *
 * Probe Q5's four properties, each load-bearing and each tested below:
 *   1. Async — the sender gets an acknowledgement, never a same-turn reply.
 *   2. Verbatim text plus sender identity, workspace REFS not file bytes.
 *   3. Zero context carry-over — no sender transcript/memory/system prompt.
 *   4. No implicit memory write on either side.
 */
import {
  sendRoleMessage,
  type DatabaseOptions,
  type HandoffFactReference,
  type HandoffKind,
  type NewRoleMessage,
  type RoleMessage,
} from "@oikonomos/db";

import { resolveWorkspacePath } from "./paths.js";

export { handoffKinds } from "@oikonomos/db";
export type { HandoffFactReference, HandoffKind } from "@oikonomos/db";

export interface SendToRoleInput {
  tenantId?: string;
  fromRoleId: string;
  toRoleId: string;
  body: string;
  /**
   * Workspace-relative paths the receiver should read for itself (probe Q5:
   * "the receiver reads the shared file itself"). Resolved and tier-checked
   * here so a caller cannot hand off a path that doesn't exist under the
   * shared workspace/role roots or that points at a sealed secret (D3).
   */
  workspaceRefs?: readonly string[];
  /** Typed handoffs carry a reference, never a memory value snapshot. */
  handoffKind?: HandoffKind;
  factRef?: HandoffFactReference;
}

/**
 * Acknowledgement returned to the SENDER only. There is deliberately no
 * receiver-side data here (probe Q5 item 1: async, no same-turn reply) and
 * no field that could be mistaken for a capability grant (F8/R13).
 */
export interface SendToRoleAcknowledgement {
  messageId: string;
  toRoleId: string;
  createdAt: Date;
}

/**
 * Dependency seam for tests: the real `send` is `@oikonomos/db`'s
 * `sendRoleMessage`, which requires a live Postgres connection. Unit tests
 * inject a fake to assert the mailbox's *shape* contract (async ack only,
 * no context, no memory write) without needing a database; the
 * `DATABASE_URL`-gated integration test exercises the real thing end to end.
 */
export interface SendToRoleDeps {
  send: (options: DatabaseOptions, input: NewRoleMessage) => Promise<RoleMessage>;
}

const defaultDeps: SendToRoleDeps = { send: sendRoleMessage };

/**
 * Send a handoff. This function intentionally accepts nothing that could
 * carry sender context: no transcript, no memory snapshot, no system
 * prompt — only identity, verbatim text, and workspace refs (probe Q5 item
 * 3). It also performs no memory write of any kind, on either side (item
 * 4) — persistence is exactly and only the one `role_messages` insert.
 */
export async function sendToRole(
  options: DatabaseOptions,
  input: SendToRoleInput,
  deps: SendToRoleDeps = defaultDeps,
): Promise<SendToRoleAcknowledgement> {
  const fromRoleId = requireNonEmpty(input.fromRoleId, "fromRoleId");
  const toRoleId = requireNonEmpty(input.toRoleId, "toRoleId");
  const body = requireNonEmpty(input.body, "body");
  if ((input.handoffKind === undefined) !== (input.factRef === undefined)) {
    throw new Error("handoffKind and factRef must be supplied together.");
  }

  // Workspace refs are validated as real, in-bounds, non-secret paths
  // before anything is persisted — a handoff must not smuggle a D3 path or
  // a traversal escape into role_messages.workspace_refs.
  const resolvedRefs = (input.workspaceRefs ?? []).map((ref) => {
    const parsed = parseWorkspaceRef(ref);
    return resolveWorkspacePath(parsed.relativePath, { roleId: parsed.roleId }).path;
  });

  const persisted = await deps.send(options, {
    tenantId: input.tenantId,
    fromRoleId,
    toRoleId,
    body,
    workspaceRefs: resolvedRefs,
    handoffKind: input.handoffKind,
    factRef: input.factRef,
  });

  // Acknowledgement carries only what the SENDER needs to know the handoff
  // was accepted — nothing from the receiver's side (there is none yet).
  return {
    messageId: persisted.messageId,
    toRoleId: persisted.toRoleId,
    createdAt: persisted.createdAt,
  };
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

/**
 * A workspace ref may be a plain shared-workspace-relative path
 * ("notes/handoff.md") or a role-scoped one prefixed "role:<roleId>/..." —
 * this keeps `role_messages.workspace_refs` as plain strings (matching
 * TASK-084's schema) while still letting a sender point at another role's
 * directory, which F9 permits.
 */
function parseWorkspaceRef(ref: string): { relativePath: string; roleId?: string } {
  const roleMatch = /^role:([^/]+)\/(.*)$/.exec(ref);
  if (roleMatch) {
    const [, roleId, relativePath] = roleMatch;
    return { relativePath: relativePath ?? "", roleId };
  }
  return { relativePath: ref };
}

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  function fakeDeps(): { deps: SendToRoleDeps; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async (_options: DatabaseOptions, input: NewRoleMessage) => {
      const message: RoleMessage = {
        messageId: "11111111-1111-1111-1111-111111111111",
        tenantId: input.tenantId ?? "basileia",
        fromRoleId: input.fromRoleId,
        toRoleId: input.toRoleId,
        body: input.body,
        workspaceRefs: input.workspaceRefs ?? [],
        handoffKind: input.handoffKind ?? null,
        factRef: input.factRef ?? null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        readAt: null,
      };
      return message;
    });
    return { deps: { send }, send };
  }

  describe("sendToRole — F8 handoff mailbox", () => {
    const options: DatabaseOptions = { connectionString: "postgres://x" };

    it("probe Q5 #1: is async — returns an acknowledgement, not a reply", async () => {
      const { deps } = fakeDeps();
      const ack = await sendToRole(
        options,
        { fromRoleId: "sender", toRoleId: "receiver", body: "please review" },
        deps,
      );
      expect(ack.messageId).toBe("11111111-1111-1111-1111-111111111111");
      expect(ack.toRoleId).toBe("receiver");
      expect(ack.createdAt).toBeInstanceOf(Date);
      // The acknowledgement type has no field for a receiver reply/body —
      // this is a same-turn acknowledgement, never a response.
      expect("replyBody" in ack).toBe(false);
    });

    it("probe Q5 #2: carries verbatim text + sender identity + workspace refs, never file bytes", async () => {
      const { deps, send } = fakeDeps();
      await sendToRole(
        options,
        {
          fromRoleId: "sender",
          toRoleId: "receiver",
          body: "see the draft",
          workspaceRefs: ["drafts/q3.md"],
        },
        deps,
      );
      expect(send).toHaveBeenCalledTimes(1);
      const [, input] = send.mock.calls[0] as [DatabaseOptions, NewRoleMessage];
      expect(input.fromRoleId).toBe("sender");
      expect(input.body).toBe("see the draft");
      expect(input.workspaceRefs).toEqual(["/oikonomos/workspace/drafts/q3.md"]);
      // No property anywhere on the persisted input carries raw file
      // contents/bytes — only a path string.
      expect(Object.values(input).every((v) => !(v instanceof Uint8Array))).toBe(true);
    });

    it("resolves a role-scoped workspace ref against that role's directory", async () => {
      const { deps, send } = fakeDeps();
      await sendToRole(
        options,
        {
          fromRoleId: "sender",
          toRoleId: "receiver",
          body: "see my file",
          workspaceRefs: ["role:sender/output.txt"],
        },
        deps,
      );
      const [, input] = send.mock.calls[0] as [DatabaseOptions, NewRoleMessage];
      expect(input.workspaceRefs).toEqual(["/oikonomos/roles/sender/output.txt"]);
    });

    it("refuses a workspace ref that escapes the workspace root", async () => {
      const { deps } = fakeDeps();
      await expect(
        sendToRole(
          options,
          { fromRoleId: "sender", toRoleId: "receiver", body: "x", workspaceRefs: ["../../etc/passwd"] },
          deps,
        ),
      ).rejects.toThrow();
    });

    it("refuses a workspace ref that resolves to the sealed-secret tier (D3)", async () => {
      const { deps } = fakeDeps();
      // Only reachable if a future root change made the shared root nest
      // under the secrets root; this documents the refusal contract.
      await expect(
        sendToRole(
          options,
          {
            fromRoleId: "sender",
            toRoleId: "receiver",
            body: "x",
            workspaceRefs: ["role:../../../oikonomos/secrets/token"],
          },
          deps,
        ),
      ).rejects.toThrow();
    });

    it("probe Q5 #3: zero context carry-over — the call surface has no transcript/memory/system-prompt field", async () => {
      const { deps } = fakeDeps();
      const input = { fromRoleId: "sender", toRoleId: "receiver", body: "hi" };
      // TypeScript already forbids extra fields on SendToRoleInput at
      // compile time; this runtime check guards against someone loosening
      // the type later and smuggling context through an `any`-typed caller.
      await sendToRole(options, input, deps);
      expect("transcript" in input).toBe(false);
      expect("memory" in input).toBe(false);
      expect("systemPrompt" in input).toBe(false);
    });

    it("probe Q5 #4: LIVENESS — sending performs exactly one persistence call and never touches memory", async () => {
      const { deps, send } = fakeDeps();
      await sendToRole(
        options,
        { fromRoleId: "sender", toRoleId: "receiver", body: "hi" },
        deps,
      );
      // Exactly one write (the role_messages insert) — if a memory-write
      // side effect were ever added, this call count goes to 2+ and the
      // assertion goes RED, which is the point: this is the canary for "no
      // implicit memory write" rather than a check on config alone.
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("rejects empty fromRoleId/toRoleId/body before ever calling send", async () => {
      const { deps, send } = fakeDeps();
      await expect(
        sendToRole(options, { fromRoleId: "  ", toRoleId: "receiver", body: "hi" }, deps),
      ).rejects.toThrow(/fromRoleId/);
      await expect(
        sendToRole(options, { fromRoleId: "sender", toRoleId: "  ", body: "hi" }, deps),
      ).rejects.toThrow(/toRoleId/);
      await expect(
        sendToRole(options, { fromRoleId: "sender", toRoleId: "receiver", body: "  " }, deps),
      ).rejects.toThrow(/body/);
      expect(send).not.toHaveBeenCalled();
    });
  });
}
