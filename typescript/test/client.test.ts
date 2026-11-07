/**
 * The TypeScript SDK against a real Nodestro API server with scripted model answers. German values
 * (inputs, labels, template names, the scripted answers) are deliberate test data: Nodestro is
 * multilingual, and the assertions look for them.
 */

import { type AddressInfo, type Socket, connect, createServer as createNetServer } from "node:net";
import { describe, expect, inject, it } from "vitest";
import { API_VERSION, NodestroAPIError, NodestroClient, NodestroRunFailed, PublishedWorkflow, type ServerEvent, compatibility } from "../src/index.js";

const server = inject("server");
const nodestro = new NodestroClient(server, { timeoutMs: 10_000 });
const fast = { timeoutMs: 30_000, pollMs: 100 };

const agent = (id: string, prompt: string) => ({
  id,
  type: "agent",
  label: id,
  agent: { name: id, system_prompt: prompt },
});
const edge = (source: string, target: string, handle: string | null = null) => ({
  id: `${source}-${target}`,
  source,
  target,
  source_handle: handle,
});
const simple = (prompt = "WRITER") => ({
  name: `SDK ${prompt}`,
  nodes: [{ id: "start", type: "start" }, agent("writer", prompt), { id: "out", type: "output" }],
  edges: [edge("start", "writer"), edge("writer", "out")],
});

async function collect(events: AsyncGenerator<ServerEvent>): Promise<ServerEvent[]> {
  const found: ServerEvent[] = [];
  for await (const event of events) found.push(event);
  return found;
}

describe("studio API", () => {
  it("reports its version and providers", async () => {
    const meta = await nodestro.meta();
    expect(meta.version).toBeTruthy();
    expect(meta.providers.map((item) => item.id)).toEqual(expect.arrayContaining(["anthropic", "openai", "gemini"]));
    const settings = await nodestro.settings();
    expect(JSON.stringify(settings)).not.toMatch(/sk-[a-z0-9]/i);
    const changed = await nodestro.updateSettings({ default_budget_usd: 7.5 });
    expect(changed.default_budget_usd).toBe(7.5);
    expect(changed.default_model).toBe(settings.default_model);
  });

  it("lists local models and the semantic index", async () => {
    const overview = await nodestro.localModels();
    expect(overview.catalog[0]?.name).toBe("qwen3.5:4b");
    expect((await nodestro.recommendLocalModel("embedding")).model).toBe("ollama:qwen3-embedding:0.6b");
    const refused = await nodestro.recommendLocalModel("dance").catch((error: unknown) => error);
    expect((refused as NodestroAPIError).code).toBe("local.task_unknown");
    const index = await nodestro.knowledgeIndex();
    expect([index.state, index.mode]).toEqual(["off", "fts"]);
  });

  it("reports the Docker sandbox and runs its self-test", async () => {
    const states = ["approved", "unavailable", "checking"];
    const status = await nodestro.sandboxStatus();
    expect(status.name).toBe("docker");
    expect(states).toContain(status.state);
    expect((await nodestro.sandboxStatus({ refresh: true, wait: 1 })).name).toBe("docker");
    const tested = await nodestro.sandboxSelfTest({ timeout: 5 });
    expect(states).toContain(tested.state);
    for (const check of tested.checks ?? []) expect(typeof check.name).toBe("string");
  });

  it("runs a workflow and returns its result", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    expect((await nodestro.listWorkflows()).map((item) => item.id)).toContain(workflow.id);
    const run = await nodestro.startRun(workflow.id, { input: "Angebot für ACME" });
    const done = await nodestro.waitForRun(run.id, fast);
    expect(done.status).toBe("succeeded");
    expect(JSON.stringify(done.output)).toContain("Wir liefern");
    expect((await nodestro.listRuns({ workflowId: workflow.id })).map((item) => item.id)).toContain(run.id);
  });

  it("starts a run once per idempotency key (API2-08)", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const first = await nodestro.startRun(workflow.id, { input: "x", idempotencyKey: "ts-order-1" });
    const again = await nodestro.startRun(workflow.id, { input: "x", idempotencyKey: "ts-order-1" });
    expect(again.id).toBe(first.id);
    const conflict = await nodestro.startRun(workflow.id, { input: "y", idempotencyKey: "ts-order-1" }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(NodestroAPIError);
    expect((conflict as NodestroAPIError).status).toBe(409);
    expect((conflict as NodestroAPIError).code).toBe("idempotency.conflict");
    await nodestro.waitForRun(first.id, fast);
  });

  it("manages keys and publications (DX-25)", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const { publication } = await nodestro.publish(workflow.id, { slug: "ts-managed" });
    expect((await nodestro.listPublications()).map((item) => item.id)).toContain(publication.id);
    const key = await nodestro.createApiKey("TS managed", ["read"], [publication.id]);
    expect((await nodestro.listApiKeys()).map((item) => item.id)).toContain(key.key.id);
    const rotated = await nodestro.rotateApiKey(key.key.id);
    expect(rotated.token).not.toBe(key.token);
    const old = new PublishedWorkflow(server, "ts-managed", { apiKey: key.token });
    const refused = await old.info().catch((error: unknown) => error);
    expect((refused as NodestroAPIError).status).toBe(401);
    expect((await new PublishedWorkflow(server, "ts-managed", { apiKey: rotated.token }).info()).publication).toBe("ts-managed");
    expect((await nodestro.revokeApiKey(rotated.key.id)).id).toBe(rotated.key.id);
    await nodestro.deleteApiKey(rotated.key.id);
    expect((await nodestro.listApiKeys()).map((item) => item.id)).not.toContain(rotated.key.id);
    await nodestro.deletePublication(publication.id);
    expect((await nodestro.listPublications()).map((item) => item.id)).not.toContain(publication.id);
  });

  it("streams the events of a run", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const run = await nodestro.startRun(workflow.id, { input: "x" });
    const names = (await collect(nodestro.events(run.id))).map((event) => event.event);
    expect(names[0]).toBe("snapshot");
    expect(names.at(-1)).toBe("end");
  });

  it("cancels a running run", async () => {
    const workflow = await nodestro.createWorkflow(simple("SLOW"));
    const run = await nodestro.startRun(workflow.id, { input: "x" });
    expect(await nodestro.cancelRun(run.id)).toBe(true);
    expect((await nodestro.waitForRun(run.id, fast)).status).toBe("cancelled");
    await expect(nodestro.waitForRun(run.id, { raiseOnFailure: true })).rejects.toBeInstanceOf(NodestroRunFailed);
  });

  it("waits for a person to approve", async () => {
    const workflow = await nodestro.createWorkflow({
      name: "SDK approval",
      nodes: [
        { id: "start", type: "start" },
        agent("writer", "WRITER"),
        { id: "check", type: "approval", label: "Prüfen", approval: { instructions: "Ok?" } },
        { id: "out", type: "output" },
      ],
      edges: [edge("start", "writer"), edge("writer", "check"), edge("check", "out", "approved")],
    });
    const run = await nodestro.startRun(workflow.id, { input: "x" });
    expect((await nodestro.waitForRun(run.id, fast)).status).toBe("paused");
    const pending = (await nodestro.listApprovals()).filter((item) => item.run_id === run.id);
    expect(pending.map((item) => item.node_id)).toEqual(["check"]);
    await nodestro.decideApproval(run.id, "check", "approved", "passt");
    expect((await nodestro.waitForRun(run.id, fast)).status).toBe("succeeded");
  });

  it("continues a failed run", async () => {
    const workflow = await nodestro.createWorkflow({
      name: "SDK resume",
      nodes: [{ id: "start", type: "start" }, agent("first", "WRITER"), agent("second", "BROKEN")],
      edges: [edge("start", "first"), edge("first", "second")],
    });
    const failed = await nodestro.waitForRun((await nodestro.startRun(workflow.id, { input: "x" })).id, fast);
    expect(failed.status).toBe("failed");
    expect((await nodestro.resumePlan(failed.id)).possible).toBe(true);
    const continued = await nodestro.resumeRun(failed.id);
    const done = await nodestro.waitForRun(continued.id, fast);
    expect(done.status).toBe("succeeded");
    expect(done.resumed_from).toBe(failed.id);
  });

  it("validates agents and keeps agent templates", async () => {
    const issues = await nodestro.validateAgent({ name: "A", system_prompt: "x", tools: ["no_such_tool"] });
    expect(issues.length).toBeGreaterThan(0);
    const created = await nodestro.createAgentTemplate({ name: "SDK-Vorlage", agent: { name: "Prüfer", system_prompt: "Prüfe." } });
    expect((await nodestro.listAgentTemplates()).map((item) => item.id)).toContain(created.id);
    await nodestro.deleteAgentTemplate(created.id);
    expect((await nodestro.listAgentTemplates()).map((item) => item.id)).not.toContain(created.id);
    expect((await nodestro.listTools()).map((tool) => tool.name)).toEqual(expect.arrayContaining(["calculator", "current_datetime"]));
  });

  it("lists and copies the 24 examples", async () => {
    const examples = await nodestro.listExamples("en");
    expect(examples).toHaveLength(24);
    const copy = await nodestro.copyExample(examples[0]!.id, { language: "de" });
    expect(copy.id.startsWith("wf_")).toBe(true);
  });

  it("raises errors with status, code and params", async () => {
    const missing = await nodestro.getRun("run_does_not_exist").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(NodestroAPIError);
    expect((missing as NodestroAPIError).status).toBe(404);
    expect((missing as NodestroAPIError).code).toBe("run.not_found");
    const empty = await nodestro.createWorkflow({ name: "leer", nodes: [], edges: [] });
    const refused = await nodestro.startRun(empty.id, { input: "x" }).catch((error: unknown) => error);
    expect((refused as NodestroAPIError).status).toBe(400);
  });
});

describe("published workflow API", () => {
  it("starts idempotently, waits for the result and refuses a wrong key", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const published = await nodestro.publish(workflow.id, { slug: "sdk-ts-angebot" });
    const publication = published.publication as { id: string; slug: string };
    const key = await nodestro.createApiKey("SDK TS", ["run", "read", "approve"], [publication.id]);
    const api = new PublishedWorkflow(server, publication.slug, { apiKey: key.token });
    const info = await api.info();
    expect(info.publication).toBe("sdk-ts-angebot");
    const first = await api.start({ input: "ACME" }, { idempotencyKey: "sdk-ts-1" });
    const again = await api.start({ input: "ACME" }, { idempotencyKey: "sdk-ts-1" });
    expect(again.run_id).toBe(first.run_id);
    const result = await api.waitForResult(first.run_id, fast);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result.output)).toContain("Wir liefern");
    expect((await collect(api.events(first.run_id))).length).toBeGreaterThan(0);
    expect((await api.usage()).runs).toBeGreaterThanOrEqual(1);
    expect((await api.runs()).map((item) => item.run_id)).toContain(first.run_id);
    const wrong = new PublishedWorkflow(server, publication.slug, { apiKey: "ndk_wrong_key" });
    const denied = (await wrong.info().catch((error: unknown) => error)) as NodestroAPIError;
    expect(denied.status).toBe(401);
    expect(denied.code.startsWith("auth.")).toBe(true);
  });

  it("starts a form with its values, as the README shows", async () => {
    const form = { fields: [{ name: "customer", label: "Customer", type: "text", required: true }] };
    const workflow = await nodestro.createWorkflow({
      ...simple(),
      nodes: [{ id: "start", type: "start", start: form }, ...simple().nodes.slice(1)],
    });
    const published = await nodestro.publish(workflow.id, { slug: "sdk-ts-form" });
    const publication = published.publication as { id: string; slug: string };
    const offered = await nodestro.updatePublication(publication.id, { mcp_tool: true });
    expect(offered.mcp_tool).toBe(true);
    const key = await nodestro.createApiKey("SDK TS form", ["run", "read"], [publication.id]);
    const api = new PublishedWorkflow(server, publication.slug, { apiKey: key.token });
    const refused = (await api.start({ customer: "ACME" }).catch((error: unknown) => error)) as NodestroAPIError;
    expect([refused.status, refused.code]).toEqual([422, "request.invalid"]);
    const started = await api.start({ values: { customer: "ACME" } });
    expect((await api.waitForResult(started.run_id, fast)).status).toBe("succeeded");
  });
});

const approvalWorkflow = (name: string) => ({
  name,
  nodes: [
    { id: "start", type: "start" },
    agent("writer", "WRITER"),
    { id: "check", type: "approval", label: "Prüfen", approval: { instructions: "Ok?" } },
    { id: "out", type: "output", output: { files: [{ format: "md", name: "angebot" }] } },
  ],
  edges: [edge("start", "writer"), edge("writer", "check"), edge("check", "out", "approved")],
});

/** Publishes `body` as `slug`: its slug, a key with `scopes` and the publication id. */
async function publishedApi(body: Record<string, unknown>, slug: string, scopes: Array<"run" | "read" | "approve">) {
  const workflow = await nodestro.createWorkflow(body);
  const { publication } = await nodestro.publish(workflow.id, { slug });
  const key = await nodestro.createApiKey(slug, scopes, [publication.id]);
  return { slug: publication.slug, token: key.token, publicationId: publication.id };
}

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as NodestroAPIError);

describe("studio API, further operations", () => {
  it("checks, versions, updates and deletes workflows", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const check = await nodestro.checkWorkflow(simple(), workflow.id);
    // The test server has no provider key; that is the only problem of a sound workflow.
    expect(check.problems.every((item) => item.code === "check.api_key_missing")).toBe(true);
    expect(check.agents).toEqual({ writer: [] });
    await expect(nodestro.checkWorkflow(workflow.id as never)).rejects.toThrow(/workflow document/);
    const empty = await nodestro.checkWorkflow({ name: "empty", nodes: [], edges: [] });
    expect(empty.problems.map((item) => item.code)).toContain("workflow.no_agents");
    expect((await nodestro.updateWorkflow(workflow.id, { ...simple(), name: "SDK renamed" })).name).toBe("SDK renamed");
    const versions = await nodestro.workflowVersions(workflow.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    await nodestro.deleteWorkflow(workflow.id);
    expect((await failure(nodestro.getWorkflow(workflow.id)))?.status).toBe(404);
  });

  it("downloads the result files of a run", async () => {
    const body = simple();
    body.nodes[2] = { id: "out", type: "output", output: { files: [{ format: "md", name: "angebot" }] } } as never;
    const workflow = await nodestro.createWorkflow(body);
    const done = await nodestro.waitForRun((await nodestro.startRun(workflow.id, { input: "x" })).id, fast);
    const files = await nodestro.runFiles(done.id);
    expect(files.map((item) => item.format)).toEqual(["md"]);
    const content = new TextDecoder().decode(await nodestro.downloadFile(done.id, files[0]!.id));
    expect(content).toContain("Wir liefern");
    expect((await failure(nodestro.downloadFile(done.id, "file_missing")))?.status).toBe(404);
    // Streamed (SDK-004): the same bytes, read piece by piece.
    const streamed = await new Response(await nodestro.streamFile(done.id, files[0]!.id)).text();
    expect(streamed).toBe(content);
    expect((await failure(nodestro.streamFile(done.id, "file_missing")))?.status).toBe(404);
  });

  it("updates agent templates and lists the examples in all six languages", async () => {
    const created = await nodestro.createAgentTemplate({ agent: { name: "Prüfer", system_prompt: "Prüfe." } });
    const changed = await nodestro.updateAgentTemplate(created.id, { agent: { name: "Prüfer 2", system_prompt: "Prüfe." } });
    expect([changed.id, changed.agent.name]).toEqual([created.id, "Prüfer 2"]);
    await nodestro.deleteAgentTemplate(created.id);
    for (const language of ["de", "en", "es", "fr", "it", "pt-BR"]) expect(await nodestro.listExamples(language)).toHaveLength(24);
  });
});

describe("published workflow API, further operations", () => {
  it("handles approvals, permissions and files", async () => {
    const { slug, token, publicationId } = await publishedApi(approvalWorkflow("SDK TS approval"), "sdk-ts-approval", ["run", "read"]);
    const foreign = await publishedApi(simple(), "sdk-ts-approval-other", ["read"]);
    const api = new PublishedWorkflow(server, slug, { apiKey: token });
    const run = await api.start({ input: "ACME" });
    expect((await api.wait(run.run_id, fast)).status).toBe("awaiting_approval");
    const approvals = await api.approvals(run.run_id);
    expect(approvals.map((item) => item.step)).toEqual(["Prüfen"]);
    const noScope = await failure(api.approve(run.run_id));
    expect(noScope?.status).toBe(403); // the key lacks "approve": the server decides
    expect(noScope?.code.startsWith("auth.")).toBe(true);
    const other = new PublishedWorkflow(server, slug, { apiKey: foreign.token });
    expect([401, 403, 404]).toContain((await failure(other.status(run.run_id)))?.status);
    const key = await nodestro.createApiKey("approver", ["run", "read", "approve"], [publicationId]);
    const approver = new PublishedWorkflow(server, slug, { apiKey: key.token });
    const decided = await approver.approve(run.run_id, "approved", { comment: "passt", approvalId: approvals[0]!.approval_id });
    expect(decided.run_id).toBe(run.run_id);
    expect([404, 409]).toContain((await failure(approver.approve(run.run_id)))?.status);
    expect((await approver.waitForResult(run.run_id, fast)).status).toBe("succeeded");
    const files = await approver.files(run.run_id);
    expect(files).toHaveLength(1);
    expect(new TextDecoder().decode(await approver.download(run.run_id, String(files[0]!.id)))).toContain("Wir liefern");
    const missing = await failure(approver.download(run.run_id, "file_missing"));
    expect([missing?.status, missing?.code]).toEqual([404, "file.not_found"]);
    const streamed = await new Response(await approver.streamFile(run.run_id, String(files[0]!.id))).text();
    expect(streamed).toContain("Wir liefern");
  });

  it("reconnects a stream that the network cuts and misses no event (SDK-004)", async () => {
    const body = simple("SLOW");
    body.nodes.splice(2, 0, agent("second", "SLOW"));
    body.edges = [edge("start", "writer"), edge("writer", "second"), edge("second", "out")];
    const { slug, token } = await publishedApi(body, "sdk-ts-reconnect", ["run", "read"]);
    const run = await new PublishedWorkflow(server, slug, { apiKey: token }).start({ input: "x" });
    const proxy = await cuttingProxy(server, "event: node_started");
    try {
      const api = new PublishedWorkflow(proxy.url, slug, { apiKey: token });
      const events = await collect(api.events(run.run_id, { reconnect: { attempts: 5, backoffMs: 200 } }));
      expect(events.at(-1)).toMatchObject({ event: "end", data: { status: "succeeded" } });
      expect(proxy.heads.length).toBeGreaterThanOrEqual(2);
      expect(proxy.heads[1]!.toLowerCase()).toContain("last-event-id:");
      // The stream broke right after a step start; still every event arrives exactly once, in order. (A step that
      // started before the first connection is only in the opening status, as the API intends.)
      const steps = events.filter((event) => event.event.startsWith("node_")).map((event) => `${event.event}:${(event.data as { node_id: string }).node_id}`);
      expect(new Set(steps).size).toBe(steps.length);
      expect(steps).toEqual(expect.arrayContaining(["node_started:second", "node_finished:second"]));
      const ids = events.filter((event) => event.event.startsWith("node_")).map((event) => Number(event.id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await proxy.close();
    }
  });


  it("cancels, continues, starts versions and reconnects to events", async () => {
    const { slug, token } = await publishedApi(simple("SLOW"), "sdk-ts-slow", ["run", "read"]);
    const api = new PublishedWorkflow(server, slug, { apiKey: token });
    expect(Object.keys((await api.openapi()).paths as object).length).toBeGreaterThan(0);
    const run = await api.start({ input: "x" }, { version: 1 });
    const events = api.events(run.run_id);
    const first = (await events.next()).value as ServerEvent;
    await events.return(undefined); // leave the stream; reconnect with the last id
    expect(first.event).toBe("status");
    expect((await api.cancel(run.run_id)).run_id).toBe(run.run_id);
    expect((await api.wait(run.run_id, fast)).status).toBe("cancelled");
    await expect(api.waitForResult(run.run_id, fast)).rejects.toBeInstanceOf(NodestroRunFailed);
    const rest = await collect(api.events(run.run_id, { lastEventId: first.id ?? "0" }));
    expect(rest.at(-1)).toMatchObject({ event: "end", data: { status: "cancelled" } });
    const continued = await api.resume(run.run_id);
    expect(continued.resumed_from).toBe(run.run_id);
    expect((await api.wait(continued.run_id, fast)).status).toBe("succeeded");
    const notFailed = await failure(api.resume(continued.run_id));
    expect([notFailed?.status, notFailed?.code]).toEqual([409, "resume.not_failed"]);
    expect((await failure(api.start({ input: "x" }, { version: 99 })))?.status).toBe(404);
    expect((await api.usage(1)).runs).toBeGreaterThanOrEqual(2);
    expect((await api.runs({ status: "cancelled" })).map((item) => item.run_id)).toEqual([run.run_id]);
  });
});

describe("batches and schedules (SDK-003)", () => {
  it("parses, plans, runs, exports and deletes a batch", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const parsed = await nodestro.parseBatchFile(workflow.id, "input\nACME\nBeta\n");
    expect(parsed.columns).toEqual(["input"]);
    expect((await nodestro.parseBatchFile(workflow.id, new Blob(["input\nGamma\n"]), "more.csv")).rows).toEqual([{ input: "Gamma" }]);
    const rows = parsed.rows.map((row) => ({ input: row.input! }));
    const plan = await nodestro.planBatch({ workflow_id: workflow.id, rows });
    expect([plan.total, plan.valid, plan.invalid]).toEqual([2, 2, 0]);
    const batch = await nodestro.createBatch({ workflow_id: workflow.id, rows, name: "SDK TS batch" });
    const deadline = Date.now() + 60_000;
    let found = await nodestro.getBatch(batch.id);
    while (found.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      found = await nodestro.getBatch(batch.id);
    }
    expect(found.status).toBe("finished");
    expect(found.items?.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    expect((await nodestro.listBatches()).map((item) => item.id)).toContain(batch.id);
    expect(new TextDecoder().decode(await nodestro.exportBatch(batch.id))).toContain("ACME");
    expect(new TextDecoder().decode(await nodestro.exportBatch(batch.id, "json")).trimStart()).toMatch(/^\[/);
    await expect(nodestro.exportBatch(batch.id, "xml" as never)).rejects.toThrow(TypeError);
    const notRunning = await failure(nodestro.pauseBatch(batch.id));
    expect([notRunning?.status, notRunning?.code]).toEqual([400, "batch.not_running"]);
    await nodestro.deleteBatch(batch.id);
    expect((await failure(nodestro.getBatch(batch.id)))?.status).toBe(404);
  });

  it("previews, creates, changes and deletes a schedule without letting it run", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    expect(await nodestro.scheduleTimeZones()).toContain("Europe/Vienna");
    const body = { workflow_id: workflow.id, name: "SDK TS daily", kind: "daily" as const, at: "06:30", time_zone: "UTC" };
    const preview = await nodestro.previewSchedule(body);
    expect(preview.next_runs?.length).toBeGreaterThan(0);
    const schedule = await nodestro.createSchedule(body);
    expect([schedule.enabled, schedule.at]).toEqual([false, "06:30"]);
    expect((await nodestro.getSchedule(schedule.id)).name).toBe("SDK TS daily");
    expect((await nodestro.listSchedules()).map((item) => item.id)).toContain(schedule.id);
    expect((await nodestro.updateSchedule(schedule.id, { ...body, kind: "weekly", weekdays: [0] })).kind).toBe("weekly");
    expect(typeof (await nodestro.previewSchedule(body, { scheduleId: schedule.id })).ok).toBe("boolean");
    expect((await nodestro.disableSchedule(schedule.id)).schedule.enabled).toBe(false);
    const bad = await failure(nodestro.createSchedule({ ...body, time_zone: "Mars/Base" }));
    expect(bad?.status).toBeGreaterThanOrEqual(400);
    await nodestro.deleteSchedule(schedule.id);
    expect((await failure(nodestro.getSchedule(schedule.id)))?.status).toBe(404);
  });
});

describe("model prices and usage", () => {
  it("lists prices, keeps overrides with history and reports cost states", async () => {
    const prices = await nodestro.listPrices();
    expect(prices.some((price) => price.provider === "anthropic" && price.quality === "verified")).toBe(true);
    const status = await nodestro.pricingStatus();
    expect(status.reference_read_only).toBe(false);
    const entry = await nodestro.setPriceOverride("openai", "org/gpt-sdk-ts", {
      input_usd_per_mtok: "1",
      output_usd_per_mtok: "4",
    });
    expect(entry.overridden).toBe(true);
    expect(entry.model).toBe("org/gpt-sdk-ts");
    expect((await nodestro.pricingHistory(50)).some((event) => event.kind === "override_set")).toBe(true);
    await nodestro.removePriceOverride("openai", "org/gpt-sdk-ts");
    const missing = await nodestro.removePriceOverride("openai", "org/gpt-sdk-ts").catch((error: unknown) => error);
    expect((missing as NodestroAPIError).status).toBe(404);
    expect(await nodestro.listPriceReviews()).toEqual([]);
    const unknown = await nodestro.decidePriceReview("nothing", "reject").catch((error: unknown) => error);
    expect((unknown as NodestroAPIError).code).toBe("pricing.review_not_found");
    const usage = await nodestro.usage(7);
    expect(["known", "partial", "unknown", "none"]).toContain(usage.total.cost_state);
    const noKey = await nodestro.reconcileCosts({ start: "2026-10-01", end: "2026-10-02" }).catch((error: unknown) => error);
    expect((noKey as NodestroAPIError).code).toBe("pricing.billing_key_missing");
  });
});

describe("release gate", () => {
  it("reports, validates and switches the gate", async () => {
    const workflow = await nodestro.createWorkflow({ ...simple(), name: "SDK gate TS" });
    expect((await nodestro.releaseGate(workflow.id)).status).toBe("off");
    const unknown = await nodestro.releaseGate(workflow.id, { gate: { suite_ids: ["suite_none"] } }).catch((error: unknown) => error);
    expect((unknown as NodestroAPIError).code).toBe("gate.suite_unknown");
    const { publication } = await nodestro.publish(workflow.id, { slug: "sdk-gate-ts" });
    expect(publication.gate).toBeNull();
    expect((await nodestro.setReleaseGate(publication.id, null)).gate).toBeNull();
  });
});

describe("connected MCP services", () => {
  it("adds, lists, changes and removes a server without returning its token", async () => {
    const status = await nodestro.mcpStatus();
    expect(status.write_tools_enabled).toBe(false);
    const unsafe = await nodestro.addMcpServer({ name: "Plain", url: "http://mcp.example.com/mcp" }).catch((error: unknown) => error);
    expect((unsafe as NodestroAPIError).code).toBe("mcp.https_required");
    const server = await nodestro.addMcpServer({ name: "Docs TS", url: "https://mcp.invalid/mcp", auth: "bearer", token: "ts-secret-token" });
    expect(server.token_set).toBe(true);
    expect(JSON.stringify(server)).not.toContain("ts-secret-token");
    expect((await nodestro.listMcpServers()).map((item) => item.id)).toContain(server.id);
    const unreachable = await nodestro.discoverMcpTools(server.id).catch((error: unknown) => error);
    expect(["mcp.dns_failed", "mcp.unreachable", "mcp.unavailable"]).toContain((unreachable as NodestroAPIError).code);
    expect(await nodestro.listMcpTools(server.id)).toEqual([]);
    const missing = await nodestro.decideMcpTool(server.id, "search", { approve: true, access: "read" }).catch((error: unknown) => error);
    expect((missing as NodestroAPIError).status).toBe(404);
    const changed = await nodestro.updateMcpServer(server.id, { name: "Docs TS 2", url: "https://mcp.invalid/mcp" });
    expect(changed.token_set).toBe(true);
    const notOAuth = await nodestro.startMcpSignIn(server.id).catch((error: unknown) => error);
    expect((notOAuth as NodestroAPIError).code).toBe("mcp.oauth_not_configured");
    const notLocal = await nodestro.mcpServerEnvironment(server.id).catch((error: unknown) => error);
    expect((notLocal as NodestroAPIError).code).toBe("mcp.stdio_invalid");
    const noPlan = await nodestro.planMcpServerEnvironment(server.id).catch((error: unknown) => error);
    expect((noPlan as NodestroAPIError).status).toBe(400);
    const noSignIn = await nodestro.signOutMcpServer(server.id).catch((error: unknown) => error);
    expect((noSignIn as NodestroAPIError).code).toBe("mcp.oauth_not_configured");
    const stats = await nodestro.mcpStats();
    expect(stats.active_calls).toBe(0);
    const events = await nodestro.mcpEvents(20);
    expect(events.some((event) => event.kind === "server_added")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("ts-secret-token");
    await nodestro.removeMcpServer(server.id);
    expect((await nodestro.listMcpServers()).map((item) => item.id)).not.toContain(server.id);
  });
});

async function until(probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("condition not reached");
}

/** An orchestrator whose team waits at an approval: the run stays paused until the test decides. */
async function orchestratedRun(): Promise<string> {
  const team = await nodestro.createWorkflow({
    name: "SDK Team TS",
    description: "schreibt Entwürfe",
    nodes: [
      { id: "start", type: "start" },
      agent("drafter", "DRAFTER"),
      { id: "check", type: "approval", label: "Prüfen", approval: { on_reject: "branch" } },
      { id: "out", type: "output" },
    ],
    edges: [edge("start", "drafter"), edge("drafter", "check"), edge("check", "out", "approved")],
  });
  const lead = await nodestro.createWorkflow({
    name: "SDK Lead TS",
    nodes: [
      { id: "start", type: "start" },
      { id: "lead", type: "orchestrator", label: "Lead", orchestrator: { members: [{ workflow_id: team.id }] } },
    ],
    edges: [edge("start", "lead")],
  });
  const run = await nodestro.startRun(lead.id, { input: "Angebot" });
  expect((await nodestro.waitForRun(run.id, fast)).status).toBe("paused");
  return run.id;
}

describe("live run chat", () => {
  it("shows the chat, takes instructions and questions and ends with the run", async () => {
    const runId = await orchestratedRun();
    const view = await nodestro.runChat(runId);
    expect(view.active).toBe(true);
    expect(view.run_status).toBe("paused");
    expect(view.messages).toEqual([]);
    expect(view.targets).toHaveLength(1);
    expect([view.targets[0]!.run_id, view.targets[0]!.node_id, view.targets[0]!.label]).toEqual([runId, "lead", "Lead"]);
    expect(view.targets[0]!.steering).toBe(true);

    // Leaving the loop of a live stream early closes it; the next call still works.
    for await (const event of nodestro.runChatEvents(runId)) {
      expect(event.event).toBe("snapshot");
      break;
    }

    const order = { kind: "instruction" as const, target_run_id: runId, node_id: "lead", content: "Kurz halten" };
    const sent = await nodestro.sendRunChatMessage(runId, { ...order, client_id: "sdk-ts-tab-1" });
    expect(sent.status).toBe("queued");
    expect(sent.client_id ?? null).toBeNull();
    const again = await nodestro.sendRunChatMessage(runId, { ...order, client_id: "sdk-ts-tab-1" });
    expect(again.id).toBe(sent.id);
    const reused = await failure(nodestro.sendRunChatMessage(runId, { ...order, content: "Anders", client_id: "sdk-ts-tab-1" }));
    expect(reused).toBeInstanceOf(NodestroAPIError);
    expect([reused!.status, reused!.code]).toEqual([409, "run_chat.client_id_reused"]);

    const asked = await nodestro.sendRunChatMessage(runId, { kind: "question", target_run_id: runId, node_id: "lead", content: "Wo stehen wir?" });
    expect(asked.status).toBe("pending");
    await until(async () => (await nodestro.runChatMessage(runId, asked.id!)).status === "answered");
    const messages = (await nodestro.runChat(runId)).messages;
    const answer = messages.find((item) => item.kind === "answer");
    expect(answer?.reply_to).toBe(asked.id);
    expect(answer?.content).toContain("wartet auf eine Freigabe");

    const waiting = (await nodestro.listApprovals()).filter((item) => item.root_run_id === runId);
    expect(waiting).toHaveLength(1);
    await nodestro.decideApproval(waiting[0]!.run_id, "check", "approved");
    expect((await nodestro.waitForRun(runId, fast)).status).toBe("succeeded");
    await until(async () => (await nodestro.runChatMessage(runId, sent.id!)).status === "considered");

    const events = await collect(nodestro.runChatEvents(runId));
    expect(events.map((event) => event.event)).toEqual(["snapshot", "end"]);
    expect((events[0]!.data as { run_id: string; active: boolean }).run_id).toBe(runId);
    expect((events[0]!.data as { active: boolean }).active).toBe(false);
    expect(events[1]!.data).toEqual({ status: "succeeded" });

    const ended = await failure(nodestro.sendRunChatMessage(runId, { kind: "question", target_run_id: runId, node_id: "lead", content: "Und jetzt?" }));
    expect(ended).toBeInstanceOf(NodestroAPIError);
    expect([ended!.status, ended!.code]).toEqual([409, "run_chat.run_not_active"]);
    expect((await failure(nodestro.runChatMessage(runId, "msg_does_not_exist")))!.status).toBe(404);
  });
});

/** A run whose budget is too small for its first model request: it pauses for a budget decision. */
async function budgetRun(): Promise<[string, string]> {
  const writer = agent("writer", "WRITER");
  const workflow = await nodestro.createWorkflow({
    name: "SDK budget",
    budget_usd: 0.0001,
    nodes: [{ id: "start", type: "start" }, { ...writer, agent: { ...writer.agent, max_tokens: 1000 } }, { id: "out", type: "output" }],
    edges: [edge("start", "writer"), edge("writer", "out")],
  });
  const run = await nodestro.startRun(workflow.id, { input: "Angebot" });
  const paused = await nodestro.waitForRun(run.id, fast);
  expect(paused.status).toBe("paused");
  const requestId = paused.budget?.pending_request_id;
  expect(requestId).toBeTruthy();
  return [run.id, requestId!];
}

describe("run budgets", () => {
  it("raises the limit of a paused run, refuses wrong limits and late decisions", async () => {
    const [runId, requestId] = await budgetRun();
    const view = await nodestro.getRunBudget(runId);
    expect([view.pending?.id, view.pending?.status, view.limit_usd, view.source]).toEqual([requestId, "pending", "0.0001", "workflow"]);
    expect(view.policy.can_decide).toBe(true);
    expect((await nodestro.listBudgetRequests()).map((item) => item.id)).toContain(requestId);

    const notHigher = await failure(nodestro.raiseRunBudget(runId, requestId, "0.00"));
    expect([notHigher?.status, notHigher?.code]).toEqual([422, "budget.limit_not_higher"]);
    const invalid = await failure(nodestro.raiseRunBudget(runId, requestId, "abc"));
    expect([invalid?.status, invalid?.code]).toEqual([422, "budget.limit_invalid"]);

    const raised = await nodestro.raiseRunBudget(runId, requestId, "2.50", { idempotencyKey: "sdk-ts-budget-1" });
    expect(raised.limit_usd).toBe("2.50");
    expect((await nodestro.raiseRunBudget(runId, requestId, "2.50", { idempotencyKey: "sdk-ts-budget-1" })).run_id).toBe(runId);
    const done = await nodestro.waitForRun(runId, fast);
    expect([done.status, done.budget?.limit_usd]).toEqual(["succeeded", "2.50"]);
    const after = await nodestro.getRunBudget(runId);
    expect(after.pending ?? null).toBeNull();
    expect((after.history ?? []).map((item) => item.status)).toEqual(["raised"]);
    expect((await nodestro.listBudgetRequests()).map((item) => item.id)).not.toContain(requestId);

    const late = await failure(nodestro.endRunForBudget(runId, requestId));
    expect([late?.status, late?.code, late?.params.request_status]).toEqual([409, "budget.not_pending", "raised"]);
    expect((await failure(nodestro.endRunForBudget(runId, "bud_does_not_exist")))?.status).toBe(404);
  });

  it("ends a paused run", async () => {
    const [runId, requestId] = await budgetRun();
    await nodestro.endRunForBudget(runId, requestId);
    const done = await nodestro.waitForRun(runId, fast);
    expect([done.status, done.error_code]).toEqual(["cancelled", "run.budget_ended"]);
  });
});

describe("revisions, paging, compatibility and local builds", () => {
  it("refuses a save based on an old revision (SDK-002)", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const first = await nodestro.updateWorkflow(workflow.id, { ...simple(), name: "SDK A" }, { revision: workflow.updated_at });
    expect(first.name).toBe("SDK A");
    const conflict = await nodestro
      .updateWorkflow(workflow.id, { ...simple(), name: "SDK B" }, { revision: workflow.updated_at })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(NodestroAPIError);
    expect([(conflict as NodestroAPIError).status, (conflict as NodestroAPIError).code]).toEqual([409, "workflow.conflict"]);
    expect((await nodestro.getWorkflow(workflow.id)).name).toBe("SDK A");
    const noted = await nodestro.updateWorkflow(workflow.id, { ...simple(), name: "SDK C" }, { revision: first.updated_at, note: "renamed" });
    expect(noted.name).toBe("SDK C");
    expect((await nodestro.workflowVersions(workflow.id))[0]?.description).toBe("renamed");
    expect((await nodestro.updateWorkflow(workflow.id, { ...simple(), name: "SDK D" })).name).toBe("SDK D");
  });

  it("pages runs with the API's cursor (SDK-002)", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const started: string[] = [];
    for (const index of [0, 1, 2]) started.push((await nodestro.startRun(workflow.id, { input: `x${index}` })).id);
    for (const id of started) await nodestro.waitForRun(id, fast);
    const newest = [...started].reverse();
    const page = await nodestro.listRunsPage({ workflowId: workflow.id, limit: 2 });
    expect(page.runs.map((run) => run.id)).toEqual(newest.slice(0, 2));
    expect(page.nextBefore).toBeTruthy();
    const rest = await nodestro.listRuns({ workflowId: workflow.id, limit: 2, before: page.nextBefore ?? undefined });
    expect(rest.map((run) => run.id)).toEqual([started[0]]);
    const all: string[] = [];
    for await (const run of nodestro.iterRuns({ workflowId: workflow.id, pageSize: 1 })) all.push(run.id);
    expect(all).toEqual(newest);
  });

  it("stops waiting for a run when the signal aborts (SDK-004)", async () => {
    const workflow = await nodestro.createWorkflow(simple("SLOW"));
    const run = await nodestro.startRun(workflow.id, { input: "x" });
    const controller = new AbortController();
    const waiting = nodestro.waitForRun(run.id, { timeoutMs: 30_000, pollMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop waiting")), 200);
    const started = Date.now();
    await expect(waiting).rejects.toThrow("stop waiting");
    expect(Date.now() - started).toBeLessThan(4_000);
    await expect(nodestro.waitForRun(run.id, { ...fast, signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
    await nodestro.cancelRun(run.id);
  });

  it("checks the compatibility with the API version (SDK-013)", async () => {
    const found = await nodestro.checkCompatibility();
    expect(found.compatible).toBe(true);
    expect(found.apiVersion).toBe((await nodestro.meta()).version);
    expect(found.sdkApiVersion).toBe(API_VERSION);
    expect(compatibility("0.2.9", "0.2.0").compatible).toBe(true);
    expect(compatibility("0.3.0", "0.2.0").compatible).toBe(false);
    expect(compatibility("2.0.0", "1.2.0").compatible).toBe(false);
    expect(compatibility("1.3.0", "1.2.0").compatible).toBe(true);
    expect(compatibility("1.1.0", "1.2.0").compatible).toBe(false);
    expect(compatibility("dev", "0.2.0").reason).toMatch(/cannot be read/);
  });

  it("builds a catalog model from local files (SDK-014)", async () => {
    const partial = await nodestro.importLocalModel({ kind: "build", path: "/no/weights", name: "mdenseon:307m" }).catch((error: unknown) => error);
    expect((partial as NodestroAPIError).code).toBe("local.name_missing");
    const missing = await nodestro
      .importLocalModel({ kind: "build", path: "/no/weights", template: "/no/template", name: "mdenseon:307m" })
      .catch((error: unknown) => error);
    expect([(missing as NodestroAPIError).status, (missing as NodestroAPIError).code]).toEqual([400, "local.file_missing"]);
  });
});

/**
 * A TCP proxy to `target` that cuts its first connection right after the first event containing `marker` reached
 * the client (as a proxy or network that drops a stream); later connections pass through.
 */
async function cuttingProxy(target: string, marker: string) {
  const upstreamUrl = new URL(target);
  const heads: string[] = [];
  const sockets = new Set<Socket>();
  const proxy = createNetServer((client) => {
    sockets.add(client);
    const upstream = connect(Number(upstreamUrl.port), upstreamUrl.hostname);
    sockets.add(upstream);
    let head = "";
    let first = false;
    let sent = "";
    client.on("data", (chunk) => {
      if (!head.includes("\r\n\r\n")) {
        head += chunk.toString("latin1");
        if (head.includes("\r\n\r\n")) {
          heads.push(head);
          first = heads.length === 1;
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      client.write(chunk);
      if (!first) return;
      sent += chunk.toString("latin1");
      const found = sent.indexOf(marker);
      if (found >= 0 && sent.indexOf("\n\n", found) >= 0) {
        first = false;
        client.end(() => client.destroy());
        upstream.destroy();
      }
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    heads,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => proxy.close(resolve));
    },
  };
}

describe("test series, knowledge, input files, tool approvals and exports (SDK-003)", () => {
  it("plans, runs, compares and deletes a test series", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const suite = await nodestro.createTestSeries({ workflow_id: workflow.id, name: "SDK TS series", cases: [{ input: "ACME" }, { input: "Beta" }] });
    expect(suite.cases?.map((item) => item.name)).toEqual(["#1", "#2"]);
    expect((await nodestro.getTestSeries(suite.id)).name).toBe("SDK TS series");
    expect((await nodestro.listTestSeries()).map((item) => item.id)).toContain(suite.id);
    expect((await nodestro.updateTestSeries(suite.id, { ...suite, name: "SDK TS series 2" })).name).toBe("SDK TS series 2");
    const plan = await nodestro.planTestRun(suite.id, { judge: false });
    expect([plan.cases, plan.judged_cases]).toEqual([2, 0]);
    const first = await nodestro.waitForTestRun((await nodestro.startTestRun(suite.id, { judge: false, concurrency: 2 })).id, fast);
    expect(first.status).toBe("finished");
    const second = await nodestro.waitForTestRun((await nodestro.startTestRun(suite.id, { judge: false })).id, fast);
    expect((await nodestro.listTestRuns(suite.id)).map((item) => item.id)).toEqual([second.id, first.id]);
    const comparison = await nodestro.compareTestRuns(first.id, second.id);
    expect([comparison.a.id, comparison.b.id]).toEqual([first.id, second.id]);
    expect(comparison.cases.map((item) => item.change)).toEqual(["same", "same"]);
    const choice = await nodestro.testSeriesModelChoice(suite.id, "writer", { minPassRate: 0.5 });
    expect([choice.node_id, choice.suite_id]).toEqual(["writer", suite.id]);
    expect((await failure(nodestro.testSeriesModelChoice(suite.id, "writer", { minPassRate: 2 })))?.status).toBe(422);
    expect((await nodestro.cancelTestRun(first.id)).status).toBe("finished");
    await nodestro.deleteTestRun(first.id);
    expect((await failure(nodestro.getTestRun(first.id)))?.status).toBe(404);
    const empty = await nodestro.createTestSeries({ workflow_id: workflow.id, cases: [] });
    const noCases = await failure(nodestro.startTestRun(empty.id));
    expect([noCases?.status, noCases?.code]).toEqual([400, "benchmark.no_cases"]);
    await nodestro.deleteTestSeries(suite.id);
    expect((await failure(nodestro.getTestSeries(suite.id)))?.status).toBe(404);
  });

  it("uploads, searches, changes and deletes knowledge files", async () => {
    const added = await nodestro.uploadKnowledge(
      [
        new File(["# Returns\n\nGoods can be returned within 30 days."], "ts-returns.md"),
        { name: "ts-shipping.md", content: "# Shipping\n\nWe ship to Austria in two days." },
      ],
      { description: "SDK TS policies", collection: "sdk-ts-policies" },
    );
    expect(added.map((item) => item.name)).toEqual(["ts-returns.md", "ts-shipping.md"]);
    const ids = added.map((item) => item.id);
    expect((await nodestro.listKnowledge("SDK TS policies")).map((item) => item.id)).toEqual(expect.arrayContaining(ids));
    expect((await nodestro.knowledgeCollections()).map((item) => item.name)).toContain("sdk-ts-policies");
    const hits = await nodestro.searchKnowledge("returned", { mode: "fts", fileIds: ids });
    expect(hits[0]?.file_id).toBe(ids[0]);
    expect(await nodestro.searchKnowledge("returned", { mode: "fts", fileIds: [ids[1]!] })).toEqual([]);
    expect(new TextDecoder().decode(await nodestro.knowledgeContent(ids[0]!))).toContain("30 days");
    const changed = await nodestro.updateKnowledge(ids[0]!, { description: "Returns policy", collection: "sdk-ts-other" });
    expect([changed.description, changed.collection]).toEqual(["Returns policy", "sdk-ts-other"]);
    expect((await failure(nodestro.searchKnowledge("x", { k: 500 })))?.status).toBe(422);
    await expect(nodestro.uploadKnowledge([])).rejects.toThrow(TypeError);
    for (const id of ids) await nodestro.deleteKnowledge(id);
    expect((await failure(nodestro.knowledgeContent(ids[0]!)))?.status).toBe(404);
  });

  it("uploads input files, reads them and cleans them up", async () => {
    expect(await nodestro.inputFormats()).toBeTruthy();
    const before = await nodestro.inputStorage();
    const results = await nodestro.uploadInputs(
      [{ name: "order.txt", content: "10 pieces until Friday" }, { name: "tool.exe", content: new Uint8Array([77, 90]) }],
      { accept: ".txt" },
    );
    const stored = results[0]?.file;
    expect(stored).toBeTruthy();
    expect(results[1]?.file ?? null).toBeNull();
    expect(results[1]?.problem).toBeTruthy();
    expect((await nodestro.getInput(stored!.id)).name).toBe("order.txt");
    expect((await nodestro.inputText(stored!.id)).text).toContain("10 pieces");
    expect(new TextDecoder().decode(await nodestro.inputContent(stored!.id))).toBe("10 pieces until Friday");
    expect((await nodestro.inputStorage()).files).toBe((before.files ?? 0) + 1);
    const run = await nodestro.startRun((await nodestro.createWorkflow(simple())).id, { input: "Read it", fileIds: [stored!.id] });
    await nodestro.waitForRun(run.id, fast);
    const unused = (await nodestro.uploadInputs([{ name: "unused.txt", content: "nobody reads this" }]))[0]?.file;
    await nodestro.cleanUpInputs(); // a new file and the file of a finished run stay
    expect((await nodestro.getInput(unused!.id)).id).toBe(unused!.id);
    const inUse = await failure(nodestro.deleteInput(stored!.id));
    expect(inUse?.code).toBe("input.in_use");
    await nodestro.deleteInput(unused!.id);
    const cleaned = await nodestro.cleanUpInputs(0); // also the files of finished runs
    expect(cleaned.removed).toBeGreaterThanOrEqual(1);
    for (const id of [stored!.id, unused!.id]) expect((await failure(nodestro.getInput(id)))?.status).toBe(404);
  });

  it("reads tool approvals and refuses unknown decisions (approvals stay off on the test server)", async () => {
    expect(await nodestro.listToolApprovals()).toEqual([]);
    const run = await nodestro.startRun((await nodestro.createWorkflow(simple())).id, { input: "go" });
    expect(await nodestro.runToolApprovals(run.id)).toEqual([]);
    expect(Array.isArray(await nodestro.toolApprovalAudit(10))).toBe(true);
    const unknown = await failure(nodestro.decideToolApproval(run.id, "tap_missing", "approved", { argumentsHash: "0".repeat(64) }));
    expect([404, 409]).toContain(unknown?.status);
    await expect(nodestro.decideToolApproval(run.id, "tap_missing", "maybe" as never, { argumentsHash: "x" })).rejects.toThrow(TypeError);
  });

  it("checks, builds, downloads and deletes an export", async () => {
    const workflow = await nodestro.createWorkflow(simple());
    const { publication } = await nodestro.publish(workflow.id, { slug: `sdk-ts-export-${Date.now()}` });
    expect((await nodestro.checkExport(publication.id)).ok).toBe(true);
    const record = await nodestro.createExport(publication.id, { kind: "standard" });
    expect(record.publication_id).toBe(publication.id);
    expect((await nodestro.listExports(publication.id))[0]?.id).toBe(record.id);
    const data = await nodestro.downloadExport(record.id);
    expect(data.byteLength).toBe(record.size);
    expect([data[0], data[1]]).toEqual([0x50, 0x4b]); // "PK": a ZIP
    let streamed = 0;
    const reader = (await nodestro.streamExport(record.id)).getReader();
    for (let piece = await reader.read(); !piece.done; piece = await reader.read()) streamed += piece.value.byteLength;
    expect(streamed).toBe(record.size);
    const standardJob = await failure(nodestro.startExportJob(publication.id, { kind: "standard" }));
    expect([standardJob?.status, standardJob?.code]).toEqual([400, "export.not_portable"]);
    expect(await nodestro.listExportJobs(publication.id)).toEqual([]);
    expect((await failure(nodestro.getExportJob("xjob_missing")))?.status).toBe(404);
    expect((await failure(nodestro.cancelExportJob("xjob_missing")))?.status).toBe(404);
    await nodestro.deleteExport(record.id);
    expect((await failure(nodestro.downloadExport(record.id)))?.status).toBe(404);
  });
});
