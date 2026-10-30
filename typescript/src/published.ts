/**
 * The client of a published workflow API (`/api/published/{slug}`), authenticated with a Nodestro key.
 *
 * The same API is served by Nodestro itself and by a workflow exported as a standalone FastAPI
 * project, so this client works with both.
 */

import { enc, type Schemas } from "./client.js";
import { type NodestroAPIError, NodestroRunFailed } from "./errors.js";
import { type ClientOptions, type ServerEvent, Transport, pollUntil } from "./http.js";

export type InfoOut = Schemas["InfoOut"];
export type RunStatusOut = Schemas["RunStatusOut"];
export type RunResultOut = Schemas["RunResultOut"];
export type ApprovalOut = Schemas["ApprovalOut"];
export type UsageSummaryOut = Schemas["UsageSummaryOut"];
export type ApprovalDecisionIn = Schemas["ApprovalDecisionIn"];

const PREFIX = "/api/published";
/** API states that end a run; `awaiting_approval` waits for a person. */
export const PUBLISHED_FINISHED = new Set(["succeeded", "failed", "cancelled"]);
export const PUBLISHED_WAITING = "awaiting_approval";

/**
 * A new idempotency key: 128 random bits as 32 hex digits. `crypto.getRandomValues` exists in
 * Node.js 20+ and in every browser page; `crypto.randomUUID` only in secure contexts (HTTPS,
 * localhost), so a page served over plain HTTP in a local network could not start runs with it.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One published workflow: start runs, follow them, decide approvals, read results and files.
 *
 * `apiKey` is sent as `Authorization: Bearer` with every request; what it may do (`run`, `read`,
 * `approve`) is decided by the server (a missing permission is a {@link NodestroAPIError} with
 * status 403). A key is a secret: use this client on a server, not in a public web page, and
 * `https://` for any server that is not on this computer.
 */
export class PublishedWorkflow {
  private readonly http: Transport;
  private readonly base: string;

  constructor(
    baseUrl: string,
    readonly slug: string,
    options: ClientOptions & { apiKey: string },
  ) {
    const { apiKey, ...rest } = options;
    if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new TypeError("apiKey must be the non-empty token of a Nodestro API key");
    }
    this.http = new Transport(baseUrl, { ...rest, headers: { ...rest.headers, Authorization: `Bearer ${apiKey}` } });
    this.base = `${PREFIX}/${enc(slug)}`;
  }

  /** What the API expects and returns: input fields, versions, limits, approvals. */
  async info(): Promise<InfoOut> {
    return this.http.json("GET", this.base);
  }

  /** The OpenAPI document of this workflow with its input and result schemas. */
  async openapi(): Promise<Record<string, unknown>> {
    return this.http.json("GET", `${this.base}/openapi.json`);
  }

  /**
   * Start a run with the request body of the workflow: `{ values: {...} }` with the fields of its
   * input form, or `{ input: "..." }` with free text (`openapi()` describes the exact body). Every start carries an
   * `Idempotency-Key` (a new random one unless given), so the automatic retry after a lost answer
   * or a 502/503/504 returns the same run instead of starting a second one. Pass your own key (at
   * most 200 characters, valid for 24 hours) to make your own retries safe too; the same key with
   * different values is refused (409 `idempotency.conflict`). `version` starts a specific published
   * version. `waitSeconds` waits that long for the result (when the publication allows it; the
   * request time limit is extended by it).
   */
  async start(
    values: Record<string, unknown>,
    options: { version?: number; idempotencyKey?: string; waitSeconds?: number } = {},
  ): Promise<RunStatusOut> {
    const path = options.version !== undefined ? `${this.base}/versions/${enc(options.version)}/runs` : `${this.base}/runs`;
    const wait = options.waitSeconds;
    if (wait !== undefined && (!Number.isFinite(wait) || wait < 0)) throw new RangeError(`waitSeconds must be >= 0, not ${wait}`);
    return this.http.json("POST", path, {
      body: values,
      query: { wait },
      headers: { "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey() },
      timeoutMs: wait ? this.http.timeoutMs + wait * 1000 : undefined,
      retryUnsafe: true,
    });
  }

  /** The runs of this API, newest first (`status` filters, e.g. `awaiting_approval`). */
  async runs(options: { status?: string; limit?: number } = {}): Promise<RunStatusOut[]> {
    return this.http.json("GET", `${this.base}/runs`, { query: options });
  }

  async status(runId: string): Promise<RunStatusOut> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}`);
  }

  async result(runId: string): Promise<RunResultOut> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/result`);
  }

  /**
   * The status once the run finished (or waits for an approval, unless `stopAtApproval` is off);
   * `timeoutMs` (total) and `pollMs` work as in {@link NodestroClient.waitForRun}.
   */
  async wait(runId: string, options: { timeoutMs?: number; pollMs?: number; stopAtApproval?: boolean } = {}): Promise<RunStatusOut> {
    const stopAtApproval = options.stopAtApproval ?? true;
    return pollUntil(
      () => this.status(runId),
      (found) => PUBLISHED_FINISHED.has(found.status) || (stopAtApproval && found.status === PUBLISHED_WAITING),
      runId,
      options,
    );
  }

  /** Wait until the run succeeded and return its result; throws {@link NodestroRunFailed} otherwise. */
  async waitForResult(runId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<RunResultOut> {
    const found = await this.wait(runId, { ...options, stopAtApproval: false });
    if (found.status !== "succeeded") throw new NodestroRunFailed(found as { status?: string; run_id?: string; error?: unknown });
    return this.result(runId);
  }

  /**
   * Live events of a run: `status`, the steps (`node_started` ...), finally `end`. `text` adds the
   * agents' text as it is written. Not reconnected automatically: after a lost connection pass the
   * `id` of the last event received as `lastEventId` to get what was missed.
   */
  async *events(
    runId: string,
    options: { text?: boolean; lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ServerEvent> {
    const query = options.text ? "?text=true" : "";
    const headers: Record<string, string> = options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {};
    yield* this.http.events(`${this.base}/runs/${enc(runId)}/events${query}`, { headers, signal: options.signal });
  }

  async cancel(runId: string): Promise<RunStatusOut> {
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/cancel`);
  }

  async approvals(runId: string): Promise<ApprovalOut[]> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/approvals`);
  }

  /** Decide the waiting approval (`approvalId` chooses one when several wait). */
  async approve(
    runId: string,
    decision: "approved" | "rejected" = "approved",
    options: { comment?: string; approvalId?: string } = {},
  ): Promise<RunStatusOut> {
    const body: ApprovalDecisionIn = { decision, comment: options.comment ?? "" };
    if (options.approvalId !== undefined) body.approval_id = options.approvalId;
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/approve`, { body });
  }

  /** Continue a failed or cancelled run (or `restart` it) as a new run. */
  async resume(runId: string, options: { restart?: boolean; confirmSideEffects?: boolean } = {}): Promise<RunStatusOut> {
    const body: Schemas["ResumeIn"] = {
      restart: options.restart ?? false,
      confirm_side_effects: options.confirmSideEffects ?? false,
    };
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/resume`, { body });
  }

  /** The result files of a run (`id`, `name`, `media_type` ...; needs `read`). */
  async files(runId: string): Promise<Array<Record<string, unknown>>> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/files`);
  }

  /** The content of a result file (held in memory as a whole). */
  async download(runId: string, fileId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `${this.base}/runs/${enc(runId)}/files/${enc(fileId)}`);
  }

  /** Runs, tokens and cost of this API over the last `days` (1 to 365). */
  async usage(days = 30): Promise<UsageSummaryOut> {
    return this.http.json("GET", `${this.base}/usage`, { query: { days } });
  }
}
