# Benchmark

Run `npm run bench`. It clones `https://github.com/pallets/itsdangerous` into `data/bench/itsdangerous`, or uses `CODEIMPACT_BENCHMARK_REPO` if set. It then analyzes each labelled historical commit against its parent and writes:

- `benchmark/REPORT.md`: per-strategy recall, suite reduction, and precision@5, split into tuning and held-out cases, plus per-case detail and latency.
- `benchmark/results.json`: the raw per-case results.

The harness reads revisions directly from git objects. No repository code is executed, and no external source is committed here.

Cases and labels are defined in `server/eval/benchmark.ts`. Each label is a test that a reviewer identified, after reading the diff, as exercising the changed behaviour. Labels are not exhaustive. Four commits is far too small a sample for accuracy claims. Treat the results as a regression harness and a worked example of the evaluation method.

Strategies compared (`src/analysis/baselines.ts`):

1. All tests
2. Tests in changed files
3. Tests in changed files plus files that directly import a changed file
4. Tests one call edge from a changed symbol
5. CodeImpact graph ranking

Ranking weights may only be tuned against `tune` cases; `holdout` cases measure the result.
