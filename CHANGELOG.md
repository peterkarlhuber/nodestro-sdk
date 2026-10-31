# Changelog

## Unreleased

Release gate (evolution plan Q-3, 2026-10-31): the `test` extra pins `nodestro-api` at `3c0ffa2` (before: `3782f19`),
which adds the opt-in release gate of a publication. Types regenerated: `ReleaseGate`, `GateReport`, `GateItem`,
`GateOverride`, `GateRecord`, `Publication.gate`, `Release.gate`, `ReleaseSummary.gate`, `PublishIn.gate` and
`PublishIn.override`.

- Python `NodestroClient`: `release_gate(workflow_id, version=..., gate=...)` and
  `set_release_gate(publication_id, gate)` (`None` switches it off); `publish` documents `gate` and `override`.
- TypeScript `NodestroClient`: `releaseGate(workflowId, { version, gate })` and `setReleaseGate(publicationId, gate)`
  (`null` switches it off), and the types `ReleaseGate`, `ReleaseGateIn`, `GateReport`, `GateItem`, `GateOverride`.

Assistant live events (2026-10-31): the `test` extra pins `nodestro-api` at `3782f19` (before: `665f1ce`), which
fixes the payload of the assistant's live SSE events. No OpenAPI or client changes.

Comparing models in a test series (evolution plan Q-2, 2026-10-31): the `test` extra pins `nodestro-api` at
`665f1ce` (before: `ec860c9`). Types regenerated: `BenchmarkStart.models` and `BenchmarkRun.models` (agent node id ->
model), `Batch.model_overrides`, and `Settings.builtin_sandbox` from runtime `45e7774`. No client method changes.

Model prices and costs (PRICING-1, 2026-10-31): the `test` extra pins `nodestro-api` at `ec860c9` (before: `f55bd80`),
which adds the `/api/pricing` routes and the cost states of `/api/usage`. Types regenerated from its OpenAPI document.

- Python `NodestroClient`: `usage`, `list_prices`, `pricing_status`, `pricing_history`, `sync_prices`,
  `list_price_reviews`, `decide_price_review`, `set_price_override`, `remove_price_override`, `reconcile_costs`.
- TypeScript `NodestroClient`: `usage`, `listPrices`, `pricingStatus`, `pricingHistory`, `syncPrices`,
  `listPriceReviews`, `decidePriceReview`, `setPriceOverride`, `removePriceOverride`, `reconcileCosts`, and the types
  `UsageReport`, `PriceEntry`, `PricingOverview`, `PricingEvent`, `SyncReport`, `PriceReview`, `SubmitResult`,
  `OverrideIn`, `ReconciliationIn`, `ReconciliationReport`.
- Model ids with `/` (e.g. `org/model`) are sent as checked path segments.

"Used in" (2026-10-31): the `test` extra pins `nodestro-api` at `f55bd80` (before: `a08c9c3`), which adds the read-only
route `GET /api/used-by?kind=knowledge|tool|memory[&ref=…]`. The OpenAPI document is copied from that version
(`make contract`); the generated types gain `Reference` and `ReferenceUser` in Python and TypeScript.

Default judge for designed agents (2026-10-31): the `test` extra pins `nodestro-api` at `a08c9c3` (before: `f119cfc`),
which gives agents designed by the Agent Architect and the Workflow Architect the configured default model as their
quality judge and reports a default model without structured output (`draft.judge_unsupported`). The OpenAPI
document is unchanged, so the generated types are unchanged.

Server deployment (2026-10-31): the `test` extra pins `nodestro-api` at `f119cfc` (before: `817c8c4`), which adds the
`nodestro-server` command (migrations, API, workers, checks, backups) and HTTPS-only identity providers apart from
loopback development. The desktop app the SDK talks to is unchanged; the OpenAPI document is unchanged, so the
generated types are unchanged.

Server workers and container images (2026-10-31): the `test` extra pins `nodestro-api` at `817c8c4` (before:
`c0e61bd`), which adds the server's worker processes (ADR-0004) and tools with libraries in the Docker sandbox
(ADR-0006 point 6). The desktop app the SDK talks to is unchanged; the OpenAPI document is unchanged, so the
generated types are unchanged.

Server logins (2026-10-31): the `test` extra pins `nodestro-api` at `c0e61bd` (before: `0f439ea`), which adds
OpenID Connect logins, tenants and roles for the server profile (ADR-0003). The desktop app the SDK talks to is
unchanged, and so are its OpenAPI document and the generated types.

Desktop launch secret (2026-10-31): the `test` extra pins `nodestro-api` at `0f439ea` (before: `cd4b198`), which adds
the desktop app's per-launch secret (`NODESTRO_LAUNCH_SECRET`). Without that variable nothing changes for SDK
clients; the OpenAPI document is unchanged, so the generated types are unchanged.

Sandbox policy (2026-10-31): the `test` extra pins `nodestro-api` at `cd4b198` (before: `d8ed049`). Its OpenAPI
document adds `ToolInfo.trust` and `ReleaseBundle.tool_trust` (ADR-0006); the generated types are regenerated
(`make contract`). Published workflow APIs are unchanged.

Storage seams (2026-10-31): the `test` extra pins `nodestro-api` at `d8ed049` (before: `b794ebe`), which backs up
and restores through the runtime's public storage methods and refuses backups of a newer database schema. Its
OpenAPI document is unchanged, so the generated types are unchanged.

Operating profiles (2026-10-31): the `test` extra pins `nodestro-api` at `b794ebe` (before: `43595a7`), which adds
the operating profile and a permission on every studio route and refuses to offer the studio API to a network. Its
OpenAPI document is unchanged (`make contract` produces no diff), so the generated types are unchanged; the SDK
talks to published APIs with keys, which are unchanged.

Release check (2026-10-30): the `test` extra pins `nodestro-api` at `43595a7` (before: `2868b7b`). That API fixes an
`assistant.busy` race and refuses damaged backup archives with `400`; its OpenAPI document is unchanged, so the
generated types are unchanged.

Platform integration (2026-10-30): the `test` extra pins `nodestro-api` at `2868b7b` (before: `1ca296b`), the API of the
platform integration. Its OpenAPI document is unchanged, so the generated types are unchanged; both SDKs pass their
tests against a real server of that API (Node.js 20 and 22).

### Fixed

- Docs: the README examples started a published form with its fields (`start({"customer": "ACME"})`), which the API
  refuses with `422 request.invalid`; `start()` takes the request body, so a form is `{"values": {...}}` and free text
  `{"input": "..."}`. The docstrings of `start()` say so, and both SDKs test it against a published form.
- Python: a `PublishedWorkflow` given an `http_client` stored its API key on that client, so the key was sent with
  every later request of the client (also to other hosts), and two published workflows sharing one client used
  the same key. Headers are now added per request; the caller's client is left unchanged.
- Python: an `http_client` without `base_url` failed with "missing protocol", and one with a different `base_url`
  silently sent the requests there. The SDK now builds absolute URLs from its own base URL.
- Python: a redirect (3xx) was returned as a successful answer (for example `None` as a run). Both SDKs now report
  it as `NodestroAPIError` with code `http_redirect` and follow no redirects, so a key never goes elsewhere and a
  POST is never turned into a GET (the TypeScript client followed redirects before).
- `PublishedWorkflow.start(..., wait=...)` / `waitSeconds`: the request timed out before the server's wait ended
  and was retried, which returned a still running run early. The request time limit is now extended by the wait.
- TypeScript: starting a published workflow failed in browser pages served over plain HTTP outside localhost,
  because `crypto.randomUUID` exists only in secure contexts. Idempotency keys now come from
  `crypto.getRandomValues` (128 bits, the same 32 hex digits).
- TypeScript: the last event of a stream that broke off in the middle was delivered (often as text instead of
  JSON). Incomplete events are now dropped, as the SSE standard requires and the Python client already did. The
  parser also accepts lone CR line endings and ignores ids containing NULL, in both SDKs.
- TypeScript: the bodies of answers that were retried (502/503/504) were left open until garbage collection; they
  are now released. A body that broke off or timed out while being read surfaced as a raw `TypeError` or
  `DOMException`; it is now a `NodestroConnectionError` / `NodestroTimeoutError` (with `cause`) and is retried
  like a lost connection.
- TypeScript: an `AbortSignal` that stopped `events()` before the answer arrived became a
  `NodestroConnectionError`; the abort error is now passed on unchanged, as during reading.
- Python: `RetryPolicy(attempts=0)` ended in an `AssertionError`. Both SDKs now refuse retry policies with fewer
  than one attempt or negative or non-finite pauses (`ValueError` / `RangeError`); `attempts=NaN` made the
  TypeScript client fail without sending anything.
- Ids and slugs `""`, `.` and `..` were normalized by the URL handling into a different endpoint
  (`/api/runs/..` is `/api`). Both SDKs now refuse them; no id or slug of the API has these values.
- A successful answer that is not JSON (for example the studio's HTML page at a wrong base URL) raised a raw
  `JSONDecodeError` / `SyntaxError`; it is now a `NodestroClientError` naming the content type.
- Error bodies with unexpected types (for example `params` as a list) raised a `ValueError` while building the
  error; they now become a normal `NodestroAPIError`.
- Waiting (`wait_for_run`, `wait`, `wait_for_result` and their TypeScript counterparts) slept a full poll interval
  past its timeout; it now ends at the timeout. A poll interval of 0 or less polled without pause; it and
  negative or non-finite timeouts are now refused.

### Changed

- Invalid base URLs (no `http`/`https`, query, fragment, credentials), timeouts and empty API keys are refused when
  a client is created instead of failing at the first request.
- More precise return types where the contract has them: `check_workflow` / `checkWorkflow` (`WorkflowCheck`),
  `workflow_versions` (`VersionSummary`), `run_files` (`ResultFile`), agent templates (`AgentTemplate`),
  `list_tools` (`ToolInfo`) and `publish` (`PublishOut`). The values returned are unchanged. Python `events()`
  returns a `Generator`, so `.close()` type-checks.
- TypeScript: every method that returns a promise now rejects instead of throwing synchronously; `events()` is an
  async generator method. `NodestroClientError` accepts and keeps `cause`.
- Python: `PublishedWorkflow.events()` accepts `timeout` like `NodestroClient.events()`.
- Documentation in English, with the supported base URLs, timeout and retry semantics, closing streams,
  reconnecting with `Last-Event-ID`, the trust boundaries of both APIs, API keys in browsers, CORS and HTTPS.

### Tests and CI

- Regression tests for every fix above, and further real-server tests in both languages: workflow checks,
  versions, updates and deletion, result files and downloads, agent template updates, the examples in all six
  languages, published approvals with missing scopes and foreign keys, cancelling, continuing, version starts,
  usage and reconnecting with `Last-Event-ID`.
- The tests refuse a `NODESTRO_SDK_SERVER` that is not a `scripts/test_server.py` server (they change its data, and
  a real installation would call paid models); the test server's process is killed if it does not stop.
- `scripts/check_typescript_package.sh` installs the packed tarball into a fresh project, compiles a strict
  consumer against its type definitions and runs it; the CI runs it and the TypeScript tests on Node.js 20 and 22.
- The CI builds the Python wheel and sdist and installs the wheel into a clean environment without the API. The
  read token is handed to the dependency installation step only, through the environment instead of the global
  git configuration.

## Earlier changes, not yet released

- TypeScript: `events()` ends the connection when the caller leaves the loop early (`break`, `return`, an
  exception) and releases the reader. Before, the event stream stayed open until garbage collection. Events,
  stopping with `signal` and errors are unchanged.
- Python: ids, slugs and version numbers are encoded as single path segments, like `encodeURIComponent` in the
  TypeScript SDK, so an id with `/`, `?` or `#` cannot call a different endpoint.
- Tests against the current `nodestro-api` (including the host check with `--host 0.0.0.0`).
- CI: current actions (Node 24), checkout without stored credentials.

## 0.2.0 (2026-10-29)

- First version as a repository of its own, for platform 0.2 (starting point `nodestro` 0.1.0, commit 15e2076).
- The tests pin `nodestro-api` at an exact commit; the tested combination is recorded in
  `nodestro-studio/platform/versions.json`.
- CI with the repository secret `NODESTRO_READ`.
- New: the Python client `nodestro-client` and the TypeScript client `@nodestro/client`, generated from the
  OpenAPI contract of API 0.2.0.
