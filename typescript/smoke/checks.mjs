/**
 * Smoke checks of @nodestro/client in one JavaScript runtime (Node.js, Bun, Deno or a browser page), against a
 * running scripts/test_server.py. `sdk` is the imported package (typescript/dist/index.js), `baseUrl` the API's
 * address, `name` a label that keeps the created slugs apart. Returns the names of the checks that passed and
 * throws at the first one that fails. Plain JavaScript on purpose: a browser loads it as it is.
 */

const decoder = new TextDecoder();

async function readStream(stream) {
  const reader = stream.getReader();
  const pieces = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
  }
  const all = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    all.set(piece, offset);
    offset += piece.byteLength;
  }
  return all;
}

async function collect(events) {
  const found = [];
  for await (const event of events) found.push(event);
  return found;
}

function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
}

export async function runChecks(sdk, baseUrl, name) {
  const passed = [];
  const nodestro = new sdk.NodestroClient(baseUrl, { timeoutMs: 15_000 });
  const fast = { timeoutMs: 30_000, pollMs: 100 };

  const meta = await nodestro.meta();
  check(typeof meta.version === "string" && meta.version.length > 0, "meta() returns the API version");
  passed.push("meta");

  const missing = await nodestro.getWorkflow("wf_missing").catch((error) => error);
  check(missing instanceof sdk.NodestroAPIError && missing.status === 404, "an unknown workflow is a NodestroAPIError 404");
  passed.push("api-error");

  const workflow = await nodestro.createWorkflow({
    name: `Smoke ${name}`,
    nodes: [
      { id: "start", type: "start" },
      { id: "writer", type: "agent", label: "Writer", agent: { name: "Writer", system_prompt: "WRITER" } },
      { id: "out", type: "output", output: { files: [{ format: "md", name: "angebot" }] } },
    ],
    edges: [
      { id: "start-writer", source: "start", target: "writer", source_handle: null },
      { id: "writer-out", source: "writer", target: "out", source_handle: null },
    ],
  });
  const run = await nodestro.startRun(workflow.id, { input: "x" });
  const events = await collect(nodestro.events(run.id, { reconnect: true }));
  check(events[0]?.event === "snapshot" && events.at(-1)?.event === "end", "the run's event stream ends with end");
  passed.push("events");

  const done = await nodestro.waitForRun(run.id, fast);
  check(done.status === "succeeded", `the run succeeded (${done.status})`);
  const files = await nodestro.runFiles(run.id);
  const whole = await nodestro.downloadFile(run.id, files[0].id);
  const streamed = await readStream(await nodestro.streamFile(run.id, files[0].id));
  check(decoder.decode(streamed) === decoder.decode(whole) && decoder.decode(whole).includes("Wir liefern"), "streamFile equals downloadFile");
  passed.push("download");

  const aborted = new AbortController();
  aborted.abort();
  const stopped = await nodestro.waitForRun(run.id, { ...fast, signal: aborted.signal }).catch((error) => error);
  check(stopped?.name === "AbortError", "an aborted wait throws the AbortError");
  passed.push("abort");

  const slug = `smoke-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const { publication } = await nodestro.publish(workflow.id, { slug });
  const key = await nodestro.createApiKey(slug, ["run", "read"], [publication.id]);
  const api = new sdk.PublishedWorkflow(baseUrl, publication.slug, { apiKey: key.token });
  const started = await api.start({ input: "ACME" });
  const result = await api.waitForResult(started.run_id, fast);
  check(result.status === "succeeded", "a published run succeeds");
  const replay = await collect(api.events(started.run_id, { lastEventId: "0", reconnect: true }));
  check(replay.at(-1)?.event === "end", "the published event stream ends with end");
  const publishedFiles = await api.files(started.run_id);
  const publishedFile = await readStream(await api.streamFile(started.run_id, String(publishedFiles[0].id)));
  check(decoder.decode(publishedFile).includes("Wir liefern"), "a published file streams");
  passed.push("published");
  return passed;
}
