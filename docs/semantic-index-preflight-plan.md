# Semantic Index Preflight and Truthful OCR Progress Plan

Status: Implemented, with nine corrections from four acceptance reviews recorded below.
Date: 2026-08-30

## Corrections after the acceptance reviews (2026-08-30)

The plan below is kept as written except where these corrections apply. Each one changes what the
implementation does, so the affected lines are corrected in place and listed here.

1. **A snapshot with an unresolved page is not reusable** (was acceptance criterion 4). Reusing an
   incomplete document is truthful about the page and permanently wrong about the document: the
   open that could have recognised the page would be answered from the cache that records it as
   unread, so it could never repair itself. Such a document now falls through to the full read
   path, and becomes ready as soon as something reads the page.
2. **The whole decision is read under one transaction**, so the document row, the cache, the
   completion marker and the chunk count describe one instant rather than up to four.
3. **Extraction versions are stamped with the cache, not before it.** They are written by
   `putMarkdown` in the same transaction as the cache row, so an interrupted run cannot leave a row
   claiming a newer reading of the document than the text it holds.
4. **A finished scope with no chunks is reusable**, so a blank document or a scan that recognises
   to nothing is not rasterised again on every open. The query believes a zero-chunk scope only
   when the cached text is empty on every page.

A second review found three related gaps in the writes themselves. They are corrected the same way:

5. **The completion claim is withdrawn before a new reading is stored, not after.** The rebuild
   stored the new cache and its extraction versions and only then called `beginChunkReplace`. Both
   are committed transactions, so between them another process could read a row and cache
   describing the new reading while the marker still vouched for the old embeddings. The ADR's
   claim that a racing preflight "either has finished or has withdrawn the marker" was false for
   exactly that window; the writes are now ordered so it is true.
6. **The empty path replaces the old scope instead of leaving it.** Writing an empty cache while a
   completed non-empty scope stood meant a later preflight could serve passages the current reading
   of the document does not contain. It now withdraws and clears the scope, stores the cache, and
   records the empty scope as finished — but only when every page was accounted for, because an
   empty reading with a page nothing could read is no evidence about the document.
7. **A full read brings the record up to date, so a document settles after one open.** After an
   extraction-version bump, or on a database migrated from before scope completion existed, the
   identical-chunks branch left the cache versions and the missing completion stamp untouched, so
   the preflight refused the document and the whole read repeated on every open. That branch has
   just read the document, so it writes the cache it read and records completion when none was
   recorded — no comparison, and no new field on a shared type to make one possible.

A third review found that the completion marker was not proof of one coherent rebuild once two
processes share the file:

8. **A completion claim is verified when it is made and retracted by anything that could invalidate
   it.** The application and the command line share one index, and `runExclusive` only serialises
   jobs inside a process, so two runs can rebuild one scope at once and leave a mixture under one
   run's claim. Inserting a batch now retracts the scope's claim in the same transaction;
   `completeChunkScope` replaces `markChunksComplete` and, in one transaction, compares the scope's
   stored chunk identifiers as a set against the ones the completing run wrote, writes that run's
   Markdown cache and provenance, and only then records the claim; and storing a document's text
   retracts every claim over it. No schema change, no dependency, and bounded batch writes and the
   cache an interrupted run leaves behind are both unchanged.

A final review found two gaps in that contract:

9. **A claim is never published without the text it was built from, and a refused claim is never
   reported as success.** `completeChunkScope` used to stamp a scope for a run that supplied no
   cache, which paired the run's chunks with whatever text was already stored — an earlier reading,
   on a document that had been read before. It now answers `claimed`, `unclaimed` or `conflicted`:
   no text means nothing is published and nothing is disturbed, and a scope that no longer holds
   what the run wrote is a conflict. `indexDocument` raises `ConcurrentIndexError` on a conflict in
   all three of its paths rather than reporting `ready`, `reused` or `empty` for an index it did not
   publish. A caller with no text to bind is not a conflict: its chunks stay searchable and only the
   reuse claim is missing.

## Outcome

An unchanged PDF whose complete semantic index already matches the active extraction, chunking, and embedding contracts must become ready without extracting pages, rasterising images, running OCR, loading the embedding model, or rebuilding chunks. "Complete" means every page is accounted for and the searchable scope was finished: a document with a page nothing could read is not complete and must be read again, and a document that finished with nothing to embed is complete and must not be. When OCR is genuinely required on a first index, the toolbar must count OCR targets (`42/59` in the measured 628-page book), not relabel document page 437 as `437/628` OCR progress.

This is a focused cache-preflight correction, not resumable per-page OCR and not a new OCR preference. Image-region OCR remains enabled on the first index because it contributes searchable text from figures on otherwise readable pages.

## Verified baseline behaviour before implementation

- `indexPdfDocument` calls `readDocumentPages` before it delegates to the reusable index path, so page extraction and OCR happen before reuse can be discovered (`core/index/indexPdfDocument.ts:79-106`, `core/index/indexPdfDocument.ts:133-163`).
- Exact chunk reuse is checked only after extraction, structural chunking, and document upsert (`core/index/indexDocument.ts:260-302`).
- The store already records a completion marker keyed by the full searchable scope: document, chunking profile/version, model id/version, and dimensions (`core/store/index.ts:67-74`, `core/store/index.ts:195-209`, `core/store/index.ts:624-641`).
- Cached Markdown is accepted only when its page list is complete for the stored document (`core/store/index.ts:725-751`).
- Extraction and OCR versions, plus the Markdown engine/version, are persisted on the document row, but `StoredDocument` does not currently expose them (`core/store/index.ts:36-65`, `core/store/index.ts:585-613`).
- OCR already reports both target position/count and document page/count internally. `indexPdfDocument` currently discards target position/count and maps `page/totalPages` into the public progress counter (`core/index/indexPdfDocument.ts:84-103`).
- The renderer already renders semantic OCR counters as `OCR current/total`; no new UI state or IPC status is necessary (`src/documentPreparation.ts:131-138`).

## Scope

### Included

- A read-only store query that proves an index is reusable for the exact content hash, extraction contract, complete Markdown cache, complete searchable scope, and active chunking/embedding contract.
- A preflight in `indexPdfDocument` after cancellation and content hashing but before `readDocumentPages`.
- A truthful reused result containing the cached document identity, page count, chunk count, and text source. (Corrected: no unresolved pages, because a snapshot carrying one is refused.)
- Target-based OCR progress (`current/total`) while retaining the actual document page in the message.
- Regression tests, high-risk cache mutation proof, an ADR for the caching decision, and a changelog entry.

### Excluded

- Disabling image-region OCR for text-bearing pages.
- A user setting for figure OCR.
- Per-page OCR persistence or resuming an interrupted OCR run.
- A schema migration or new dependency.
- Changes to renderer OCR overlays, OCR quality, OCR language, or Tesseract scheduling.

## Acceptance criteria

1. Index a PDF that needs OCR, close/reopen it or invoke the same indexing entry point again with identical bytes and settings, and receive `status: "reused"` without invoking the extractor/OCR resolver or embedder.
2. `force: true` always bypasses the preflight.
3. Changed bytes, missing or malformed cached Markdown/provenance, an incomplete chunk scope, or a mismatch in extraction, OCR, Markdown, chunking, model, model-version, or vector-dimension contracts must fall through to the normal read/index path.
4. **Corrected.** Cached unresolved-page provenance must be refused, not reused: a document whose cache records a page nothing could read takes the full read path again, and the next open with a working recogniser reports it `ready` with that page's text indexed.
5. On a first index with OCR targets, progress uses target position/count. If document page 437 is the 42nd of 59 OCR targets, the visible counter is `OCR 42/59`; the message may still say it is reading page 437.
6. A first index continues to OCR qualifying image regions on readable pages.
7. Cancellation before or during preflight performs no write and starts no extraction.

## Design

### 1. Exact reusable-index lookup

Add one narrow store operation for this question instead of exposing raw database columns to orchestration code. Its input contains:

- content hash;
- text-extraction, OCR-extraction, Markdown-engine, and Markdown-version contracts; and
- the active chunking profile/version and embedding model id/version/dimensions.

It returns either `null` or a typed reusable snapshot containing document id, page count, text source, chunk count, and cached page provenance. The query must require all of the following:

- exact content hash;
- exact extraction and Markdown versions;
- a structurally valid, page-complete Markdown cache for the same engine/version;
- a completion row for the exact searchable scope; and
- a chunk count derived from chunks joined to embeddings in that exact scope.

The completion row may be used as proof here because it is removed before replacement begins and written only after the final batch commits (`core/store/index.ts:195-209`, `core/store/index.ts:616-641`). Document or chunk counts alone are not proof. Validate every SQLite value through the existing row guards.

If provenance is absent or malformed, return `null`. **Corrected:** if provenance contains unresolved pages, also return `null`, so the caller reads the document and can repair it. A cache for a legacy row must be repaired by the existing full path rather than guessed complete.

### 2. Preflight before expensive work

In `indexPdfDocument`:

1. Check cancellation.
2. Hash the supplied bytes.
3. If `force !== true`, build the exact active scope from the curated model metadata and the embedder's dimensions, then ask the store for a reusable snapshot.
4. Check cancellation again after the lookup.
5. On a hit, emit only a ready/reused progress event and return the reusable result.
6. On a miss, continue through the existing `readDocumentPages` and `indexDocument` path unchanged.

Do not load model weights to perform the lookup. Curated model metadata and `embedder.dimensions` are already available without calling `embed`.

Avoid two independent definitions of the searchable scope. Extract a small pure scope-input helper if necessary so preflight, indexing, and search cannot drift. This is a focused reuse contract, not a new caching layer.

### 3. OCR target progress

Forward `progress.current` and `progress.total` from the OCR event into `IndexProgress`. Preserve `progress.page` and `progress.totalPages` only in the human-readable message already supplied by the recogniser. No IPC or renderer type widening is needed because the public progress object already carries validated numeric counters.

Update the accepted OCR-progress ADR because its existing decision explicitly chooses document-page counters (`docs/adr/2026-08-29-OCR-Index-Progress-Phases.md:30-65`). Add a separate accepted ADR for the preflight reuse decision because this changes the caching/reuse model.

## Test-driven implementation

### Capability 1: unchanged complete indexes skip extraction and OCR

Observable journey: indexing a local PDF once and reopening the identical document makes semantic search ready from the exact stored snapshot without reading or recognising pages again.

#### Red

1. Add a regression test at `core/index/indexPdfDocument.test.ts` using a real temporary SQLite store and deterministic PDF fixture. The first call builds a complete index through the existing OCR seam. The second call supplies the same bytes with an OCR resolver and embedder that fail if invoked. Require a reused result and no OCR progress.
2. Run `npm test -- core/index/indexPdfDocument.test.ts` and record the expected failure: the second call reaches the OCR resolver before reuse is checked.
3. Add focused store tests before the store implementation for exact hit and each false-hit cluster: extraction/Markdown mismatch, missing or invalid provenance, absent completion marker, and scope/model mismatch.

#### Green

Implement the narrow store lookup and the early `indexPdfDocument` branch with the minimum production changes needed to satisfy the tests.

#### Refactor and mutation proof

- Temporarily remove the exact extraction-version guard; the mismatch test must fail.
- Temporarily accept a missing completion marker; the interrupted-scope test must fail.
- Restore both guards and rerun the focused tests green.

### Capability 2: OCR displays target progress

Observable journey: the user sees how far OCR is through the actual work queue, while the message still identifies the document page being read.

#### Red

1. Change the focused progress fixture in `core/index/indexPdfDocument.test.ts` so an OCR event for document page 437, target 42 of 59, requires `{ status: "ocr", current: 42, total: 59 }` and a message identifying page 437.
2. Update or extend `tests/e2e/mixed-document-ocr.spec.ts` to assert the toolbar counter follows target position/count through the real preload/IPC/renderer path.
3. Run the focused Vitest and Electron journey and record that current code reports document page/count instead.

#### Green and refactor

Forward the correct fields, keep the message truthful, and avoid changing the public progress shape. Re-run both tests. Temporarily restore the old `page/totalPages` mapping and prove the focused test fails before restoring Green.

## Expected files

- `core/store/index.ts`
- `core/store/store.test.ts` or a focused adjacent store test
- `core/index/indexPdfDocument.ts`
- `core/index/indexPdfDocument.test.ts`
- `tests/e2e/mixed-document-ocr.spec.ts`
- `docs/adr/2026-08-29-OCR-Index-Progress-Phases.md`
- `docs/adr/2026-08-30-Semantic-Index-Preflight-Reuse.md`
- `CHANGELOG.md`

If implementation requires an IPC or renderer contract change, stop and report why; the planned progress correction does not require one. If it requires a schema migration, new dependency, or a cross-module refactor beyond this list, stop for approval.

## Verification

Run the narrowest checks during each TDD loop, then before delivery run:

```sh
npm test
npm run typecheck:core
npm run typecheck:tests
npm run build
npx playwright test tests/e2e/mixed-document-ocr.spec.ts
```

Also inspect the complete diff for accidental changes, type assertions, suppression comments, non-null assertions, debug output, and unrelated refactors. This repository has no configured lint command; report lint as unavailable rather than passed.

Do not commit or push.
