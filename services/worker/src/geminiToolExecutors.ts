import { riskTiers, type RiskTier } from "@oikonomos/policy";
import type { SandboxClient, SandboxEndpoint } from "@oikonomos/sandbox-client";

/**
 * Sandbox-backed `GeminiTool` implementations (TASK-211).
 *
 * `createGeminiAdapter` (packages/harness-factory) decides nothing about
 * WHERE a tool runs — it calls `tool.execute()` and the caller supplies that
 * function. So the Gemini lane's isolation is entirely this module's choice,
 * and the lazy choice is dangerous: executing here, in the worker process,
 * would run model-directed commands on the control-plane host itself,
 * discarding the egress-controlled sandbox that TASK-185/208 built for the
 * Claude lane. Every executor below dispatches through execd into the role's
 * own sandbox, exactly as `executeSandboxChatRun` does.
 *
 * Ordering guarantee this module must not break: the adapter awaits
 * `l1.handle()` immediately before `execute()` (ADR-011 §2.2). Nothing here
 * may run, pre-warm, or otherwise side-effect before that decision returns —
 * construction is therefore inert, and the first I/O of any kind happens
 * inside `execute()`.
 */

/** Numeric tier the adapter compares against its own ceiling. */
export function tierNumber(tier: RiskTier): number {
  const index = riskTiers.indexOf(tier);
  if (index < 0) throw new Error(`Unknown risk tier: ${tier}`);
  return index;
}

/** Shape `createGeminiAdapter` requires, restated so this module need not import it. */
export interface SandboxGeminiTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly tier: number;
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxToolContext {
  readonly client: SandboxClient;
  readonly endpoint: SandboxEndpoint;
  /** The role's durable in-sandbox workspace, as the Claude lane computes it. */
  readonly workspace: string;
  readonly timeoutMs?: number;
}

/** Matches the Claude lane's own per-command ceiling. */
export const SANDBOX_TOOL_TIMEOUT_MS = 10 * 60_000;

/**
 * Result handed back to the model for one tool call.
 *
 * A failed command is a RESULT, not an exception: a non-zero exit or an
 * unreachable sandbox must reach the model as something it can react to and
 * retry differently, not abort the whole run. Only a programming error
 * (a malformed argument) throws.
 */
export interface SandboxToolResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireStringArgument(arguments_: Record<string, unknown>, field: string): string {
  const value = arguments_[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Gemini tool argument '${field}' must be a non-empty string.`);
  }
  return value;
}

/**
 * Runs one command inside the role's sandbox.
 *
 * `envs` is deliberately empty: the Claude lane passes only a per-turn broker
 * identity and a model credential, and a tool call needs neither. Nothing of
 * the worker's own environment may reach a bot's tool process.
 */
async function runInSandbox(
  context: SandboxToolContext,
  command: string,
): Promise<SandboxToolResult> {
  try {
    const result = await context.client.runCommand(context.endpoint, {
      command,
      cwd: context.workspace,
      envs: {},
      timeoutMs: context.timeoutMs ?? SANDBOX_TOOL_TIMEOUT_MS,
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    // The sandbox being unreachable is a tool failure the model can be told
    // about, not a crashed run. The message is deliberately generic: a
    // transport error can carry endpoint/credential detail we must not put
    // in front of a model.
    return {
      ok: false,
      stdout: "",
      stderr: "The sandbox could not run this command.",
      exitCode: null,
    };
  }
}

/**
 * The governed tool surface for a Gemini run, tiered honestly.
 *
 * Tiers are the REAL ones from the capability registry — `runtime.bash` is
 * T3_external and `fs.read` is T0_observe — not flattened to 0 to slip past
 * the adapter's Stage-1 ceiling. Under `STAGE_ONE_MAXIMUM_TOOL_TIER = 0`
 * that means Read works and Bash is refused, which is the correct and
 * intended Stage-1 behaviour: TASK-212 lifts the ceiling deliberately, with
 * the per-provider cap and canary in place. Mislabelling Bash as Tier-0 here
 * would have quietly defeated exactly the control ADR-011 §3 put there.
 */
export function createSandboxGeminiTools(context: SandboxToolContext): readonly SandboxGeminiTool[] {
  return [
    {
      name: "Read",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string", description: "Path to read." } },
        required: ["file_path"],
      },
      tier: tierNumber("T0_observe"),
      execute: async (arguments_) =>
        runInSandbox(context, `cat -- ${shellQuote(requireStringArgument(arguments_, "file_path"))}`),
    },
    {
      name: "Bash",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Command to run." } },
        required: ["command"],
      },
      tier: tierNumber("T3_external"),
      execute: async (arguments_) => runInSandbox(context, requireStringArgument(arguments_, "command")),
    },
  ];
}

/**
 * Steel Browser tools for the Gemini lane (TASK-225).
 *
 * Research finding this implementation is built on (full detail in
 * PLAN.md's TASK-225 Progress_Notes, read `steel-mcp-server`'s own
 * pinned-commit source directly — not guessed from tool names): of the 6
 * tools, only session create/release are plain REST. `navigate`/`act`/
 * `snapshot`/`screenshot` all drive a live session over raw Chrome
 * DevTools Protocol (CDP) on a WebSocket — `steel-mcp-server` implements
 * its own minimal CDP client, not Playwright/Puppeteer. Session create's
 * REST response carries `websocketUrl`, a session-scoped token Steel's own
 * docs confirm is RE-MINTED ON EVERY READ — so every CDP tool call fetches
 * a fresh one via `GET /v1/sessions/{id}` immediately before connecting,
 * never caching it across calls.
 *
 * `runSteelCdp` stays compatible with Gemini's one-shot `execute()` shape
 * (no persistent connection held across tool calls) by opening exactly one
 * WebSocket per tool call, running a short sequence of CDP commands/event
 * waits on it, and closing — the same "one command, one result" contract
 * Read/Bash already have with `runCommand`, just executing a small Node
 * script (Node 22 ships a global `WebSocket`; no new dependency) instead
 * of a `curl` invocation. The payload (which can carry arbitrary model-
 * supplied text, e.g. `steel_act`'s `text` field) is base64-encoded into a
 * single trailing argument specifically to avoid shell-quoting an
 * attacker-controlled string at all, rather than trying to escape it.
 *
 * KNOWN SIMPLIFICATION, stated plainly rather than left implicit:
 * `steel_snapshot` here returns `Accessibility.getFullAXTree` plus visible
 * text, not upstream's full `Page.getFrameTree` + `DOMSnapshot.
 * captureSnapshot` + `Page.getLayoutMetrics` merge (that merge logic is a
 * genuinely large, unread 40KB file — replicating it byte-for-byte was
 * out of this pass's scope). `steel_act` uses `Runtime.evaluate`-executed
 * DOM manipulation (`.click()`, `.value` + `input`/`change` events) rather
 * than upstream's presumed `Input.dispatchMouseEvent`/`dispatchKeyEvent`
 * synthetic input — real, working, CDP-based, but not confirmed
 * byte-for-byte identical to `steel-mcp-server`'s own exact technique
 * (its `act` implementation was the one piece of the research that stayed
 * unread). Both are real governed browser actions today; tightening them
 * to exact upstream parity is a legitimate, separate follow-up, not a
 * blocker for shipping a working, honestly-scoped lane.
 *
 * HUMAN TAKEOVER (ADR-010 / TASK-204's contract): `packages/harness-
 * factory/src/providers/gemini.ts`'s `functionResponseFor` catches and
 * swallows ANY exception a tool's `execute()` throws, turning it into an
 * ordinary `{error: "..."}` result the model can just retry past — that
 * file is a protected path (adversarial review required) and is
 * deliberately NOT changed in this pass. So a detected takeover signal
 * cannot escape execute() as an exception the way it does on the Claude
 * lane. Mitigated two ways instead, both real, neither a full fix: (1)
 * `context.onHumanTakeover` fires SYNCHRONOUSLY inside execute(), before
 * any value is returned — the caller in `chatRunDriver.ts` uses it to
 * record the `run.human_takeover_required` audit event immediately, not
 * only once the turn eventually ends, and to set a flag `executeGeminiChatRun`
 * checks the instant `adapter.run()` returns, parking the run the same way
 * the Claude lane does; (2) the tool result itself carries
 * `human_takeover_required: true` plus an explicit "STOP" instruction, so
 * the model is told directly rather than seeing a generic failure it might
 * retry. HONEST GAP: between the offending tool call and the model's very
 * next turn (bounded by the adapter's existing turn cap), the model could
 * still attempt one further tool call before the run parks — closing that
 * window fully needs the small, deliberate, adversarially-reviewed change
 * to `gemini.ts` this pass does not make unilaterally.
 */

const STEEL_BASE_URL = "http://127.0.0.1:3000"; // matches packages/connectors/src/steelSession.ts's STEEL_BROWSER_BASE_URL — not imported because that module is not re-exported from the package's public surface (see chatRunDriver.ts's own isHumanTakeoverSignal comment for the same constraint).

// Mirrors packages/connectors/src/steelSession.ts's detectHumanTakeover patterns exactly, kept in sync manually for the same reason as STEEL_BASE_URL above.
const HUMAN_TAKEOVER_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["captcha", /captcha|recaptcha|hcaptcha|verify you are human/],
  ["two_factor", /two[- ]factor|2fa|one[- ]time (?:code|password)|authenticator app/],
  ["login_wall", /sign in to continue|log in to continue|login required/],
  ["payment", /payment required|checkout|confirm (?:payment|purchase)/],
];

function detectTakeover(pageText: string): { readonly kind: string; readonly detail: string } | undefined {
  const normalized = pageText.toLowerCase();
  for (const [kind, pattern] of HUMAN_TAKEOVER_PATTERNS) {
    if (pattern.test(normalized)) return { kind, detail: `detected ${kind.replaceAll("_", " ")} page` };
  }
  return undefined;
}

async function steelRest(
  context: SandboxToolContext,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number; json?: unknown; raw: SandboxToolResult }> {
  const url = `${STEEL_BASE_URL}/v1${path}`;
  const bodyFlag = body === undefined ? "" : ` -H 'content-type: application/json' -d ${shellQuote(JSON.stringify(body))}`;
  // -w appends the HTTP status on its own trailing line — curl exits 0 even on
  // a 4xx/5xx response, so the status must be read out of the body, not the
  // exit code, to distinguish a real failure from a genuine JSON error body.
  const raw = await runInSandbox(context, `curl -sS -X ${method} ${shellQuote(url)}${bodyFlag} -w '\\n%{http_code}'`);
  if (!raw.ok) return { ok: false, raw };
  const splitAt = raw.stdout.lastIndexOf("\n");
  const bodyText = splitAt >= 0 ? raw.stdout.slice(0, splitAt) : "";
  const statusText = splitAt >= 0 ? raw.stdout.slice(splitAt + 1).trim() : raw.stdout.trim();
  const status = Number.parseInt(statusText, 10);
  if (!Number.isInteger(status) || status < 200 || status >= 300) return { ok: false, raw, status: Number.isInteger(status) ? status : undefined };
  try {
    return { ok: true, json: JSON.parse(bodyText) as unknown, status, raw };
  } catch {
    return { ok: false, raw, status };
  }
}

interface CdpStep {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly waitForEvent?: string;
  readonly timeoutMs?: number;
}

interface CdpStepResult {
  readonly method?: string;
  readonly event?: string;
  readonly result?: unknown;
  readonly params?: unknown;
}

/**
 * A minimal, real CDP client, one WebSocket connection per call. See this
 * module's top-of-section comment for why: Node 22's built-in `WebSocket`
 * needs no new dependency, and a fresh connection per tool call keeps this
 * compatible with Gemini's one-shot `execute()` contract rather than
 * needing a persistent process the adapter has nowhere to hold.
 */
const CDP_RUNNER_SCRIPT = `
const payload = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], "base64").toString("utf8"));
const ws = new WebSocket(payload.websocketUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });
}
function waitForEvent(eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error("timeout waiting for " + eventName)); }, timeoutMs || 10000);
    function handler(event) {
      const msg = JSON.parse(event.data);
      if (msg.method === eventName) { clearTimeout(timer); ws.removeEventListener("message", handler); resolve(msg.params); }
    }
    ws.addEventListener("message", handler);
  });
}
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "CDP error"));
    else resolve(msg.result);
  }
});
const overallTimeout = setTimeout(() => { console.error("CDP overall timeout"); process.exit(1); }, payload.timeoutMs || 20000);
ws.addEventListener("open", async () => {
  try {
    const results = [];
    for (const step of payload.steps) {
      if (step.waitForEvent) {
        const params = await waitForEvent(step.waitForEvent, step.timeoutMs);
        results.push({ event: step.waitForEvent, params });
      } else {
        const result = await send(step.method, step.params);
        results.push({ method: step.method, result });
      }
    }
    clearTimeout(overallTimeout);
    console.log(JSON.stringify({ results }));
    ws.close();
    process.exit(0);
  } catch (err) {
    clearTimeout(overallTimeout);
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
});
ws.addEventListener("error", () => { clearTimeout(overallTimeout); console.error("CDP connection error"); process.exit(1); });
`.trim();

async function runSteelCdp(
  context: SandboxToolContext,
  websocketUrl: string,
  steps: readonly CdpStep[],
): Promise<{ ok: boolean; results?: readonly CdpStepResult[]; raw: SandboxToolResult }> {
  const payload = Buffer.from(JSON.stringify({ websocketUrl, steps, timeoutMs: 20000 })).toString("base64");
  const raw = await runInSandbox(context, `node -e ${shellQuote(CDP_RUNNER_SCRIPT)} -- ${shellQuote(payload)}`);
  if (!raw.ok) return { ok: false, raw };
  try {
    const parsed = JSON.parse(raw.stdout) as { results?: readonly CdpStepResult[] };
    return { ok: true, results: parsed.results, raw };
  } catch {
    return { ok: false, raw };
  }
}

async function fetchFreshWebsocketUrl(context: SandboxToolContext, sessionId: string): Promise<string | undefined> {
  const response = await steelRest(context, "GET", `/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok || typeof response.json !== "object" || response.json === null) return undefined;
  const url = (response.json as Record<string, unknown>).websocketUrl;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

function evaluatedValue(step: CdpStepResult | undefined): unknown {
  const result = step?.result as { result?: { value?: unknown } } | undefined;
  return result?.result?.value;
}

export interface SteelGeminiContext extends SandboxToolContext {
  /**
   * Fires synchronously inside a tool's `execute()`, before it returns —
   * see this module's top comment for why this exists and what it does
   * and does not close about the human-takeover propagation gap.
   */
  readonly onHumanTakeover?: (kind: string, detail: string) => Promise<void> | void;
}

const STEEL_TAKEOVER_INSTRUCTION =
  "STOP: this page requires human intervention (CAPTCHA, 2FA, a login wall, or a payment step). Do not attempt to solve, bypass, or continue past it. The run is being parked for a human.";

/**
 * The 6 Steel Browser tools, filtered to `grantedToolNames` (the manifest's
 * `mcp__steel__*` tool names a role actually holds — mirrors TASK-204 AC2's
 * Claude-lane behaviour: only construct/mount what's granted).
 */
export function createSteelGeminiTools(
  context: SteelGeminiContext,
  grantedToolNames: readonly string[],
): readonly SandboxGeminiTool[] {
  const granted = new Set(grantedToolNames);
  const tools: SandboxGeminiTool[] = [
    {
      name: "mcp__steel__steel_session_create",
      description: "Start a new Steel Browser session. Call this before navigate/act/snapshot/screenshot.",
      parameters: { type: "object", properties: {}, required: [] },
      tier: tierNumber("T1_draft"),
      execute: async () => {
        const response = await steelRest(context, "POST", "/sessions", {});
        if (!response.ok) return { ok: false, error: "steel session create failed" };
        const json = response.json as Record<string, unknown>;
        return { ok: true, session_id: json.id, status: json.status };
      },
    },
    {
      name: "mcp__steel__steel_session_release",
      description: "Release (end) a Steel Browser session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
      tier: tierNumber("T1_draft"),
      execute: async (arguments_) => {
        const sessionId = requireStringArgument(arguments_, "session_id");
        const response = await steelRest(context, "POST", `/sessions/${encodeURIComponent(sessionId)}/release`);
        return { ok: response.ok };
      },
    },
    {
      name: "mcp__steel__steel_navigate",
      description: "Navigate an existing Steel Browser session to a URL.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" }, url: { type: "string" } },
        required: ["session_id", "url"],
      },
      tier: tierNumber("T1_draft"),
      execute: async (arguments_) => {
        const sessionId = requireStringArgument(arguments_, "session_id");
        const url = requireStringArgument(arguments_, "url");
        const websocketUrl = await fetchFreshWebsocketUrl(context, sessionId);
        if (websocketUrl === undefined) return { ok: false, error: "could not resolve a live CDP endpoint for this session" };
        const cdp = await runSteelCdp(context, websocketUrl, [
          { method: "Page.enable" },
          { method: "Page.navigate", params: { url } },
          { waitForEvent: "Page.loadEventFired", timeoutMs: 15_000 },
          {
            method: "Runtime.evaluate",
            params: {
              expression: "({ title: document.title, text: document.body ? document.body.innerText.slice(0, 4000) : '' })",
              returnByValue: true,
            },
          },
        ]);
        if (!cdp.ok) return { ok: false, error: "navigation failed" };
        const evaluated = evaluatedValue(cdp.results?.at(-1)) as { title?: string; text?: string } | undefined;
        const pageText = evaluated?.text ?? "";
        const takeover = detectTakeover(pageText);
        if (takeover !== undefined) {
          await context.onHumanTakeover?.(takeover.kind, takeover.detail);
          return { ok: false, human_takeover_required: true, kind: takeover.kind, detail: takeover.detail, instruction: STEEL_TAKEOVER_INSTRUCTION };
        }
        return { ok: true, url, title: evaluated?.title ?? "" };
      },
    },
    {
      name: "mcp__steel__steel_snapshot",
      description: "Read the current page's accessibility tree and visible text.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
      tier: tierNumber("T0_observe"),
      execute: async (arguments_) => {
        const sessionId = requireStringArgument(arguments_, "session_id");
        const websocketUrl = await fetchFreshWebsocketUrl(context, sessionId);
        if (websocketUrl === undefined) return { ok: false, error: "could not resolve a live CDP endpoint for this session" };
        const cdp = await runSteelCdp(context, websocketUrl, [
          { method: "Accessibility.getFullAXTree" },
          {
            method: "Runtime.evaluate",
            params: { expression: "document.body ? document.body.innerText.slice(0, 8000) : ''", returnByValue: true },
          },
        ]);
        if (!cdp.ok) return { ok: false, error: "snapshot failed" };
        const axResult = cdp.results?.[0]?.result as { nodes?: unknown[] } | undefined;
        const text = (evaluatedValue(cdp.results?.[1]) as string | undefined) ?? "";
        const takeover = detectTakeover(text);
        if (takeover !== undefined) {
          await context.onHumanTakeover?.(takeover.kind, takeover.detail);
          return { ok: false, human_takeover_required: true, kind: takeover.kind, detail: takeover.detail, instruction: STEEL_TAKEOVER_INSTRUCTION };
        }
        return { ok: true, accessibility_tree: axResult?.nodes ?? [], visible_text: text };
      },
    },
    {
      name: "mcp__steel__steel_act",
      description: "Click, type into, or fill a form field on the current page, addressed by CSS selector.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          selector: { type: "string", description: "CSS selector for the target element." },
          action: { type: "string", enum: ["click", "type", "fill"] },
          text: { type: "string", description: "Required for type/fill." },
        },
        required: ["session_id", "selector", "action"],
      },
      tier: tierNumber("T2_internal"),
      execute: async (arguments_) => {
        const sessionId = requireStringArgument(arguments_, "session_id");
        const selector = requireStringArgument(arguments_, "selector");
        const action = requireStringArgument(arguments_, "action");
        if (action !== "click" && action !== "type" && action !== "fill") {
          throw new Error("Gemini tool argument 'action' must be one of click, type, fill.");
        }
        const text = action === "click" ? "" : requireStringArgument(arguments_, "text");
        const websocketUrl = await fetchFreshWebsocketUrl(context, sessionId);
        if (websocketUrl === undefined) return { ok: false, error: "could not resolve a live CDP endpoint for this session" };
        const expression = action === "click"
          ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found:false }; el.click(); return { found:true }; })()`
          : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found:false }; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return { found:true }; })()`;
        const cdp = await runSteelCdp(context, websocketUrl, [
          { method: "Runtime.evaluate", params: { expression, returnByValue: true } },
          {
            method: "Runtime.evaluate",
            params: { expression: "document.body ? document.body.innerText.slice(0, 4000) : ''", returnByValue: true },
          },
        ]);
        if (!cdp.ok) return { ok: false, error: "act failed" };
        const acted = evaluatedValue(cdp.results?.[0]) as { found?: boolean } | undefined;
        const pageText = (evaluatedValue(cdp.results?.[1]) as string | undefined) ?? "";
        const takeover = detectTakeover(pageText);
        if (takeover !== undefined) {
          await context.onHumanTakeover?.(takeover.kind, takeover.detail);
          return { ok: false, human_takeover_required: true, kind: takeover.kind, detail: takeover.detail, instruction: STEEL_TAKEOVER_INSTRUCTION };
        }
        return { ok: acted?.found ?? false, found: acted?.found ?? false };
      },
    },
    {
      name: "mcp__steel__steel_screenshot",
      description: "Capture a screenshot (base64 PNG) of the current live session page.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
      tier: tierNumber("T0_observe"),
      execute: async (arguments_) => {
        const sessionId = requireStringArgument(arguments_, "session_id");
        const websocketUrl = await fetchFreshWebsocketUrl(context, sessionId);
        if (websocketUrl === undefined) return { ok: false, error: "could not resolve a live CDP endpoint for this session" };
        const cdp = await runSteelCdp(context, websocketUrl, [
          { method: "Page.captureScreenshot", params: { format: "png" } },
        ]);
        if (!cdp.ok) return { ok: false, error: "screenshot failed" };
        const shot = cdp.results?.[0]?.result as { data?: string } | undefined;
        return { ok: true, image_base64: shot?.data ?? "" };
      },
    },
  ];
  return tools.filter((tool) => granted.has(tool.name));
}
