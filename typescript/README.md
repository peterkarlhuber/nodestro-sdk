# @nodestro/client

Der TypeScript-Client der [Nodestro API](https://github.com/peterkarlhuber/nodestro-api), für Node 20+ und den
Browser (nutzt `fetch`).

Das Paket wird (noch) nicht in einer Registry veröffentlicht. Aus einem Checkout am gewünschten Commit:

```bash
cd typescript && npm ci && npm run build && npm pack    # -> nodestro-client-0.2.0.tgz
npm install /pfad/zu/nodestro-client-0.2.0.tgz          # im eigenen Projekt
```

```ts
import { NodestroClient, PublishedWorkflow } from "@nodestro/client";

const nodestro = new NodestroClient("http://127.0.0.1:8000");
const [workflow] = await nodestro.listWorkflows();
const run = await nodestro.startRun(workflow!.id, { input: "Angebot für ACME" });
for await (const event of nodestro.events(run.id)) console.log(event.event); // snapshot, event ..., end
const done = await nodestro.waitForRun(run.id, { raiseOnFailure: true });

const api = new PublishedWorkflow("http://127.0.0.1:8000", "angebot", { apiKey: "ndk_..." });
const started = await api.start({ customer: "ACME" }); // mit Idempotency-Key, sicher wiederholbar
const result = await api.waitForResult(started.run_id);
```

Fehler der API kommen als `NodestroAPIError` mit `status`, `code` und `params`. Die Typen
(`components["schemas"]`, `paths`) sind mit openapi-typescript aus `openapi/nodestro-api.json` generiert
(`npm run generate`).

MIT, siehe [LICENSE](LICENSE).
