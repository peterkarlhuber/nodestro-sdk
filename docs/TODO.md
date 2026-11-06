# TODO: nodestro-sdk

> Open work for this repository: release blockers, known bugs, security follow-ups, technical debt and planned improvements.
> GitHub issues are the source of truth for details; this file is the entry point and summary.
>
> **Last full review:** 2026-11-06 against master at 3cb5dde (TODO abatement round)

## Summary

| Priority | Count |
|---|---|
| P0 Critical | 0 |
| P1 High | 0 |
| P2 Medium | 0 |
| P3 Low | 2 |
| P4 Optional | 4 |

**Release blockers:** None for this repository; every entry below is not a release blocker.

Both clients are complete for their scope and contract-tested against the pinned API. The open work is mainly API
coverage and dependency hygiene: some API areas have no client methods yet (SDK-003), and TypeScript 7 still breaks
type generation with openapi-typescript 7.13.0, so Dependabot ignores TypeScript majors (SDK-009); `@types/node`
majors are ignored too, because it follows the lowest supported Node.js major (22). Since the TODO abatement round
(2026-11-06) the package needs Node.js 22.12 or later, CI tests Node.js 22 and 24, and Vitest 5 is in use.

## Priorities and statuses

- **P0 Critical**: data loss, security exposure, or broken core function; blocks any release.
- **P1 High**: blocks a planned release or a promised capability, or a significant risk.
- **P2 Medium**: real defect or gap with a workaround; schedule soon.
- **P3 Low**: minor defect, polish, or small debt.
- **P4 Optional**: improvement idea; not a defect.

Statuses: `Open`, `In progress` (PR linked), `Blocked` (names the blocker), `Needs decision` (owner decision pending),
`Needs external review`, `Accepted risk` (deliberately not fixed; reason stated).

## Release blockers and critical items

None known.

## Security

None known.

## Bugs and reliability

None known.

## Architecture and modularity

None known.

## Performance

None known.

## Features and enhancements

### SDK-003 · Further studio API areas only through the generated types

- **Priority:** P4 Optional · **Status:** Open · **Refs:** `python/src/nodestro_client/client.py`, `typescript/src/client.ts`
- **What:** The clients have no methods for batches, schedules, test series, knowledge files and search, input
  files, per-call tool approvals, exports or export jobs. Local models and the knowledge index have methods since
  #71 (building from weights since 2026-11-06), settings changes have `update_settings`/`updateSettings` since #79. Callers have to build the other requests themselves (the generated types cover them).
- **Next step:** Add methods for the areas that SDK users ask for, starting with batches and schedules.

### SDK-004 · Event streams and downloads

- **Priority:** P4 Optional · **Status:** Open · **Refs:** SDK quality round 2026-10-30 (remaining limitations)
- **What:** Waits can be stopped with an `AbortSignal` (TypeScript) and Python's waits now keep one overall timeout
  (TODO abatement round 2026-11-06). Left, by choice so far:
  - Published event streams do not reconnect by themselves (manual reconnect with `last_event_id`).
  - Downloads are read fully into memory.
- **Next step:** An opt-in auto-reconnect and streamed downloads when a user needs them.

### SDK-005 · Clients for the server profile

- **Priority:** P4 Optional · **Status:** Needs decision · **Refs:** backend audit D-18
- **What:** `NodestroClient` targets the desktop studio API. The server profile uses OIDC sessions, which a script
  cannot obtain. The server routes have a contract now (nodestro-api `openapi/nodestro-api-server.json`, API-012).
- **Next step:** Decide whether the server should offer a scriptable credential (for example personal access
  tokens). Then add it here and contract-test against the server document.
- **Depends on:** None

## Tests and quality assurance

None known.

## Platform coverage

### SDK-006 · Browsers, runtimes and operating systems not verified

- **Priority:** P3 Low · **Status:** Open · **Refs:** SDK quality round 2026-10-30
- **What:** Browser use is tested only in Chromium. Not verified: Firefox, Safari, Deno and Bun, Windows and macOS,
  and a real `nodestro-server` deployment.
- **Next step:** Add a browser smoke test (Playwright with Firefox and WebKit) for the TypeScript package, and
  record the results in the README.

## Documentation

## Technical debt

### SDK-009 · TypeScript 7 (Dependabot #40) breaks type generation

- **Priority:** P3 Low · **Status:** Blocked · **Refs:** #48, PR #40 (closed)
- **What:**
  - Checked locally: `tsc --noEmit` and the build pass with 7.0.2.
  - openapi-typescript (7.8.0 and 7.13.0) crashes under TypeScript 7, because it needs the TypeScript 5 compiler
    API. `make generate` and the CI check of the generated types would therefore fail.
- **Next step:** #40 is closed and `.github/dependabot.yml` ignores TypeScript majors (round 3). Revisit when
  openapi-typescript supports TypeScript 7.
- **Depends on:** openapi-typescript support for TypeScript 7 (upstream)
- **Also:** `npm audit` reports no advisory since the Vitest 5 lock update (2026-11-06).

### SDK-012 · Python package not published to PyPI, TypeScript package not on npm

- **Priority:** P4 Optional · **Status:** Needs decision · **Refs:** `python/README.md`, `typescript/README.md` ("Installation")
- **What:** Users install from a git commit or a packed tarball. Neither package is published, and there is no
  release workflow with provenance.
- **Next step:** Decide whether to publish. If yes, add a tag-triggered release workflow with trusted publishing
  and provenance.

## Later optimizations

None known.

## Accepted risks

None known.

## Cross-repository dependencies

| This repo item | Other repo | Other item | Relation |
|---|---|---|---|
| (pointer) | nodestro-studio | ST-052 (Dependabot policy: weekly groups, cooldown, manual merge; auto-merge prerequisites) | Full entry in studio |
| (pointer) | nodestro-api | API-012 (done: `openapi/nodestro-api-server.json`) | SDK-005 can contract-test against it |
| (pointer) | nodestro-api | API-016, API-017, API-018, API-053 | new API fields reach the SDK by regenerating at the next pin |

## CI access to private repositories

Keep the repository secret `NODESTRO_READ`; do not delete it. CI currently installs the sibling repositories anonymously
because they are public, and does not need the secret. When the repositories become private, CI authenticates again
with this read-only secret, passed only in the environment of the install steps (never in a global Git configuration,
a log or an image layer).

## Maintaining this file

- Add an entry when work is identified but not done in the current PR. Use the next free ID; IDs are never reused.
- Link a GitHub issue for anything concrete enough to be picked up; keep details in the issue, not here.
- When an item is finished, delete its entry in the PR that completes it and mention the ID in the PR description.
  Git history is the record; do not keep ticked checklists.
- Accepted risks stay listed with their reason until the risk is removed or re-evaluated.
- Re-review the whole file before each release and update the "Last full review" line.
- Security issues that are not yet fixed are described only in general terms here. Report details privately
  (GitHub private vulnerability reporting), never in this file or in public issues.
