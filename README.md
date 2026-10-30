# Nodestro SDK

Python and TypeScript clients for the [Nodestro API](https://github.com/peterkarlhuber/nodestro-api). Both are
plain HTTP clients: they need neither the Nodestro runtime nor the API (nor the studio) installed, and they work
with a Nodestro installation as well as with a workflow exported as a standalone FastAPI project.

| Directory | Package | Requirements |
| --- | --- | --- |
| [`python/`](python/) | `nodestro-client` (import `nodestro_client`) | Python 3.10+, httpx; synchronous; typed models (`TypedDict`) |
| [`typescript/`](typescript/) | `@nodestro/client` | Node.js 20+ or a browser with `fetch`; ES modules; promises; types generated from OpenAPI |
| [`openapi/nodestro-api.json`](openapi/nodestro-api.json) | | the contract both packages' types are generated from |

## Two clients

- **`NodestroClient`** talks to the studio REST API of an installation (`/api`): workflows and their versions,
  pre-checks, runs, live events, approvals, continuing failed runs, result files, agents and agent templates,
  tools, the example library, publishing, and API keys.
- **`PublishedWorkflow`** talks to one published workflow API (`/api/published/{slug}`) with a Nodestro API key:
  start (with an `Idempotency-Key`), status, result, waiting, events with `Last-Event-ID`, cancelling,
  approvals, continuing, result files and usage. The same API is served by Nodestro itself and by a standalone
  export, so the client works with both.

Both clients offer the same operations under language-typical names (`wait_for_run` / `waitForRun`), and share:

- **Timeouts and retries.** Reads are retried after connection errors and 502/503/504 (3 attempts, exponential
  backoff with jitter). Requests that change something are never retried, except starts of published workflows,
  which carry an idempotency key, so a retry returns the same run instead of starting a second one.
- **One error class for both API error formats.** `NodestroAPIError` with `status`, `code` (for example
  `auth.missing`, `run.agents_invalid`) and `params`; `NodestroConnectionError`, `NodestroTimeoutError` and
  `NodestroRunFailed` for the rest. All derive from `NodestroClientError`.
- **No redirects.** A redirect is reported as `NodestroAPIError` with code `http_redirect`, so a key is never sent
  to another address; use the final address as the base URL.

## Compatibility

| | |
| --- | --- |
| SDK version | 0.2.0 (both packages) |
| API contract | Nodestro API 0.2.0 (`API_VERSION`; `openapi/nodestro-api.json`) |
| Tested against | `nodestro-api` at the commit pinned in [`python/pyproject.toml`](python/pyproject.toml) (`test` extra) |
| Platform | the tested combination of all components is recorded in `nodestro-studio/platform/versions.json` |

A newer API is not guaranteed to work with this SDK; the CI checks that the committed contract and the generated
types match the pinned API exactly.

## Security

- **The studio API has no login.** Nodestro listens on `127.0.0.1` by default and answers only this computer (and
  host names it was told about). Anyone who can reach it can change everything; `NodestroClient` adds no
  protection of its own. Do not expose it to a network.
- **Published APIs are protected by API keys** with the scopes `run`, `read` and `approve`. The server decides
  what a key may do; the SDK does not check scopes and a missing permission is a 403 `NodestroAPIError`.
- **API keys are secrets.** Use them in server-side code or local tools. Never put a long-lived key into a web page
  or app that others load: anyone can read it there. A browser application should call your own backend, which
  holds the key and talks to the published API.
- **Use HTTPS** for every server that is not on your own computer; plain `http://127.0.0.1` is fine locally. Over
  plain HTTP in a network, keys and run data can be read on the way.
- **Browsers:** the Nodestro API sends CORS headers only for the studio's development server, so a page can use
  the TypeScript client only when it is served from the same origin as the API (for example behind one reverse
  proxy). Calls from another origin fail with `NodestroConnectionError`.
- The clients send no telemetry, store nothing on disk, log nothing, and never put a key into an error message.

## Development

```bash
make install     # Python package with the dev and test extras, npm ci
make check       # ruff, ruff format, mypy, tsc and both test suites
make contract    # copy the contract from the installed nodestro-api and regenerate the types
make generate    # regenerate the types from openapi/nodestro-api.json
scripts/check_typescript_package.sh   # pack @nodestro/client and compile and run a consumer project against it
```

The tests start a real Nodestro API server (`scripts/test_server.py`) whose agents answer from a script, so no
model provider is called and nothing is paid. The `test` extra installs `nodestro-api` at the pinned commit for
this. `NODESTRO_SDK_SERVER=<url>` runs the tests against an already running `scripts/test_server.py` instead; the
tests refuse any other server, because they create workflows, publications and keys.

The CI needs the repository secret `NODESTRO_READ` (read access to orkexa and the Nodestro repositories); it is
only handed to the dependency installation step.

Part of the Nodestro platform; see the
[platform overview](https://github.com/peterkarlhuber/nodestro-studio/blob/master/docs/PLATFORM.md).

MIT, see [LICENSE](LICENSE).
