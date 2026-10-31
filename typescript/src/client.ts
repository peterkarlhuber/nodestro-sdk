/**
 * The client of the Nodestro API (the studio REST API under `/api`).
 *
 * The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
 * (Nodestro listens on `127.0.0.1` by default). Published workflows have their own key-protected
 * API: {@link PublishedWorkflow}.
 */

import type { components } from "./generated/openapi.js";
import { type NodestroClientError, NodestroRunFailed } from "./errors.js";
import { type ClientOptions, type ServerEvent, Transport, pathSegment, pollUntil } from "./http.js";

export type Schemas = components["schemas"];
export type Meta = Schemas["Meta"];
export type Settings = Schemas["Settings"];
/** Stored objects always carry their id in answers (the schema marks it optional because it has a default). */
export type Stored<T> = T & { id: string; created_at: string };
export type Workflow = Stored<Schemas["Workflow"]>;
export type WorkflowIn = Schemas["WorkflowIn"];
export type WorkflowSummary = Schemas["WorkflowSummary"];
export type Run = Stored<Schemas["Run"]>;
export type RunIn = Schemas["RunIn"];
export type RunSummary = Schemas["RunSummary"];
export type PendingApproval = Schemas["PendingApproval"];
export type ResumePlan = Schemas["ResumePlan"];
export type AgentConfig = Schemas["AgentConfig"];
export type ConfigIssue = Schemas["ConfigIssue"];
export type TemplateSummary = Schemas["TemplateSummary"];
export type WorkflowCheck = Schemas["WorkflowCheck"];
export type VersionSummary = Schemas["VersionSummary"];
export type ResultFile = Stored<Schemas["ResultFile"]>;
export type AgentTemplate = Stored<Schemas["AgentTemplate"]>;
export type AgentTemplateIn = Schemas["AgentTemplateIn"];
export type ToolInfo = Schemas["ToolInfo"];
export type PublishIn = Schemas["PublishIn"];
export type Publication = Stored<Schemas["Publication"]>;
export type PublishOut = Omit<Schemas["PublishOut"], "publication"> & { publication: Publication };
export type NewApiKey = Schemas["NewApiKey"];
export type KeyIn = Schemas["KeyIn"];
export type UsageReport = Schemas["UsageReport"];
export type PriceEntry = Schemas["PriceEntry"];
export type PricingOverview = Schemas["PricingOverview"];
export type PricingEvent = Schemas["PricingEvent"];
export type SyncReport = Schemas["SyncReport"];
export type PriceReview = Schemas["ReviewOut"];
export type SubmitResult = Schemas["SubmitResult"];
/** Fields with server defaults (quality, source, ...) may be left out. */
export type OverrideIn = Pick<Schemas["OverrideIn"], "input_usd_per_mtok" | "output_usd_per_mtok"> & Partial<Schemas["OverrideIn"]>;
/** Fields with server defaults (thresholds) may be left out. */
export type ReconciliationIn = Pick<Schemas["ReconciliationIn"], "start" | "end"> & Partial<Schemas["ReconciliationIn"]>;
export type ReconciliationReport = Schemas["ReconciliationReport"];

/** Run states that end a run, and the state of a run waiting for a person. */
export const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
export const WAITING = "paused";

export interface WaitOptions {
  /** Total wait in milliseconds (default 300 000); the last status request may take up to the request time limit more. */
  timeoutMs?: number;
  /** Pause between two status requests in milliseconds (default 500). */
  pollMs?: number;
  /** Return when the run waits for a person (default true). */
  stopAtApproval?: boolean;
  /** Throw {@link NodestroRunFailed} for a failed or cancelled run. */
  raiseOnFailure?: boolean;
}

/**
 * Workflows, runs, approvals, agents, tools and examples of a Nodestro installation.
 *
 * `baseUrl` is the address of the installation (`http` or `https`, host, optional port and path
 * prefix; no query). Reads are retried after connection errors and 502/503/504, a request that
 * changes something never. Throws a `TypeError` or `RangeError` for invalid options or ids (`""`,
 * `.`, `..`); every other error is a {@link NodestroClientError}.
 */
export class NodestroClient {
  private readonly http: Transport;

  constructor(baseUrl = "http://127.0.0.1:8000", options: ClientOptions = {}) {
    this.http = new Transport(baseUrl, options);
  }

  // ---- installation

  /** Version, providers, models and server tools of the installation. */
  async meta(): Promise<Meta> {
    return this.http.json("GET", "/api/meta");
  }

  /** The settings as the interface shows them (API keys are never returned). */
  async settings(): Promise<Settings> {
    return this.http.json("GET", "/api/settings");
  }

  // ---- workflows

  async listWorkflows(): Promise<WorkflowSummary[]> {
    return this.http.json("GET", "/api/workflows");
  }

  async getWorkflow(workflowId: string): Promise<Workflow> {
    return this.http.json("GET", `/api/workflows/${enc(workflowId)}`);
  }

  async createWorkflow(workflow: WorkflowIn | Record<string, unknown>): Promise<Workflow> {
    return this.http.json("POST", "/api/workflows", { body: workflow });
  }

  async updateWorkflow(workflowId: string, workflow: WorkflowIn | Record<string, unknown>): Promise<Workflow> {
    return this.http.json("PUT", `/api/workflows/${enc(workflowId)}`, { body: workflow });
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.http.request("DELETE", `/api/workflows/${enc(workflowId)}`);
  }

  /** The pre-check of a run: problems per workflow and per agent (free, no model request). */
  async checkWorkflow(workflow: WorkflowIn | Record<string, unknown>, workflowId?: string): Promise<WorkflowCheck> {
    return this.http.json("POST", "/api/workflows/check", { body: workflow, query: { workflow_id: workflowId } });
  }

  /** The saved versions of a workflow, newest first. */
  async workflowVersions(workflowId: string): Promise<VersionSummary[]> {
    return this.http.json("GET", `/api/workflows/${enc(workflowId)}/versions`);
  }

  // ---- runs

  /** Start a run; it runs in the background (see {@link waitForRun} and {@link events}). */
  async startRun(
    workflowId: string,
    options: { input?: string; values?: Record<string, unknown>; fileIds?: string[] } = {},
  ): Promise<Run> {
    const body: RunIn = { input: options.input ?? "", values: options.values ?? {}, file_ids: options.fileIds ?? [] };
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/runs`, { body });
  }

  async getRun(runId: string): Promise<Run> {
    return this.http.json("GET", `/api/runs/${enc(runId)}`);
  }

  async listRuns(options: { workflowId?: string; limit?: number } = {}): Promise<RunSummary[]> {
    return this.http.json("GET", "/api/runs", { query: { workflow_id: options.workflowId, limit: options.limit } });
  }

  /** Ask a running run to stop; `false` when it had already ended. */
  async cancelRun(runId: string): Promise<boolean> {
    const answer = await this.http.json<{ cancelled?: boolean } | undefined>("POST", `/api/runs/${enc(runId)}/cancel`);
    return Boolean(answer?.cancelled);
  }

  /**
   * Wait until the run finished (or waits for a person, unless `stopAtApproval` is off). Throws
   * {@link NodestroTimeoutError} when it has not by `timeoutMs` (the run keeps running).
   */
  async waitForRun(runId: string, options: WaitOptions = {}): Promise<Run> {
    const stopAtApproval = options.stopAtApproval ?? true;
    const run = await pollUntil(
      () => this.getRun(runId),
      (found) => FINISHED.has(found.status) || (stopAtApproval && found.status === WAITING),
      runId,
      options,
    );
    if (options.raiseOnFailure && (run.status === "failed" || run.status === "cancelled")) {
      throw new NodestroRunFailed(run as { status?: string; id?: string; error?: unknown });
    }
    return run;
  }

  /**
   * The live events of a run: `snapshot` (the run), `event` (one step), `end`. Leaving the
   * `for await` loop (or aborting `signal`) closes the connection.
   */
  async *events(runId: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<ServerEvent> {
    yield* this.http.events(`/api/runs/${enc(runId)}/events`, options);
  }

  /** The result files of a run (documents written by its output steps). */
  async runFiles(runId: string): Promise<ResultFile[]> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/files`);
  }

  /** The content of a result file (held in memory as a whole). */
  async downloadFile(runId: string, fileId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/runs/${enc(runId)}/files/${enc(fileId)}`);
  }

  // ---- people in the loop and continued runs

  /** Every approval that waits for a decision (all runs). */
  async listApprovals(): Promise<PendingApproval[]> {
    return this.http.json("GET", "/api/approvals");
  }

  async decideApproval(runId: string, nodeId: string, decision: "approved" | "rejected", comment = ""): Promise<Run> {
    const body: Schemas["ApprovalDecision"] = { decision, comment };
    return this.http.json("POST", `/api/runs/${enc(runId)}/approvals/${enc(nodeId)}`, { body });
  }

  /** Which steps of a failed run would be reused or run again (nothing starts). */
  async resumePlan(runId: string): Promise<ResumePlan> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/resume`);
  }

  async resumeRun(runId: string, options: { mode?: "continue" | "restart"; confirmSideEffects?: boolean } = {}): Promise<Run> {
    const body: Schemas["ResumeRequest"] = {
      mode: options.mode ?? "continue",
      confirm_side_effects: options.confirmSideEffects ?? false,
    };
    return this.http.json("POST", `/api/runs/${enc(runId)}/resume`, { body });
  }

  // ---- agents, tools, examples

  /** The problems of one agent configuration (empty when it is fine; no model request). */
  async validateAgent(agent: AgentConfig | Record<string, unknown>): Promise<ConfigIssue[]> {
    return this.http.json("POST", "/api/agents/validate", { body: agent });
  }

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    return this.http.json("GET", "/api/agents/templates");
  }

  /** Save an agent as a template (`{ agent: {...} }`). */
  async createAgentTemplate(template: AgentTemplateIn | Record<string, unknown>): Promise<AgentTemplate> {
    return this.http.json("POST", "/api/agents/templates", { body: template });
  }

  async updateAgentTemplate(templateId: string, template: AgentTemplateIn | Record<string, unknown>): Promise<AgentTemplate> {
    return this.http.json("PUT", `/api/agents/templates/${enc(templateId)}`, { body: template });
  }

  async deleteAgentTemplate(templateId: string): Promise<void> {
    await this.http.request("DELETE", `/api/agents/templates/${enc(templateId)}`);
  }

  /** The tools agents can use: built-in, custom and generated ones. */
  async listTools(): Promise<ToolInfo[]> {
    return this.http.json("GET", "/api/tools");
  }

  /** The example library (`language`: `de`, `en`, `es`, `fr`, `it` or `pt-BR`). */
  async listExamples(language?: string): Promise<TemplateSummary[]> {
    return this.http.json("GET", "/api/library", { query: { language } });
  }

  /** Copy an example into a new workflow (`tests` also copies its test cases). */
  async copyExample(templateId: string, options: { language?: string; tests?: boolean } = {}): Promise<Workflow> {
    const body = { language: options.language ?? null, tests: options.tests ?? false };
    return this.http.json("POST", `/api/library/${enc(templateId)}/copy`, { body });
  }

  // ---- usage and model prices

  /** Tokens and costs of the last `days` days; `cost_state` tells known, partial and unknown costs apart. */
  async usage(days = 30): Promise<UsageReport> {
    return this.http.json("GET", `/api/usage?days=${encodeURIComponent(String(days))}`);
  }

  /** Every effective model price with status, quality, source, check date and version. */
  async listPrices(): Promise<PriceEntry[]> {
    return this.http.json("GET", "/api/pricing");
  }

  /** The active price version, the last check, staleness and open reviews. */
  async pricingStatus(): Promise<PricingOverview> {
    return this.http.json("GET", "/api/pricing/status");
  }

  async pricingHistory(limit = 200): Promise<PricingEvent[]> {
    return this.http.json("GET", `/api/pricing/history?limit=${encodeURIComponent(String(limit))}`);
  }

  /** Check the prices against their sources now (desktop; a server answers 403). */
  async syncPrices(): Promise<SyncReport> {
    return this.http.json("POST", "/api/pricing/sync");
  }

  async listPriceReviews(): Promise<PriceReview[]> {
    return this.http.json("GET", "/api/pricing/reviews");
  }

  /** Accept or discard the held-back price changes of a review (`null` after a rejection). */
  async decidePriceReview(version: string, decision: "approve" | "reject", note?: string): Promise<SubmitResult | null> {
    const path = `/api/pricing/reviews/${enc(version)}/${decision}`;
    if (decision === "reject") {
      await this.http.request("POST", path, { body: { note: note ?? null } });
      return null;
    }
    return this.http.json("POST", path, { body: { note: note ?? null } });
  }

  /** An individual price (USD per million tokens) for one model; it wins over the reference price. */
  async setPriceOverride(provider: string, model: string, price: OverrideIn): Promise<PriceEntry> {
    return this.http.json("PUT", `/api/pricing/overrides/${enc(provider)}/${modelPath(model)}`, { body: price });
  }

  async removePriceOverride(provider: string, model: string): Promise<void> {
    await this.http.request("DELETE", `/api/pricing/overrides/${enc(provider)}/${modelPath(model)}`);
  }

  /** Compare Nodestro's estimates with the providers' bills (`start`, `end`; optional one-off `keys`). */
  async reconcileCosts(request: ReconciliationIn): Promise<ReconciliationReport> {
    return this.http.json("POST", "/api/pricing/reconciliation", { body: request });
  }

  // ---- publishing

  /** Publish the workflow as an API (options: `slug`, `note`, `version`, `activate`). */
  async publish(workflowId: string, options: Partial<PublishIn> = {}): Promise<PublishOut> {
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/api/publish`, { body: options });
  }

  /** A key for published workflows; its `token` is returned only this once. `publications` are publication ids. */
  async createApiKey(name: string, scopes: KeyIn["scopes"], publications: string[]): Promise<NewApiKey> {
    const body: KeyIn = { name, scopes, publications };
    return this.http.json("POST", "/api/api-keys", { body });
  }
}

/** One path segment (see {@link pathSegment}). */
export const enc = pathSegment;

/** A model id as the path tail of a price route: its `/`-separated parts, each one a checked path segment. */
function modelPath(model: string): string {
  return model.split("/").map(pathSegment).join("/");
}
