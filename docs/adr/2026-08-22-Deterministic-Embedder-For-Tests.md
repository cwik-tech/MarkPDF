# Deterministic embedder for the default test suite

## Status

Accepted

## Context

The Electron acceptance journey must exercise the whole cross-process path: renderer
extraction, the preload bridge, the main-process handler, core, and a real SQLite file. Written
naively it also pulls the real embedding model, roughly 133 MB, on every run. That repeatedly
exceeded Playwright's per-test timeout and made a required test depend on network access.

`AGENTS.md` places a real external provider or managed tool in an opt-in check excluded from
the default suite. A journey that transitively required one was a harness defect.

## Decision

Embedder construction is injected into the Electron semantic shell. A deterministic
bag-of-words embedder is substituted for the real model only when all three of the following
hold:

1. the application is not packaged, so a released build can never take this path;
2. `MARKPDF_E2E_EMBEDDER` equals the exact token `deterministic`, so no stray truthy value
   selects it;
3. `MARKPDF_TEST_USER_DATA` is a non-empty string, so it cannot touch a real user's index.

The decision is a pure function, `shouldUseDeterministicEmbedder`, whose only inputs are the
packaging state and the process environment. No IPC channel and no persisted setting reaches
it, so a running application cannot be talked into the substitution by the renderer. The
Transformers embedder remains the production default.

The real model is covered by `core/index/embeddings.live.test.ts`, run through
`npm run test:live` and excluded from `npm test`.

## Consequences

- The Electron journey is a required test again, offline and fast, and still proves the whole
  path end to end.
- The substitution proves nothing about the model itself. Documented in the live check: whether
  the weights download and cache, whether onnxruntime-node initialises, whether q8 quantisation
  produces usable output, whether real rankings are good, whether the 0.3 default threshold
  still suits them, and whether the advertised vector width matches what the model emits.
- The live check cannot gate a pull request, because a cold download is minutes and needs
  network access. It is run deliberately.
- One more environment variable exists that changes behaviour. Its blast radius is bounded by
  the conjunctive guard, and each condition is independently mutation-proved.

## Alternatives considered

- **Running the journey against the real model.** Rejected: it failed the same boundary three
  times, and it makes a required test network-dependent.
- **Asserting only that the database file appears.** Rejected as weakening the acceptance
  requirement — it would not prove retrieval, navigation, or the highlight.
- **A build-time flag rather than an environment variable.** Rejected: it would need a separate
  build of the application under test, so the journey would no longer exercise the artefact the
  user runs.

## Verification

`core/index/embedderSelection.test.ts` — five contracts covering packaged builds, a missing
flag, six near-miss flag values, a missing or empty test directory, and the single case that
selects the stand-in. Mutation-proved by removing the packaged check, by accepting any truthy
flag, and by dropping the test-directory requirement; each breaks a distinct test.

`tests/e2e/semantic-store.spec.ts` consumes the seam and passes in 19 seconds, against three
minutes of timeout before it existed.
