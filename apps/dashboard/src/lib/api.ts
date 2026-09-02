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
