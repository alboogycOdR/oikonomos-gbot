/**
 * TASK-102 / E9.1a — thin fetch wrapper against control-api. Every call
 * uses `credentials: "same-origin"` so the httpOnly session cookie minted
 * by `POST /auth/login` (TASK-101) rides along automatically; the
 * dashboard's own JS never reads or stores the token/cookie itself. A 401
 * from any call is surfaced as `UnauthorizedError` so route guards can
 * redirect to `/login` uniformly, no matter which fetch triggered it.
 *
 * Base URL: same-origin by default (the dashboard is served as static
 * files off control-api itself, per this task's Description). Overridable
 * via `VITE_CONTROL_API_BASE_URL` for local dev against a separate
 * control-api process.
 */

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

const BASE_URL: string =
  (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

/**
 * TASK-239 (spec §6.2) — `vite.config.ts` (TASK-240) already replaces this
 * identifier with the build's git SHA via Vite's `define`; nothing in
 * `src/` referenced it until now, which is why only the separately-emitted
 * `dist/build.json` could verify it. Declared ambient-locally to this
 * module (not `vite-env.d.ts`, which is outside this task's Owned_Paths) —
 * every consumer imports `BUILD_SHA` from here rather than the raw global.
 */
declare const __OIKONOMOS_BUILD_SHA__: string;
export const BUILD_SHA: string =
  typeof __OIKONOMOS_BUILD_SHA__ === "string" ? __OIKONOMOS_BUILD_SHA__ : "unknown";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    let message = `request to ${path} failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error !== undefined) {
        message = body.error;
      }
    } catch {
      // response body wasn't JSON; keep the generic message.
    }
    throw new Error(message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function login(token: string): Promise<void> {
  await request<{ authenticated: boolean }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * TASK-241 (spec §3.3) — exchanges a real Firebase ID token (obtained
 * client-side via `lib/firebase.ts`'s `signInWithGooglePopup`) for a
 * session cookie at the real `POST /auth/google` route (`app.ts:967-978`,
 * TASK-172). Request/response shape read directly from that handler:
 * `{idToken}` in, `{authenticated: true}` + `set-cookie` out — same shape
 * as `login` above, just a different credential. A rejected/expired/
 * tampered ID token surfaces as the same generic request failure `request`
 * already produces for a non-2xx response; the server's own message
 * ("invalid or expired Firebase ID token") rides through via `body.error`.
 */
export async function loginWithGoogle(idToken: string): Promise<void> {
  await request<{ authenticated: boolean }>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
}

/**
 * TASK-239 (spec §3.1) — mirrors control-api's real `GET /auth/me` shape
 * exactly (`app.ts`'s handler): `expiresAt` is `null` for a bearer-service
 * principal, an ISO-8601 string for a cookie-backed user session. `request`
 * already turns a 401 into `UnauthorizedError`, which is exactly how a
 * missing/expired/tampered cookie is meant to be told apart from a real
 * network/server failure here.
 */
export interface AuthMe {
  tenantId: string;
  kind: "service" | "user";
  expiresAt: string | null;
}

export async function getMe(): Promise<AuthMe> {
  return request<AuthMe>("/auth/me");
}

/**
 * TASK-239 (spec §3.2) — `POST /auth/logout` (`auth.ts:80`/`app.ts`) always
 * clears the session cookie server-side and responds `204`; `request`
 * already treats `204` as `undefined`. The dashboard's own in-memory
 * workspace state (drafts, pending, transcripts) is dropped by `ChatPage`
 * unmounting once `AuthContext` flips `isAuthenticated` to `false` — this
 * call is only responsible for the server-side half.
 */
export async function logout(): Promise<void> {
  await request<void>("/auth/logout", { method: "POST" });
}

export type RunStatus =
  | "started"
  | "waiting_approval"
  | "resumed"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  runId: string;
  taskId: string;
  tenantId: string;
  provider: string;
  sessionRef: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  failureNote: string | null;
}

export interface RunListPage {
  runs: Run[];
  nextCursor: string | null;
}

export interface ListRunsParams {
  tenantId?: string;
  status?: RunStatus;
  taskId?: string;
  limit?: number;
  cursor?: string;
}

export async function listRuns(params: ListRunsParams = {}): Promise<RunListPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return request<RunListPage>(`/runs${qs.length > 0 ? `?${qs}` : ""}`);
}

export async function getRun(runId: string): Promise<Run> {
  return request<Run>(`/runs/${encodeURIComponent(runId)}`);
}

export interface AuditEvent {
  eventId: string;
  tenantId: string;
  runId: string | null;
  at: string;
  actor: string;
  eventType: string;
  capability: string | null;
  tier: string | null;
  payload: Record<string, unknown>;
  evidenceUri: string | null;
}

export async function getRunEvidence(runId: string): Promise<AuditEvent[]> {
  return request<AuditEvent[]>(`/runs/${encodeURIComponent(runId)}/evidence`);
}

/**
 * TASK-239 (spec §4.1) — mirrors `GET /workspace/summary`'s real,
 * server-serialized shape exactly (TASK-237, `packages/db/src/
 * workspaceSummary.ts` / `services/control-api/src/app.ts`): one bounded
 * row per thread the principal owns, `latestRun: null` when the thread has
 * no runs yet, `lastActivityAt` as an ISO-8601 string (the server sends a
 * `Date`, which serializes to ISO-8601 over JSON).
 */
export interface WorkspaceSummaryEntry {
  threadId: string;
  latestRun: { runId: string; status: RunStatus } | null;
  pendingApprovals: number;
  lastActivityAt: string;
}

export async function getWorkspaceSummary(): Promise<WorkspaceSummaryEntry[]> {
  return request<WorkspaceSummaryEntry[]>("/workspace/summary");
}

export type ApprovalStatus =
  | "pending"
  | "granted"
  | "rejected"
  | "expired"
  | "invalidated"
  | "consumed";

/**
 * TASK-103 — mirrors `GET /approvals`'s real, serialized shape (one
 * approval service, one canonical rendering per OIK-089). `nonce` rides in
 * this response body because control-api's contract puts it there; the
 * discipline this task owns is keeping it out of the URL bar, browser
 * history, and any persisted client storage, same as
 * `services/gateway-telegram/src/approvals/index.ts`'s in-process handle
 * pattern — it must only ever be read from in-memory component state and
 * sent straight back over a single `decide` request.
 */
export interface ApprovalSummary {
  approvalId: string;
  tenantId: string;
  runId: string;
  capabilityId: string;
  actionDigest: string;
  actionRender: string;
  destination: string;
  nonce: string;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
}

export async function listPendingApprovals(): Promise<ApprovalSummary[]> {
  return request<ApprovalSummary[]>("/approvals");
}

export type ApprovalDecisionKind = "granted" | "rejected";

export type DecideApprovalResult =
  | { decided: true; approval: ApprovalSummary }
  | { decided: false };

/**
 * The dashboard has no per-operator identity beyond the shared operator
 * access token (TASK-101) — there is no per-user session claim to attribute
 * the decision to, so `decidedBy` uses a fixed, clearly-labelled actor
 * string, same spirit as gateway-telegram's `telegram:user:${id}` but
 * without a real per-user id to interpolate.
 */
const DASHBOARD_DECIDER = "dashboard:operator";

export async function decideApproval(
  nonce: string,
  decision: ApprovalDecisionKind,
): Promise<DecideApprovalResult> {
  const response = await fetch(`${BASE_URL}/approvals/${encodeURIComponent(nonce)}/decide`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, decidedBy: DASHBOARD_DECIDER }),
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (response.status === 409) {
    return { decided: false };
  }
  if (!response.ok) {
    let message = `request to /approvals/${nonce}/decide failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error !== undefined) {
        message = body.error;
      }
    } catch {
      // response body wasn't JSON; keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as DecideApprovalResult;
}

/**
 * TASK-108 (Chat-1d) — thread/message/role client calls wiring
 * `<ChatShell>` (Chat-1c, `components/chat/**`, not modified here) to the
 * real control-api endpoints added by Chat-1b (`services/control-api/src/
 * app.ts`: `GET /roles`, `GET /threads`, `GET /threads/:id/messages`,
 * `POST /threads/:id/messages`). Shapes below mirror the server's real
 * serialization exactly (see `app.ts`'s `/threads` and
 * `/threads/:id/messages` handlers) rather than `components/chat/types.ts`,
 * which is Chat-1c's fixture-facing shape — this task maps between the two
 * in `pages/ChatPage.tsx`, not here, so a future server-shape change only
 * requires touching one file.
 */
export interface Role {
  id: string;
  name: string;
  description: string;
  avatarSeed: string;
}

export async function listRoles(): Promise<Role[]> {
  return request<Role[]>("/roles");
}

export interface Thread {
  id: string;
  roleId: string;
  botName: string;
  botDescription: string;
  avatarSeed: string;
  title: string | null;
  lastMessagePreview: string;
  updatedAt: string;
}

/**
 * TASK-122 (Chat-2c) — mirrors `app.ts`'s `GET /threads` group-thread
 * summary shape exactly (TASK-121): a group thread has no single
 * `roleId`/`botName`, only `memberRoleIds`/`memberNames`. Discriminated
 * from `Thread` by the presence of `memberRoleIds` (same discriminant
 * `app.ts` itself uses server-side), never a null `roleId` on `Thread`.
 */
export interface GroupThread {
  id: string;
  memberRoleIds: string[];
  memberNames: string[];
  title: string | null;
  lastMessagePreview: string;
  updatedAt: string;
}

export function isGroupThread(thread: Thread | GroupThread): thread is GroupThread {
  return "memberRoleIds" in thread;
}

export async function listThreads(): Promise<Array<Thread | GroupThread>> {
  return request<Array<Thread | GroupThread>>("/threads");
}

/**
 * TASK-122 (Chat-2c) — `POST /threads/group` (TASK-121). Requires 2+
 * roleIds server-side; mirrored here as a thin wrapper, no client-side
 * duplicate validation beyond what the dialog itself already enforces
 * (fail loud from the server is fine for this rare, deliberate action).
 */
export async function createGroupThread(roleIds: string[], title?: string): Promise<GroupThread> {
  return request<GroupThread>("/threads/group", {
    method: "POST",
    body: JSON.stringify(title === undefined ? { roleIds } : { roleIds, title }),
  });
}

export type ThreadMessageRole = "user" | "bot" | "system";

/**
 * `approval`, when present, carries the server's real field name
 * (`action_render`, not `actionRender` — see `app.ts`'s
 * `/threads/:id/messages` handler, which builds this object literally).
 * Inline approval rendering itself is Chat-1e (TASK-109)'s scope; this
 * task only needs the transcript fields, so the type is kept loose here
 * rather than asserting a shape this task does not exercise.
 */
export interface ThreadMessage {
  id: string;
  threadId: string;
  role: ThreadMessageRole;
  body: string;
  runId: string | null;
  createdAt: string;
  /**
   * TASK-122 (Chat-2c) — server's real field names (`app.ts`'s
   * `/threads/:id/messages` handler, TASK-121): the sending bot's role id
   * and resolved display name, present on every message (`null` for
   * human/system messages). Needed to attribute each line in a group
   * thread to the right bot instead of assuming a single sender.
   */
  senderRoleId?: string | null;
  senderName?: string | null;
  /**
   * TASK-118 (Grants-1b): `capability_id`/`max_tier` are the server's own
   * field names (`app.ts`'s `/threads/:id/messages` handler builds this
   * object literally, same convention as `action_render`) — carried so
   * the "Always Allow" action on `ApprovalCard` can call
   * `POST /roles/:roleId/grants` with the right capability/tier without
   * a second round trip. `max_tier` is `null` when the approval's
   * capability is no longer registered.
   */
  approval?: {
    nonce: string;
    action_render: string;
    status: string;
    capability_id: string;
    max_tier: string | null;
  };
}

export interface ListThreadMessagesParams {
  after?: string;
}

export async function listThreadMessages(
  threadId: string,
  params: ListThreadMessagesParams = {},
): Promise<ThreadMessage[]> {
  const query = new URLSearchParams();
  if (params.after !== undefined) {
    query.set("after", params.after);
  }
  const qs = query.toString();
  return request<ThreadMessage[]>(
    `/threads/${encodeURIComponent(threadId)}/messages${qs.length > 0 ? `?${qs}` : ""}`,
  );
}

export async function sendThreadMessage(threadId: string, body: string): Promise<ThreadMessage> {
  return request<ThreadMessage>(`/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/**
 * TASK-118 (Grants-1b) — "Always Allow" standing grant. Capability+tier
 * scoped (deliberate v1 simplification, see PLAN.md TASK-118). Mirrors
 * `decideApproval`'s error-shape handling rather than the generic
 * `request` helper's, since `ApprovalCard` needs to distinguish "grant
 * written" from a 401 the same way it already does for decide.
 */
export interface RoleGrant {
  roleId: string;
  capabilityId: string;
  maxTier: string;
  constraints: Record<string, unknown>;
}

export async function createRoleGrant(
  roleId: string,
  capabilityId: string,
  maxTier: string,
): Promise<RoleGrant> {
  return request<RoleGrant>(`/roles/${encodeURIComponent(roleId)}/grants`, {
    method: "POST",
    body: JSON.stringify({ capabilityId, maxTier }),
  });
}
