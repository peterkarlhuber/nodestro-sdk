# Nodestro SDK

Clients für die [Nodestro API](https://github.com/peterkarlhuber/nodestro-api) in Python und TypeScript. Beide
sprechen nur HTTP: Sie brauchen weder die Runtime noch die API installiert und funktionieren mit Nodestro selbst
(lokal oder im Netz freigegeben) und mit Workflows, die als eigenständiges FastAPI-Projekt exportiert wurden.

| Verzeichnis | Paket | |
| --- | --- | --- |
| [`python/`](python/) | `nodestro-client` (`nodestro_client`) | Python 3.10+, httpx, typisierte Modelle (TypedDict) |
| [`typescript/`](typescript/) | `@nodestro/client` | Node 20+ und Browser (fetch), ES-Module, Typen aus OpenAPI |
| [`openapi/nodestro-api.json`](openapi/nodestro-api.json) | | der Vertrag, aus dem beide Typen generiert sind (API 0.2.0) |

Beide Clients bieten dasselbe:

- `NodestroClient`: die Studio-REST-API einer Installation (Workflows, Läufe, Live-Events, Freigaben, Fortsetzen,
  Agenten und Vorlagen, Tools, Beispiele, Veröffentlichen, API-Schlüssel).
- `PublishedWorkflow`: eine veröffentlichte Workflow-API mit Nodestro-Schlüssel (Start mit `Idempotency-Key`,
  Status, Ergebnis, Warten, Events mit `Last-Event-ID`, Abbruch, Freigaben, Fortsetzen, Dateien, Nutzung).
- Zeitlimits, Wiederholungen bei Verbindungsfehlern und 502/503/504 (Anfragen, die etwas ändern, nur mit
  Idempotenzschlüssel), und eine Fehlerklasse für beide Fehlerformate der API (`status`, `code`, `params`).

Teil der Nodestro-Plattform; den Überblick gibt
[PLATTFORM.md](https://github.com/peterkarlhuber/nodestro-studio/blob/master/docs/PLATTFORM.md).

## Entwicklung

```bash
make install     # Python-Paket mit dev- und test-Extra, npm ci
make check       # ruff, mypy, typecheck und beide Testsuiten
make contract    # Vertrag aus der installierten nodestro-api übernehmen und Typen neu erzeugen
```

Die Tests starten einen echten Nodestro-Server (`scripts/test_server.py`) mit simulierten Modellen, es wird nichts
bezahlt. Dafür installiert das `test`-Extra `nodestro-api` am gepinnten Commit; mit `NODESTRO_SDK_SERVER=<url>`
laufen sie gegen einen bereits laufenden Server. Die CI prüft außerdem, dass Vertrag und generierte Typen zur
gepinnten API passen und dass der Python-Client ohne die API installierbar ist.

Die CI braucht das Repository-Secret `NODESTRO_READ` (Lesezugriff auf orkexa und die nodestro-Repositories).

MIT, siehe [LICENSE](LICENSE).
