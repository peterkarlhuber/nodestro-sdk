/** The TypeScript SDK against a real Nodestro API server with scripted model answers. */

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
});
