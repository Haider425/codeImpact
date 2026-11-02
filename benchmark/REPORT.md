# Benchmark report

Generated 2026-11-02T04:45:36.141Z · win32 x64 · Node v26.13.0 · Python 3.11.9 · pyright 1.1.414

## What this measures

CodeImpact is run on commits that inject a known breaking change into a real repository, and on real merged pull requests from the same repositories. Five modes are compared. All five come from the same analysis run, so they see the same evidence:

- **Diff-only, rules**: only findings whose location is in a file the commit changed.
- **Diff-only, rules + type checker + tests**: only findings whose location is in a file the commit changed.
- **Impact, rules**
- **Impact, rules + type checker**
- **Impact, rules + type checker + tests**

> **The diff-only modes are an ablation of CodeImpact itself, not a comparison with CodeRabbit or any other product.** They apply the same rules and evidence, restricted to what is visible in the changed files. No third-party reviewer was run.

**Sample size.** 89 injected cases over 3 repositories (44 tuning, 45 held-out), plus 36 real pull requests. Every cell below is small; read the 95% intervals, not the point estimates.

## Method

- **Repositories** (cloned at the commit shown, deleted afterwards):
  - [pallets/itsdangerous](https://github.com/pallets/itsdangerous) @ `672971d66a` (python): 6 target functions, 30 injected cases, 12 real PRs, 506.0 s total.
  - [pallets/click](https://github.com/pallets/click) @ `2247b35ea1` (python): 6 target functions, 30 injected cases, 12 real PRs, 1047.4 s total.
  - [unjs/ufo](https://github.com/unjs/ufo) @ `f06c800d0c` (typescript): 6 target functions, 29 injected cases, 12 real PRs, 592.7 s total.
- **Target selection.** For each repository, every function in the head revision was a candidate when it:
  - is a top-level function (not a method or nested function) in a file under `src/` that is not a test file;
  - has a name of at least 5 characters that does not start with `__` and is unique among all symbols in the repository, so the textual oracle cannot confuse it with another definition;
  - has between 1 and 25 textual call sites, counted by the same oracle used for scoring.
  Candidates were ordered by an FNV-1a hash of `repository:name`, and the first 6 were taken. No one picked or excluded functions by hand.
  The selection **does favour called functions**: it requires at least one call site, because a break with no caller cannot be measured. It **does not look at tests**. As a result, 17 of 18 targets had at least one impacted test linked to them, and 14 of 18 had callers outside their own file. Targets and call-site counts: `itsdangerous:want_bytes` (21 call sites, 2 in its own file, 20 linked tests), `itsdangerous:base64_encode` (4 call sites, 0 in its own file, 20 linked tests), `itsdangerous:base64_decode` (5 call sites, 0 in its own file, 20 linked tests), `itsdangerous:is_text_serializer` (2 call sites, 2 in its own file, 13 linked tests), `itsdangerous:bytes_to_int` (2 call sites, 0 in its own file, 13 linked tests), `itsdangerous:int_to_bytes` (2 call sites, 0 in its own file, 10 linked tests), `click:get_text_stderr` (2 call sites, 0 in its own file, 20 linked tests), `click:_is_incomplete_argument` (1 call site, 1 in its own file, 20 linked tests), `click:custom_version_option` (2 call sites, 0 in its own file, 20 linked tests), `click:_make_default_short_help` (2 call sites, 0 in its own file, 20 linked tests), `click:_resolve_pager_command` (1 call site, 1 in its own file, 20 linked tests), `click:make_pass_decorator` (8 call sites, 0 in its own file, 20 linked tests), `ufo:parseAuth` (3 call sites, 0 in its own file, 0 linked tests), `ufo:withLeadingSlash` (2 call sites, 2 in its own file, 1 linked test), `ufo:encodePath` (4 call sites, 1 in its own file, 2 linked tests), `ufo:withFragment` (1 call site, 0 in its own file, 1 linked test), `ufo:joinURL` (3 call sites, 1 in its own file, 2 linked tests), `ufo:encodeHash` (4 call sites, 0 in its own file, 2 linked tests).
- **Injected break types:**
  - `signature`: a new required first parameter.
  - `rename`: the definition is renamed.
  - `delete`: the definition is removed.
  - `return-shape`: every single-line `return X` becomes `return [X]`.
  - `raise`: an unconditional `raise RuntimeError` / `throw new Error` at the top of the body.
  Each break is one commit on top of the repository head, built with git plumbing.
- **Ground truth.** It comes from a text-based oracle (`server/eval/inject.ts`) that is independent of CodeImpact's parser:
  - Every textual call of the name counts, outside comments and the definition itself.
  - For `rename` and `delete`, import and re-export lines of the name count too.
  - For `return-shape`, only calls whose value is used count.
  - For `raise`, calls inside a `try` that catches the exception are excluded.
  - Test files count, because a broken test call is a real break.
  The oracle can be wrong; see Limitations.
- **Matching.** A finding is correct when its affected location, or one of its affected callers, is an oracle location (same file and line). A failing-test finding with no caller location also counts when it is linked to the changed file. For the diff-only modes, type-checker errors inside the changed file also count. They sit on the lines the commit changed or on lines that use the changed function, which the call-site oracle does not cover. Each of the 21 such errors on the held-out set was reviewed from its message and location in the saved results; each is a return-type error on a changed line, a type error on a line that uses the value of the changed function, or an undefined-name error where the deleted function is referenced. The strict numbers, without that allowance, are in the footnote under the headline table.
- **Metrics:**
  - Case recall: cases with at least one correct flagged finding.
  - Location recall: oracle locations covered.
  - Precision: correct flagged findings over all flagged findings, pooled.
  - False positives per case.
  - Runtime: analysis, plus the type checker and tests for the modes that use them.
- **Threshold.** The only tuned parameter is the minimum severity that counts as flagged. It was chosen on the tuning split alone, by F1 of case recall and precision for the impact + type checker + tests mode: **`medium`**.
- **Evidence settings.** Type checker: tsc for TypeScript, pyright for Python, 180 s limit per run. Tests: up to 20 top-ranked impacted tests, 300 s limit, failures re-run on the base revision.

## Headline: held-out injected cases (n = 45, threshold `medium`)

| Mode | Cases detected | Case recall (95% CI) | Location recall | Inside the diff | Outside the diff | Precision (95% CI) | False positives per case | Median runtime | p95 runtime |
|---|---|---|---|---|---|---|---|---|---|
| Diff-only, rules | 9/45 | 20% (11–34%) | 5% (12/241) | 63% | 0% | 100% (76–100%) | 0.00 | 0.6 s | 5.6 s |
| Diff-only, rules + type checker + tests | 19/45 | 42% (29–57%) | 5% (13/241) | 68% | 0% | 100% (90–100%) | 0.00 | 8.9 s | 24.1 s |
| Impact, rules | 35/45 | 78% (64–87%) | 75% (180/241) | 63% | 76% | 100% (97–100%) | 0.00 | 0.6 s | 5.6 s |
| Impact, rules + type checker | 36/45 | 80% (66–89%) | 75% (181/241) | 63% | 76% | 100% (97–100%) | 0.00 | 7.4 s | 22.5 s |
| Impact, rules + type checker + tests | 45/45 | 100% (92–100%) | 75% (181/241) | 63% | 76% | 100% (98–100%) | 0.02 | 8.9 s | 24.1 s |

<sub>Strict scoring for the diff-only modes, counting only oracle locations: Diff-only, rules: 9/45 cases detected, precision 100% (76–100%), 0.00 false positives per case; Diff-only, rules + type checker + tests: 9/45 cases detected, precision 38% (24–55%), 0.47 false positives per case. The impact modes are unaffected; their type checker skips changed files.</sub>

Of the 241 held-out break locations, 19 are in the changed file and 222 are elsewhere.

**What the diff-only type checker finds.** It reports 21 errors inside the changed file at lines that are not call sites. Most are the changed function's own `return` statements after a return-shape change. The rest are lines that use the changed function's value, or references to a deleted function that are not calls. They are counted as correct above and as wrong in the strict footnote. Either way, the diff-only modes cannot see the 222 breaks outside the changed file.

## Held-out results by bug type (case recall / precision)

| Mode | signature (n=9) | rename (n=9) | delete (n=9) | return-shape (n=9) | raise (n=9) |
|---|---|---|---|---|---|
| Diff-only, rules | 22% / 100% | 22% / 100% | 56% / 100% | 0% / — | 0% / — |
| Diff-only, rules + type checker + tests | 22% / 100% | 22% / 100% | 67% / 100% | 100% / 100% | 0% / — |
| Impact, rules | 89% / 100% | 100% / 100% | 100% / 100% | 56% / 100% | 44% / 100% |
| Impact, rules + type checker | 100% / 100% | 100% / 100% | 100% / 100% | 56% / 100% | 44% / 100% |
| Impact, rules + type checker + tests | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 98% |

## Real merged pull requests: false positives

36 merged pull requests: 12 from itsdangerous, 12 from click, 12 from ufo. Each was analysed against its first parent. Any finding on an already-merged pull request is a candidate false positive, so the [spot-check](spot-check.md) below decides which ones were real.

| Mode | Flagged findings per PR | PRs with any flagged finding | Most on one PR | Median runtime | p95 runtime |
|---|---|---|---|---|---|
| Diff-only, rules | 0.00 | 0/36 | 0 | 0.6 s | 2.8 s |
| Diff-only, rules + type checker + tests | 0.00 | 0/36 | 0 | 8.5 s | 14.2 s |
| Impact, rules | 0.00 | 0/36 | 0 | 0.6 s | 2.8 s |
| Impact, rules + type checker | 0.00 | 0/36 | 0 | 7.6 s | 11.3 s |
| Impact, rules + type checker + tests | 0.00 | 0/36 | 0 | 8.5 s | 14.2 s |

All findings on real PRs in the impact + type checker + tests mode, by severity: high: 0, medium: 0, low: 13.

### Spot-check of real-PR findings

All 13 findings on the real pull requests were reviewed by Haider425 against each pull request's full diff on GitHub, not only the lines each finding cites. Verdicts and notes are in [spot-check.md](spot-check.md).

- **Precision on these findings: 1/13 (8%)** on low-severity findings. That is 1 true positive, 12 false positives, and 0 unsure.
- **No real-PR finding reached medium severity**, so with the default threshold none of them would be flagged, and none would appear in the PR comment, which now hides low severity by default.
- **Under-rated real change (unjs/ufo#286):** A real behaviour change reported as low severity and labelled "internally only": parseQuery's result changed from a plain object to a null-prototype object. The tool rated it low and called the change internal, so with the default threshold it would not have been surfaced.

## Where it fails (held-out, impact + type checker + tests)

No held-out case was missed.

False positives on held-out injected cases (impact + type checker + tests): 1.

| Case | Finding | Location |
|---|---|---|
| `itsdangerous:base64_decode:raise` | high tests/failure+impact/unupdated-caller: `TestSerializer.test_loads_unsafe` fails on the PR head: AssertionError: assert (False, {'id': 42}) == (True, {'id': 42})&#10;  &#10;  At index 0 diff: False != | src/itsdangerous/signer.py:230 |

## Next planned fixes

These come from the real-PR spot-check, ordered by how many rows each pattern cost. They are deliberately **not fixed yet**: changing the rules now would tune them against cases that have already been seen, and the held-out set would no longer be held out. They will be fixed together and then measured on new cases.

1. Findings are emitted even when the tool itself concludes that no caller is affected. (spot-check rows 4, 5, 12, and the internals-only rows)
2. Comment and docstring edits count as changes. (spot-check rows 1, 2, 13)
3. Return-value changes are missed by the "internals only" label, because only return expressions are compared, not how the returned value is built. (spot-check rows 8, 10)
4. Name-based method resolution picks the wrong class. (spot-check row 11)
5. Protocol signatures are treated as runtime contracts. (spot-check row 6)

Weaknesses the injected cases exposed, also deferred for the same reason:

- `impact/unupdated-caller` only considers callers in files the PR did not touch, so an unchanged caller in the same file is not escalated.
- An inserted parameter is not detected by arity checks when a default or rest parameter absorbs the arguments; only the type checker or tests catch it.
- When a rename or delete breaks test collection itself (an ImportError in every test module), the test run reports it as an environment problem rather than as a finding. The broken-import rule still catches these cases.

## Tuning split (n = 44)

Threshold selection, impact + type checker + tests mode:

| Threshold | Case recall | Precision | F1 |
|---|---|---|---|
| `high` | 95% | 99% | 0.97 |
| `medium` (chosen) | 98% | 99% | 0.99 |
| `low` | 98% | 99% | 0.99 |

All modes on the tuning split, at the chosen threshold:

| Mode | Case recall | Location recall | Precision | False positives per case |
|---|---|---|---|---|
| Diff-only, rules | 23% (10/44) | 8% | 100% | 0.00 |
| Diff-only, rules + type checker + tests | 50% (22/44) | 11% | 100% | 0.00 |
| Impact, rules | 73% (32/44) | 73% | 100% | 0.00 |
| Impact, rules + type checker | 75% (33/44) | 75% | 100% | 0.00 |
| Impact, rules + type checker + tests | 98% (43/44) | 75% | 99% | 0.02 |

## Skipped cases

1 candidate case was not run, because the break type does not apply to that function or no call site would break.

- 1× return-shape does not apply to this function

## Resources

Peak disk use: **172 MB**. That figure covers the benchmark folder (one clone, its virtualenv or `node_modules`, and pyright) plus temporary revision copies, sampled every 15 s and after each case. Each repository's clone and dependencies were deleted before the next one started, and pyright was removed at the end.

## Limitations

- **Small samples.** A held-out cell often has 5–10 cases, so one case moves a percentage by 10–20 points.
- **The oracle is textual:**
  - It can count a same-named call on another object.
  - It misses dynamic calls (`getattr`, callbacks passed by reference) and multi-line call expressions whose name is on an earlier line.
  - For `raise`, it approximates `try` nesting from indentation or braces.
- **Injected breaks are synthetic and blunt.** Real regressions are subtler, so real-PR noise and the spot-check matter as much as recall.
- **Tests are judged by their own outcome.** A test that fails on head and passes on base is counted for the case even if it fails for an unrelated reason; base re-runs reduce this risk.
- **Only three repositories, all small.** Results may not transfer to large or heavily dynamic codebases.
- **No other review tool was run**, so these numbers say nothing about how CodeImpact compares with CodeRabbit or similar products.


---

## Appendix: historical test-selection benchmark (pallets/itsdangerous)

Generated 2026-11-02T22:45:57.161Z · parser `ts-parser/6` · algorithm `impact-bfs/3`

**Sample size: 4 historical commits, 4 labelled relevant tests.** This is far too small to support accuracy claims; treat it as a regression harness and a worked example of the method.

### Tuning cases (n = 2)

| Strategy | Mean recall | Mean suite reduction | Mean precision@5 | Mean tests selected |
|---|---|---|---|---|
| All tests | 100% | 0% | 0% | 37.0 |
| Tests in changed files | 100% | 70% | 10% | 11.0 |
| Changed files + direct importers | 100% | 43% | 10% | 21.0 |
| Tests one call edge from a change | 100% | 84% | 20% | 6.0 |
| CodeImpact graph ranking | 100% | 43% | 20% | 21.0 |

### Held-out cases (n = 2)

| Strategy | Mean recall | Mean suite reduction | Mean precision@5 | Mean tests selected |
|---|---|---|---|---|
| All tests | 100% | 0% | 0% | 37.0 |
| Tests in changed files | 0% | 100% | — | 0.0 |
| Changed files + direct importers | 100% | 76% | 20% | 9.0 |
| Tests one call edge from a change | 100% | 81% | 20% | 7.0 |
| CodeImpact graph ranking | 100% | 76% | 20% | 9.0 |

### Per-case detail

| Case | Split | Changed symbols | Labelled | Graph found | Graph selected / suite | Evidence valid | Latency |
|---|---|---|---|---|---|---|---|
| 177196d-oserror | tune | modified:TimestampSigner.timestamp_to_datetime<br>modified:TimestampSigner.unsign<br>module:tests/test_itsdangerous/test_timed.py<br>signature:TestTimestampSigner.test_malformed_future_timestamp | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 1059 ms |
| 7f4dcf8-lazy-sha1 | tune | added:_lazy_sha1<br>modified:HMACAlgorithm<br>modified:Signer<br>module:tests/test_itsdangerous/test_serializer.py<br>modified:TestSerializer<br>modified:TestSerializer.test_iter_unsigners | test_iter_unsigners | 1/1 | 33/37 | yes | 736 ms |
| 37f0997-valueerror | holdout | modified:TimestampSigner.timestamp_to_datetime<br>modified:TimestampSigner.unsign | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 671 ms |
| 3edfbbb-overflowerror | holdout | modified:TimestampSigner.unsign | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 661 ms |

Latency (load + parse both revisions + analyze): median 671 ms, p95 1059 ms.

### Method

- Each case is a single upstream commit; base is its first parent. Revisions are read straight from git objects; no repository code is executed.
- Labels are tests a reviewer identified as exercising the changed behaviour after reading the diff. They are not exhaustive; unlabelled recommendations are not necessarily wrong.
- Recall = labelled tests selected ÷ labelled tests. Reduction = 1 − selected ÷ all tests. Precision@5 uses the labels as the only positives, so it is a lower bound.
- Weights in `src/analysis/engine.ts` (`RANKING_WEIGHTS`) may only be tuned against `tune` cases.

### Case notes

- **177196d-oserror**: Commit also edits the labelled test file.

