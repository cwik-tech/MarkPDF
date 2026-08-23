# Semantic pipeline in the main process

## Status

Accepted

## Context

Moving only the store out of the renderer would have left embeddings there, and the plan
originally assumed the app and a command line surface could then share one model cache. They
cannot. In `@huggingface/transformers`, `env.useFS` and `env.useFSCache` are both gated on
`IS_FS_AVAILABLE`, which is false in a bundled browser context, so `FileCache` is unavailable to
the renderer at all. The `env.useCustomCache` escape hatch does not bridge it either: a custom
cache is keyed by the full remote URL while `FileCache` keys by a relative path, so sharing one
directory would need bespoke translation coupled to library internals.

The general form is worth naming, because it decided the boundary: a browser context cannot
participate in a filesystem-backed resource that a Node process owns. The database had the same
shape.

## Decision

Chunking, embedding, storage and search all move into `core/` and run in the main process.
`src/semanticIndex.ts` is deleted rather than rewired.

Extraction stays in the renderer for now, because OCR does — rasterising a page needs a canvas,
and OCR output already feeds the on-screen text layer. The renderer sends finished page text
over IPC. Phase 2 moves extraction into core as well.

The renderer reaches the pipeline through `semantic:index`, `semantic:search`, `semantic:cancel`,
`semantic:download-model`, `semantic:get-document`, `semantic:delete-document`, `semantic:list-models`,
`semantic:clear-db` and `semantic:db-info`, with progress pushed back on `semantic:progress`.
Handler, preload bridge and `src/global.d.ts` declaration change together. Every request is
validated at the handler boundary and rejected with a typed error rather than cast.

Main returns the content hash it actually indexed, and the renderer stores it on the tab.
Searches key off that value.

The embedder loads its weights lazily, on first use.

## Consequences

- One database, one model cache, one chunker. A document indexed by the app or by a future
  command line surface produces identical chunks.
- No vector ever crosses IPC: the renderer sends a query string and receives result objects.
- `yieldToBrowser()` is deleted, but a yield still exists and it is worth being precise about
  the difference rather than claiming the workaround disappeared. The renderer's version yielded
  per chunk on the thread that also painted, purely so the interface could render at all while
  indexing monopolised it. The main-process pipeline injects `yieldControl` — a `setImmediate` —
  between *batches*, and it is there for a different reason: the progress message is queued to
  the renderer over IPC, and without returning to the event loop it would not be delivered until
  the whole job finished. So the granularity dropped from per chunk to per batch, and the
  purpose changed from letting the interface paint to letting a message leave. What genuinely
  went away is UI contention; what remains is ordinary event-loop courtesy in a process that
  also serves IPC.
- The renderer bundle drops `@huggingface/transformers` and `sql.js` entirely.
- Semantic search stops requiring the network for its runtime: the renderer previously fetched
  the ONNX WebAssembly backend from a CDN on first use, and `onnxruntime-node` is bundled.
- Existing users re-download the embedding model once, because the previous copy lives in
  Chromium's Cache API and is unreachable from Node.
- A lazily-loaded embedder means an already-complete index is recognised as complete without
  any download, and a document's row is recorded even when the model is unavailable.
- The renderer keeps its own copy of the model catalogue, because it must not import `core/`.
  That duplication is guarded by a parity test rather than left to discipline.

## Alternatives considered

- **Store only, embeddings left in the renderer.** Rejected on the evidence above: the shared
  model cache is unreachable, so it would have required throwaway IPC for vectors and a second
  migration later.
- **`env.useCustomCache` bridged over IPC.** Technically possible, rejected as a bespoke key
  translation coupled to library internals.
- **An Electron `utilityProcess`.** Deferred with an explicit trigger: if measured main-process
  blocking during indexing exceeds 50 ms, move core into a forked process. Core's API is already
  process-agnostic, so the change is contained.

## Verification

`core/index/pipeline.test.ts` proves parse-index-search with no browser, including reuse and
survival across a restart.

`tests/e2e/semantic-store.spec.ts` is the Phase 1 Electron exit criterion and passes in 19
seconds: it opens a generated two-page document, waits for embeddings to land, submits a
semantic query, asserts the result names page 2, clicks it, and asserts the toolbar page box
reads 2, the result is marked active, and the highlight rectangle renders. It further asserts
`text_source = "pdf"`, which proves the native text layer was indexed rather than OCR output —
the condition that makes the highlight assertion meaningful. Mutation-proved by stopping the
renderer recording the indexed content hash; the journey then fails at the named stage
"waiting for semantic results" with `resultCount: 0`.

Cancellation travels as an `AbortSignal`, not a mutable boolean. `JobRegistry` owns an
`AbortController` per job and is the only thing that aborts; `JobToken` exposes a read-only
signal, so a holder cannot cancel itself by writing to its own copy of a flag. `scheduleIndexJob`
reads it after acquiring a permit, `indexDocument` reads it at the top of its exclusive section
and again between embeddings, and the renderer's own controller drives `extractDocumentPages`
between pages. IPC cannot structured-clone a signal, so each side holds its own controller and
`semantic:cancel` is the bridge that aborts the main one.

Two details are easy to get wrong and are recorded because both were. First, `indexDocument`
must check **before** `onProgress`, `upsertDocument` and the reuse return: `upsertDocument`
already writes, and an unforced request whose chunks are all present returns `reused` without
consulting the signal, which would tell the caller a stopped job had produced a searchable
index. Second, the signal is read through a call rather than as a property — after one direct
`signal.aborted === true` check, TypeScript narrows the property to `false` and every later check
becomes provably dead code.

Cancellation stays a discriminated result, never a thrown error. Stopping because the reader
asked to stop is an expected outcome; an exception would be indistinguishable at the call site
from a genuine extraction or indexing failure, and the tab would settle into an error state for
something the user chose.

Out of scope and named as remaining debt: `startAutoOcr` in the renderer still uses a mutable
`{ cancelled: boolean }` job with `runDocumentOcr`'s `isCancelled` callback. It predates this
work and is untouched by it.

`core/index/scheduling.test.ts` proves the two bounds that together keep indexing from starving
the main process, and they are separate guarantees. `BoundedScheduler` caps how many *different*
documents index at once; `runExclusive` keeps two jobs for the *same* document from interleaving
their clear-then-insert protocol. The first did not exist before: opening ten tabs scheduled ten
distinct content hashes, and nothing bounded them.

The cap is **one**, and the reason is evidence rather than caution. Embedding is synchronous
native work — `session.run` blocks this thread, as recorded under the cancellation limitation
above — so overlapping jobs cannot make progress in parallel. They only interleave at await
points, multiplying peak memory (each job holds a batch of chunk texts and their vectors) and
lengthening the stalls in the process that also serves IPC. Raising the cap would need evidence
that inference has become preemptible, which today it has not.

Registration order is part of the contract: a job registers with the `JobRegistry` **before** it
queues for a permit, and re-checks cancellation **after** acquiring one. Registering afterwards
would leave a queued job invisible to `cancel` and to a clear's drain, so disabling semantic
search would appear to work and a queued job would then wake up and write into the index that
had just been emptied. Mutation-proved by moving registration after the queue, by dropping the
post-permit re-check, and by removing the release in `finally` — each turns a scheduling test
red.

`core/index/concurrency.test.ts` and `core/index/serialQueue.test.ts` prove that two jobs for
one document cannot interleave; mutation-proved by removing the per-hash serialisation, which
reproduces `UNIQUE constraint failed: document_chunks.id`.

`core/index/embeddingTensor.test.ts` proves the provider boundary rejects a tensor whose width
disagrees with the model's declared dimensions, using the last axis rather than the total
element count so a batch cannot mislead it.

`core/modelParity.test.ts` guards the duplicated catalogue.
