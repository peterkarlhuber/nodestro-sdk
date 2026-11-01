# TODO: nodestro-sdk

> Open work for this repository: release blockers, known bugs, security follow-ups, technical debt and planned improvements.
> GitHub issues are the source of truth for details; this file is the entry point and summary.
>
> **Last full review:** 2026-11-01 against `master` at `05080f6`.

## Summary

| Priority | Count |
|---|---|
| P0 Critical | 0 |
| P1 High | 0 |
| P2 Medium | 2 |
| P3 Low | 7 |
| P4 Optional | 4 |

**Release blockers:** None for this repository.

Both clients are complete for their scope and contract-tested against the pinned API. The open work is mainly
dependency and CI hygiene: four Dependabot pull requests fail on a now-unneeded token check, and TypeScript 7
breaks type generation. A few API features of 2026-11-01 also have no client methods yet.

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

### SDK-001 · Live Run Chat client methods (LRC-1)

- **Priority:** P2 Medium · **Status:** In progress · **Refs:** PR #46
- **What:** Client methods for run chat and steering, with types regenerated from api #49.
- **Next step:** Merge after api #49, re-pinned to the api merge commit, with the types regenerated
  (`make contract`).
- **Depends on:** nodestro-api API-015 (api #49)

### SDK-002 · `If-Match` on workflow updates and cursor paging of runs

- **Priority:** P3 Low · **Status:** Open · **Refs:** #49, backend audit section 14
- **What:** The API supports `If-Match` on `PUT /api/workflows/{id}` and `before` paging on `GET /api/runs`. The
  generated types know about both, but `update_workflow`/`updateWorkflow` and `list_runs`/`listRuns` do not use
  them.
- **Next step:** Add a revision argument and a paging helper in both clients, with tests against the test server.

### SDK-003 · Further studio API areas only through the generated types

- **Priority:** P4 Optional · **Status:** Open · **Refs:** `python/src/nodestro_client/client.py`, `typescript/src/client.ts`
- **What:** The clients have no methods for batches, schedules, test series, knowledge, input files or per-call
  tool approvals. Callers have to build these requests themselves.
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

- **Priority:** P3 Low · **Status:** Open · **Refs:** `README.md` "Security", `README.md` "Development"
- **What:**
  - "Security" says that the studio API has no login. A `nodestro-server` installation has logins, and the SDK
    cannot use them (SDK-005).
  - "Development" calls the dependencies private.
- **Next step:** Describe both profiles and what the SDK supports on each. Update the token note together with
  SDK-008.

## Technical debt

### SDK-008 · CI requires a read token, so every Dependabot PR fails

- **Priority:** P2 Medium · **Status:** Open · **Refs:** #47, PRs #38-#41
- **What:** Both CI jobs exit when `NODESTRO_READ` is empty. Dependabot runs get no secrets, and the dependencies
  are public now.
- **Next step:** Install anonymously and keep the token optional or remove it. Then re-run #38-#41.

### SDK-009 · TypeScript 7 (Dependabot #40) breaks type generation

- **Priority:** P3 Low · **Status:** Blocked · **Refs:** #48, PR #40
- **What:**
  - Checked locally: `tsc --noEmit` and the build pass with 7.0.2.
  - openapi-typescript (7.8.0 and 7.13.0) crashes under TypeScript 7, because it needs the TypeScript 5 compiler
    API. `make generate` and the CI check of the generated types would therefore fail.
- **Next step:** Do not merge #40. Ignore TypeScript majors in `.github/dependabot.yml`, or keep TypeScript 5 only
  for generation.
- **Depends on:** openapi-typescript support for TypeScript 7 (upstream)

### SDK-010 · Supported Node.js range and `@types/node` (Dependabot #41)

- **Priority:** P3 Low · **Status:** Needs decision · **Refs:** #50, PR #41
- **What:** `engines` says `>=20`, and CI tests 20 and 22. Node 20 is end-of-life, and Node 24 LTS is untested.
  `@types/node` 26 type-checks, but it should follow the lowest supported Node major.
- **Next step:** Choose the range, then update CI, `engines` and the README. Add an ignore rule for `@types/node`
  majors and close #41.

### SDK-011 · Minor Dependabot updates #39 and #38

- **Priority:** P3 Low · **Status:** Blocked · **Refs:** PR #39 (openapi-typescript 7.13.0), PR #38 (actions/setup-node 7.1.0)
- **What:**
  - openapi-typescript 7.13.0 changes the JSDoc layout of the generated types (checked locally), so #39 needs a
    regenerated `typescript/src/generated/openapi.ts` before CI can pass.
  - #38 needs only a green run.
- **Next step:** After SDK-008, rebase both, add the regenerated types to #39, and merge when green.
- **Depends on:** SDK-008

### SDK-012 · Python package not published to PyPI, TypeScript package not on npm

- **Priority:** P4 Optional · **Status:** Needs decision · **Refs:** `python/README.md`, `typescript/README.md` ("Installation")
- **What:** Users install from a git commit or a packed tarball. Neither package is published, and there is no
  release workflow with provenance.
- **Next step:** Decide whether to publish. If yes, add a tag-triggered release workflow with trusted publishing
  and provenance.

### SDK-013 · Supported Python versions

- **Priority:** P3 Low · **Status:** Needs decision · **Refs:** `python/pyproject.toml` (`requires-python = ">=3.10"`), CI matrix 3.10/3.13
- **What:** Python 3.10 reached end of life in October 2026, and 3.14 is not tested.
- **Next step:** Follow the platform decision in nodestro-api API-025, then update `requires-python`, the CI matrix
  and the README.
- **Depends on:** nodestro-api API-025

## Later optimizations

None known.

## Accepted risks

None known.

## Cross-repository dependencies

| This repo item | Other repo | Other item | Relation |
|---|---|---|---|
| SDK-001 | nodestro-api | API-015 (api #49) | api merges first; SDK re-pins and regenerates |
| SDK-005 | nodestro-api | API-012 | needs the server contract |
| SDK-013 | nodestro-api | API-025 | one platform decision |
| (pointer) | nodestro-api | API-016, API-017, API-018 | new API fields reach the SDK by regenerating at the next pin |

## Maintaining this file

- Add an entry when work is identified but not done in the current PR. Use the next free ID; IDs are never reused.
- Link a GitHub issue for anything concrete enough to be picked up; keep details in the issue, not here.
- When an item is finished, delete its entry in the PR that completes it and mention the ID in the PR description.
  Git history is the record; do not keep ticked checklists.
- Accepted risks stay listed with their reason until the risk is removed or re-evaluated.
- Re-review the whole file before each release and update the "Last full review" line.
- Security issues that are not yet fixed are described only in general terms here. Report details privately
  (GitHub private vulnerability reporting), never in this file or in public issues.
