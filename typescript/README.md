# @nodestro/client

The TypeScript client of the [Nodestro API](https://github.com/peterkarlhuber/nodestro-api): `NodestroClient` for
the studio REST API of an installation and `PublishedWorkflow` for published, key-protected workflow APIs (served
by Nodestro or by a standalone export). ES modules with type definitions, promises and async iterators, built on
`fetch`; no runtime dependencies.

Runs on Node.js 20 and later (tested with 20 and 22) and in browsers with `fetch`, `AbortSignal.timeout` and Web
Streams (tested with Chromium; see [Browsers](#browsers)).

## Installation

The package is not published to a registry. Build it from a checkout at the commit you want:

```bash
cd typescript && npm ci && npm run build && npm pack    # -> nodestro-client-0.2.0.tgz
npm install /path/to/nodestro-client-0.2.0.tgz         # in your project
```

## Quickstart

```ts
import { NodestroAPIError, NodestroClient, NodestroClientError, PublishedWorkflow } from "@nodestro/client";

// The studio API of a local installation (no key; it answers only this computer).
const nodestro = new NodestroClient("http://127.0.0.1:8000", { timeoutMs: 30_000 });
const [workflow] = await nodestro.listWorkflows();
const run = await nodestro.startRun(workflow!.id, { input: "Quote for ACME" });
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

## Options

`new NodestroClient(baseUrl, options)` and `new PublishedWorkflow(baseUrl, slug, { apiKey, ...options })`:

- `baseUrl`: `http://` or `https://`, a host name, IPv4 or `[IPv6]` address, an optional port and an optional path
  prefix; a trailing slash is ignored. A query, fragment or credentials throw a `TypeError`.
- `timeoutMs` (default 30 000): time limit of one request from sending it to the end of its body.
- `retry`: `{ attempts: 3, backoffMs: 500, maxBackoffMs: 8000 }`; `attempts` counts the first try (`1` = never
  retry; values below 1 throw a `RangeError`). Only reads, and starts of published workflows (idempotency key),
  are retried, after connection errors and 502/503/504. The bodies of discarded answers are released.
- `headers`: sent with every request; `PublishedWorkflow` always sends its own `Authorization`.
- `fetch`: a replacement for the global `fetch` (proxies, tests).

Ids and slugs are encoded as single path segments; `""`, `.` and `..` are refused.

## Waiting, events and cancelling

- `waitForRun()` / `wait()` / `waitForResult()` poll every `pollMs`. `timeoutMs` is the total wait; only the last
  status request may take up to the request time limit longer. On timeout they throw `NodestroTimeoutError` and
  the run keeps running (cancel it with `cancelRun()` / `cancel()`).
- `events()` is an async generator of `{ event, data, id }` until the run ends. Leaving the `for await` loop
  (`break`, `return`, an exception) closes the connection; `signal` (an `AbortSignal`) stops it from outside, and
  the abort error is passed on unchanged. An event the connection broke off in the middle of is dropped.
  Connections are not re-established automatically: call `events(runId, { lastEventId })` with the id of the last
  event to receive what was missed.
- `start(values, { waitSeconds })` waits for the result on the server when the publication allows it; the request
  time limit is extended by `waitSeconds`.
- Downloads (`downloadFile()`, `download()`) return the whole file as a `Uint8Array`.

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
