/**
 * The client of a published workflow API (`/api/published/{slug}`), authenticated with a Nodestro key.
 *
 * The same API is served by Nodestro itself and by a workflow exported as a standalone FastAPI
 * project, so this client works with both.
 */

import { enc, type Schemas } from "./client.js";
import { NodestroRunFailed, NodestroTimeoutError } from "./errors.js";
import { type ClientOptions, type ServerEvent, Transport } from "./http.js";

export type InfoOut = Schemas["InfoOut"];
export type RunStatusOut = Schemas["RunStatusOut"];
export type RunResultOut = Schemas["RunResultOut"];
export type ApprovalOut = Schemas["ApprovalOut"];
export type UsageSummaryOut = Schemas["UsageSummaryOut"];

const PREFIX = "/api/published";
/** API states that end a run; `awaiting_approval` waits for a person. */
export const PUBLISHED_FINISHED = new Set(["succeeded", "failed", "cancelled"]);
export const PUBLISHED_WAITING = "awaiting_approval";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One published workflow: start runs, follow them, decide approvals, read results and files. */
export class PublishedWorkflow {
  private readonly http: Transport;
  private readonly base: string;

  constructor(
    baseUrl: string,
    readonly slug: string,
    options: ClientOptions & { apiKey: string },
  ) {
    const { apiKey, ...rest } = options;
    this.http = new Transport(baseUrl, { ...rest, headers: { ...rest.headers, Authorization: `Bearer ${apiKey}` } });
    this.base = `${PREFIX}/${enc(slug)}`;
  }

  /** What the API expects and returns: input fields, versions, limits, approvals. */
  info(): Promise<InfoOut> {
    return this.http.json("GET", this.base);
  }

  /** The OpenAPI document of this workflow with its input and result schemas. */
  openapi(): Promise<Record<string, unknown>> {
    return this.http.json("GET", `${this.base}/openapi.json`);
  }

  /**
   * Start a run with the values of the workflow's input form. Every start carries an
   * `Idempotency-Key` (a new one unless given), so a retry after a lost answer never starts a
   * second run. `waitSeconds` waits that long for the result (when the publication allows it).
   */
  start(
    values: Record<string, unknown>,
    options: { version?: number; idempotencyKey?: string; waitSeconds?: number } = {},
  ): Promise<RunStatusOut> {
    const path = options.version !== undefined ? `${this.base}/versions/${options.version}/runs` : `${this.base}/runs`;
    return this.http.json("POST", path, {
      body: values,
      query: { wait: options.waitSeconds },
      headers: { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID().replaceAll("-", "") },
      retryUnsafe: true,
    });
  }

  runs(options: { status?: string; limit?: number } = {}): Promise<RunStatusOut[]> {
    return this.http.json("GET", `${this.base}/runs`, { query: options });
  }

  status(runId: string): Promise<RunStatusOut> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}`);
  }

  result(runId: string): Promise<RunResultOut> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/result`);
  }

  /** The status once the run finished (or waits for an approval, unless `stopAtApproval` is off). */
  async wait(runId: string, options: { timeoutMs?: number; pollMs?: number; stopAtApproval?: boolean } = {}): Promise<RunStatusOut> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.status(runId);
      const state = found.status;
      if (PUBLISHED_FINISHED.has(state) || ((options.stopAtApproval ?? true) && state === PUBLISHED_WAITING)) return found;
      if (Date.now() >= deadline) throw new NodestroTimeoutError(`Run ${runId} is still ${state} after ${timeoutMs} ms`);
      await sleep(options.pollMs ?? 500);
    }
  }

  /** Wait until the run succeeded and return its result; throws {@link NodestroRunFailed} otherwise. */
  async waitForResult(runId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<RunResultOut> {
    const found = await this.wait(runId, { ...options, stopAtApproval: false });
    if (found.status !== "succeeded") throw new NodestroRunFailed(found as { status?: string; run_id?: string; error?: unknown });
    return this.result(runId);
  }

  /** Live events of a run; after a lost connection pass the last event id to get what was missed. */
  events(runId: string, options: { text?: boolean; lastEventId?: string; signal?: AbortSignal } = {}): AsyncGenerator<ServerEvent> {
    const query = options.text ? "?text=true" : "";
    const headers: Record<string, string> = options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {};
    return this.http.events(`${this.base}/runs/${enc(runId)}/events${query}`, { headers, signal: options.signal });
  }

  cancel(runId: string): Promise<RunStatusOut> {
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/cancel`);
  }

  approvals(runId: string): Promise<ApprovalOut[]> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/approvals`);
  }

  /** Decide the waiting approval (`approvalId` chooses one when several wait). */
  approve(
    runId: string,
    decision: "approved" | "rejected" = "approved",
    options: { comment?: string; approvalId?: string } = {},
  ): Promise<RunStatusOut> {
    const body: Record<string, unknown> = { decision, comment: options.comment ?? "" };
    if (options.approvalId !== undefined) body.approval_id = options.approvalId;
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/approve`, { body });
  }

  /** Continue a failed or cancelled run (or `restart` it) as a new run. */
  resume(runId: string, options: { restart?: boolean; confirmSideEffects?: boolean } = {}): Promise<RunStatusOut> {
    const body: Schemas["ResumeIn"] = {
      restart: options.restart ?? false,
      confirm_side_effects: options.confirmSideEffects ?? false,
    };
    return this.http.json("POST", `${this.base}/runs/${enc(runId)}/resume`, { body });
  }

  files(runId: string): Promise<Array<Record<string, unknown>>> {
    return this.http.json("GET", `${this.base}/runs/${enc(runId)}/files`);
  }

  async download(runId: string, fileId: string): Promise<Uint8Array> {
    const response = await this.http.request("GET", `${this.base}/runs/${enc(runId)}/files/${enc(fileId)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  usage(days = 30): Promise<UsageSummaryOut> {
    return this.http.json("GET", `${this.base}/usage`, { query: { days } });
  }
}
