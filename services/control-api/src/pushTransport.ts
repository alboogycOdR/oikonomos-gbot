import { createSign, randomUUID } from "node:crypto";

export interface PushNotification {
  type: "approval-pending" | "run-completed";
  runId: string;
}

export interface PushTransportPort {
  send(deviceToken: string, notification: PushNotification): Promise<void>;
}

export class DisabledPushTransport implements PushTransportPort {
  public async send(_deviceToken: string, _notification: PushNotification): Promise<void> {}
}

/** Test fake that records sends without ever retaining or logging credentials. */
export class CollectingPushTransport implements PushTransportPort {
  public readonly sends: Array<{ deviceToken: string; notification: PushNotification }> = [];

  public async send(deviceToken: string, notification: PushNotification): Promise<void> {
    this.sends.push({ deviceToken, notification });
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function requireServiceAccount(value: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("FCM service account configuration is not valid JSON.");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof (parsed as Partial<FcmServiceAccount>).project_id !== "string" ||
    typeof (parsed as Partial<FcmServiceAccount>).client_email !== "string" ||
    typeof (parsed as Partial<FcmServiceAccount>).private_key !== "string"
  ) {
    throw new Error("FCM service account configuration is incomplete.");
  }
  return parsed as FcmServiceAccount;
}

function signedAssertion(account: FcmServiceAccount, nowMs: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 3600,
    jti: randomUUID(),
  }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(account.private_key).toString("base64url")}`;
}

export class FcmHttpPushTransport implements PushTransportPort {
  public constructor(
    private readonly account: FcmServiceAccount,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  public async send(deviceToken: string, notification: PushNotification): Promise<void> {
    const tokenResponse = await this.fetchFn(this.account.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedAssertion(this.account, this.now()),
      }),
    });
    if (!tokenResponse.ok) throw new Error(`FCM OAuth request failed (${tokenResponse.status}).`);
    const tokenBody = await tokenResponse.json() as { access_token?: unknown };
    if (typeof tokenBody.access_token !== "string" || tokenBody.access_token.length === 0) {
      throw new Error("FCM OAuth response did not include an access token.");
    }
    const response = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenBody.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: deviceToken, data: { type: notification.type, runId: notification.runId } } }),
    });
    if (!response.ok) throw new Error(`FCM send failed (${response.status}).`);
  }
}

/** Absent configuration intentionally disables push; it is additive, never load-bearing. */
export function createPushTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchLike = fetch,
): PushTransportPort {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (raw === undefined || raw.trim().length === 0) return new DisabledPushTransport();
  return new FcmHttpPushTransport(requireServiceAccount(raw), fetchFn);
}
