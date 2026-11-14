/**
 * The client of the Nodestro API (the studio REST API under `/api`).
 *
 * The studio API is the one the Nodestro interface uses; it is local and has no keys of its own
 * (Nodestro listens on `127.0.0.1` by default). Published workflows have their own key-protected
 * API: {@link PublishedWorkflow}.
 */

import type { components } from "./generated/openapi.js";
import { type NodestroClientError, NodestroRunFailed } from "./errors.js";
import {
  API_VERSION,
  type ClientOptions,
  type DownloadOptions,
  type EventStreamOptions,
  type ServerEvent,
  Transport,
  newIdempotencyKey,
  pathSegment,
  pollUntil,
} from "./http.js";

export type Schemas = components["schemas"];

/** One page of {@link NodestroClient.listRunsPage}: the runs, newest first, and the cursor of the next page. */
export interface RunPage {
  runs: RunSummary[];
  /** The `before` of the next (older) page; `null` when no older run matches. */
  nextBefore: string | null;
}

/** The answer of {@link NodestroClient.checkCompatibility}. */
export interface Compatibility {
  /** Whether this SDK fits the installation's API. */
  compatible: boolean;
  /** The installation's API version. */
  apiVersion: string;
  /** The API version this SDK's types were generated from (`API_VERSION`). */
  sdkApiVersion: string;
  /** Why not, in English (empty when compatible). */
  reason: string;
}

function versionParts(version: string): [number, number] | null {
  const [major = "", minor = ""] = version.trim().split(".");
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor)) return null;
  return [Number(major), Number(minor)];
}

/** Whether an API of `apiVersion` fits an SDK generated from `sdkApiVersion` (see `checkCompatibility`). */
export function compatibility(apiVersion: string, sdkApiVersion: string = API_VERSION): Compatibility {
  const answer = (reason = ""): Compatibility => ({ compatible: !reason, apiVersion, sdkApiVersion, reason });
  const found = versionParts(apiVersion);
  const expected = versionParts(sdkApiVersion);
  if (!found || !expected) return answer(`The API version ${JSON.stringify(apiVersion)} cannot be read`);
  if (found[0] !== expected[0]) return answer(`The API has major version ${found[0]}, this SDK was made for ${expected[0]}`);
  if (expected[0] === 0 && found[1] !== expected[1]) {
    return answer(`The API is ${apiVersion}; this SDK was made for ${sdkApiVersion} (0.x minors may break)`);
  }
  if (found[1] < expected[1]) return answer(`The API is ${apiVersion}, older than the ${sdkApiVersion} this SDK was made for`);
  return answer();
}
export type Meta = Schemas["Meta"];
export type Settings = Schemas["Settings"];
export type SettingsIn = Schemas["SettingsIn"];
export type SandboxBackendStatus = Schemas["SandboxBackendStatus"];
export type SandboxStatus = Schemas["SandboxStatus"];
export type SandboxCheck = Schemas["SandboxCheck"];
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
export type AgentTemplateVersion = Schemas["AgentTemplateVersion"];
export type TemplateCheck = Schemas["TemplateCheck"];
export type AgentTemplateImport = Schemas["ImportResult"];
export type LibraryAgentSummary = Schemas["LibraryAgentSummary"];
export type LibraryAgentDetail = Schemas["LibraryAgentDetail"];
export type Skill = Schemas["Skill"];
export type SkillVersion = Schemas["SkillVersion"];
export type SkillDetail = Schemas["SkillDetail"];
export type SkillCheck = Schemas["SkillCheck"];
export type SkillImportResult = Schemas["SkillImportResult"];
export type SkillFileText = Schemas["SkillFileText"];
export type SkillUser = Schemas["SkillUser"];
export type SkillBinding = Schemas["SkillBinding"];
export type LibrarySkill = Schemas["LibrarySkill"];
export type LibrarySkillDetail = Schemas["LibrarySkillDetail"];
export type PartSummary = Schemas["PartSummary"];
export type PartDetail = Schemas["PartDetail"];
/** A skill file to save: text, bytes, or `null` to keep the file of the latest version. */
export type SkillFiles = Record<string, string | Uint8Array | null>;
export type ToolInfo = Schemas["ToolInfo"];
export type LocalOverview = Schemas["LocalOverview"];
export type LocalStatus = Schemas["LocalStatus"];
export type LocalJob = Schemas["LocalJob"];
export type LocalImport = Schemas["ImportIn"];
export type Recommendation = Schemas["Recommendation"];
export type KnowledgeIndexStatus = Schemas["KnowledgeIndexStatus"];
export type BuiltinToolInfo = Schemas["BuiltinToolInfo"];
export type ConnectionStatus = Schemas["ConnectionStatus"];
export type ConnectionTypeInfo = Schemas["ConnectionTypeInfo"];
export type ConnectionView = Schemas["ConnectionView"];
export type ConnectionIn = Schemas["ConnectionIn"];
export type ConnectionPatch = Schemas["ConnectionPatch"];
export type ConnectionEvent = Schemas["ConnectionEvent"];
export type McpStatus = Schemas["McpStatus"];
export type McpServerView = Schemas["McpServerView"];
export type McpServerIn = Schemas["McpServerIn"];
export type McpDiscovery = Schemas["McpDiscovery"];
export type McpToolView = Schemas["McpToolView"];
export type McpEvent = Schemas["McpEvent"];
export type McpAccess = "read" | "write" | "destructive";
export type McpOAuthStart = Schemas["McpOAuthStart"];
export type McpStats = Schemas["McpStats"];
export type McpServerHealth = Schemas["McpServerHealth"];
export type DependencyStatus = Schemas["DependencyStatus"];
export type DependencyPlan = Schemas["Plan"];
export type PublicationPatch = Schemas["PublicationPatch"];
export type PublishIn = Schemas["PublishIn"];
export type ReleaseGate = Schemas["ReleaseGate"];
/** A gate as sent: `min_pass_rate` defaults to 1 (every case clean). */
export type ReleaseGateIn = Omit<ReleaseGate, "min_pass_rate"> & { min_pass_rate?: number };
export type GateReport = Schemas["GateReport"];
export type GateItem = Schemas["GateItem"];
export type GateOverride = Schemas["GateOverride"];
export type Publication = Stored<Schemas["Publication"]>;
export type PublishOut = Omit<Schemas["PublishOut"], "publication"> & { publication: Publication };
export type NewApiKey = Schemas["NewApiKey"];
export type ApiKey = Schemas["ApiKeyOut"];
export type KeyIn = Schemas["KeyIn"];
export type UsageReport = Schemas["UsageReport"];
export type Batch = Stored<Schemas["Batch"]>;
/** One row of a batch as sent (fields with a server default may be left out). */
export type BatchRowIn = Partial<Schemas["BatchRow"]>;
/** A batch as sent: `workflow_id` and `rows`; the other fields have server defaults. */
export type BatchIn = Omit<Partial<Schemas["BatchIn"]>, "workflow_id" | "rows"> & { workflow_id: string; rows: BatchRowIn[] };
export type BatchSummary = Schemas["BatchSummary"];
export type BatchPlan = Schemas["BatchPlan"];
export type ParsedRows = Schemas["ParsedRows"];
export type Schedule = Stored<Schemas["Schedule"]>;
/** A schedule as sent: `workflow_id`; the other fields have server defaults. */
export type ScheduleIn = Omit<Partial<Schemas["ScheduleIn"]>, "workflow_id"> & { workflow_id: string };
export type ScheduleState = Schemas["ScheduleState"];
export type ScheduleActivation = Schemas["Activation"];
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
export type RunChatView = Schemas["RunChatView"];
export type RunMessage = Schemas["RunMessage"];
export type ChatMessageIn = Schemas["ChatMessageIn"];
export type ChatTarget = Schemas["ChatTarget"];
export type ChatLimits = Schemas["ChatLimits"];
export type TeamActivity = Schemas["TeamActivity"];
export type DecisionNote = Schemas["DecisionNote"];
export type Suite = Stored<Schemas["Suite"]>;
/** A test series as sent: `workflow_id`; the other fields have server defaults. */
export type SuiteIn = Omit<Partial<Schemas["SuiteIn"]>, "workflow_id" | "cases"> & {
  workflow_id: string;
  cases?: Partial<Schemas["TestCase"]>[];
};
/** A test run's settings as sent (every field has a server default). */
export type BenchmarkStart = Partial<Schemas["BenchmarkStart"]>;
export type BenchmarkPlan = Schemas["BenchmarkPlan"];
export type BenchmarkRun = Stored<Schemas["BenchmarkRun"]>;
export type Comparison = Schemas["Comparison"];
export type ModelChoice = Schemas["ModelChoice"];
export type CaseProposalIn = Partial<Schemas["CaseProposalIn"]>;
export type CaseProposal = Schemas["CaseProposal"];
export type KnowledgeFile = Schemas["KnowledgeFile"];
export type CollectionInfo = Schemas["CollectionInfo"];
export type SearchHit = Schemas["SearchHit"];
export type StorageInfo = Schemas["StorageInfo"];
export type FormatsInfo = Schemas["FormatsInfo"];
export type UploadResult = Schemas["UploadResult"];
export type InputFile = Schemas["InputFileOut"];
export type FileText = Schemas["FileText"];
export type InputCleanupResult = Schemas["InputCleanupResult"];
export type ToolApprovalRequest = Schemas["ToolApprovalRequest"];
export type ToolApprovalEvent = Schemas["ToolApprovalEvent"];
/** Export options as sent (every field has a server default; `kind` is `standard` unless given). */
export type ExportOptions = Partial<Schemas["ExportOptions"]>;
export type ExportCheck = Schemas["ExportCheck"];
export type ExportRecord = Stored<Schemas["ExportRecord"]>;
export type ExportJob = Stored<Schemas["ExportJob"]>;
/** A file to upload: a `Blob`/`File`, or a name with its content. */
export type UploadFile = Blob | { name: string; content: Uint8Array | string };
/** A budget request of a run; amounts are decimal strings (`"2.50"`). */
export type BudgetRequest = Stored<Schemas["BudgetRequest"]>;
/** The budget of a run's top-level run, its open request and what the caller may decide; amounts are decimal strings. */
export type RunBudgetOut = Omit<Schemas["RunBudgetOut"], "pending" | "history"> & {
  pending?: BudgetRequest | null;
  history?: BudgetRequest[];
};
export type RunBudget = Schemas["RunBudget"];
export type BudgetPolicy = Schemas["BudgetPolicy"];
export type BudgetRaise = Schemas["BudgetRaise"];
export type BudgetBlock = Schemas["BudgetBlock"];
export type BlockedRequest = Schemas["BlockedRequest"];
export type BudgetDecisionIn = Schemas["BudgetDecisionIn"];
export type BudgetAction = BudgetDecisionIn["action"];

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
  /** Stops waiting (the run keeps running): the wait rejects with the signal's reason, also during a pause. */
  signal?: AbortSignal;
}

/**
 * Workflows, runs, approvals, agents, tools and examples of a Nodestro installation.
 *
 * `baseUrl` is the address of the installation (`http` or `https`, host, optional port and path
 * prefix; no query). Reads are retried after connection errors and 502/503/504, a request that
 * changes something never (except run chat messages and budget decisions, which carry a key). Throws a `TypeError` or `RangeError` for invalid options or ids (`""`,
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

  /**
   * Compare the installation's API version (`/api/meta`) with the one this SDK was generated from. Never throws for
   * a mismatch (only for a failed request): the answer says whether the versions fit and why not. They fit when
   * the major versions are equal and, for `0.x`, the minor versions too (`0.x` minors may break); from `1.0` an
   * API with a newer minor version fits as well.
   */
  async checkCompatibility(): Promise<Compatibility> {
    const meta = await this.meta();
    return compatibility(String(meta.version ?? ""));
  }

  /** The settings as the interface shows them (API keys are never returned). */
  async settings(): Promise<Settings> {
    return this.http.json("GET", "/api/settings");
  }

  /**
   * Change some settings (needs `admin`): only the fields given change, e.g.
   * `updateSettings({ default_model: "anthropic:claude-sonnet-4-5" })`. Returns the settings afterwards (keys are
   * never returned).
   */
  async updateSettings(changes: SettingsIn): Promise<Settings> {
    return this.http.json("PUT", "/api/settings", { body: changes });
  }

  /**
   * The Docker sandbox of the computer the API runs on, as its background check last found it (`state` `checking`,
   * `approved` or `unavailable`, with `reason` and `checks`). Never waits for Docker; `refresh` starts a new check
   * (answering at once), `wait` (seconds, at most 5) waits for a running one.
   */
  async sandboxStatus(options: { refresh?: boolean; wait?: number } = {}): Promise<SandboxStatus> {
    return this.http.json("GET", "/api/sandbox/status", {
      query: { refresh: options.refresh ?? false, wait: options.wait ?? 0 },
    });
  }

  /**
   * Run the Docker sandbox's checks again now, the in-container self-test included (permission `admin`), and wait at
   * most `timeout` seconds (at most 60) for the result; `state` is `checking` while it goes on.
   */
  async sandboxSelfTest(options: { timeout?: number } = {}): Promise<SandboxStatus> {
    const timeout = options.timeout ?? 30;
    return this.http.json("POST", "/api/sandbox/self-test", {
      query: { timeout },
      timeoutMs: Math.max(30, timeout + 15) * 1000,
    });
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

  /**
   * Save a workflow; a changed one becomes its next version (`note` describes it). `revision` is the workflow's
   * `updated_at` as read: it is sent as `If-Match`, so the save applies only when nobody saved in between, and is
   * otherwise refused with {@link NodestroAPIError} 409 `workflow.conflict` (`params.updated_at` names the current
   * revision). Without it the save always applies.
   */
  async updateWorkflow(
    workflowId: string,
    workflow: WorkflowIn | Record<string, unknown>,
    options: { revision?: string; note?: string } = {},
  ): Promise<Workflow> {
    const headers = options.revision !== undefined ? { "If-Match": `"${options.revision}"` } : undefined;
    return this.http.json("PUT", `/api/workflows/${enc(workflowId)}`, { body: workflow, headers, query: { note: options.note } });
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.http.request("DELETE", `/api/workflows/${enc(workflowId)}`);
  }

  /** The pre-check of a run: problems per workflow and per agent (free, no model request). */
  async checkWorkflow(workflow: WorkflowIn | Record<string, unknown>, workflowId?: string): Promise<WorkflowCheck> {
    if (typeof workflow === "string") {
      throw new TypeError(
        "checkWorkflow() takes the workflow document, not its id: checkWorkflow(await client.getWorkflow(id), id)",
      );
    }
    return this.http.json("POST", "/api/workflows/check", { body: workflow, query: { workflow_id: workflowId } });
  }

  /** The saved versions of a workflow, newest first. */
  async workflowVersions(workflowId: string): Promise<VersionSummary[]> {
    return this.http.json("GET", `/api/workflows/${enc(workflowId)}/versions`);
  }

  // ---- runs

  /**
   * Start a run; it runs in the background (see {@link waitForRun} and {@link events}).
   *
   * Every start carries an `Idempotency-Key` (a new random one unless `idempotencyKey` is given), so the automatic
   * retry after a lost answer or a 502/503/504 returns the run that already started instead of starting a second
   * one. The same key with a different request is refused (409 `idempotency.conflict`).
   */
  async startRun(
    workflowId: string,
    options: { input?: string; values?: Record<string, unknown>; fileIds?: string[]; idempotencyKey?: string } = {},
  ): Promise<Run> {
    const body: RunIn = { input: options.input ?? "", values: options.values ?? {}, file_ids: options.fileIds ?? [] };
    const headers = { "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey() };
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/runs`, { body, headers, retryUnsafe: true });
  }

  async getRun(runId: string): Promise<Run> {
    return this.http.json("GET", `/api/runs/${enc(runId)}`);
  }

  /**
   * One page of stored runs, newest first (at most `limit`, the API's default 100). `before` continues with older
   * runs: a cursor from {@link listRunsPage} or a time (ISO 8601). {@link iterRuns} pages through all of them.
   */
  async listRuns(options: { workflowId?: string; limit?: number; before?: string } = {}): Promise<RunSummary[]> {
    return (await this.listRunsPage(options)).runs;
  }

  /** Like {@link listRuns}, with the cursor of the next (older) page (`null` when no older run matches). */
  async listRunsPage(options: { workflowId?: string; limit?: number; before?: string } = {}): Promise<RunPage> {
    const query = { workflow_id: options.workflowId, limit: options.limit, before: options.before };
    return this.http.send("GET", "/api/runs", { query }, async (response) => {
      const runs = (await response.json()) as RunSummary[];
      const more = response.headers.get("x-has-more") === "true";
      return { runs, nextBefore: (more && response.headers.get("x-next-before")) || null };
    });
  }

  /**
   * Every stored run (of one workflow), newest first, read a page of `pageSize` (1 to 500) at a time with the API's
   * cursor, so runs started meanwhile never shift a page.
   */
  async *iterRuns(options: { workflowId?: string; pageSize?: number; before?: string } = {}): AsyncGenerator<RunSummary> {
    let before = options.before;
    for (;;) {
      const page = await this.listRunsPage({ workflowId: options.workflowId, limit: options.pageSize ?? 100, before });
      yield* page.runs;
      if (page.nextBefore === null || page.runs.length === 0) return;
      before = page.nextBefore;
    }
  }

  /** Ask a running run to stop; `false` when it had already ended. */
  async cancelRun(runId: string): Promise<boolean> {
    const answer = await this.http.json<{ cancelled?: boolean } | undefined>("POST", `/api/runs/${enc(runId)}/cancel`);
    return Boolean(answer?.cancelled);
  }

  /**
   * Wait until the run finished (or waits for a person, unless `stopAtApproval` is off). Throws
   * {@link NodestroTimeoutError} when it has not by `timeoutMs` (the run keeps running).
   *
   * A run that waits for a person is `paused`, for example at an approval step or for a budget decision. A budget
   * wait has `run.budget?.pending_request_id` set; answer it with {@link raiseRunBudget} or {@link endRunForBudget}
   * (see {@link getRunBudget}).
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
   *
   * `reconnect` (`true` or a retry policy) connects again after a lost connection, until `end` (see
   * {@link EventStreamOptions}). This stream has no event ids: every connection starts with a new `snapshot` (the
   * whole run as it is now), and the steps between the lost connection and that snapshot are not delivered one by
   * one. Aborting `signal` also ends the pause before a reconnect.
   */
  async *events(runId: string, options: EventStreamOptions = {}): AsyncGenerator<ServerEvent> {
    yield* this.http.events(`/api/runs/${enc(runId)}/events`, options);
  }

  /** The result files of a run (documents written by its output steps). */
  async runFiles(runId: string): Promise<ResultFile[]> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/files`);
  }

  /** The content of a result file (held in memory as a whole; see {@link streamFile} for large files). */
  async downloadFile(runId: string, fileId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/runs/${enc(runId)}/files/${enc(fileId)}`);
  }

  /**
   * The content of a result file as a `ReadableStream`, never held in memory as a whole. The promise resolves when
   * the answer arrived (errors such as 404 reject it); a body that breaks off errors the stream with a
   * {@link NodestroConnectionError} (a stall of `timeoutMs`: {@link NodestroTimeoutError}). Cancel the stream (or
   * abort `signal`) to stop early. In Node.js, `stream/promises` `pipeline(Readable.fromWeb(stream), file)` writes it
   * to a file.
   */
  async streamFile(runId: string, fileId: string, options: DownloadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    return this.http.download(`/api/runs/${enc(runId)}/files/${enc(fileId)}`, options);
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

  // ---- run budgets

  /**
   * The budget of a run: limits, spending, raises, the open request (`pending`), earlier requests and what the caller
   * may decide (`policy`). `runId` may be a run below the top-level run; the answer is the top-level run's budget.
   * Amounts are decimal strings (`"2.50"`).
   */
  async getRunBudget(runId: string): Promise<RunBudgetOut> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/budget`);
  }

  /** Every budget request that waits for a decision (all runs), oldest first. */
  async listBudgetRequests(): Promise<BudgetRequest[]> {
    return this.http.json("GET", "/api/budget-requests", { query: { status: "pending" } });
  }

  /**
   * Answer a run's budget request: `raise` sets the blocking limit to `limitUsd` and continues the run (one
   * operation), `end` ends the run. Resolves to the run's budget after the decision.
   *
   * `limitUsd` is a decimal string with at most two decimal places (`"2.50"`); a number is refused with a
   * `TypeError`, so no amount is rounded on the way. Every decision carries an `idempotencyKey` (a new random one
   * unless given), so the automatic retry after a lost answer or a 502/503/504 returns the stored result instead of
   * being refused as already decided. Pass your own key (at most 100 of `A-Z a-z 0-9 . _ : -`) to make your own
   * retries safe too.
   *
   * Refusals are {@link NodestroAPIError}s: 404 (run or request unknown), 409 `budget.not_pending` (decided, expired
   * or cancelled; `params.request_status`, `params.decided_by`), 422 `budget.limit_not_higher`
   * (`params.current_limit_usd`) and `budget.limit_invalid`, 403 `budget.over_policy` (above `params.max_limit_usd`)
   * and `access.forbidden` (only the person who started the run or an administrator decides; `params.reason`).
   */
  async decideRunBudget(
    runId: string,
    requestId: string,
    action: BudgetAction,
    options: { limitUsd?: string; idempotencyKey?: string } = {},
  ): Promise<RunBudgetOut> {
    const body: BudgetDecisionIn = { request_id: requestId, action, idempotency_key: options.idempotencyKey ?? newIdempotencyKey() };
    if (options.limitUsd !== undefined) body.limit_usd = amount(options.limitUsd);
    return this.http.json("POST", `/api/runs/${enc(runId)}/budget/decisions`, { body, retryUnsafe: true });
  }

  /** Raise the limit that stopped the run to `limitUsd` and continue it (see {@link decideRunBudget}). */
  async raiseRunBudget(runId: string, requestId: string, limitUsd: string, options: { idempotencyKey?: string } = {}): Promise<RunBudgetOut> {
    return this.decideRunBudget(runId, requestId, "raise", { ...options, limitUsd: amount(limitUsd) });
  }

  /**
   * End the run instead of raising its budget; it ends as `cancelled` with `error_code` `run.budget_ended` (see
   * {@link decideRunBudget}).
   */
  async endRunForBudget(runId: string, requestId: string, options: { idempotencyKey?: string } = {}): Promise<RunBudgetOut> {
    return this.decideRunBudget(runId, requestId, "end", options);
  }

  // ---- live run chat

  /**
   * The live chat of a run: messages, the orchestrators one can talk to (with what their teams do now) and the
   * limits. `runId` may be the top-level run or any run below it; the chat belongs to the top-level run.
   */
  async runChat(runId: string): Promise<RunChatView> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/chat`);
  }

  /**
   * Ask a question about the run (answered from the stored run state; it changes nothing) or give the orchestrator
   * `node_id` of `target_run_id` an instruction for its next decision.
   *
   * Every message carries a `client_id` (a new random one unless given), so the automatic retry after a lost answer
   * or a 502/503/504 returns the stored message instead of sending a second one. Pass your own key (at most 100 of
   * `A-Z a-z 0-9 . _ : -`) to make your own retries safe too; the same key for another message is refused (409
   * `run_chat.client_id_reused`). The answer to a question arrives later as a message of kind `answer`.
   */
  async sendRunChatMessage(runId: string, body: ChatMessageIn): Promise<RunMessage> {
    const sent: ChatMessageIn = { ...body, client_id: body.client_id ?? newIdempotencyKey() };
    return this.http.json("POST", `/api/runs/${enc(runId)}/chat/messages`, { body: sent, retryUnsafe: true });
  }

  /** One message of the run's chat (e.g. to see whether a question was answered). */
  async runChatMessage(runId: string, messageId: string): Promise<RunMessage> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/chat/messages/${enc(messageId)}`);
  }

  /**
   * The live events of a run's chat: `snapshot` (the whole view, on every connect), `message` (a new or changed
   * message), `targets` (what the orchestrators do now), `end` (the run ended and no answer is pending, or access
   * ended). A reconnect gets a new snapshot. Leaving the `for await` loop (or aborting `signal`) closes the
   * connection. `reconnect` works as in {@link events}.
   */
  async *runChatEvents(runId: string, options: EventStreamOptions = {}): AsyncGenerator<ServerEvent> {
    yield* this.http.events(`/api/runs/${enc(runId)}/chat/events`, options);
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

  /** Every saved version of a template, newest first (NAL-B1). */
  async listAgentTemplateVersions(templateId: string): Promise<AgentTemplateVersion[]> {
    return this.http.json("GET", `/api/agents/templates/${enc(templateId)}/versions`);
  }

  async getAgentTemplateVersion(templateId: string, version: number): Promise<AgentTemplateVersion> {
    return this.http.json("GET", `/api/agents/templates/${enc(templateId)}/versions/${Math.trunc(version)}`);
  }

  /** What the template needs in this workspace (tools, model, service connections). */
  async checkAgentTemplate(templateId: string): Promise<TemplateCheck> {
    return this.http.json("GET", `/api/agents/templates/${enc(templateId)}/check`);
  }

  /** The template as a `nodestro-agent/1` document, without connections, knowledge files or approval rules. */
  async exportAgentTemplate(templateId: string): Promise<Record<string, unknown>> {
    return this.http.json("GET", `/api/agents/templates/${enc(templateId)}/export`);
  }

  /** Store an exported template as a new one; approval rules are reset and connections dropped. */
  async importAgentTemplate(document: Record<string, unknown>): Promise<AgentTemplateImport> {
    return this.http.json("POST", "/api/agents/templates/import", { body: document });
  }

  /** The tools agents can use: built-in, custom and generated ones. */
  async listTools(): Promise<ToolInfo[]> {
    return this.http.json("GET", "/api/tools");
  }

  /** Built-in tools with their specs: category, network, offline, connection type, limits, cost unit. */
  async listBuiltinTools(): Promise<BuiltinToolInfo[]> {
    return this.http.json("GET", "/api/tools/builtin");
  }

  // ---- service connections (nodestro-runtime ADR-0001)

  /** Whether secrets are stored encrypted (`secret_vault`), the mode and the contract version. */
  async connectionStatus(): Promise<ConnectionStatus> {
    return this.http.json("GET", "/api/connections/status");
  }

  async listConnectionTypes(): Promise<ConnectionTypeInfo[]> {
    return this.http.json("GET", "/api/connections/types");
  }

  /** The service connections (secrets are never returned, only `secret_set`). */
  async listConnections(options: { type?: string } = {}): Promise<ConnectionView[]> {
    return this.http.json("GET", "/api/connections", options.type === undefined ? {} : { query: { type: options.type } });
  }

  async getConnection(connectionId: string): Promise<ConnectionView> {
    return this.http.json("GET", `/api/connections/${enc(connectionId)}`);
  }

  /** Create a connection (`type`, `name`, `provider`, `settings`); needs `admin`. */
  async createConnection(connection: Partial<ConnectionIn> & { type: string; name: string }): Promise<ConnectionView> {
    return this.http.json("POST", "/api/connections", { body: connection });
  }

  /** Change name, description, provider or settings; a new target resets the check. */
  async updateConnection(connectionId: string, change: ConnectionPatch): Promise<ConnectionView> {
    return this.http.json("PATCH", `/api/connections/${enc(connectionId)}`, { body: change });
  }

  /** Delete a connection; one that agents still bind is refused (`connection.in_use`) unless `force`. */
  async deleteConnection(connectionId: string, options: { force?: boolean } = {}): Promise<void> {
    await this.http.request("DELETE", `/api/connections/${enc(connectionId)}`, options.force ? { query: { force: true } } : {});
  }

  /** Store or replace the secret (`""` removes it); it is never returned. */
  async setConnectionSecret(connectionId: string, secret: string): Promise<ConnectionView> {
    return this.http.json("PUT", `/api/connections/${enc(connectionId)}/secret`, { body: { secret } });
  }

  /** Check the connection; the result holds a status and an error code, never the service's message. */
  async checkConnection(connectionId: string): Promise<ConnectionView> {
    return this.http.json("POST", `/api/connections/${enc(connectionId)}/check`);
  }

  /** Administration events, newest first (never secrets or settings values); needs `admin`. */
  async listConnectionEvents(options: { limit?: number } = {}): Promise<ConnectionEvent[]> {
    return this.http.json("GET", "/api/connections/events", { query: { limit: options.limit ?? 200 } });
  }

  /** The example library (`language`: `de`, `en`, `es`, `fr`, `it` or `pt-BR`). */
  // ---- connected MCP services

  /** Whether MCP is available here: token vault, operator endpoint list, loopback, unattended runs, write gate. */
  async mcpStatus(): Promise<McpStatus> {
    return this.http.json("GET", "/api/mcp/status");
  }

  /** The connected MCP servers (tokens are never returned, only `token_set` and `token_storage`). */
  async listMcpServers(): Promise<McpServerView[]> {
    return this.http.json("GET", "/api/mcp/servers");
  }

  /** Connect an MCP server (`name`, `url`, optional `auth` and write-only `token`); needs `admin`. */
  async addMcpServer(server: Partial<McpServerIn> & { name: string; url: string }): Promise<McpServerView> {
    return this.http.json("POST", "/api/mcp/servers", { body: server });
  }

  /** Change a server; an omitted `token` keeps the stored one, `""` removes it. */
  async updateMcpServer(serverId: string, server: Partial<McpServerIn> & { name: string; url: string }): Promise<McpServerView> {
    return this.http.json("PUT", `/api/mcp/servers/${enc(serverId)}`, { body: server });
  }

  async removeMcpServer(serverId: string): Promise<void> {
    await this.http.request("DELETE", `/api/mcp/servers/${enc(serverId)}`);
  }

  /** Connect to the server and list its tools; new and changed definitions wait for an administrator. */
  async discoverMcpTools(serverId: string): Promise<McpDiscovery> {
    return this.http.json("POST", `/api/mcp/servers/${enc(serverId)}/discover`);
  }

  async listMcpTools(serverId: string): Promise<McpToolView[]> {
    return this.http.json("GET", `/api/mcp/servers/${enc(serverId)}/tools`);
  }

  /**
   * Approve (with a classification) or reject a tool's current definition. `expectedHash` is the definition hash you
   * reviewed: the server refuses when the definition changed since.
   */
  async decideMcpTool(
    serverId: string,
    name: string,
    decision: { approve: boolean; access?: McpAccess; expectedHash?: string },
  ): Promise<McpToolView> {
    const body: Record<string, unknown> = { approve: decision.approve };
    if (decision.access !== undefined) body.access = decision.access;
    if (decision.expectedHash !== undefined) body.expected_hash = decision.expectedHash;
    return this.http.json("POST", `/api/mcp/servers/${enc(serverId)}/tools/${enc(name)}/decision`, { body });
  }

  /**
   * Start the OAuth sign-in of a server with `auth: "oauth"`; open `authorization_url` in a browser. The authorization
   * server returns to Nodestro's callback, which stores the credentials sealed.
   */
  async startMcpSignIn(serverId: string): Promise<McpOAuthStart> {
    return this.http.json("POST", `/api/mcp/servers/${enc(serverId)}/oauth/start`);
  }

  /** Forget a server's OAuth credentials. */
  async signOutMcpServer(serverId: string): Promise<McpServerView> {
    return this.http.json("POST", `/api/mcp/servers/${enc(serverId)}/oauth/sign-out`);
  }

  /** The package environment of a local (stdio) server: approval, installation and image state. */
  async mcpServerEnvironment(serverId: string): Promise<DependencyStatus> {
    return this.http.json("GET", `/api/mcp/servers/${enc(serverId)}/environment`);
  }

  /** Resolve the hash-pinned package versions of a local server for review. */
  async planMcpServerEnvironment(serverId: string): Promise<DependencyPlan> {
    return this.http.json("POST", `/api/mcp/servers/${enc(serverId)}/environment/plan`);
  }

  /** Operational state for administrators: active calls, limits and each server's health (no secrets). */
  async mcpStats(): Promise<McpStats> {
    return this.http.json("GET", "/api/mcp/stats");
  }

  /** The audit log of the MCP configuration (never tokens or tool arguments). */
  async mcpEvents(limit = 100): Promise<McpEvent[]> {
    return this.http.json("GET", `/api/mcp/events?limit=${encodeURIComponent(String(limit))}`);
  }

  // ---- batches (one workflow over many inputs)

  /** The batches, newest first. */
  async listBatches(): Promise<BatchSummary[]> {
    return this.http.json("GET", "/api/batches");
  }

  /** One batch with its items (one per row: status, run id, error). */
  async getBatch(batchId: string): Promise<Batch> {
    return this.http.json("GET", `/api/batches/${enc(batchId)}`);
  }

  /**
   * The rows of a CSV, XLSX or JSON file (at most 10 MB, 1000 rows) and a suggested mapping of its columns to the
   * workflow's form; nothing starts. `filename` (its extension tells the format) defaults to the `File`'s name or
   * `rows.csv`.
   */
  async parseBatchFile(workflowId: string, file: Blob | Uint8Array | string, filename?: string): Promise<ParsedRows> {
    const blob = file instanceof Blob ? file : new Blob([typeof file === "string" ? file : new Uint8Array(file)]);
    const name = filename ?? (typeof File !== "undefined" && file instanceof File && file.name ? file.name : "rows.csv");
    const form = new FormData();
    form.append("file", blob, name);
    form.append("workflow_id", workflowId);
    return this.http.json("POST", "/api/batches/parse", { form });
  }

  /** Count the valid and invalid rows and estimate the cost; nothing starts. */
  async planBatch(batch: BatchIn): Promise<BatchPlan> {
    return this.http.json("POST", "/api/batches/plan", { body: batch });
  }

  /**
   * Start a batch: `{ workflow_id, rows: [{ values }, { input }, ...] }` with `concurrency`, `max_cost_usd`,
   * `max_failures`. A workflow with external tools needs `confirm_external`. Not retried automatically (it would
   * start the rows twice).
   */
  async createBatch(batch: BatchIn): Promise<Batch> {
    return this.http.json("POST", "/api/batches", { body: batch });
  }

  /** Start no further rows (running ones finish). */
  async pauseBatch(batchId: string): Promise<Batch> {
    return this.http.json("POST", `/api/batches/${enc(batchId)}/pause`);
  }

  async resumeBatch(batchId: string): Promise<Batch> {
    return this.http.json("POST", `/api/batches/${enc(batchId)}/resume`);
  }

  /** Cancel the batch and its running rows. */
  async cancelBatch(batchId: string): Promise<Batch> {
    return this.http.json("POST", `/api/batches/${enc(batchId)}/cancel`);
  }

  async deleteBatch(batchId: string): Promise<void> {
    await this.http.request("DELETE", `/api/batches/${enc(batchId)}`);
  }

  /** The results of all rows as a CSV (default) or JSON file. */
  async exportBatch(batchId: string, format: "csv" | "json" = "csv"): Promise<Uint8Array> {
    if (format !== "csv" && format !== "json") throw new TypeError(`format must be "csv" or "json", not ${JSON.stringify(format)}`);
    return this.http.bytes("GET", `/api/batches/${enc(batchId)}/export`, { query: { format } });
  }

  // ---- schedules (runs at set times)

  async listSchedules(): Promise<Schedule[]> {
    return this.http.json("GET", "/api/schedules");
  }

  async getSchedule(scheduleId: string): Promise<Schedule> {
    return this.http.json("GET", `/api/schedules/${enc(scheduleId)}`);
  }

  /** The IANA time zones a schedule can use. */
  async scheduleTimeZones(): Promise<string[]> {
    return this.http.json("GET", "/api/schedules/time-zones");
  }

  /**
   * Whether the schedule could be enabled (`ok`, `problems`, `notes`) and its next run times; `scheduleId` checks a
   * change of an existing schedule. Nothing is stored.
   */
  async previewSchedule(schedule: ScheduleIn, options: { scheduleId?: string } = {}): Promise<ScheduleActivation> {
    return this.http.json("POST", "/api/schedules/preview", { body: schedule, query: { schedule_id: options.scheduleId } });
  }

  /** Store a schedule (`kind` once/hourly/daily/weekly/monthly, `at`, `time_zone` ...); it is created disabled. */
  async createSchedule(schedule: ScheduleIn): Promise<Schedule> {
    return this.http.json("POST", "/api/schedules", { body: schedule });
  }

  /** Replace a schedule's settings (the whole `ScheduleIn`). */
  async updateSchedule(scheduleId: string, schedule: ScheduleIn): Promise<Schedule> {
    return this.http.json("PUT", `/api/schedules/${enc(scheduleId)}`, { body: schedule });
  }

  /** Enable a schedule; refused (`activation.problems`) when its workflow cannot run unattended. */
  async enableSchedule(scheduleId: string): Promise<ScheduleState> {
    return this.http.json("POST", `/api/schedules/${enc(scheduleId)}/enable`);
  }

  async disableSchedule(scheduleId: string): Promise<ScheduleState> {
    return this.http.json("POST", `/api/schedules/${enc(scheduleId)}/disable`);
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.http.request("DELETE", `/api/schedules/${enc(scheduleId)}`);
  }

  // ---- local models (Ollama) and the semantic knowledge index

  /**
   * The local model server's state, the catalog with what is installed, this computer's hardware and a
   * recommendation per task. A recommendation is a suggestion: store the chosen model explicitly.
   */
  async localModels(): Promise<LocalOverview> {
    return this.http.json("GET", "/api/local-models");
  }

  /** The local model for a task profile (`classify`, `write`, `analysis`, `embedding` ...). */
  async recommendLocalModel(task: string): Promise<Recommendation> {
    return this.http.json("GET", "/api/local-models/recommend", { query: { task } });
  }

  /** Start the managed local model server (desktop); a server's tenants get 403 `local.server_managed`. */
  async startLocalModels(): Promise<LocalStatus> {
    return this.http.json("POST", "/api/local-models/start");
  }

  async stopLocalModels(): Promise<LocalStatus> {
    return this.http.json("POST", "/api/local-models/stop");
  }

  /**
   * Install the pinned, SHA-256-verified Ollama runtime from a release archive on the Nodestro computer, or download
   * it (refused in the strict offline mode). Follow the job with {@link localModelJob}.
   */
  async installLocalRuntime(source: { archive?: string; download?: boolean }): Promise<LocalJob> {
    return this.http.json("POST", "/api/local-models/runtime", { body: source });
  }

  /** Download a model (e.g. `qwen3.5:4b`); needs the internet. */
  async pullLocalModel(model: string): Promise<LocalJob> {
    return this.http.json("POST", "/api/local-models/pull", { body: { model } });
  }

  /**
   * Import offline: an offline model package (checked by SHA-256; `models` picks some of its models) or a GGUF file
   * (`name` the model to create, `projector` an optional vision projector). Paths name files on the computer that runs
   * Nodestro.
   */
  async importLocalModel(request: LocalImport): Promise<LocalJob> {
    return this.http.json("POST", "/api/local-models/import", { body: request });
  }

  async deleteLocalModel(name: string): Promise<void> {
    await this.http.request("DELETE", `/api/local-models/models/${enc(name)}`);
  }

  /** A job's progress (`completed` of `total`) and outcome. */
  async localModelJob(jobId: string): Promise<LocalJob> {
    return this.http.json("GET", `/api/local-models/jobs/${enc(jobId)}`);
  }

  async cancelLocalModelJob(jobId: string): Promise<LocalJob> {
    return this.http.json("POST", `/api/local-models/jobs/${enc(jobId)}/cancel`);
  }

  /** The semantic knowledge index: retrieval mode, embedding model, state and how many chunks are embedded. */
  async knowledgeIndex(): Promise<KnowledgeIndexStatus> {
    return this.http.json("GET", "/api/knowledge/index");
  }

  /**
   * Build or rebuild the semantic index (default: the embedding model of the settings). Searches keep the complete
   * current index until the new one is finished; a cancelled rebuild continues where it stopped.
   */
  async rebuildKnowledgeIndex(model?: string): Promise<KnowledgeIndexStatus> {
    return this.http.json("POST", "/api/knowledge/index/rebuild", { body: { model: model ?? null } });
  }

  async cancelKnowledgeIndex(): Promise<KnowledgeIndexStatus> {
    return this.http.json("POST", "/api/knowledge/index/cancel");
  }

  async listExamples(language?: string): Promise<TemplateSummary[]> {
    return this.http.json("GET", "/api/library", { query: { language } });
  }

  /** Copy an example into a new workflow (`tests` also copies its test cases). */
  async copyExample(templateId: string, options: { language?: string; tests?: boolean } = {}): Promise<Workflow> {
    const body = { language: options.language ?? null, tests: options.tests ?? false };
    return this.http.json("POST", `/api/library/${enc(templateId)}/copy`, { body });
  }

  /** The shipped agent templates (NAL-B1); reading stores nothing. */
  async listLibraryAgents(language?: string): Promise<LibraryAgentSummary[]> {
    return this.http.json("GET", "/api/library/agents", { query: { language } });
  }

  async getLibraryAgent(agentId: string, language?: string): Promise<LibraryAgentDetail> {
    return this.http.json("GET", `/api/library/agents/${enc(agentId)}`, { query: { language } });
  }

  /** Store a shipped agent template as an own template (`services`: connection id per kind it needs). */
  async copyLibraryAgent(
    agentId: string,
    options: { language?: string; model?: string; services?: Record<string, string> } = {},
  ): Promise<AgentTemplate> {
    const body = { language: options.language ?? null, model: options.model ?? null, services: options.services ?? {} };
    return this.http.json("POST", `/api/library/agents/${enc(agentId)}/copy`, { body });
  }

  // ---- skills (NAL-B3)

  /** The skill library: every skill in its latest version. */
  async listSkills(): Promise<Skill[]> {
    return this.http.json("GET", "/api/skills");
  }

  /** A skill in its latest version (or `version`): instructions, files and findings. */
  async getSkill(skillId: string, version?: number): Promise<SkillDetail> {
    return this.http.json("GET", `/api/skills/${enc(skillId)}`, { query: { version } });
  }

  /** Every version of a skill, newest first. */
  async listSkillVersions(skillId: string): Promise<SkillVersion[]> {
    return this.http.json("GET", `/api/skills/${enc(skillId)}/versions`);
  }

  async readSkillFile(skillId: string, version: number, path: string): Promise<SkillFileText> {
    return this.http.json("GET", `/api/skills/${enc(skillId)}/versions/${enc(String(version))}/file`, {
      query: { path },
    });
  }

  /**
   * Import a skill ZIP or a `SKILL.md` (at most 10 MB). `dryRun` only checks it (validation report and preview);
   * `skillId` stores it as the next version of that skill. Errors refuse it, warnings do not.
   */
  async importSkill(
    file: Blob | Uint8Array | string,
    options: { filename?: string; dryRun?: boolean; skillId?: string } = {},
  ): Promise<SkillImportResult> {
    const blob = file instanceof Blob ? file : new Blob([typeof file === "string" ? file : new Uint8Array(file)]);
    const named = typeof File !== "undefined" && file instanceof File && file.name ? file.name : "skill.zip";
    const form = new FormData();
    form.append("file", blob, options.filename ?? named);
    form.append("dry_run", options.dryRun ? "true" : "false");
    if (options.skillId !== undefined) form.append("skill_id", options.skillId);
    return this.http.json("POST", "/api/skills/import", { form });
  }

  /** A new skill from its files (`SKILL.md` required). */
  async createSkill(files: SkillFiles, note = ""): Promise<Skill> {
    return this.http.json("POST", "/api/skills", { body: skillBody(files, note) });
  }

  /** Store changed files as the next version; `null` keeps a file of the latest version. */
  async updateSkill(skillId: string, files: SkillFiles, note = ""): Promise<Skill> {
    return this.http.json("PUT", `/api/skills/${enc(skillId)}`, { body: skillBody(files, note) });
  }

  /** The findings for a package without storing it. */
  async checkSkill(files: SkillFiles, skillId?: string): Promise<SkillCheck> {
    return this.http.json("POST", "/api/skills/check", { query: { skill_id: skillId }, body: skillBody(files, "") });
  }

  /** A skill version as a standard Agent Skills ZIP. */
  async exportSkill(skillId: string, version?: number): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/skills/${enc(skillId)}/export`, { query: { version } });
  }

  async copySkill(skillId: string, name: string): Promise<Skill> {
    return this.http.json("POST", `/api/skills/${enc(skillId)}/copy`, { body: { name } });
  }

  async setSkillStatus(skillId: string, status: "active" | "disabled"): Promise<Skill> {
    return this.http.json("POST", `/api/skills/${enc(skillId)}/status`, { body: { status } });
  }

  /** Archive a skill (`admin`): it can no longer run or be assigned. */
  async archiveSkill(skillId: string): Promise<Skill> {
    return this.http.json("POST", `/api/skills/${enc(skillId)}/archive`);
  }

  /** Delete a skill (`admin`); refused with `skill.in_use` while an agent uses it. */
  async deleteSkill(skillId: string): Promise<void> {
    await this.http.request("DELETE", `/api/skills/${enc(skillId)}`);
  }

  async skillUsage(skillId: string): Promise<SkillUser[]> {
    return this.http.json("GET", `/api/skills/${enc(skillId)}/usage`);
  }

  /** The shipped skills in one language (English where one is missing). */
  async listLibrarySkills(language?: string): Promise<LibrarySkill[]> {
    return this.http.json("GET", "/api/library/skills", { query: { language } });
  }

  async getLibrarySkill(name: string): Promise<LibrarySkillDetail> {
    return this.http.json("GET", `/api/library/skills/${enc(name)}`);
  }

  /** Store a shipped skill as a skill of the workspace (origin `builtin:...`). */
  async copyLibrarySkill(name: string): Promise<Skill> {
    return this.http.json("POST", `/api/library/skills/${enc(name)}/copy`);
  }

  /** The building blocks (parts) templates run as teams or sub-workflows, as gallery entries. */
  async listLibraryParts(language?: string): Promise<PartSummary[]> {
    return this.http.json("GET", "/api/library/parts", { query: { language } });
  }

  /** One building block with the workflow a copy would get. */
  async getLibraryPart(partId: string, language?: string): Promise<PartDetail> {
    return this.http.json("GET", `/api/library/parts/${enc(partId)}`, { query: { language } });
  }

  /** Create an ordinary workflow from a building block (the parts it runs are saved first). */
  async copyLibraryPart(partId: string, language?: string): Promise<Workflow> {
    return this.http.json("POST", `/api/library/parts/${enc(partId)}/copy`, { body: { language } });
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

  /**
   * Publish the workflow as an API (options: `slug`, `note`, `version`, `activate`, `gate` to switch the release gate
   * on with this release, `override: { reason }` to release although non-critical gate items failed).
   */
  async publish(workflowId: string, options: Partial<PublishIn> = {}): Promise<PublishOut> {
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/api/publish`, { body: options });
  }

  /** What the release gate says about a saved version (`gate`: try one before switching it on). */
  async releaseGate(workflowId: string, options: { version?: number | null; gate?: ReleaseGateIn | null } = {}): Promise<GateReport> {
    return this.http.json("POST", `/api/workflows/${enc(workflowId)}/api/gate`, { body: options });
  }

  /**
   * Change a publication's slug, description, network access, limits or `mcp_tool` (offer the API as a tool of
   * Nodestro's MCP server; it answers only when the operator switched the server on).
   */
  async updatePublication(publicationId: string, patch: PublicationPatch): Promise<Publication> {
    return this.http.json("PATCH", `/api/publications/${enc(publicationId)}`, { body: patch });
  }

  /** Switch the release gate of a publication on, change it, or switch it off (`null`). */
  async setReleaseGate(publicationId: string, gate: ReleaseGateIn | null): Promise<Publication> {
    return this.http.json("PUT", `/api/publications/${enc(publicationId)}/gate`, { body: { gate } });
  }

  /** A key for published workflows; its `token` is returned only this once. `publications` are publication ids. */
  async createApiKey(name: string, scopes: KeyIn["scopes"], publications: string[]): Promise<NewApiKey> {
    const body: KeyIn = { name, scopes, publications };
    return this.http.json("POST", "/api/api-keys", { body });
  }

  /** Every key for published workflows (never its token: only a hash is stored). */
  async listApiKeys(): Promise<ApiKey[]> {
    return this.http.json("GET", "/api/api-keys");
  }

  /** Revoke a key at once; it stays listed as revoked. */
  async revokeApiKey(keyId: string): Promise<ApiKey> {
    return this.http.json("POST", `/api/api-keys/${enc(keyId)}/revoke`);
  }

  /** A new key with the same name, permissions and publications; the old one is revoked in the same step. */
  async rotateApiKey(keyId: string): Promise<NewApiKey> {
    return this.http.json("POST", `/api/api-keys/${enc(keyId)}/rotate`);
  }

  /** Delete a key (revoked or not) from the list. */
  async deleteApiKey(keyId: string): Promise<void> {
    await this.http.request("DELETE", `/api/api-keys/${enc(keyId)}`);
  }

  /** Every published workflow API of the installation. */
  async listPublications(): Promise<Publication[]> {
    return this.http.json("GET", "/api/publications");
  }

  /**
   * Take a workflow's API offline and delete its publication with its releases (keys lose it); refused with
   * `api.runs_active` while runs of the API have not finished.
   */
  async deletePublication(publicationId: string): Promise<void> {
    await this.http.request("DELETE", `/api/publications/${enc(publicationId)}`);
  }

  // ---- test series (a workflow against saved test cases)

  /** The test series (suites of test cases), most recently changed first. */
  async listTestSeries(): Promise<Suite[]> {
    return this.http.json("GET", "/api/benchmarks");
  }

  async getTestSeries(suiteId: string): Promise<Suite> {
    return this.http.json("GET", `/api/benchmarks/${enc(suiteId)}`);
  }

  /** Save a test series: `{ workflow_id, name, cases: [{ input, checks }] }`. */
  async createTestSeries(suite: SuiteIn): Promise<Suite> {
    return this.http.json("POST", "/api/benchmarks", { body: suite });
  }

  async updateTestSeries(suiteId: string, suite: SuiteIn): Promise<Suite> {
    return this.http.json("PUT", `/api/benchmarks/${enc(suiteId)}`, { body: suite });
  }

  async deleteTestSeries(suiteId: string): Promise<void> {
    await this.http.request("DELETE", `/api/benchmarks/${enc(suiteId)}`);
  }

  /** What a test run would do and cost (cases, judged cases, estimate, problems); nothing starts. */
  async planTestRun(suiteId: string, start: BenchmarkStart = {}): Promise<BenchmarkPlan> {
    return this.http.json("POST", `/api/benchmarks/${enc(suiteId)}/plan`, { body: start });
  }

  /**
   * Run every case of a test series (`judge`, `concurrency`, `max_cost_usd`, `max_failures`, `version`, `models`).
   * Not retried automatically (it would run the cases twice).
   */
  async startTestRun(suiteId: string, start: BenchmarkStart = {}): Promise<BenchmarkRun> {
    return this.http.json("POST", `/api/benchmarks/${enc(suiteId)}/runs`, { body: start });
  }

  /** The test runs of a series, newest first. */
  async listTestRuns(suiteId: string): Promise<BenchmarkRun[]> {
    return this.http.json("GET", `/api/benchmarks/${enc(suiteId)}/runs`);
  }

  async getTestRun(runId: string): Promise<BenchmarkRun> {
    return this.http.json("GET", `/api/benchmark-runs/${enc(runId)}`);
  }

  /** Poll a test run until it is no longer `running` or `evaluating` ({@link NodestroTimeoutError} after `timeoutMs`). */
  async waitForTestRun(runId: string, options: WaitOptions = {}): Promise<BenchmarkRun> {
    return pollUntil(
      () => this.getTestRun(runId),
      (found) => found.status !== "running" && found.status !== "evaluating",
      runId,
      { timeoutMs: options.timeoutMs ?? 600_000, pollMs: options.pollMs ?? 1000, signal: options.signal },
    );
  }

  async cancelTestRun(runId: string): Promise<BenchmarkRun> {
    return this.http.json("POST", `/api/benchmark-runs/${enc(runId)}/cancel`);
  }

  async deleteTestRun(runId: string): Promise<void> {
    await this.http.request("DELETE", `/api/benchmark-runs/${enc(runId)}`);
  }

  /** Two test runs of a series case by case (for example two workflow versions). */
  async compareTestRuns(a: string, b: string): Promise<Comparison> {
    return this.http.json("GET", "/api/benchmark-runs/compare", { query: { a, b } });
  }

  /** The model one agent should use by the series' measured test runs and a policy; nothing changes. */
  async testSeriesModelChoice(
    suiteId: string,
    nodeId: string,
    policy: { objective?: string; minPassRate?: number; noNewFailures?: boolean } = {},
  ): Promise<ModelChoice> {
    const query = {
      node_id: nodeId,
      objective: policy.objective ?? "cost",
      min_pass_rate: policy.minPassRate,
      no_new_failures: policy.noNewFailures ?? true,
    };
    return this.http.json("GET", `/api/benchmarks/${enc(suiteId)}/model-choice`, { query });
  }

  /**
   * A redacted test case from the input of a failed run (credentials always replaced; `personal_data` replaces
   * e-mail addresses, phone numbers and the like too); nothing is stored.
   */
  async proposeTestCase(runId: string, request: CaseProposalIn = {}): Promise<CaseProposal> {
    return this.http.json("POST", `/api/runs/${enc(runId)}/test-case`, { body: request });
  }

  // ---- knowledge files and search

  /** The knowledge files (`query` filters by name and description). */
  async listKnowledge(query?: string): Promise<KnowledgeFile[]> {
    return this.http.json("GET", "/api/knowledge", { query: { q: query || undefined } });
  }

  /** Add files to the knowledge base (the extension of the name tells the format). Not retried automatically. */
  async uploadKnowledge(
    files: UploadFile[],
    options: { description?: string; collection?: string } = {},
  ): Promise<KnowledgeFile[]> {
    const form = uploadForm(files);
    form.append("description", options.description ?? "");
    form.append("collection", options.collection ?? "");
    return this.http.json("POST", "/api/knowledge", { form });
  }

  /** Change a knowledge file's description and (when given) its collection. */
  async updateKnowledge(fileId: string, change: { description: string; collection?: string }): Promise<KnowledgeFile> {
    return this.http.json("PATCH", `/api/knowledge/${enc(fileId)}`, { body: change });
  }

  async deleteKnowledge(fileId: string): Promise<void> {
    await this.http.request("DELETE", `/api/knowledge/${enc(fileId)}`);
  }

  /** The stored file itself. */
  async knowledgeContent(fileId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/knowledge/${enc(fileId)}/content`);
  }

  async knowledgeCollections(): Promise<CollectionInfo[]> {
    return this.http.json("GET", "/api/knowledge/collections");
  }

  /**
   * Search the knowledge base (`k` 1 to 50 hits; `mode` full text, semantic or both, default the workspace's
   * setting; a mode that is not available is an error, never a silent fallback).
   */
  async searchKnowledge(
    query: string,
    options: { fileIds?: string[]; k?: number; mode?: "fts" | "vector" | "hybrid" } = {},
  ): Promise<SearchHit[]> {
    const params = {
      q: query,
      k: options.k ?? 8,
      file_ids: options.fileIds?.length ? options.fileIds.join(",") : undefined,
      mode: options.mode,
    };
    return this.http.json("GET", "/api/knowledge/search", { query: params });
  }

  // ---- input files (uploads for runs)

  /** How many input files there are and how much they take (in use by runs or not). */
  async inputStorage(): Promise<StorageInfo> {
    return this.http.json("GET", "/api/inputs");
  }

  /** The file formats Nodestro reads, by group, and the size limits. */
  async inputFormats(): Promise<FormatsInfo> {
    return this.http.json("GET", "/api/inputs/formats");
  }

  /**
   * Upload files for a run (`fileIds` of {@link startRun}). Each result has the stored `file` or a `problem` (refused
   * format or size; the others are stored). `accept` narrows the formats like a form field's (`.pdf,.docx`). Not
   * retried automatically.
   */
  async uploadInputs(files: UploadFile[], options: { accept?: string; maxSizeMb?: number } = {}): Promise<UploadResult[]> {
    const form = uploadForm(files);
    form.append("accept", options.accept ?? "");
    form.append("origin", "sdk");
    if (options.maxSizeMb !== undefined) form.append("max_size_mb", String(options.maxSizeMb));
    return this.http.json("POST", "/api/inputs", { form });
  }

  async getInput(fileId: string): Promise<InputFile> {
    return this.http.json("GET", `/api/inputs/${enc(fileId)}`);
  }

  /** What Nodestro read from a file (or, with `path`, from one file of an archive): the text agents get. */
  async inputText(fileId: string, path = ""): Promise<FileText> {
    return this.http.json("GET", `/api/inputs/${enc(fileId)}/text`, { query: { path: path || undefined } });
  }

  /** The uploaded file itself. */
  async inputContent(fileId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/inputs/${enc(fileId)}/content`);
  }

  async deleteInput(fileId: string): Promise<void> {
    await this.http.request("DELETE", `/api/inputs/${enc(fileId)}`);
  }

  /** Remove input files no run uses (`olderThanDays`: also the files of finished runs older than that). */
  async cleanUpInputs(olderThanDays?: number): Promise<InputCleanupResult> {
    const body = olderThanDays === undefined ? {} : { older_than_days: olderThanDays };
    return this.http.json("POST", "/api/inputs/cleanup", { body });
  }

  // ---- per-call tool approvals (only while the installation switched them on)

  /**
   * The open questions of runs paused at a tool call. Empty while `NODESTRO_TOOL_APPROVALS` is off (the default);
   * the SDK never switches it on.
   */
  async listToolApprovals(): Promise<ToolApprovalRequest[]> {
    return this.http.json("GET", "/api/tool-approvals");
  }

  /** Every tool approval question of one run, open or decided. */
  async runToolApprovals(runId: string): Promise<ToolApprovalRequest[]> {
    return this.http.json("GET", `/api/runs/${enc(runId)}/tool-approvals`);
  }

  /**
   * Approve or reject one tool call. `argumentsHash` is the question's own: a decision about other arguments than
   * the ones shown is refused.
   */
  async decideToolApproval(
    runId: string,
    requestId: string,
    decision: "approved" | "rejected",
    options: { argumentsHash: string; comment?: string },
  ): Promise<ToolApprovalRequest> {
    if (decision !== "approved" && decision !== "rejected") {
      throw new TypeError(`decision must be "approved" or "rejected", not ${JSON.stringify(decision)}`);
    }
    const body = { decision, arguments_hash: options.argumentsHash, comment: options.comment ?? "" };
    return this.http.json("POST", `/api/runs/${enc(runId)}/tool-approvals/${enc(requestId)}`, { body });
  }

  /** The audit trail of tool approval questions and decisions, newest first. */
  async toolApprovalAudit(limit = 200): Promise<ToolApprovalEvent[]> {
    return this.http.json("GET", "/api/tool-approvals/audit", { query: { limit } });
  }

  // ---- exports of published workflows

  /**
   * What an export of a publication's release (`number`, default the active one) would contain and what keeps it
   * from being built (`ok`, `problems`); nothing is written.
   */
  async checkExport(publicationId: string, options: ExportOptions = {}, number?: number): Promise<ExportCheck> {
    return this.http.json("POST", `/api/publications/${enc(publicationId)}/export/check`, { body: exportBody(options, number) });
  }

  /** Export a release as a standalone project (`kind` `standard`, the default); portable packages are export jobs. */
  async createExport(publicationId: string, options: ExportOptions = {}, number?: number): Promise<ExportRecord> {
    return this.http.json("POST", `/api/publications/${enc(publicationId)}/exports`, { body: exportBody(options, number) });
  }

  /** The stored exports of a publication, newest first. */
  async listExports(publicationId: string): Promise<ExportRecord[]> {
    return this.http.json("GET", `/api/publications/${enc(publicationId)}/exports`);
  }

  /** The ZIP of an export in memory (a portable package can be gigabytes: see {@link streamExport}). */
  async downloadExport(exportId: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/api/exports/${enc(exportId)}/download`);
  }

  /** The ZIP of an export as a `ReadableStream` (as {@link streamFile}). */
  async streamExport(exportId: string, options: DownloadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    return this.http.download(`/api/exports/${enc(exportId)}/download`, options);
  }

  /** Delete an export and its ZIP (on a server this frees the workspace's export quota). */
  async deleteExport(exportId: string): Promise<void> {
    await this.http.request("DELETE", `/api/exports/${enc(exportId)}`);
  }

  /**
   * Build a portable package in the background (`kind` must be `portable`); follow it with {@link getExportJob} or
   * {@link waitForExportJob}. Not retried automatically.
   */
  async startExportJob(publicationId: string, options: ExportOptions, number?: number): Promise<ExportJob> {
    return this.http.json("POST", `/api/publications/${enc(publicationId)}/export-jobs`, { body: exportBody(options, number) });
  }

  async listExportJobs(publicationId: string): Promise<ExportJob[]> {
    return this.http.json("GET", `/api/publications/${enc(publicationId)}/export-jobs`);
  }

  async getExportJob(jobId: string): Promise<ExportJob> {
    return this.http.json("GET", `/api/export-jobs/${enc(jobId)}`);
  }

  async cancelExportJob(jobId: string): Promise<ExportJob> {
    return this.http.json("POST", `/api/export-jobs/${enc(jobId)}/cancel`);
  }

  /** Poll an export job until it is no longer `running` ({@link NodestroTimeoutError} after `timeoutMs`). */
  async waitForExportJob(jobId: string, options: WaitOptions = {}): Promise<ExportJob> {
    const job = await pollUntil(
      async () => {
        const found = await this.getExportJob(jobId);
        return { ...found, status: found.state };
      },
      (found) => found.state !== "running",
      jobId,
      { timeoutMs: options.timeoutMs ?? 3_600_000, pollMs: options.pollMs ?? 2000, signal: options.signal },
    );
    const { status: _status, ...rest } = job;
    return rest as ExportJob;
  }
}

/** One path segment (see {@link pathSegment}). */
export const enc = pathSegment;

/** A model id as the path tail of a price route: its `/`-separated parts, each one a checked path segment. */
function modelPath(model: string): string {
  return model.split("/").map(pathSegment).join("/");
}

/** A USD amount as the decimal string the API expects; numbers are refused so that no amount is rounded. */
function amount(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`limitUsd must be a decimal string, not ${typeof value}`);
  return value;
}

/** The body of a skill save: text files as `text`, bytes as `base64`, `null` as `keep`. */
function skillBody(files: SkillFiles, note: string): { files: Record<string, unknown>[]; note: string } {
  const entries = Object.entries(files).map(([path, value]) => {
    if (value === null) return { path, keep: true };
    if (typeof value === "string") return { path, text: value };
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { path, base64: btoa(binary) };
  });
  return { files: entries, note };
}

/** A multipart form with each file as `files`. */
function uploadForm(files: UploadFile[]): FormData {
  if (!Array.isArray(files) || files.length === 0) throw new TypeError("files must name at least one file");
  const form = new FormData();
  for (const file of files) {
    if (file instanceof Blob) {
      const name = typeof File !== "undefined" && file instanceof File && file.name ? file.name : "file";
      form.append("files", file, name);
    } else {
      const content = typeof file.content === "string" ? file.content : new Uint8Array(file.content);
      form.append("files", new Blob([content]), file.name);
    }
  }
  return form;
}

function exportBody(options: ExportOptions, number?: number): { options: ExportOptions; number?: number } {
  return number === undefined ? { options } : { options, number };
}
