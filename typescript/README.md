# @nodestro/client

The TypeScript client of the [Nodestro API](https://github.com/peterkarlhuber/nodestro-api): `NodestroClient` for
the studio REST API of an installation and `PublishedWorkflow` for published, key-protected workflow APIs (served
by Nodestro or by a standalone export). ES modules with type definitions, promises and async iterators, built on
`fetch`; no runtime dependencies.

Runs on Node.js 22.12 and later (tested with 22 and 24) and in browsers with `fetch`, `AbortSignal.timeout` and Web
Streams (tested with Chromium; see [Browsers](#browsers)).

## Installation

The package is not published to a registry. Build it from a checkout at the commit you want:

```bash
cd typescript && npm ci && npm run build && npm pack    # -> nodestro-client-0.3.0.tgz
npm install /path/to/nodestro-client-0.3.0.tgz         # in your project
```

## Quickstart

```ts
import { NodestroAPIError, NodestroClient, NodestroClientError, PublishedWorkflow } from "@nodestro/client";

// The studio API of a local installation (no key; it answers only this computer).
const nodestro = new NodestroClient("http://127.0.0.1:8000", { timeoutMs: 30_000 });
// A new installation has no workflows yet: copy one from the example library (listExamples()).
const workflow = (await nodestro.listWorkflows())[0] ?? (await nodestro.copyExample("blog-article"));
const run = await nodestro.startRun(workflow.id, { input: "Quote for ACME" }); // needs the provider key of its agents
for await (const event of nodestro.events(run.id)) console.log(event.event); // snapshot, event ..., end
const done = await nodestro.waitForRun(run.id, { timeoutMs: 300_000, raiseOnFailure: true });

// A published workflow API with a Nodestro API key (scopes run, read, approve), on a server.
const api = new PublishedWorkflow("https://nodestro.example.com", "quote", { apiKey: process.env.NODESTRO_API_KEY! });
try {
  const started = await api.start({ values: { customer: "ACME" } }); // carries an Idempotency-Key: safe to retry
  const result = await api.waitForResult(started.run_id, { timeoutMs: 600_000 });
  console.log(result.output);
} catch (error) {
  if (error instanceof NodestroAPIError) console.error(error.status, error.code, error.params);
  else if (error instanceof NodestroClientError) console.error(error.message, error.cause);
  else throw error;
}
```

Keep keys out of the code. A key comes from the studio (publication, "API keys") or from
`nodestro.publish(workflowId, { slug: "quote" })` and `nodestro.createApiKey("My app", ["run", "read"], [publicationId])`,
whose `token` is the secret, returned only once.

A run calls the model provider of the workflow's agents. Without that provider's key (for example
`ANTHROPIC_API_KEY`, or the key entered in the studio's settings), `startRun()` throws `NodestroAPIError` with status
400 and code `api_key_missing` (`params.provider` names the provider).

A **new** desktop installation uses local models by default (`(await nodestro.settings()).default_model`, for example
`ollama:qwen3.5:4b`), and `copyExample()` gives the copied agents the local models recommended for this computer, even
when a cloud key is set. Until the local model runtime is installed and a model is downloaded, `startRun()` throws
`NodestroAPIError` with status 400, code `workflow.blocked` and the problem `check.local_runtime_missing` in
`params.problems`; see [Local models and the knowledge index](#local-models-and-the-knowledge-index), or choose a
cloud model as the default model in the studio's settings before copying the example.

`checkWorkflow(await nodestro.getWorkflow(workflowId), workflowId)` reports these problems without starting a run; it
takes the workflow document (also an unsaved one), not its id.

## Options

`new NodestroClient(baseUrl, options)` and `new PublishedWorkflow(baseUrl, slug, { apiKey, ...options })`:

- `baseUrl`: `http://` or `https://`, a host name, IPv4 or `[IPv6]` address, an optional port and an optional path
  prefix; a trailing slash is ignored. A query, fragment or credentials throw a `TypeError`.
- `timeoutMs` (default 30 000): time limit of one request from sending it to the end of its body.
- `retry`: `{ attempts: 3, backoffMs: 500, maxBackoffMs: 8000 }`; `attempts` counts the first try (`1` = never
  retry; values below 1 throw a `RangeError`). Only reads, starts of runs (published workflows and `start_run`/`startRun`: idempotency key), run chat
  messages (`client_id`) and budget decisions (`idempotency_key`) are retried, after connection errors and 502/503/504. The bodies of discarded answers are released.
- `headers`: sent with every request; `PublishedWorkflow` always sends its own `Authorization`.
- `fetch`: a replacement for the global `fetch` (proxies, tests).

Ids and slugs are encoded as single path segments; `""`, `.` and `..` are refused.

## Revisions, paging and the API version

- `updateWorkflow(id, workflow, { revision: workflow.updated_at, note })` sends the revision as `If-Match`: when
  somebody saved in between, it throws `NodestroAPIError` 409 `workflow.conflict` (`params.updated_at` is the
  current revision) instead of overwriting their change. Without `revision` the save always applies.
- `listRuns({ limit, before })` returns one page, newest first; `listRunsPage()` also returns the cursor of the
  next page (`nextBefore`, `null` at the end), and `for await (const run of nodestro.iterRuns({ pageSize: 100 }))`
  reads every run, a page at a time, so runs started meanwhile never shift a page.
- `checkCompatibility()` compares `/api/meta` with `API_VERSION` and returns `{ compatible, apiVersion,
  sdkApiVersion, reason }`; it never throws for a mismatch. `0.x` versions fit only with the same minor version.
- `importLocalModel({ kind: "build", path: weights, template, name: "mdenseon:307m" })` builds a catalog model
  from its upstream files (the catalog's `build_inputs` name them).

## Waiting, events and cancelling

- `waitForRun()` / `wait()` / `waitForResult()` poll every `pollMs`. `timeoutMs` is the total wait; only the last
  status request may take up to the request time limit longer. On timeout they throw `NodestroTimeoutError` and
  the run keeps running (cancel it with `cancelRun()` / `cancel()`). `signal` (an `AbortSignal`) stops waiting at
  once, also during a pause, with the signal's reason; the run keeps running.
- `events()` is an async generator of `{ event, data, id }` until the run ends. Leaving the `for await` loop
  (`break`, `return`, an exception) closes the connection; `signal` (an `AbortSignal`) stops it from outside, and
  the abort error is passed on unchanged. An event the connection broke off in the middle of is dropped. By
  default a lost connection throws `NodestroConnectionError`; `events(runId, { lastEventId })` with the id of the
  last event then receives what was missed.
- `{ reconnect: true }` (or a `RetryPolicy`) on `events()`, `runChatEvents()` and the published `events()`
  reconnects by itself after a lost connection, a stream that ends before its `end` event or a 502/503/504, with
  growing pauses (`DEFAULT_RECONNECT`: 1 s doubling up to 15 s), until `end`. The published stream resumes with
  `Last-Event-ID`: a new `status` event, then every missed event, none twice. The studio streams have no event ids;
  each connection starts with a new `snapshot` of the whole run or chat. `attempts` counts connection attempts in a
  row without progress (no event after the opening one and open for less than a minute); then the last error is
  thrown. 401/403/404 and other refusals are thrown at once. `signal` ends the stream also during the pause before
  a reconnect:

  ```ts
  const controller = new AbortController(); // controller.abort() ends the loop with an AbortError
  for await (const event of api.events(runId, { reconnect: true, signal: controller.signal })) console.log(event.event);
  ```
- `start(values, { waitSeconds })` waits for the result on the server when the publication allows it; the request
  time limit is extended by `waitSeconds`.
- Downloads (`downloadFile()`, `download()`) return the whole file as a `Uint8Array`. For large files,
  `streamFile(runId, fileId, { signal, timeoutMs })` (both clients) returns a `ReadableStream<Uint8Array>` that
  reads the body only as it is consumed. A body that breaks off (fewer bytes than announced, a lost connection)
  errors the stream with `NodestroConnectionError`, a stall of `timeoutMs` (per piece, not for the whole file) with
  `NodestroTimeoutError`; cancel the stream or abort `signal` to stop early. Failures before the content starts
  (connection errors, 502/503/504) are retried. In Node.js, write it to a file with
  `await pipeline(Readable.fromWeb(stream), createWriteStream(path))` (and remove the file if that throws).
- A run that waits for a person is `paused`, and `waitForRun()` returns it (unless `stopAtApproval: false`). A
  budget wait has `run.budget?.pending_request_id` set; answer it as described under "Run budgets".

## Live run chat

While a run with an orchestrator is active, people can ask about it and steer it:

- `runChat(runId)`: the messages, the orchestrators one can talk to (`targets`, with what their teams do now) and
  the limits. Any run of the tree may be given; the chat belongs to the top-level run.
- `sendRunChatMessage(runId, { kind: "question" | "instruction", target_run_id, node_id, content, client_id? })`:
  a question is answered by a separate model call from the stored run state (it changes nothing; the answer
  arrives as a message of kind `answer`), an instruction goes to the orchestrator at its next decision. Each
  message carries a `client_id` (a random one unless given), so it is retried safely; the same `client_id` again
  returns the stored message, for another message it is refused (409 `run_chat.client_id_reused`).
- `runChatMessage(runId, messageId)`: one message (for example to see whether a question was answered).
- `runChatEvents(runId, { signal })`: `snapshot` (the whole view, on every connect), `message`, `targets` and
  `end`; it closes like `events()`. A reconnect gets a new snapshot.

Refusals are `NodestroAPIError`s with `run_chat.*` codes, for example 409 `run_chat.run_not_active` for a run that
ended, 429 `run_chat.too_many_questions`.

## Run budgets

An attended run whose next model request does not fit its budget pauses before the request is sent and waits for
a decision. Amounts are decimal strings (`"2.50"`) in both directions; the client never turns them into numbers.

- `getRunBudget(runId)`: the limits (`initial_limit_usd`, `limit_usd`), `spent_usd`, `remaining_usd`, the approved
  `raises`, the open request (`pending`), earlier requests (`history`) and what you may decide (`policy`:
  `can_decide`, `reason`, `max_limit_usd`). Any run of the tree may be given; the budget belongs to the top-level run.
- `listBudgetRequests()`: every open budget request (all runs), oldest first.
- `raiseRunBudget(runId, requestId, limitUsd, { idempotencyKey? })`: set the limit that stopped the run to
  `limitUsd` (a string with at most two decimal places; a number throws a `TypeError`) and continue the run, in one
  operation.
- `endRunForBudget(runId, requestId, { idempotencyKey? })`: end the run instead (`cancelled`, error code
  `run.budget_ended`).
- `decideRunBudget(runId, requestId, "raise" | "end", { limitUsd?, idempotencyKey? })`: both in one method.

All three resolve to the run's budget after the decision. Each decision carries an `idempotency_key` (a random one
unless given), so it is retried safely: the same decision with the same key by the same person returns the stored
result.

```ts
const run = await nodestro.waitForRun(runId);
const requestId = run.budget?.pending_request_id;
if (run.status === "paused" && requestId) {
  const view = await nodestro.getRunBudget(runId);
  console.log(view.spent_usd, view.limit_usd, view.pending?.suggested_limit_usd);
  await nodestro.raiseRunBudget(runId, requestId, "2.50");
}
```

Refusals are `NodestroAPIError`s: 404 (run or request unknown), 409 `budget.not_pending` (already decided, expired
or cancelled; `params.request_status`, `params.decided_by`), 422 `budget.limit_not_higher`
(`params.current_limit_usd`) and `budget.limit_invalid`, 403 `budget.over_policy` (above `params.max_limit_usd`) and
`access.forbidden` (only the person who started the run or an administrator decides; `params.reason`).

## Local models and the knowledge index

On a desktop installation Nodestro manages a local model server (Ollama) itself. The steps are explicit and run as
jobs on the computer that runs Nodestro; paths name files there:

```ts
const overview = await nodestro.localModels(); // status, catalog, hardware and a recommendation per task
if (!overview.status.runtime_installed) {
  let job = await nodestro.installLocalRuntime({ download: true }); // or { archive: "/path/ollama-linux-amd64.tar.zst" }
  while (job.state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    job = await nodestro.localModelJob(job.id);
  }
}
await nodestro.startLocalModels();
const { model } = await nodestro.recommendLocalModel("write"); // e.g. "ollama:qwen3.5:4b"
if (model) await nodestro.pullLocalModel(model); // network; offline: importLocalModel(...)
```

- `localModelJob(jobId)` reports `state` (`running`, `done`, `failed`, `cancelled`), `completed` of `total` and, on
  failure, `error_code`; `cancelLocalModelJob()` stops it.
- `recommendLocalModel(task)` takes the task profiles `classify`, `extract`, `write`, `document_vision`,
  `tool_agent`, `analysis`, `coding`, `judge`, `orchestrator`, `architect`, `assistant` and `embedding`; another
  name is refused with 400 `local.task_unknown`. A recommendation is a suggestion, never stored on its own.
- Refusals carry `local.*` codes, for example 400 `local.runtime_missing` (`startLocalModels()` before the runtime
  is installed), `local.not_running` (a download while no local server runs), `local.archive_or_download` and
  `local.file_missing`; tenants of a server get 403 `local.server_managed`.
- `knowledgeIndex()` shows the retrieval mode (`fts`, `vector`, `hybrid`) and how many chunks are embedded;
  `rebuildKnowledgeIndex(model?)` builds the semantic index with the embedding model of the settings (400
  `knowledge.embedding_model_missing` while none is chosen); searches keep the complete current index until the new
  one is finished, and `cancelKnowledgeIndex()` stops the build.

## Errors

`NodestroAPIError` (`status`, `code`, `detail`, `params`) when the API answers with an error, in either of its two
formats; any other answer (a proxy page, an empty body) gets code `http_error`, a redirect `http_redirect`.
`NodestroConnectionError` and `NodestroTimeoutError` keep the underlying error as `cause`. `NodestroRunFailed`
(`run`) is thrown by `waitForResult()` and `waitForRun({ raiseOnFailure: true })`. All derive from
`NodestroClientError`, which is also thrown for a successful answer that is not JSON (wrong base URL).

## Types

`components["schemas"]` and `paths` are generated with openapi-typescript from `openapi/nodestro-api.json`
(`npm run generate`); the clients return these types (`Run`, `Workflow`, `RunStatusOut`, `ResultFile`, ...).
`API_VERSION` names the API version of that contract.

## Browsers

- **Same origin only.** The Nodestro API sends CORS headers only for the studio's development server, so a page
  can call it only when it is served from the same origin as the API (for example behind one reverse proxy).
  Requests from another origin fail with `NodestroConnectionError`.
- **No API keys in public pages.** A key in a web page can be read by everyone who loads it. A browser application
  should call your own backend, which holds the key and uses `PublishedWorkflow` there.
- Idempotency keys come from `crypto.getRandomValues`, which pages served over plain HTTP have too
  (`crypto.randomUUID` exists only in secure contexts). Still, use HTTPS for anything that is not on this
  computer.

MIT, see [LICENSE](LICENSE).
