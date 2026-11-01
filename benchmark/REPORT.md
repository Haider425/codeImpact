# Benchmark report — pallets/itsdangerous

Generated 2026-11-01T20:00:19.487Z · parser `ts-parser/2` · algorithm `impact-bfs/2`

**Sample size: 4 historical commits, 4 labelled relevant tests.** This is far too small to support accuracy claims; treat it as a regression harness and a worked example of the method.

## Tuning cases (n = 2)

| Strategy | Mean recall | Mean suite reduction | Mean precision@5 | Mean tests selected |
|---|---|---|---|---|
| All tests | 100% | 0% | 0% | 37.0 |
| Tests in changed files | 100% | 70% | 10% | 11.0 |
| Changed files + direct importers | 100% | 43% | 10% | 21.0 |
| Tests one call edge from a change | 100% | 84% | 20% | 6.0 |
| CodeImpact graph ranking | 100% | 43% | 20% | 21.0 |

## Held-out cases (n = 2)

| Strategy | Mean recall | Mean suite reduction | Mean precision@5 | Mean tests selected |
|---|---|---|---|---|
| All tests | 100% | 0% | 0% | 37.0 |
| Tests in changed files | 0% | 100% | — | 0.0 |
| Changed files + direct importers | 100% | 76% | 20% | 9.0 |
| Tests one call edge from a change | 100% | 81% | 20% | 7.0 |
| CodeImpact graph ranking | 100% | 76% | 20% | 9.0 |

## Per-case detail

| Case | Split | Changed symbols | Labelled | Graph found | Graph selected / suite | Evidence valid | Latency |
|---|---|---|---|---|---|---|---|
| 177196d-oserror | tune | modified:TimestampSigner.timestamp_to_datetime<br>modified:TimestampSigner.unsign<br>module:tests/test_itsdangerous/test_timed.py<br>signature:TestTimestampSigner.test_malformed_future_timestamp | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 686 ms |
| 7f4dcf8-lazy-sha1 | tune | added:_lazy_sha1<br>modified:HMACAlgorithm<br>modified:Signer<br>module:tests/test_itsdangerous/test_serializer.py<br>modified:TestSerializer<br>modified:TestSerializer.test_iter_unsigners | test_iter_unsigners | 1/1 | 33/37 | yes | 377 ms |
| 37f0997-valueerror | holdout | modified:TimestampSigner.timestamp_to_datetime<br>modified:TimestampSigner.unsign | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 657 ms |
| 3edfbbb-overflowerror | holdout | modified:TimestampSigner.unsign | test_malformed_future_timestamp | 1/1 | 9/37 | yes | 706 ms |

Latency (load + parse both revisions + analyze): median 657 ms, p95 706 ms.

## Method

- Each case is a single upstream commit; base is its first parent. Revisions are read straight from git objects; no repository code is executed.
- Labels are tests a reviewer identified as exercising the changed behaviour after reading the diff. They are not exhaustive; unlabelled recommendations are not necessarily wrong.
- Recall = labelled tests selected ÷ labelled tests. Reduction = 1 − selected ÷ all tests. Precision@5 uses the labels as the only positives, so it is a lower bound.
- Weights in `src/analysis/engine.ts` (`RANKING_WEIGHTS`) may only be tuned against `tune` cases.

## Case notes

- **177196d-oserror**: Commit also edits the labelled test file.
