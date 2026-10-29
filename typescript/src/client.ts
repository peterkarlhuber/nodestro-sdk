/**
 * The client of the Nodestro API (the studio REST API under `/api`).
 *
 * The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
 * (Nodestro listens on `127.0.0.1` by default). Published workflows have their own key-protected
 * API: {@link PublishedWorkflow}.
 */

import type { components } from "./generated/openapi.js";
import { NodestroRunFailed, NodestroTimeoutError } from "./errors.js";
import { type ClientOptions, type ServerEvent, Transport } from "./http.js";

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
export type NewApiKey = Schemas["NewApiKey"];
export type KeyIn = Schemas["KeyIn"];

/** Run states that end a run, and the state of a run waiting for a person. */
export const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
export const WAITING = "paused";

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Return when the run waits for a person (default true). */
  stopAtApproval?: boolean;
  raiseOnFailure?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Workflows, runs, approvals, agents, tools and examples of a Nodestro installation. */
export class NodestroClient {
  private readonly http: Transport;

  constructor(baseUrl = "http://127.0.0.1:8000", options: ClientOptions = {}) {
    this.http = new Transport(baseUrl, options);
  }

  // ---- installation

  /** Version, providers, models and server tools of the installation. */
  meta(): Promise<Meta> {
    return this.http.json("GET", "/api/meta");
  }

  /** The settings as the interface shows them (API keys are never returned). */
  settings(): Promise<Settings> {
    return this.http.json("GET", "/api/settings");
  }

  // ---- workflows

  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.http.json("GET", "/api/workflows");
  }

  getWorkflow(workflowId: string): Promise<Workflow> {
    return this.http.json("GET", `/api/workflows/${enc(workflowId)}`);
  }

  createWorkflow(workflow: WorkflowIn | Record<string, unknown>): Promise<Workflow> {
    return this.http.json("POST", "/api/workflows", { body: workflow });
  }

  updateWorkflow(workflowId: string, workflow: WorkflowIn | Record<string, unknown>): Promise<Workflow> {
    return this.http.json("PUT", `/api/workflows/${enc(workflowId)}`, { body: workflow });
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.http.request("DELETE", `/api/workflows/${enc(workflowId)}`);
  }

  /** The pre-check of a run: problems per workflow and per agent (free, no model request). */
  checkWorkflow(workflow: WorkflowIn | Record<string, unknown>, workflowId?: string): Promise<unknown> {
    return this.http.json("POST", "/api/workflows/check", { body: workflow, query: { workflow_id: workflowId } });
  }

  workflowVersions(workflowId: string): Promise<unknown[]> {
    return this.http.json("GET", `/api/workflows/${enc(workflowId)}/versions`);
  }

  // ---- runs

  /** Start a run; it runs in the background (see {@link waitForRun} and {@link events}). */
  startRun(
    workflowId: string,
    options: { input?: string; values?: Record<string, unknown>; fileIds?: string[] } = {},
  ): Promise<Run> {
    const body: RunIn = { input: options.input ?? "", values: options.values ?? {}, file_ids: options.fileIds ?? [] };
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/runs`, { body });
  }

  getRun(runId: string): Promise<Run> {
    return this.http.json("GET", `/api/runs/${enc(runId)}`);
  }

  listRuns(options: { workflowId?: string; limit?: number } = {}): Promise<RunSummary[]> {
    return this.http.json("GET", "/api/runs", { query: { workflow_id: options.workflowId, limit: options.limit } });
  }

  async cancelRun(runId: string): Promise<boolean> {
    const answer = await this.http.json<{ cancelled?: boolean } | undefined>("POST", `/api/runs/${enc(runId)}/cancel`);
    return Boolean(answer?.cancelled);
  }

  /** Wait until the run finished (or waits for a person, unless `stopAtApproval` is off). */
  async waitForRun(runId: string, options: WaitOptions = {}): Promise<Run> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(runId);
      const status = run.status;
      if (FINISHED.has(status) || ((options.stopAtApproval ?? true) && status === WAITING)) {
        if (options.raiseOnFailure && (status === "failed" || status === "cancelled")) {
          throw new NodestroRunFailed(run as { status?: string; id?: string; error?: unknown });
        }
        return run;
      }
      if (Date.now() >= deadline) throw new NodestroTimeoutError(`Run ${runId} is still ${status} after ${timeoutMs} ms`);
      await sleep(options.pollMs ?? 500);
    }
  }

  /** The live events of a run: `snapshot` (the run), `event` (one step), `end`. */
  events(runId: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<ServerEvent> {
    return this.http.events(`/api/runs/${enc(runId)}/events`, options);
  }

  runFiles(runId: string): Promise<unknown[]> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/files`);
  }

  async downloadFile(runId: string, fileId: string): Promise<Uint8Array> {
    const response = await this.http.request("GET", `/api/runs/${enc(runId)}/files/${enc(fileId)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  // ---- people in the loop and continued runs

  /** Every approval that waits for a decision (all runs). */
  listApprovals(): Promise<PendingApproval[]> {
    return this.http.json("GET", "/api/approvals");
  }

  decideApproval(runId: string, nodeId: string, decision: "approved" | "rejected", comment = ""): Promise<Run> {
    const body: Schemas["ApprovalDecision"] = { decision, comment };
    return this.http.json("POST", `/api/runs/${enc(runId)}/approvals/${enc(nodeId)}`, { body });
  }

  /** Which steps of a failed run would be reused or run again (nothing starts). */
  resumePlan(runId: string): Promise<ResumePlan> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/resume`);
  }

  resumeRun(runId: string, options: { mode?: "continue" | "restart"; confirmSideEffects?: boolean } = {}): Promise<Run> {
    const body: Schemas["ResumeRequest"] = {
      mode: options.mode ?? "continue",
      confirm_side_effects: options.confirmSideEffects ?? false,
    };
    return this.http.json("POST", `/api/runs/${enc(runId)}/resume`, { body });
  }

  // ---- agents, tools, examples

  validateAgent(agent: AgentConfig | Record<string, unknown>): Promise<ConfigIssue[]> {
    return this.http.json("POST", "/api/agents/validate", { body: agent });
  }

  listAgentTemplates(): Promise<Array<Record<string, unknown> & { id: string }>> {
    return this.http.json("GET", "/api/agents/templates");
  }

  createAgentTemplate(template: Record<string, unknown>): Promise<Record<string, unknown> & { id: string }> {
    return this.http.json("POST", "/api/agents/templates", { body: template });
  }

  updateAgentTemplate(templateId: string, template: Record<string, unknown>): Promise<unknown> {
    return this.http.json("PUT", `/api/agents/templates/${enc(templateId)}`, { body: template });
  }

  async deleteAgentTemplate(templateId: string): Promise<void> {
    await this.http.request("DELETE", `/api/agents/templates/${enc(templateId)}`);
  }

  listTools(): Promise<Array<Record<string, unknown> & { name: string }>> {
    return this.http.json("GET", "/api/tools");
  }

  listExamples(language?: string): Promise<TemplateSummary[]> {
    return this.http.json("GET", "/api/library", { query: { language } });
  }

  copyExample(templateId: string, options: { language?: string; tests?: boolean } = {}): Promise<Workflow> {
    const body = { language: options.language ?? null, tests: options.tests ?? false };
    return this.http.json("POST", `/api/library/${enc(templateId)}/copy`, { body });
  }

  // ---- publishing

  /** Publish the workflow as an API (options: `slug`, `note`, `version`, `activate`). */
  publish(workflowId: string, options: Partial<Schemas["PublishIn"]> = {}): Promise<Record<string, any>> {
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/api/publish`, { body: options });
  }

  /** A key for published workflows; its `token` is returned only this once. */
  createApiKey(name: string, scopes: KeyIn["scopes"], publications: string[]): Promise<NewApiKey> {
    const body: KeyIn = { name, scopes, publications };
    return this.http.json("POST", "/api/api-keys", { body });
  }
}

export const enc = encodeURIComponent;
