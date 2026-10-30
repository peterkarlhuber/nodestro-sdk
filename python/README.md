# nodestro-client

The Python client of the [Nodestro API](https://github.com/peterkarlhuber/nodestro-api): `NodestroClient` for the
studio REST API of an installation and `PublishedWorkflow` for published, key-protected workflow APIs (served by
Nodestro or by a standalone export). Python 3.10+, synchronous, built on httpx; it needs neither the Nodestro
runtime nor the API installed.

## Installation

The package is not published to PyPI; install it from the repository at a commit:

```bash
pip install "nodestro-client @ git+https://github.com/peterkarlhuber/nodestro-sdk.git@<commit>#subdirectory=python"
```

## Quickstart

```python
import os

from nodestro_client import NodestroAPIError, NodestroClient, NodestroClientError, PublishedWorkflow

# The studio API of a local installation (no key; it answers only this computer).
with NodestroClient("http://127.0.0.1:8000", timeout=30) as nodestro:
    workflow = nodestro.list_workflows()[0]
    run = nodestro.start_run(workflow["id"], input="Quote for ACME")
    for event in nodestro.events(run["id"]):  # snapshot, event ..., end
        print(event.event)
    done = nodestro.wait_for_run(run["id"], timeout=300, raise_on_failure=True)
    print(done["output"])

# A published workflow API with a Nodestro API key (scopes run, read, approve).
try:
    with PublishedWorkflow("https://nodestro.example.com", "quote", api_key=os.environ["NODESTRO_API_KEY"]) as api:
        started = api.start({"values": {"customer": "ACME"}})  # carries an Idempotency-Key: safe to retry
        result = api.wait_for_result(started["run_id"], timeout=600)
        print(result["output"])
except NodestroAPIError as error:  # the API answered with an error
    print(error.status, error.code, error.params)
except NodestroClientError as error:  # unreachable, timed out, run failed, ...
    print(error)
```

Never write a key into the code; read it from the environment or a secret store.

## Configuration

`NodestroClient(base_url, *, timeout=30.0, retry=None, headers=None, http_client=None)` and
`PublishedWorkflow(base_url, slug, *, api_key, timeout=30.0, retry=None, http_client=None)`:

- `base_url`: `http://` or `https://`, a host name, IPv4 or `[IPv6]` address, an optional port and an optional path
  prefix (`https://proxy.example.com/nodestro`); a trailing slash is ignored. A query, fragment or credentials in
  it are refused with `ValueError`.
- `timeout`: seconds for each phase of a request (connecting, sending, each read), not for the whole request.
- `retry`: `RetryPolicy(attempts=3, backoff=0.5, max_backoff=8.0)`. `attempts` counts the first try (`1` = never
  retry; values below 1 raise `ValueError`). Only reads, and starts of published workflows (idempotency key), are
  retried, after connection errors and 502/503/504.
- `headers`: sent with every request (for example for a proxy).
- `http_client`: an `httpx.Client` of your own (proxies, certificates, limits). It is used as is, never changed
  (the key is added per request) and not closed by `close()`; you close it.

Use the clients as context managers, or call `close()`; closing twice is harmless.

Ids and slugs are encoded as single path segments; `""`, `.` and `..` are refused with `ValueError`.

## Waiting, events and cancelling

- `wait_for_run()` / `PublishedWorkflow.wait()` / `wait_for_result()` poll every `poll` seconds. `timeout` is the
  total wait; only the last status request may take up to the request timeout longer. On timeout they raise
  `NodestroTimeoutError` and the run keeps running (cancel it with `cancel_run()` / `cancel()`).
- `events()` yields `Event(event, data, id)` until the run ends. `timeout` there limits the wait for the next line
  (the API sends a keep-alive every 15 seconds). Leaving the loop closes the connection once the generator is
  collected; to close it at once, use `contextlib.closing(nodestro.events(run_id))` or call `.close()`.
- An event the connection broke off in the middle of is dropped. Connections are not re-established
  automatically: call `PublishedWorkflow.events(run_id, last_event_id=<id of the last event>)` to receive what
  was missed.
- `start(values, wait=seconds)` waits for the result on the server when the publication allows it; the request
  timeout is extended by `wait`.
- Downloads (`download_file()`, `download()`) return the whole file as `bytes`.

## Errors

| Exception | When |
| --- | --- |
| `NodestroAPIError` | The API answered with an error: `status`, `code`, `message`, `params`. Both API error formats are read; any other answer (a proxy page, an empty body) gets code `http_error`, a redirect `http_redirect`. |
| `NodestroConnectionError` | The server could not be reached, also after the retries. |
| `NodestroTimeoutError` | A request or a wait took longer than allowed. |
| `NodestroRunFailed` | A run that was waited for with `raise_on_failure` / `wait_for_result()` failed or was cancelled (`run`). |
| `NodestroClientError` | Base class of all of these; also raised for a successful answer that is not JSON (wrong base URL). |

Invalid arguments (base URL, timeouts, retry policy, ids, an empty key) raise `ValueError` right away.

## Types

The request and response types in `nodestro_client.models` are `TypedDict`s generated from
`openapi/nodestro-api.json` (`make generate` in the repository); `API_VERSION` names the API version of that
contract. The package ships `py.typed`.

## Security

API keys are secrets: keep them out of code and logs, and use `https://` for every server that is not on this
computer. The SDK never follows redirects, so a key is not sent to another address, and it never puts a key into
an error message. The server decides what a key may do. See the [repository README](../README.md#security).

MIT, see [LICENSE](LICENSE).
