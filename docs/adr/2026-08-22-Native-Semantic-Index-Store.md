# Native semantic index store

## Status

Accepted

## Context

The index was held by `sql.js`, SQLite compiled to WebAssembly. Because WebAssembly in a
browser tab has no filesystem, the whole database was loaded into renderer memory and written
back wholesale on every save — `saveDatabase(Array.from(db.export()))` crossing IPC as a plain
number array, then overwriting the file non-atomically.

No second process can share a database under that model. The operation "write one row" does not
exist in the API: every save serialises the whole database and overwrites the file, so any row
another process wrote since the renderer loaded it is lost. That is the failure this decision
addresses, and it is the one observed — the concurrent-index test reproduces data loss through
duplicate chunk identifiers. Whether an overwrite concurrent with another process's open handle
would also corrupt the file was not demonstrated and is not claimed.

Separately, the declared `ON DELETE CASCADE` clauses had never fired, because `PRAGMA
foreign_keys` was never enabled.

## Decision

`core/` owns the index through `better-sqlite3` 13.0.3, pinned exactly, behind a narrow
`SemanticStore` interface. `sql.js` and `@types/sql.js` are removed.

The database path is unchanged, so the upgrade is in place on the user's existing file.
Migration reads `PRAGMA user_version`: 0 with a `documents` table means a legacy sql.js file, and
a version above the current one is a hard stop rather than a downgrade. The v1 schema is kept
verbatim in `core/store/legacySchema.ts` and replayed as migration 0 to 1, so a fresh database
and a legacy one converge on identical structure before any v2 change runs.

Pragmas at open: `busy_timeout = 5000` first so later statements wait rather than fail, then
WAL, `synchronous = NORMAL`, `foreign_keys = ON`, `secure_delete = ON`, `temp_store = MEMORY`.

Write transactions use `BEGIN IMMEDIATE` and never span an `await`. Embedding happens between
`beginChunkReplace` and `insertChunkBatch`, so the write lock is held for a batch and no longer.
Completeness is derived rather than stamped, which is what makes a crash mid-index recoverable
rather than mistaken for a finished one. It compares the stored chunk identifiers against the
expected set, not their count: identifiers embed page and per-page position, so the same total
can describe a different set when extraction distributes text differently between runs. An
earlier version of this decision claimed a matching count implied matching identifiers; that was
wrong, and a regression test now covers it.

One limitation remains and is deliberately not claimed away: identical identifiers can still
carry stale text, because an identifier does not cover its chunk's content and OCR output is not
deterministic. Phase 2 does not fix this merely by moving extraction — the app's OCR stays in
the renderer — so Phase 2 must extend chunk identity or invalidation to cover changed extracted
text. Until then a forced rebuild is the only refresh.

Every value read back from SQLite passes through guards in `core/store/rows.ts` that construct
the typed value and throw `StoreDataError` on a mismatch. Casts are not validation.

## Consequences

- The app and a separate process can use the index concurrently. Demonstrated across real OS
  processes: a child process wrote to the index file while the parent had it open. See the
  scope limitation under Verification — the parent does not hold a write transaction, so lock
  contention is not covered.
- One prebuilt Node-API binary serves Electron and plain Node — verified loading under two
  different V8 module ABIs — so `@electron/rebuild` is not needed.
- WAL creates `-wal` and `-shm` sidecars. Anything that deletes or measures the database must
  account for all three. `clear()` deletes rows in a transaction rather than unlinking the file,
  and `info().sizeBytes` sums the main file with both sidecars — `page_count * page_size` alone
  understated real usage roughly twentyfold after a bulk insert.
- The package carries eight platform binaries in 27 MB; `build.files` excludes the seven not
  shipped. `asarUnpack` covers `**/*.node` plus `onnxruntime-node/bin/**` and `@img/**`: those
  two ship dynamic libraries beside their bindings — a 36 MB ONNX Runtime dylib and libvips —
  which cannot be `dlopen`ed from inside an archive. They already shipped but were never
  loaded, because the renderer resolved the web build of Transformers; main-process inference
  loads them for the first time.

  Verified against an unpacked darwin-arm64 build: `better-sqlite3`, `onnxruntime-node` and
  `sharp` all load under the packaged Electron runtime with `fetch` replaced by a throwing stub,
  producing SQLite 3.53.4, libvips 8.17.3 and a usable `InferenceSession`. Full signing and
  notarization validation of a distributable remains Phase 3; `codesign --verify --strict` on a
  `--dir` build reports "code has no resources", which is expected for an unpacked build and is
  not evidence that a real release signs cleanly.
- Enabling `foreign_keys` makes the long-declared cascades real. Measured against the live
  index this had produced no orphans, because the delete path removed embeddings explicitly, so
  the migration sweep is insurance rather than the repair of an observed fault.

## Alternatives considered

- **`node:sqlite`.** Verified to load in Electron's main process with no flag and under Node 25.
  Rejected because it is still marked experimental and prints a warning, and because its SQLite
  version is whatever the runtime ships — 3.51.2 under Electron against 3.53.0 under Node —
  where `better-sqlite3` bundles one version for both.
- **Keeping `sql.js` with file locking.** Rejected: the whole-file rewrite is the defect.
- **`sqlite-vec` for vector search.** Rejected for now. A 300-page document is roughly 1,500
  chunks, about a millisecond of dot products, so an extension binary per platform on the
  notarised release path buys nothing measurable. The `search` method hides the implementation.

## Verification

`core/store/store.test.ts` — ten contracts covering schema version, WAL, in-place migration with
row preservation, the orphan sweep, cascade through both levels from an independent connection,
the recoverable partial-index invariant, superseded-version reclamation, the injected clock, and
a real child-process concurrent write. Mutation-proved by disabling foreign keys, by making the
migration recreate tables, by removing the orphan sweep, and by making `beginChunkReplace` a
no-op.

Scope limitation worth stating: the child-process test proves two processes writing to one
index file through WAL, but it does not hold an open write transaction in the parent, so
`busy_timeout` contention is untested. There is no retry or backoff in the store, and none is
claimed.
