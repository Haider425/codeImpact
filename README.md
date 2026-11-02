# CodeImpact

**CodeImpact** is a deterministic static-analysis and dependency-mapping engine for reviewing pull requests in Python and TypeScript repositories. It finds the symbols a pull request changed, traces their callers across files through a static dependency graph, and flags breakage in code the diff does not show. It also ranks the tests worth running. Every finding comes with inspectable evidence: the changed location, the affected location, and the dependency edges between them.

By default, repository code is parsed with Tree-sitter and never executed; all source is treated as untrusted text. Running the project's type checker and its impacted tests is opt-in, and happens in an isolated, read-only job.

The full product spec is in [codeImpact_mvp.md](codeImpact_mvp.md).

## GitHub Action

Add `.github/workflows/codeimpact.yml` to the repository you want reviewed:

```yaml
name: CodeImpact
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions: {}
concurrency:
  group: codeimpact-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  analyze:                      # runs repository code; read-only token
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0              # the merge base must be available
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: Haider425/codeImpact/actions/analyze@review-layer
        with:
          install-command: npm ci     # or: pip install -e ".[test]"
          typecheck: true             # optional, off by default
          run-tests: true             # optional, off by default

  comment:                      # never runs repository code; may write the PR comment
    needs: analyze
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: write
    steps:
      - uses: Haider425/codeImpact/actions/comment@review-layer
        with:
          fail-on-high: false         # true fails the check when high-severity findings exist
```

The comment is posted once and edited in place on every push. A finished example is the demo repository described in [Trying it end to end](#trying-it-end-to-end).

**`actions/analyze` inputs**

| Input | Default | |
|---|---|---|
| `install-command` | none | Installs the project's dependencies. Needed for type checks and test runs. |
| `typecheck` | `false` | Run `tsc` (needs a `tsconfig.json`) or pyright (needs a pyright or mypy config) on base and head. pyright is installed automatically for Python projects. |
| `run-tests` | `false` | Run the top-ranked impacted tests with pytest, vitest, or jest, and re-run failures on base. |
| `max-tests` | `20` | Upper bound on impacted tests to run. |
| `timeout-seconds` | `300` | Time limit for each type-check or test run. |
| `base`, `head` | PR base and head SHAs | Commit range to analyze; the diff starts at their merge base. |

**`actions/comment` inputs:** `fail-on-high` (default `false`), `github-token` (default: the workflow token), `dry-run` (render to the log and job summary only).

**Security model**

- The analyze job runs your install command and, if enabled, your tests, so it gets `contents: read` and nothing else. Checkout uses `persist-credentials: false`. Type checkers and tests run in a temporary copy of each revision, with an environment that drops tokens and secrets, under a hard time limit.
- The comment job holds `pull-requests: write`. It downloads the report artifact and runs one dependency-free script; it never checks out or executes the pull request's code.
- The report artifact comes from a job that ran repository code, so the comment step treats it as untrusted input. It validates every field, escapes HTML and markdown, neutralizes `@mentions`, URLs, and `#123` references, truncates long output, and builds links only from validated paths and from the repository name and commit SHAs in the trusted event payload.
- Do not trigger this workflow from `pull_request_target`.
- Fork pull requests get a read-only token, so the comment step writes the results to the job summary instead of commenting.
- Third-party actions are referenced by major tag (`@v4`). Pin them to commit SHAs if your policy requires it.

This repository reviews its own pull requests with [.github/workflows/codeimpact.yml](.github/workflows/codeimpact.yml). There, the comment job checks out the comment action from the PR's base commit, so a pull request cannot change the code that holds the write token. As a result, the comment job fails on the first pull request that adds the action, because the base commit does not contain it yet.

### Trying it end to end

A demo project lives outside this repository at `codeimpact-demo` (a sibling folder). Its `main` branch is a small TypeScript pricing module with passing tests. Its `break-discount` branch adds a required parameter to `applyDiscount()` without updating the caller in `src/cart.ts`. A pull request from `break-discount` produces three high-severity findings: a rule finding (missing argument), a type-checker finding (`tsc` TS2554 in `src/cart.ts`), and two impacted `checkout` tests that pass on `main` and fail on the PR.

To run the same steps locally without GitHub:

```bash
npm run review -- --repo ../codeimpact-demo --base main --head break-discount --typecheck --run-tests --output report.json
GITHUB_REPOSITORY=you/codeimpact-demo INPUT_REPORT_PATH=report.json INPUT_DRY_RUN=true node actions/comment/comment.mjs
```

## Quick start

Prerequisites: Node.js 20.11 or newer, and git.

```bash
git clone https://github.com/Haider425/codeImpact.git
cd codeImpact
npm install
npm run server      # API + inline worker on http://127.0.0.1:8787
npm run dev         # web UI on http://localhost:3000 (proxies /api to the server)
```

Open the UI and paste a public pull-request URL, such as `https://github.com/pallets/itsdangerous/pull/428`. The **Offline demo** link runs the bundled fixture entirely in the browser, with no server.

For a production-style single process, run `npm run build && npm run server`. The server also serves `dist/`.

Configuration lives in environment variables; see [.env.example](.env.example). Nothing is required. A `GITHUB_TOKEN` raises rate limits and allows private repositories. CodeImpact uses no language model and no paid service.

## How it works

```
GitHub PR / local range
  └─ fetch merge-base + head (shallow, bare cache, no checkout)      server/github.ts, server/git.ts
      └─ parse both revisions with tree-sitter (Python, TS, TSX)       src/analysis/parser.ts
          └─ resolve imports & calls → typed, evidence-carrying edges
              └─ diff symbols (body, signature, rename, module-level)   src/analysis/engine.ts
                  └─ BFS over reverse call edges, depth-limited
                      └─ rank findings + tests (documented weights)
                          └─ bounded evidence bundle → explanation      server/explain.ts
                              └─ validate every reference, else template
```

- **Edges carry provenance**: file, line, revision, extraction method, and a resolution status. `resolved` means confirmed through a declaration or import. `inferred` means matched by method name when the receiver type is unknown, including small override families. Calls that can't be resolved safely are listed, not dropped.
- **Ranking** (`RANKING_WEIGHTS` in `src/analysis/engine.ts`): 45% proximity, 20% direct link, 10% resolution, 10% test link, 10% fan-in, 5% exported API. Tests changed in the PR score 100. Tests linked only by a file import score 15. Scores order review priority; they are not failure probabilities.
- **Findings are merged by affected location.** Rule, type-checker, and failing-test evidence that point at the same caller become one finding. A failing test joins the finding whose caller lies on its dependency path. The finding's severity is that of its strongest evidence. The PR comment, the CLI, and the report page all show these merged findings, with the source of each piece of evidence.
- **Explanations** are generated by a fixed template from the analysis results. Every sentence cites refs that exist in the evidence bundle; no language model is involved.
- **Jobs** follow `queued → fetching → parsing → graphing → ranking → explaining → completed | failed`. Runs are deduplicated by repository, PR, commits, and engine version. Transient failures retry with backoff, and runs abandoned by a crashed worker are recovered. Webhook deliveries are HMAC-verified and deduplicated by delivery ID.

### Core modules

- `src/analysis/parser.ts`: Tree-sitter (WASM) parsing for Python and TypeScript. Extracts symbols, parameters, return and raise behaviour, call shapes, and import bindings, and resolves calls to declarations.
- `src/analysis/engine.ts`: diffs symbols between base and head, builds the dependency graph, and ranks impacted symbols and tests by shortest caller path.
- `src/analysis/review.ts`: deterministic review rules (signature contracts, removed or renamed symbols, broken imports, grouped unupdated callers). Exception inheritance lives in `src/analysis/exceptions.ts`.
- `server/evidence/`: opt-in type-checker and impacted-test runs, isolated in temporary copies.
- `server/review-cli.ts`: the reviewer CLI that the GitHub Action runs.
- `actions/analyze`, `actions/comment`: the GitHub Action.
- `server/eval/`: the benchmark harness behind `npm run bench`.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/config` | Server capabilities and versions |
| POST | `/api/analyses` | `{ "pullRequest": "owner/repo#12" }` → 202 `{ id }` (200 if deduplicated) |
| POST | `/api/local-analyses` | `{ repository, base, head }` for allow-listed local checkouts |
| GET | `/api/analyses`, `/api/analyses/:id` | History and status with stage timings |
| GET | `/api/analyses/:id/report` | Findings, tests, graph, evidence files, explanation |
| GET | `/api/analyses/:id/findings` · `/tests` · `/graph` | Slices of the report |
| POST | `/api/analyses/:id/retry` | Re-queue a failed run |
| GET | `/api/github/:owner/:repo/pull-requests` | Open PRs |
| GET/DELETE | `/api/repositories[/:id[/connection]]` | Connected repositories |
| POST | `/api/webhooks/github` | `pull_request` opened / synchronize / reopened |

## Scripts

| | |
|---|---|
| `npm test` | Engine, resolution, server, and security tests (the benchmark test runs when a clone exists) |
| `npm run bench` | Clones `pallets/itsdangerous` and writes `benchmark/REPORT.md` and `results.json` |
| `npm run typecheck` · `npm run lint` | |
| `npm run worker` | Standalone worker; use with `CODEIMPACT_WORKER=external` |
| `npm run review -- <PR or --repo …>` | Review one pull request or commit range from the terminal. `--typecheck` and `--run-tests` add evidence, `--store` saves the result for the web UI, and `--as owner/repo#N` labels a local checkout with its public pull request. |
| `npm run showcase:export -- --ids 2,3` | Copy selected completed analyses into `data/showcase.db`. `--list` shows what is available. Analyses of local checkouts need `--allow-local`, because their stored source files would be published. |

### Showcase mode

`CODEIMPACT_SHOWCASE=1 npm run server` serves `data/showcase.db` (or `CODEIMPACT_DB`) read-only. It runs no worker, and every write endpoint returns 403, as does the GitHub proxy. The dashboard hides the analysis forms. A typical flow:

1. Store analyses with `npm run review -- … --store`.
2. Pick the ones to publish with `npm run showcase:export -- --list`, then export them with `npm run showcase:export -- --ids …`.
3. Deploy with `CODEIMPACT_SHOWCASE=1`.

Hosting is not set up yet.

## Status against the MVP spec

Done:

- Python and TypeScript/TSX parsing. Import resolution covers relative imports, `src/` layouts, package re-exports, TS barrels, and default and namespace imports. Call resolution covers `self`/`this` methods, constructors, and module attributes.
- Change detection: body, signature, rename, deleted, added, module-level, and decorator changes. `@overload` stubs are skipped.
- Depth-limited BFS impact analysis with direct/transitive labels and evidence paths.
- Test recommendations with connection type, reasons, and limitations.
- Four baselines plus the graph strategy, with recall, reduction, and precision@K metrics, and a reproducible benchmark with a tune/holdout split.
- GitHub PR ingestion at the merge base with resource limits, and local git ranges.
- SQLite persistence, job queue, worker, retries, stale-job recovery, and deduplication.
- Webhook endpoint with HMAC verification and delivery deduplication.
- Deterministic explanations built from the evidence bundle.
- Web UI: dashboard, history, live progress, report, dependency map, evidence inspector, source viewer, baselines, and export.

Not done yet:

- **GitHub sign-in and per-user repository authorization.** There is no auth today, so keep the server bound to `127.0.0.1` and don't expose it with a token that can read private repositories.
- A GitHub App installation flow, plus Checks and inline annotations (P1).
- Postgres and Redis. SQLite covers both storage and the queue for now; the schema follows the spec's tables, with findings stored as JSON per run.
- pytest fixture and inheritance linking, and tsconfig `paths` aliases.
- A larger labelled benchmark. Four commits is a harness, not evidence.
- API rate limiting.
- Deployment config (Docker, CI) and centralized monitoring.
