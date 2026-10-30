# Changelog

## Unveröffentlicht

- TypeScript: `events()` beendet die Verbindung, wenn der Aufrufer die Schleife vorzeitig verlässt (`break`,
  `return`, Ausnahme), und gibt den Reader frei. Bisher blieb die Event-Stream-Verbindung offen, bis der Garbage
  Collector sie einsammelte. Ereignisse, Abbruch über `signal` und Fehler bleiben unverändert.
- Python: IDs, Slugs und Versionsnummern werden als einzelne Pfadsegmente kodiert, wie `encodeURIComponent` im
  TypeScript-SDK. Eine ID mit `/`, `?` oder `#` kann so keinen anderen Endpunkt aufrufen.
- Tests gegen `nodestro-api` am aktuellen Stand.
- CI: aktuelle Actions (Node 24), Checkout ohne gespeicherte Zugangsdaten.

## 0.2.0 (2026-10-29)

- Erste Version als eigenes Repository zur Plattform 0.2 (Ausgangspunkt `nodestro` 0.1.0, Commit 15e2076).
- Die Tests pinnen `nodestro-api` auf einen exakten Commit; die getestete Kombination steht in
  `nodestro-studio/platform/versions.json`.
- CI mit dem Repository-Secret `NODESTRO_READ`.
- Neu: Python-Client `nodestro-client` und TypeScript-Client `@nodestro/client`, aus dem OpenAPI-Vertrag der API 0.2.0
  generiert.
