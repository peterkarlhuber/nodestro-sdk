/**
 * The TypeScript SDK against a real Nodestro API server with scripted model answers. German values
 * (inputs, labels, template names, the scripted answers) are deliberate test data: Nodestro is
 * multilingual, and the assertions look for them.
 */

import { describe, expect, inject, it } from "vitest";
import { NodestroAPIError, NodestroClient, NodestroRunFailed, PublishedWorkflow, type ServerEvent } from "../src/index.js";

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
    expect(JSON.stringify(await nodestro.settings())).not.toMatch(/sk-[a-z0-9]/i);
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
    expect((missing as NodestroAPIError).code).toBe("not_found");
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
