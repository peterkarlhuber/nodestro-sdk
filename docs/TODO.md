# TODO: nodestro-sdk

> Open work for this repository: release blockers, known bugs, security follow-ups, technical debt and planned improvements.
> GitHub issues are the source of truth for details; this file is the entry point and summary.
>
> **Last full review:** 2026-11-05 against `master` at `abdf686` (quality round 3 close-out; TODO consolidated).

## Summary

| Priority | Count |
|---|---|
| P0 Critical | 0 |
| P1 High | 0 |
| P2 Medium | 0 |
| P3 Low | 6 |
| P4 Optional | 5 |

**Release blockers:** None for this repository; every entry below is not a release blocker.

Both clients are complete for their scope and contract-tested against the pinned API (nodestro-api `5ee13f7`, #79).
The open work is mainly API coverage and dependency hygiene: some API areas have no client methods yet (SDK-003,
SDK-014), and TypeScript 7 still breaks type generation with openapi-typescript 7.13.0, so Dependabot ignores
TypeScript and `@types/node` majors since #79 (SDK-009, SDK-010). Dependency round 2026-11-05: #80 (TypeScript
5.9.3, `@types/node` 22.20.5) is merged; #81 (Vitest 5) is closed and Vitest majors are ignored until SDK-010 decides
the Node.js range, because Vitest 5 does not support Node.js 20.

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

### SDK-002 · `If-Match` on workflow updates and cursor paging of runs

- **Priority:** P3 Low · **Status:** Open · **Refs:** #49, backend audit section 14
- **What:** The API supports `If-Match` on `PUT /api/workflows/{id}` and `before` paging on `GET /api/runs`. The
  generated types know about both, but `update_workflow`/`updateWorkflow` and `list_runs`/`listRuns` do not use
  them.
- **Next step:** Add a revision argument and a paging helper in both clients, with tests against the test server.

### SDK-003 · Further studio API areas only through the generated types

- **Priority:** P4 Optional · **Status:** Open · **Refs:** `python/src/nodestro_client/client.py`, `typescript/src/client.ts`
- **What:** The clients have no methods for batches, schedules, test series, knowledge files and search, input
  files, per-call tool approvals, exports or export jobs. Local models and the knowledge index have methods since
  #71 (building from weights is SDK-014), settings changes have `update_settings`/`updateSettings` since #79. Callers have to build the other requests themselves (the generated types cover them).
- **Next step:** Add methods for the areas that SDK users ask for, starting with batches and schedules.

### SDK-004 · Ergonomics of waits, event streams and downloads

- **Priority:** P4 Optional · **Status:** Open · **Refs:** SDK quality round 2026-10-30 (remaining limitations)
- **What:** The current behavior was a deliberate choice:
  - TypeScript waits cannot be stopped with an `AbortSignal`.
  - Python timeouts apply per phase, not to the whole wait.
  - Published event streams do not reconnect by themselves (manual reconnect with `last_event_id`).
  - Downloads are read fully into memory.
- **Next step:** Add `signal` to `waitForRun`, an overall deadline in Python and an opt-in auto-reconnect when a
  user needs them.

### SDK-005 · Clients for the server profile

- **Priority:** P4 Optional · **Status:** Needs decision · **Refs:** backend audit D-18
- **What:** `NodestroClient` targets the desktop studio API. The server profile uses OIDC sessions, which a script
  cannot obtain, and the server routes have no contract to test against.
- **Next step:** Decide whether the server should offer a scriptable credential (for example personal access
  tokens). Then add it here and contract-test against the server document.
- **Depends on:** nodestro-api API-012

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

### SDK-007 · The README's security notes describe only the desktop

- **Priority:** P3 Low · **Status:** Open · **Refs:** `README.md` "Security"
- **What:** "Security" says that the studio API has no login. A `nodestro-server` installation has logins, and the
  SDK cannot use them (SDK-005).
- **Next step:** Describe both profiles and what the SDK supports on each.

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
- **Also:** the remaining moderate `npm audit` advisory (minimatch, GHSA-g3hv-75wg-m249) is a dev-only dependency
  of openapi-typescript (3 moderate dev advisories); no critical or high advisory is left (vitest 4.1.12, API2-13
  done).

### SDK-010 · Supported Node.js range and `@types/node` (Dependabot #41)

- **Priority:** P3 Low · **Status:** Decided (owner, 2026-11-05), not implemented · **Refs:** #50, PR #41 and #81
  (closed), studio ST-054 (Node.js 24 LTS)
- **What:** `engines` says `>=20`, and CI tests 20 and 22. Node 20 is end-of-life, and Node 24 LTS is untested.
  `@types/node` 26 type-checks, but it should follow the lowest supported Node major.
  Vitest 5 (Dependabot #81, closed 2026-11-05) declares `node: ^22.12.0 || ^24.0.0 || >=26.0.0`; its CI run on
  Node 20 passed, but only because npm does not enforce `engines`. Node.js 22 is supported until 2027-04-30.
  **Owner decision 2026-11-05:** the minimum may rise to Node.js `>=22.12`; CI covers Node 22 and 24.
- **Next step:** Separate pull request: `engines` `>=22.12`, CI matrix 22 and 24, README ("Node.js 22.12+"),
  `@types/node` 22 stays (lowest supported major). Dropping Node 20 is a breaking change for users of
  `@nodestro/client`: list it under "Changed" as **Breaking** in CHANGELOG and, because the package is still 0.x,
  raise the minor version (0.2.0 → 0.3.0) with the next version bump through the pin cascade; no release in that
  pull request. Then check Vitest 5 again on 22 and 24 (changelog, test run) in its own pull request and remove the
  Dependabot `ignore` rule for Vitest majors when it passes. The later move to Node 24 as the common version
  follows studio ST-054.

### SDK-012 · Python package not published to PyPI, TypeScript package not on npm

- **Priority:** P4 Optional · **Status:** Needs decision · **Refs:** `python/README.md`, `typescript/README.md` ("Installation")
- **What:** Users install from a git commit or a packed tarball. Neither package is published, and there is no
  release workflow with provenance.
- **Next step:** Decide whether to publish. If yes, add a tag-triggered release workflow with trusted publishing
  and provenance.

### SDK-013 · No compatibility check against the API version

- **Priority:** P4 Optional · **Status:** Open · **Refs:** backend audit round 2 API2-14, round 3 API3-12
- **What:** Both clients send a User-Agent (`nodestro-sdk-python/<version>`, `nodestro-sdk-ts/<version>`, since
  #67), but neither checks the API version it talks to.
- **Next step:** Add `check_compatibility()`/`checkCompatibility()` against `/api/meta`.

### SDK-014 · `import_local_model` cannot build from weights

- **Priority:** P3 Low · **Status:** Open · **Refs:** UX round 3 DX handover B11 (B3 and B10 done in #79)
- **What:** `import_local_model`/`importLocalModel` do not offer the API's import kind `build` with `template`.
- **Next step:** Add the kind and the template argument in both clients, with a test against the test server.

## Later optimizations

None known.

## Accepted risks

None known.

## Cross-repository dependencies

| This repo item | Other repo | Other item | Relation |
|---|---|---|---|
| (pointer) | nodestro-studio | ST-052 (Dependabot policy: weekly groups, cooldown, manual merge; auto-merge prerequisites) | Full entry in studio |
| SDK-005 | nodestro-api | API-012 | needs the server contract |
| (pointer) | nodestro-api | API-016, API-017, API-018, API-052, API-053 | new API fields reach the SDK by regenerating at the next pin |

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
