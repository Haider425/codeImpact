# MVP

## MVP Product Requirements and Engineering Specification

**Document type:** Product Requirements Document + Technical Design  
**Project duration:** 4–6 months  
**Team:** One developer  
**Product type:** GitHub-integrated developer SaaS  
**Primary users:** Software developers and engineering teams  
**Primary objective:** Identify code potentially affected by a pull request, recommend relevant tests, and explain every recommendation with inspectable evidence.

---

# 1. Executive Summary

CodeImpact analyzes changes in a software repository to help developers understand the potential consequences of a pull request before merging it.

A change to one function can affect other functions, modules, APIs, and tests. Developers can discover these relationships through manual investigation, code search, static analysis, and test execution, but the process can be time-consuming, particularly in unfamiliar repositories.

CodeImpact will construct a dependency graph from supported source code, identify symbols affected by a change, rank potentially relevant tests, and generate a report explaining its findings.

The system combines deterministic analysis with AI-assisted explanations.

The deterministic engine is responsible for:

- Parsing source code and extracting symbols.
    
- Building dependency relationships.
    
- Identifying changed symbols.
    
- Traversing the dependency graph.
    
- Ranking potentially affected components and tests.
    
- Attaching evidence to each result.
    

The AI layer is responsible for:

- Summarizing the potential impact.
    
- Explaining graph paths in developer-friendly language.
    
- Highlighting uncertainties and missing evidence.
    
- Producing structured explanations grounded in analysis results.
    

The AI layer must not invent dependencies, claim tests passed when they were not executed, or present uncertain relationships as confirmed facts.

## 1.1 Product vision

Make the consequences of a code change easier to understand before the change reaches production.

## 1.2 MVP objective

A developer connects a GitHub repository, opens a pull request, and receives an impact report identifying potentially affected symbols and relevant tests, with evidence supporting each recommendation.

The MVP must work end to end on real repositories, provide a usable web interface, and include a reproducible benchmark for measuring its analysis quality.

## 1.3 Non-goals

The MVP will not attempt to:

- Replace GitHub Actions or existing CI systems.
    
- Replace full test-suite execution.
    
- Guarantee that all runtime dependencies are discovered.
    
- Automatically approve or merge pull requests.
    
- Automatically modify source code.
    
- Support every programming language.
    
- Train a foundation model from scratch.
    
- Execute arbitrary repository code on the application server.
    
- Claim that a change is safe simply because no impact was found.
    

---

# 2. Problem Statement

## 2.1 User problem

When a developer changes a function, they need to understand what else may be affected.

Typical questions include:

1. Which functions call or depend on the changed code?
    
2. Which downstream modules may be affected?
    
3. Which tests are relevant to the change?
    
4. Why was a particular test recommended?
    
5. What relationships could the analysis not resolve?
    
6. How confident should the developer be in the results?
    

Existing workflows can require developers to search across multiple files, trace imports and calls manually, inspect test files, and rely on knowledge of the codebase.

CodeImpact should make this investigation faster without pretending to know more than the underlying evidence supports.

## 2.2 Initial target users

**Primary user:** A software developer working on a small or medium-sized Python or TypeScript repository.

**Secondary user:** A technical lead reviewing pull requests in an unfamiliar or frequently changing codebase.

**Initial adoption strategy:** Individual developers and small teams using GitHub repositories. Avoid enterprise-specific permissions, compliance requirements, and complex organization-wide administration until the core product works.

## 2.3 Core user story

As a developer, I want to connect my repository and analyze a pull request so that I can see which parts of the code may be affected, which tests deserve attention, and why the system recommends them.

## 2.4 Value proposition

CodeImpact provides three outputs in one workflow:

- **Impact map:** A graph of the changed code and its potentially affected dependencies.
    
- **Test recommendations:** A ranked list of relevant tests, each linked to the evidence behind its recommendation.
    
- **Impact report:** A concise explanation of the change, its potential consequences, and the limitations of the analysis.
    

The product succeeds if developers can understand and validate the recommendations, not merely if it produces an impressive-looking graph.

---

# 3. MVP Feature Scope

## 3.1 P0: Required for launch

### A. Repository onboarding

Users must be able to:

- Sign in using GitHub.
    
- Install or authorize the CodeImpact GitHub App.
    
- Select an accessible repository.
    
- View supported languages and analysis limitations.
    
- Trigger analysis for a pull request.
    
- View previous analysis runs.
    

The system must provide a clear error if a repository is inaccessible, unsupported, too large, or unable to be analyzed.

### B. Pull request ingestion

When a pull request is opened, updated, or manually selected:

- Identify the repository, base commit, and head commit.
    
- Retrieve the changed files and relevant source revisions.
    
- Detect additions, deletions, renames, and modifications.
    
- Deduplicate repeated webhook deliveries.
    
- Create an analysis job and expose its status.
    

GitHub documents an endpoint for listing pull-request files, including filenames, change counts, status, and patch information. Its documented response is capped at 3,000 files, so the product must detect unusually large changes and provide a graceful fallback rather than assume every pull request can be analyzed identically.

Reference: [https://docs.github.com/en/rest/pulls/pulls](https://docs.github.com/en/rest/pulls/pulls)

### C. Source parsing

The initial supported languages are:

1. Python
    
2. TypeScript
    

The parser must extract, where supported:

- Functions and methods.
    
- Classes and interfaces.
    
- Imports and exports.
    
- Call expressions.
    
- File-level relationships.
    
- Test files and recognizable test functions.
    
- Source locations, including line numbers.
    

Tree-sitter is suitable for syntax parsing because it provides language grammars, structured syntax trees, and query patterns. However, syntax parsing alone does not resolve every runtime or semantic relationship.

Reference: [https://tree-sitter.github.io/tree-sitter/using-parsers/](https://tree-sitter.github.io/tree-sitter/using-parsers/)

The parser must record unsupported or ambiguous constructs instead of silently treating them as understood.

### D. Dependency graph

Construct a graph containing:

- File nodes.
    
- Symbol nodes.
    
- Test nodes.
    
- Dependency edges.
    
- Change nodes or references to changed symbols.
    
- Evidence attached to each edge.
    

Examples of edge types:

- Imports.
    
- Calls.
    
- Exports and references.
    
- Test-to-symbol relationships.
    
- Known inheritance or interface relationships where reliably available.
    

Each edge must include provenance, such as the source file, line range, and extraction method.

The graph should distinguish confirmed static relationships from inferred or unresolved relationships.

### E. Change impact analysis

For each pull request:

1. Parse the base and head revisions.
    
2. Identify added, modified, and deleted symbols.
    
3. Map changed symbols to graph nodes.
    
4. Traverse relevant dependency relationships.
    
5. Identify potentially affected symbols and tests.
    
6. Rank the results.
    
7. Generate an evidence-backed report.
    

The report must distinguish direct impact from transitive impact.

A direct dependency is one edge away from a changed symbol. A transitive dependency is reachable through one or more intermediate relationships.

### F. Test recommendations

For each recommended test, show:

- Test name.
    
- Test file and source location.
    
- Impact ranking.
    
- Dependency path connecting the test to the changed code, when available.
    
- Reason for selection.
    
- Any limitations affecting the recommendation.
    

The initial version recommends tests. It does not need to execute arbitrary test commands.

### G. AI-generated explanation

Generate a structured summary containing:

- What changed.
    
- Which components may be affected.
    
- Why those components were selected.
    
- Which tests are recommended.
    
- What evidence supports the findings.
    
- What the analysis could not resolve.
    

Every factual statement about a dependency must be traceable to a graph edge or source location.

If the graph contains no evidence of a relationship, the AI must not invent one.

### H. Web application

The deployed application must provide:

- GitHub authentication.
    
- Repository selection.
    
- Pull-request selection.
    
- Analysis progress and failure states.
    
- Impact summary.
    
- Affected symbol list.
    
- Test recommendations.
    
- Interactive dependency graph.
    
- Evidence details.
    
- Historical analysis results.
    

The interface must be useful without requiring users to understand graph theory.

### I. Evaluation and observability

The project must include:

- Automated unit and integration tests.
    
- A reproducible evaluation dataset.
    
- Baseline algorithms.
    
- Metrics for impact and test-selection quality.
    
- Analysis latency measurements.
    
- Structured error logs.
    
- A benchmark report documenting limitations.
    

## 3.2 P1: Add after the core works

- GitHub Checks integration.
    
- Inline pull-request annotations.
    
- Incremental graph updates.
    
- Historical analysis comparisons.
    
- Configurable analysis limits.
    
- Support for additional TypeScript and Python project layouts.
    
- Test execution through an isolated external CI runner.
    

## 3.3 Explicitly out of scope

Do not build these during the initial MVP:

- A custom-trained language model.
    
- A general-purpose autonomous coding agent.
    
- Automatic code fixes.
    
- Multi-provider AI orchestration.
    
- Enterprise role-management systems.
    
- A marketplace for plugins.
    
- Ten or more programming languages.
    
- A complex billing system.
    
- A full replacement for CodeQL, CI, or existing test frameworks.
    

---

# 4. Product Workflow

## Step 1: Connect a repository

The user signs in and authorizes the GitHub App.

The application records the repository identifier and the minimum permissions required for its features.

## Step 2: Select a pull request

The user selects an existing pull request or opens one that triggers the integration.

CodeImpact identifies the base and head commits and creates an analysis run.

## Step 3: Analyze the change

The worker:

1. Retrieves required source files.
    
2. Parses the relevant revisions.
    
3. Extracts symbols and dependency relationships.
    
4. Identifies changed symbols.
    
5. Traverses the dependency graph.
    
6. Ranks affected symbols and candidate tests.
    
7. Stores the results.
    

## Step 4: Review the report

The user sees a summary such as:

- 3 changed symbols.
    
- 12 potentially affected symbols.
    
- 8 recommended tests.
    
- 2 unresolved dependency relationships.
    

These values are illustrative, not expected performance claims.

## Step 5: Inspect the evidence

Selecting a result reveals:

- The changed symbol.
    
- The dependency path.
    
- Relevant source locations.
    
- The edge types used.
    
- The reasoning behind the ranking.
    
- Any uncertainty flags.
    

## Step 6: Act on the recommendation

The developer can inspect the suggested tests and use their normal test runner or CI workflow to execute them.

The report must clearly distinguish tests recommended by CodeImpact from tests actually executed by another system.

---

# 5. Technical Architecture

## 5.1 Recommended stack

### Frontend

- Next.js
    
- React
    
- TypeScript
    
- A graph visualization library such as React Flow
    
- A component library for consistent interface design
    

### Backend

- Python
    
- FastAPI
    
- Pydantic for request and response validation
    
- A separate analysis worker
    

### Parsing and analysis

- Tree-sitter
    
- Language-specific extraction rules
    
- Custom graph representation and traversal algorithms
    
- pytest for testing the analysis engine
    

### Data and job processing

- PostgreSQL for persistent application data.
    
- Redis for queued jobs and temporary coordination.
    
- A worker process for repository analysis.
    

### AI

- One LLM API for explanations.
    
- A provider-independent adapter to avoid coupling the analysis engine to one model.
    
- Structured outputs validated against a schema.
    

### Infrastructure

- Docker.
    
- CI for tests and builds.
    
- A managed application deployment.
    
- Centralized application logs and basic error monitoring.
    

Do not add a graph database initially. PostgreSQL can store graph nodes, edges, and provenance while the graph algorithms run in Python. Reconsider the storage layer only if measurements show it is a bottleneck.

## 5.2 System components

### Component A: GitHub integration service

Responsibilities:

- Receive webhook events.
    
- Validate webhook signatures.
    
- Verify repository access.
    
- Fetch pull-request metadata and source revisions.
    
- Create analysis jobs.
    
- Publish results to GitHub when integration is enabled.
    

Webhook validation is essential. GitHub recommends verifying the HMAC signature in the `X-Hub-Signature-256` header before processing deliveries.

Reference: [https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

### Component B: Analysis orchestrator

Responsibilities:

- Track analysis state.
    
- Deduplicate jobs.
    
- Enforce repository and resource limits.
    
- Schedule worker execution.
    
- Retry transient failures.
    
- Record stage timings.
    
- Publish a final result or actionable failure.
    

Use an explicit job lifecycle:

`queued → fetching → parsing → graphing → ranking → explaining → completed`

Failures should record the stage, a safe error message, and whether retrying is appropriate.

For substantial analysis workloads, use a separate worker rather than relying on lightweight in-process background tasks. FastAPI's documentation similarly recommends larger task-processing tools for heavy work that can run outside the web process.

Reference: [https://fastapi.tiangolo.com/tutorial/background-tasks/](https://fastapi.tiangolo.com/tutorial/background-tasks/)

### Component C: Repository parser

Responsibilities:

- Enumerate permitted source files.
    
- Exclude generated files, dependency folders, and irrelevant binary files.
    
- Parse supported languages.
    
- Extract symbols and source locations.
    
- Record syntax errors and unsupported constructs.
    
- Produce normalized intermediate representations.
    

The parser should not need the LLM to identify basic syntax nodes or source locations.

### Component D: Graph builder

Responsibilities:

- Create nodes and typed edges.
    
- Resolve symbols to the extent possible.
    
- Connect imports, calls, and test relationships.
    
- Record evidence and uncertainty.
    
- Support queries from changed symbols to related nodes.
    

### Component E: Impact engine

Responsibilities:

- Map changes to graph nodes.
    
- Traverse dependency relationships.
    
- Rank affected components and tests.
    
- Produce a structured evidence bundle.
    
- Report unresolved relationships.
    

### Component F: Explanation engine

Responsibilities:

- Receive a bounded set of findings and evidence.
    
- Generate structured summaries.
    
- Validate output against a schema.
    
- Reject invalid source references.
    
- Mark unsupported claims as unavailable rather than guessing.
    

### Component G: Web application

Responsibilities:

- Display analysis state.
    
- Present the report.
    
- Allow graph exploration.
    
- Show source locations and explanations.
    
- Provide access to prior results.
    

---

# 6. Core Algorithm Design

The graph and impact engine are the technical heart of the project.

## 6.1 Intermediate representation

Do not let the frontend or AI layer depend directly on raw parser output.

Normalize extracted code into a consistent representation.

A symbol record should include:

- Stable symbol identifier.
    
- Repository identifier.
    
- File path.
    
- Symbol name.
    
- Symbol type.
    
- Start and end lines.
    
- Language.
    
- Export status, when available.
    
- Parser confidence or resolution status.
    

An edge record should include:

- Source symbol.
    
- Target symbol.
    
- Relationship type.
    
- Source file and line.
    
- Extraction method.
    
- Resolution status.
    

Use stable identifiers derived from repository revision, file path, symbol signature, and symbol type. Do not rely solely on line numbers because edits shift source locations.

## 6.2 Build the dependency graph

Represent the repository as a directed, typed graph:

G = (V, E)

Where:

- V represents files, symbols, and tests.
    
- E represents dependency relationships.
    

For example:

`checkout() → calculate_total() → apply_discount()`

If `apply_discount()` changes, the graph may identify `calculate_total()` and `checkout()` as potentially affected callers.

Direction matters. The engine must explicitly define whether an edge points from caller to callee or callee to caller and use that convention consistently.

For impact traversal, reverse edges can be useful when discovering upstream callers of a changed function.

## 6.3 Change detection

Compare the base and head revisions.

Classify changes as:

- New symbol.
    
- Modified symbol.
    
- Deleted symbol.
    
- Signature change.
    
- Export or interface change.
    
- File-level change with unresolved symbol mapping.
    

Where a symbol is renamed, avoid automatically treating the old and new symbols as unrelated if a reliable match can be established.

For the MVP, use deterministic matching based on file paths, symbol names, signatures, and structural information. Label uncertain matches instead of silently asserting equivalence.

## 6.4 Impact traversal

Start from changed symbols and traverse relevant graph edges.

A simple initial strategy:

1. Find directly connected symbols.
    
2. Traverse callers and selected dependency types.
    
3. Track shortest paths from each changed symbol.
    
4. Limit traversal depth.
    
5. Deduplicate nodes reachable through multiple paths.
    
6. Exclude or down-rank irrelevant relationships.
    
7. retain provenance for every discovered result.
    

Use breadth-first search for shortest dependency paths and deterministic graph traversal for reproducible rankings.

A traversal-depth limit is a practical MVP control. It should be configurable and visible in the report because deeper paths increase both computation and the chance of noisy results.

## 6.5 Initial ranking algorithm

Begin with a transparent heuristic, not a trained model.

For each candidate symbol or test, compute features such as:

- Shortest path distance from a changed symbol.
    
- Whether the relationship is direct or transitive.
    
- Number of changed dependencies.
    
- Whether the symbol is an exported API.
    
- Whether a test directly references the changed symbol.
    
- Whether the relationship was resolved statically.
    
- Whether the candidate depends on ambiguous dynamic behavior.
    

Normalize the features and combine them using a documented weighted score.

For example:

`score = w1 × proximity + w2 × direct_change_link + w3 × dependency_count + w4 × test_link_strength`

The exact feature definitions and weights must be documented and tested. Do not present the score as a calibrated probability of failure.

The report should explain why each item ranked highly.

## 6.6 Test selection

Build a test-to-symbol relationship map using:

- Test imports.
    
- Test calls.
    
- Fixtures and test setup where detectable.
    
- File-level dependencies.
    
- Naming or path heuristics only as weaker evidence.
    

Rank tests by their connection to changed symbols.

The MVP must compare this strategy against simple baselines:

- All tests.
    
- Tests in changed files.
    
- Tests in changed files and directly imported modules.
    
- Graph-based test selection.
    

This is important because regression test selection involves a trade-off between reducing testing cost and missing failures. Research has found that results vary with the program, test suite, and evaluation method.

References:

- [https://www.sciencedirect.com/science/article/pii/S0950584909001219](https://www.sciencedirect.com/science/article/pii/S0950584909001219)
    
- [https://doi.org/10.1145/3057269](https://doi.org/10.1145/3057269)
    

The system should not label a reduced test suite safe merely because it is smaller or because all selected tests pass.

---

# 7. AI Integration

## 7.1 Why use an LLM?

Graph traversal can identify relationships but does not always communicate their significance clearly.

The LLM should translate a structured evidence bundle into a concise report that a developer can understand.

Input evidence may include:

- Changed symbol descriptions.
    
- Dependency paths.
    
- Source locations.
    
- Candidate tests.
    
- Ranking features.
    
- Unresolved relationships.
    
- Explicit analysis limitations.
    

## 7.2 Output schema

The explanation engine should return a validated object containing:

- Summary.
    
- Changed components.
    
- Potentially affected components.
    
- Recommended tests.
    
- Evidence references.
    
- Limitations.
    
- Uncertainty notes.
    

Every referenced symbol and source location must exist in the supplied evidence bundle.

Reject or repair invalid structured output. Never accept a model-generated source location without validating it against the analysis results.

## 7.3 AI evaluation

Measure:

- Percentage of factual claims supported by evidence.
    
- Invalid source-reference rate.
    
- Unsupported dependency-claim rate.
    
- Human-rated usefulness.
    
- Explanation latency.
    
- Cost per analyzed pull request.
    

Use a manually reviewed sample to audit factual claims.

Do not equate a valid JSON response with a correct explanation. Schema validity is necessary but insufficient.

## 7.4 Security requirements

Treat repository contents as untrusted data, including comments, documentation, tests, and source strings.

A malicious repository may contain instructions intended to influence the LLM. Those instructions must be treated as data, not as commands.

The AI must have no authority to:

- Execute shell commands.
    
- Install packages.
    
- Modify repository contents.
    
- Access arbitrary network destinations.
    
- Read unrelated tenants' data.
    
- Change repository permissions.
    

Apply authorization and validation in application code, not in the model prompt alone.

Reference: [https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.md](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.md)

---

# 8. Data Model

Use PostgreSQL initially.

## 8.1 users

- id
    
- github_user_id
    
- username
    
- created_at
    

## 8.2 repositories

- id
    
- github_repository_id
    
- owner
    
- name
    
- installation_id
    
- default_branch
    
- created_at
    

## 8.3 repository_access

- user_id
    
- repository_id
    
- access_role
    
- granted_at
    

## 8.4 analysis_runs

- id
    
- repository_id
    
- pull_request_number
    
- base_sha
    
- head_sha
    
- status
    
- error_code
    
- started_at
    
- completed_at
    
- parser_version
    
- algorithm_version
    
- prompt_version
    
- model_identifier
    

## 8.5 symbols

- id
    
- repository_id
    
- commit_sha
    
- file_path
    
- qualified_name
    
- symbol_type
    
- start_line
    
- end_line
    
- language
    
- resolution_status
    

## 8.6 dependency_edges

- id
    
- repository_id
    
- commit_sha
    
- source_symbol_id
    
- target_symbol_id
    
- edge_type
    
- evidence_path
    
- evidence_line
    
- resolution_status
    

## 8.7 impact_findings

- id
    
- analysis_run_id
    
- symbol_id
    
- impact_type
    
- rank
    
- score
    
- evidence_json
    
- uncertainty_reason
    

## 8.8 test_recommendations

- id
    
- analysis_run_id
    
- test_symbol_id
    
- rank
    
- score
    
- selection_reason
    
- evidence_json
    

## 8.9 explanation_reports

- id
    
- analysis_run_id
    
- structured_output
    
- model_identifier
    
- prompt_version
    
- validation_status
    
- created_at
    

## 8.10 Important design rules

- Use commit SHAs to distinguish repository revisions.
    
- Make webhook processing idempotent.
    
- Preserve analysis and algorithm versions for reproducibility.
    
- Avoid storing full repository contents unless necessary.
    
- Encrypt credentials and minimize their retention.
    
- Enforce repository access on every read and write.
    
- Define retention and deletion behavior before public launch.
    

---

# 9. API Design

Illustrative endpoints:

## Authentication and repositories

- `GET /api/repositories`
    
- `GET /api/repositories/{repository_id}`
    
- `DELETE /api/repositories/{repository_id}/connection`
    

## Pull requests

- `GET /api/repositories/{repository_id}/pull-requests`
    
- `POST /api/repositories/{repository_id}/pull-requests/{number}/analyze`
    

## Analysis

- `GET /api/analyses/{analysis_id}`
    
- `GET /api/analyses/{analysis_id}/findings`
    
- `GET /api/analyses/{analysis_id}/tests`
    
- `GET /api/analyses/{analysis_id}/graph`
    
- `GET /api/analyses/{analysis_id}/report`
    

## Webhooks

- `POST /api/webhooks/github`
    

The analyze endpoint should return promptly with an analysis identifier. The client can poll for status in the MVP; real-time updates can be added later.

Validate all request parameters and verify that the requesting user is authorized to access the repository and analysis.

---

# 10. Evaluation Plan

Evaluation must be designed before tuning the ranking algorithm.

## 10.1 Evaluation dataset

Create a benchmark of historical pull requests from public repositories with:

- Base and head commits.
    
- Changed files and symbols.
    
- Available test suites.
    
- Test outcomes where reproducible.
    
- Known limitations.
    
- Manual labels for a subset of affected components.
    

Start with a small, carefully inspected set and expand only after the labeling process is reliable.

Do not assume every changed file or failing test provides a complete ground-truth label.

## 10.2 Avoid data leakage

Separate examples used to tune ranking weights from examples used for final evaluation.

Where possible, hold out repositories or later changes so the system is not evaluated only on patterns it has already seen.

Record:

- Repository and commit identifiers.
    
- Parser and algorithm versions.
    
- Dataset construction method.
    
- Exclusions.
    
- Missing ground truth.
    
- Reproduction instructions.
    

## 10.3 Baselines

Compare the graph-based algorithm against:

1. Running all available tests.
    
2. Selecting tests in changed files.
    
3. Selecting tests associated with directly changed dependencies.
    
4. Selecting tests using the full graph-based ranking.
    

If adding an ML-based ranking model later, compare it against the deterministic heuristic on the same held-out evaluation set.

## 10.4 Primary metrics

### Test-selection recall

Of the tests considered relevant under the benchmark's defined ground truth, what proportion did CodeImpact select?

### Test-suite reduction

What proportion of the original tests were excluded?

### Precision at K

Among the top K recommended tests or components, what proportion were relevant under the evaluation labels?

### Impact recall

What proportion of known affected components were identified?

### Analysis latency

Measure median and 95th-percentile end-to-end analysis time, grouped by repository size and changed-file count.

### Explanation grounding

Audit generated factual claims and measure the proportion supported by verifiable evidence.

### Reliability

Measure analysis completion rate, failure rate, retry rate, and duplicate-job prevention.

## 10.5 Initial success criteria

These are project targets, not existing results:

- Complete analysis on at least 90% of the defined supported benchmark cases.
    
- Achieve at least 90% test-selection recall on the labeled evaluation set.
    
- Reduce the selected test set meaningfully compared with running all tests, without hiding the recall trade-off.
    
- Keep at least 95% of audited factual explanation claims supported by verifiable evidence.
    
- Produce reproducible results for a fixed repository revision and algorithm version.
    
- Provide actionable failure messages when analysis is incomplete.
    

Report confidence intervals or sample sizes where appropriate. A high percentage on a tiny sample is not strong evidence.

If the targets are not met, document the result honestly and use the evaluation to improve the engine.

---

# 11. Security, Privacy, and Reliability

## 11.1 GitHub permissions

Request the minimum permissions required for the selected features.

Start with read access to repository contents and pull requests, plus only the webhook and Checks permissions needed for the features actually implemented.

Write permissions for GitHub Checks require a GitHub App. The MVP can begin with read-only analysis and the web interface, then add check publishing when the analysis workflow is stable.

Reference: [https://docs.github.com/en/rest/checks](https://docs.github.com/en/rest/checks)

## 11.2 Webhook security

- Verify webhook signatures.
    
- Process only supported events.
    
- Deduplicate delivery identifiers.
    
- Use HTTPS.
    
- Avoid logging secrets or raw authorization headers.
    
- Rotate credentials when needed.
    

## 11.3 Tenant isolation

- Enforce repository authorization in every endpoint.
    
- Prevent analysis IDs from being used to access another user's data.
    
- Restrict worker access to the job's repository.
    
- Separate tenant data logically and test authorization failures.
    

## 11.4 Resource limits

- Limit repository size and analysis duration.
    
- Limit file count and supported file types.
    
- Ignore generated files and dependency folders.
    
- Bound graph traversal and explanation input size.
    
- Apply API rate limits.
    
- Provide explicit partial-analysis status when limits are reached.
    

## 11.5 Safe analysis

The MVP must parse source files without executing repository code.

If isolated test execution is introduced later, use an isolated environment with restricted network access, resource limits, short-lived credentials, and no access to application secrets.

## 11.6 AI safety

- Treat source code and documentation as untrusted inputs.
    
- Validate model output.
    
- Do not allow model output to trigger tools or code execution.
    
- Never use model-generated reasoning as a substitute for authorization checks.
    
- Record model and prompt versions for reproducibility.
    

---

# 12. Six-Month Implementation Plan

## Month 1: Parsing and graph foundation

Deliverables:

- Repository import from local Git checkouts.
    
- Diff extraction.
    
- Python and TypeScript parsing.
    
- Symbol extraction.
    
- Basic import and call relationships.
    
- Graph traversal and path output.
    
- Unit tests for representative cases.
    

Acceptance criteria:

- Given a test repository and a fixed diff, the engine produces a deterministic graph and identifies direct dependencies.
    
- Unsupported constructs are reported.
    
- No source execution is required.
    

## Month 2: Impact engine and baseline evaluation

Deliverables:

- Changed-symbol identification.
    
- Direct and transitive impact analysis.
    
- Test discovery and linking.
    
- Deterministic ranking algorithm.
    
- Baseline implementations.
    
- Initial evaluation dataset.
    

Acceptance criteria:

- Results contain evidence paths.
    
- Rankings are reproducible.
    
- The benchmark can compare graph-based selection with simple baselines.
    

## Month 3: AI explanations and API

Deliverables:

- FastAPI service.
    
- Persistent analysis records.
    
- Structured explanation generation.
    
- Output validation.
    
- Explanation audit tooling.
    
- Integration and error-handling tests.
    

Acceptance criteria:

- Every generated finding links to evidence.
    
- Unsupported claims can be rejected or flagged.
    
- The service returns analysis status independently of completion time.
    

## Month 4: Web application and GitHub App

Deliverables:

- GitHub authentication.
    
- Repository selection.
    
- Pull-request ingestion.
    
- Job queue and worker.
    
- Analysis history.
    
- Impact report and graph interface.
    

Acceptance criteria:

- A user can connect a repository, analyze a supported pull request, and inspect the findings through the web application.
    

## Month 5: Reliability and developer workflow

Deliverables:

- Webhook signature validation.
    
- Idempotent event handling.
    
- Retry and timeout policies.
    
- Analysis caching where safe.
    
- GitHub Checks integration.
    
- Monitoring and deployment hardening.
    

Acceptance criteria:

- Duplicate webhook deliveries do not create duplicate analysis results.
    
- Failed jobs produce actionable errors.
    
- Pull requests can receive a check result when the integration is enabled.
    

## Month 6: Benchmark, polish, and launch

Deliverables:

- Held-out evaluation results.
    
- Performance report.
    
- Security review.
    
- Polished onboarding and error states.
    
- Public demo repository.
    
- Architecture documentation.
    
- Deployment instructions.
    
- Technical write-up of limitations and trade-offs.
    

Acceptance criteria:

- A new user can try the product without developer assistance.
    
- The benchmark can be reproduced from documented instructions.
    
- The report distinguishes measured performance from goals.
    
- Known limitations are visible and documented.
    

---

# 13. Launch Requirements

The MVP is ready to launch when all of the following are true:

- A user can authenticate with GitHub.
    
- A user can connect a supported repository.
    
- A pull request can trigger or manually start analysis.
    
- The analysis engine identifies changed symbols.
    
- The graph contains evidence-backed dependency edges.
    
- The engine produces ranked affected components.
    
- The engine recommends relevant tests.
    
- Each recommendation explains why it was selected.
    
- AI explanations are validated against supplied evidence.
    
- Users can inspect source locations and dependency paths.
    
- Analysis failures and unsupported cases are explained.
    
- Repository access is enforced.
    
- Webhook signatures are verified.
    
- Jobs are deduplicated and retried safely.
    
- Automated tests cover core algorithms and security boundaries.
    
- A benchmark compares results against simple baselines.
    
- Performance and accuracy claims are backed by measured results.
    
- The application is deployed and usable by someone other than its developer.
    

---

# 14. Main Risks and Mitigations

## Risk 1: Static analysis misses runtime relationships

Python and TypeScript can use dynamic behavior that is difficult to resolve from syntax alone.

Mitigation:

- Start with imports, calls, and explicit relationships.
    
- Mark unresolved relationships.
    
- Add richer semantic analysis only where the benchmark demonstrates a need.
    

## Risk 2: Test recommendations are noisy

A test can be related to a changed module without being useful for detecting the relevant regression.

Mitigation:

- Separate impact discovery from test ranking.
    
- Compare against simple baselines.
    
- Measure recall and reduction together.
    
- Never claim that selected tests are guaranteed to be sufficient.
    

## Risk 3: AI explanations sound convincing but are wrong

Mitigation:

- Supply bounded evidence.
    
- Require structured output.
    
- Validate source references.
    
- Audit factual claims.
    
- Keep AI out of the authoritative dependency engine.
    

## Risk 4: The project becomes too large

Mitigation:

- Support only Python and TypeScript initially.
    
- Start with a local analysis engine.
    
- Add the GitHub App after the core graph and ranking work.
    
- Defer model training and automatic test execution.
    

## Risk 5: Existing tools already solve parts of the problem

Mitigation:

- Do not claim to replace established code-analysis or test-selection systems.
    
- Focus on explainable dependency paths, visible uncertainty, and reproducible evaluation.
    
- Demonstrate value on real repositories and clearly identify where the system performs well or poorly.
    

---

# 15. Resume and Portfolio Deliverables

The project should ultimately include:

1. A live web application.
    
2. A public code repository with automated tests.
    
3. A demo repository with reproducible pull-request examples.
    
4. A system architecture diagram.
    
5. A benchmark dataset or documented dataset-construction process.
    
6. A report comparing graph-based analysis against simple baselines.
    
7. A technical article explaining algorithm design and trade-offs.
    
8. A short product demo showing the complete user workflow.
    

The resume should emphasize the actual graph algorithm, developer integration, asynchronous processing, and measured evaluation results.

A potential resume entry, to revise after implementation:

**CodeImpact | AI-Powered Code Impact Analysis Platform**

- Engineered a code analysis engine using syntax parsing and dependency graphs to identify potentially affected functions and tests across GitHub pull requests.
    
- Developed an evidence-grounded explanation pipeline using an LLM, validating generated findings against source locations and dependency paths.
    
- Built an asynchronous GitHub-integrated platform and benchmarked test-selection recall, test-suite reduction, and analysis latency across [N] repositories.
    

Only use claims supported by the completed implementation and evaluation.

---

# 16. Final Product Decision

Build the smallest version that proves the core value:

**Input:** A pull request in a supported Python or TypeScript repository.

**Processing:** Parse the change, construct or update a dependency graph, identify potentially affected symbols, rank relevant tests, and generate an evidence-backed explanation.

**Output:** A web-based impact report that a developer can inspect and use alongside their existing CI workflow.

Do not begin by building a large AI agent, training a custom model, or polishing a dashboard before the analysis engine works.

The defining achievement should be a reliable, testable code-analysis system wrapped in a usable product. Its strongest portfolio value will come from demonstrating not just that it works, but how you measured its accuracy, where it fails, and what you did to improve it.