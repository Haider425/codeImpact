# Real-repository benchmark

Run `set CODEIMPACT_BENCHMARK_REPO=%TEMP%\codeimpact-itsdangerous-eval && npm test -- benchmark.test.ts` after cloning `https://github.com/pallets/itsdangerous` with full history. The harness reads tracked Python blobs using `git show`; no external source is committed here. Labels are manually derived from the inspected diffs: each timed-signature exception change targets `TimestampSigner.unsign` and `test_malformed_future_timestamp`; `7f4dcf8` targets lazy digest defaults and `test_iter_unsigners`.

The baseline is only tests with a one-edge static path from a changed symbol. Metrics count hand-labelled tests found, unlabelled recommendations, and labels not selected. This is a tiny inspection benchmark, not representative accuracy evidence. Namespace/member dispatch and class-method resolution are expected limitations.
