# nodestro-client

Der Python-Client der [Nodestro API](https://github.com/peterkarlhuber/nodestro-api).

```bash
pip install "nodestro-client @ git+https://github.com/peterkarlhuber/nodestro-sdk.git@<commit>#subdirectory=python"
```

```python
from nodestro_client import NodestroClient, PublishedWorkflow

with NodestroClient("http://127.0.0.1:8000") as nodestro:
    workflow = nodestro.list_workflows()[0]
    run = nodestro.start_run(workflow["id"], input="Angebot für ACME")
    for event in nodestro.events(run["id"]):  # snapshot, event ..., end
        print(event.event)
    done = nodestro.wait_for_run(run["id"], raise_on_failure=True)
    print(done["output"])

# Eine veröffentlichte Workflow-API mit einem Nodestro-Schlüssel (Rechte run/read/approve):
with PublishedWorkflow("http://127.0.0.1:8000", "angebot", api_key="ndk_...") as api:
    started = api.start({"customer": "ACME"})  # mit Idempotency-Key, sicher wiederholbar
    result = api.wait_for_result(started["run_id"])
```

Fehler der API kommen als `NodestroAPIError` mit `status`, `code` (z. B. `auth.missing`, `run.agents_invalid`) und
`params`; nicht erreichbare Server als `NodestroConnectionError`, Zeitüberschreitungen als `NodestroTimeoutError`,
gescheiterte Läufe beim Warten als `NodestroRunFailed`. Die Request- und Response-Typen in `nodestro_client.models`
sind aus `openapi/nodestro-api.json` generiert (`make generate` im Repository).

MIT, siehe [LICENSE](LICENSE).
