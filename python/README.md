# nodestro-client

The Python client of the [Nodestro API](https://github.com/peterkarlhuber/nodestro-api): `NodestroClient` for the
studio REST API of an installation and `PublishedWorkflow` for published, key-protected workflow APIs (served by
Nodestro or by a standalone export). Python 3.11+, synchronous, built on httpx; it needs neither the Nodestro
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
    # A new installation has no workflows yet: copy one from the example library (list_examples()).
    workflow = next(iter(nodestro.list_workflows()), None) or nodestro.copy_example("blog-article")
    run = nodestro.start_run(workflow["id"], input="Quote for ACME")  # needs the provider key of its agents
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

Never write a key into the code; read it from the environment or a secret store. A key comes from the studio
(publication, "API keys") or from `NodestroClient.publish(workflow_id, slug="quote")` and
`create_api_key("My app", ["run", "read"], [publication_id])`, whose `token` is the secret, returned only once.

A run calls the model provider of the workflow's agents. Without that provider's key (for example
`ANTHROPIC_API_KEY`, or the key entered in the studio's settings), `start_run()` raises `NodestroAPIError` with
status 400 and code `api_key_missing` (`params["provider"]` names the provider).

A **new** desktop installation uses local models by default (`settings()["default_model"]`, for example
`ollama:qwen3.5:4b`), and `copy_example()` gives the copied agents the local models recommended for this computer,
even when a cloud key is set. Until the local model runtime is installed and a model is downloaded, `start_run()`
raises `NodestroAPIError` with status 400, code `workflow.blocked` and the problem `check.local_runtime_missing` in
`params["problems"]`; see [Local models and the knowledge index](#local-models-and-the-knowledge-index), or choose a
cloud model as the default model in the studio's settings before copying the example.

`check_workflow(nodestro.get_workflow(workflow_id), workflow_id)` reports these problems without starting a run; it
takes the workflow document (also an unsaved one), not its id.

## Configuration

`NodestroClient(base_url, *, timeout=30.0, retry=None, headers=None, http_client=None)` and
`PublishedWorkflow(base_url, slug, *, api_key, timeout=30.0, retry=None, http_client=None)`:

- `base_url`: `http://` or `https://`, a host name, IPv4 or `[IPv6]` address, an optional port and an optional path
  prefix (`https://proxy.example.com/nodestro`); a trailing slash is ignored. A query, fragment or credentials in
  it are refused with `ValueError`.
- `timeout`: seconds for each phase of a request (connecting, sending, each read), not for the whole request.
- `retry`: `RetryPolicy(attempts=3, backoff=0.5, max_backoff=8.0)`. `attempts` counts the first try (`1` = never
  retry; values below 1 raise `ValueError`). Only reads, starts of runs (published workflows and `start_run`/`startRun`: idempotency key), run chat
  messages (`client_id`) and budget decisions (`idempotency_key`) are retried, after connection errors and
  502/503/504.
- `headers`: sent with every request (for example for a proxy).
- `http_client`: an `httpx.Client` of your own (proxies, certificates, limits). It is used as is, never changed
  (the key is added per request) and not closed by `close()`; you close it.

Use the clients as context managers, or call `close()`; closing twice is harmless.

Ids and slugs are encoded as single path segments; `""`, `.` and `..` are refused with `ValueError`.

## Revisions, paging and the API version

- `update_workflow(id, workflow, revision=workflow["updated_at"], note="...")` sends the revision as `If-Match`:
  when somebody saved in between, it raises `NodestroAPIError` 409 `workflow.conflict` (`params["updated_at"]` is
  the current revision) instead of overwriting their change. Without `revision` the save always applies.
- `list_runs(limit=..., before=...)` returns one page, newest first; `list_runs_page()` also returns the cursor of
  the next page (`RunPage.next_before`, `None` at the end), and `iter_runs(workflow_id=..., page_size=100)`
  yields every run, a page at a time, so runs started meanwhile never shift a page.
- `check_compatibility()` compares `/api/meta` with `API_VERSION` and returns `Compatibility(compatible,
  api_version, sdk_api_version, reason)`; it never raises for a mismatch. `0.x` versions fit only with the same
  minor version.
- `import_local_model("build", weights_path, name="mdenseon:307m", template=template_path)` builds a catalog model
  from its upstream files (the catalog's `build_inputs` name them).

## Waiting, events and cancelling

- `wait_for_run()` / `PublishedWorkflow.wait()` / `wait_for_result()` poll every `poll` seconds. `timeout` is the
  total wait: each status request gets the time that is left as its limit (at least half a second; a retry after
  a lost connection may add its pause). On timeout they raise `NodestroTimeoutError` and the run keeps running
  (cancel it with `cancel_run()` / `cancel()`).
- `events()` yields `Event(event, data, id)` until the run ends. `timeout` there limits the wait for the next line
  (the API sends a keep-alive every 15 seconds). Leaving the loop closes the connection once the generator is
  collected; to close it at once, use `contextlib.closing(nodestro.events(run_id))` or call `.close()`.
- An event the connection broke off in the middle of is dropped. By default a lost connection raises
  `NodestroConnectionError` (a stall `NodestroTimeoutError`); `PublishedWorkflow.events(run_id,
  last_event_id=<id of the last event>)` then receives what was missed.
- `reconnect=True` (or a `RetryPolicy`) on `events()`, `run_chat_events()` and `PublishedWorkflow.events()`
  reconnects by itself after a lost connection, a stall, a stream that ends before its `end` event or a
  502/503/504, with growing pauses (`DEFAULT_RECONNECT`: 1 s doubling up to 15 s), until `end`. The published
  stream resumes with `Last-Event-ID`: a new `status` event, then every missed event, none twice. The studio
  streams have no event ids; each connection starts with a new `snapshot` of the whole run or chat. `attempts`
  counts connection attempts in a row without progress (no event after the opening one and open for less than a
  minute); then the last error is raised. 401/403/404 and other refusals are raised at once.
  `stop=threading.Event()` ends the loop without an error, also during the pause before a reconnect:

  ```python
  stop = threading.Event()  # stop.set() from another thread ends the loop
  for event in api.events(run_id, reconnect=True, timeout=60, stop=stop):
      print(event.event, event.id)
  ```
- `start(values, wait=seconds)` waits for the result on the server when the publication allows it; the request
  timeout is extended by `wait`.
- Downloads (`download_file()`, `download()`) return the whole file as `bytes`. For large files,
  `stream_file(run_id, file_id, chunk_size=65536)` (both clients) yields the content in chunks as they arrive,
  and `save_file(run_id, file_id, path_or_binary_file)` writes it to disk without holding it in memory. A
  download that breaks off (fewer bytes than announced, a lost connection) raises `NodestroConnectionError`, a
  stall of `timeout` `NodestroTimeoutError`. `save_file` to a path writes a temporary file next to it and
  replaces the path only when the whole file arrived (no partial file is left behind); a file object keeps the
  part that arrived. Failures before the content starts (connection errors, 502/503/504) are retried.
- A run that waits for a person is `paused`, and `wait_for_run()` returns it (unless `stop_at_approval=False`). A
  budget wait has `run["budget"]["pending_request_id"]` set; answer it as described under "Run budgets".

## Live run chat

While a run with an orchestrator is active, people can ask about it and steer it:

- `run_chat(run_id)`: the messages, the orchestrators one can talk to (`targets`, with what their teams do now) and
  the limits. Any run of the tree may be given; the chat belongs to the top-level run.
- `send_run_chat_message(run_id, kind="question" | "instruction", target_run_id=..., node_id=..., content=...)`:
  a question is answered by a separate model call from the stored run state (it changes nothing; the answer
  arrives as a message of kind `answer`), an instruction goes to the orchestrator at its next decision. Each
  message carries a `client_id` (a random one unless given), so it is retried safely; the same `client_id` again
  returns the stored message, for another message it is refused (409 `run_chat.client_id_reused`).
- `run_chat_message(run_id, message_id)`: one message (for example to see whether a question was answered).
- `run_chat_events(run_id)`: `snapshot` (the whole view, on every connect), `message`, `targets` and `end`; it
  closes like `events()`. A reconnect gets a new snapshot.

Refusals are `NodestroAPIError`s with `run_chat.*` codes, for example 409 `run_chat.run_not_active` for a run that
ended, 429 `run_chat.too_many_questions`.

## Run budgets

An attended run whose next model request does not fit its budget pauses before the request is sent and waits for
a decision. Amounts are decimal strings (`"2.50"`) in both directions; the client never turns them into floats.

- `get_run_budget(run_id)`: the limits (`initial_limit_usd`, `limit_usd`), `spent_usd`, `remaining_usd`, the
  approved `raises`, the open request (`pending`), earlier requests (`history`) and what you may decide (`policy`:
  `can_decide`, `reason`, `max_limit_usd`). Any run of the tree may be given; the budget belongs to the top-level run.
- `list_budget_requests()`: every open budget request (all runs), oldest first.
- `raise_run_budget(run_id, request_id, limit_usd, *, idempotency_key=None)`: set the limit that stopped the run to
  `limit_usd` (a `str` or `Decimal` with at most two decimal places; a float raises `TypeError`) and continue the run,
  in one operation.
- `end_run_for_budget(run_id, request_id, *, idempotency_key=None)`: end the run instead (`cancelled`, error code
  `run.budget_ended`).
- `decide_run_budget(run_id, request_id, "raise" | "end", *, limit_usd=None, idempotency_key=None)`: both in one
  method.

All three return the run's budget after the decision. Each decision carries an `idempotency_key` (a random one unless
given), so it is retried safely: the same decision with the same key by the same person returns the stored result.

```python
run = nodestro.wait_for_run(run_id)
if run["status"] == "paused" and (run.get("budget") or {}).get("pending_request_id"):
    view = nodestro.get_run_budget(run_id)
    print(view["spent_usd"], view["limit_usd"], view["pending"]["suggested_limit_usd"])
    nodestro.raise_run_budget(run_id, run["budget"]["pending_request_id"], "2.50")
```

Refusals are `NodestroAPIError`s: 404 (run or request unknown), 409 `budget.not_pending` (already decided, expired
or cancelled; `params` has `request_status` and `decided_by`), 422 `budget.limit_not_higher`
(`params["current_limit_usd"]`) and `budget.limit_invalid`, 403 `budget.over_policy` (above
`params["max_limit_usd"]`) and `access.forbidden` (only the person who started the run or an administrator decides;
`params["reason"]`).

## Batches and schedules

```python
rows = nodestro.parse_batch_file(workflow_id, "customers.csv")["rows"]  # CSV, XLSX or JSON; nothing starts
batch_in = {"workflow_id": workflow_id, "rows": [{"values": row} for row in rows], "max_cost_usd": 2.0}
print(nodestro.plan_batch(batch_in)["estimate"])  # valid/invalid rows and the expected cost
batch = nodestro.create_batch(batch_in)  # follow it with get_batch(); pause/resume/cancel_batch()
csv = nodestro.export_batch(batch["id"])  # or format="json"

schedule = nodestro.create_schedule(
    {"workflow_id": workflow_id, "kind": "daily", "at": "07:00", "time_zone": "Europe/Vienna", "input": "Daily report"}
)
nodestro.enable_schedule(schedule["id"])  # created disabled; preview_schedule() checks first
```

`create_batch` is never retried automatically (a retry would start the rows twice). Schedules: `list_schedules`,
`get_schedule`, `update_schedule`, `disable_schedule`, `delete_schedule`, `schedule_time_zones`.

## Test series, knowledge, input files, tool approvals and exports

```python
suite = nodestro.create_test_series({"workflow_id": workflow_id, "name": "Offers", "cases": [{"input": "ACME"}]})
print(nodestro.plan_test_run(suite["id"], {"judge": False})["estimate"])
run = nodestro.wait_for_test_run(nodestro.start_test_run(suite["id"], {"judge": False})["id"])
# compare_test_runs(a, b), test_series_model_choice(suite_id, node_id), propose_test_case(failed_run_id)

nodestro.upload_knowledge(["returns.md", ("shipping.md", b"# Shipping ...")], collection="policies")
hits = nodestro.search_knowledge("returns", k=5, mode="fts")  # list_knowledge, update_knowledge, delete_knowledge

uploaded = nodestro.upload_inputs(["order.pdf"])  # each result: the stored "file" or a "problem"
nodestro.start_run(workflow_id, input="Check it", file_ids=[uploaded[0]["file"]["id"]])
nodestro.clean_up_inputs()  # files nobody uses; older_than_days= also those of older finished runs

record = nodestro.create_export(publication_id, {"kind": "standard"})  # check_export() first
nodestro.save_export(record["id"], "project.zip")  # streamed; a cut download leaves no partial file
job = nodestro.start_export_job(publication_id, {"kind": "portable", "confirm_distribution": True})
job = nodestro.wait_for_export_job(job["id"])  # "done" (export_id), "failed" (error_code) or "cancelled"
```

`start_test_run`, `upload_knowledge`, `upload_inputs` and `start_export_job` are never retried automatically.
Per-call tool approvals (`list_tool_approvals`, `run_tool_approvals`, `decide_tool_approval` with the question's
`arguments_hash`, `tool_approval_audit`) only have questions where the installation switched
`NODESTRO_TOOL_APPROVALS` on (off by default); the SDK never switches it on. On a server, portable export jobs wait in
the job queue (`queued`) until a worker builds them.

## Local models and the knowledge index

On a desktop installation Nodestro manages a local model server (Ollama) itself. The steps are explicit and run as
jobs on the computer that runs Nodestro; paths name files there:

```python
import time

overview = nodestro.local_models()  # status, catalog, hardware and a recommendation per task
if not overview["status"]["runtime_installed"]:
    job = nodestro.install_local_runtime(download=True)  # or archive="/path/ollama-linux-amd64.tar.zst" (offline)
    while (job := nodestro.local_model_job(job["id"]))["state"] == "running":
        time.sleep(2)
nodestro.start_local_models()
model = nodestro.recommend_local_model("write")["model"]  # e.g. "ollama:qwen3.5:4b"
if model:
    job = nodestro.pull_local_model(model)  # network; offline: import_local_model(...)
```

- `local_model_job(job_id)` reports `state` (`running`, `done`, `failed`, `cancelled`), `completed` of `total` and,
  on failure, `error_code`; `cancel_local_model_job()` stops it.
- `recommend_local_model(task)` takes the task profiles `classify`, `extract`, `write`, `document_vision`,
  `tool_agent`, `analysis`, `coding`, `judge`, `orchestrator`, `architect`, `assistant` and `embedding`; another
  name is refused with 400 `local.task_unknown`. A recommendation is a suggestion, never stored on its own.
- Refusals carry `local.*` codes, for example 400 `local.runtime_missing` (`start_local_models()` before the
  runtime is installed), `local.not_running` (a download while no local server runs), `local.archive_or_download`
  and `local.file_missing`; tenants of a server get 403 `local.server_managed`.
- `knowledge_index()` shows the retrieval mode (`fts`, `vector`, `hybrid`) and how many chunks are embedded;
  `rebuild_knowledge_index(model=None)` builds the semantic index with the embedding model of the settings (400
  `knowledge.embedding_model_missing` while none is chosen); searches keep the complete current index until the new
  one is finished, and `cancel_knowledge_index()` stops the build.

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
