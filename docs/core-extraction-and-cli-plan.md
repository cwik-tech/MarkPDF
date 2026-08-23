# MarkPDF — Core extraction, Markdown-as-index, and the CLI

**Status:** Proposed
**Date:** 2026-08-22
**Owner:** Tomasz
**Audience:** implementing agent / developer working in the MarkPDF repository
**Implements:** the first programme of [`mcp-and-agent-integration-plan.md`](./mcp-and-agent-integration-plan.md)

---

## Context

`docs/mcp-and-agent-integration-plan.md` argues that MarkPDF already contains three valuable
capabilities — conditional OCR, a page-anchored embedding index, and a multi-engine Markdown
converter — locked inside the Electron renderer and reachable only from MarkPDF's own UI. It
proposes extracting them into pure Node.js and exposing them through a CLI and an MCP server.

This plan covers extracting the core, rebuilding the index from structured Markdown, shipping
a four-command CLI, and then a narrow MCP server over the same core. Every core operation and
every `--json` shape is designed so the MCP adapter in Phase 4 is a thin wrapper rather than a
second implementation.

The work is bounded by `AGENTS.md`, which mandates Red → Green → Refactor, requires ADRs for
substantial decisions, forbids claiming lint passed, and defines the repository as one npm
package with three runtime boundaries.

---

## Decisions

| | Decision |
| --- | --- |
| **D1** | Store engine is `better-sqlite3` v13 with WAL, behind a swappable interface. `sql.js` removed. |
| **D2** | Scope: core extraction, the semantic pipeline moving to the main process, Markdown-as-index, four CLI commands, then a narrow MCP server (Phase 4). |
| **D3** | The **whole semantic pipeline** moves into `core/` and runs in the main process. `src/semanticIndex.ts` is deleted, not rewired. OCR and rendering stay in the renderer. |
| **D4** | CLI ships `index`, `search`, `outline`, `convert`. |
| **D5** | CLI ships inside MarkPDF.app with an install action. Not published to npm. |
| **D6** | **Intel macOS is out of scope.** darwin-arm64 only. Native `@firecrawl/pdf-inspector` is the extractor. |
| **D7** | **One npm package.** `core/` and `cli/` are sibling directories, not workspaces. |
| **D8** | Dependencies approved: `better-sqlite3`, `@firecrawl/pdf-inspector`, `@tesseract.js-data/eng`, `@napi-rs/canvas` promoted to direct. **No CLI argument parser** — `node:util.parseArgs`. |
| **D9** | Reindex is lazy, silent, and per document. |

### Why D3 is not optional

An earlier draft moved only the store and left embedding in the renderer, sharing a model
cache. That is impossible. In `node_modules/@huggingface/transformers/src/env.js`:

```
line  33:  const IS_FS_AVAILABLE = !isEmpty(fs);
line 264:  useFS:      IS_FS_AVAILABLE,
line 269:  useFSCache: IS_FS_AVAILABLE,
```

`fs` is empty in the bundled renderer, so `FileCache` is unavailable. The `env.useCustomCache`
escape hatch exists but does not help: `src/utils/hub.js:139-147` keys a custom cache by the
full remote URL while `FileCache` keys by the relative `{model}/{file}` path
(`src/utils/cache/FileCache.js:30,47`), so sharing one directory would need bespoke key
translation coupled to library internals.

The generalisation is worth keeping: **a browser context cannot participate in a
filesystem-backed resource that a Node process owns.** Same shape as the database problem.
So the boundary moves rather than the resource.

What this buys beyond correctness: one database, one model cache, one chunker, one extractor,
so a document indexed by the app and by the CLI produces identical chunks. `yieldToBrowser()`
(`src/semanticIndex.ts:161-163`) is deleted rather than ported. The renderer drops
`@huggingface/transformers`, `sql.js`, and `@types/sql.js`.

### Why D7, given the strategy document proposes workspaces

`AGENTS.md`'s *Repository architecture* states the repository has no separate packages, and defines three
runtime boundaries. Workspaces would contradict both.

They are *technically* viable — `app-builder-lib/out/node-module-collector/nodeModulesCollector.js:256`
realpaths symlinked packages before copying, so electron-builder handles them. They are
rejected on risk: they force a full `package-lock.json` regeneration and add a new
symlink-resolution step to the **signed, notarised release path** during the same change that
introduces three native modules.

The isolation argument for workspaces also fails: npm hoists `better-sqlite3` to the root
`node_modules`, so a `packages/` split would not stop `src/App.tsx` importing it. A 15-line
Vite `resolveId` guard that throws when anything under `src/` imports `node:*`,
`better-sqlite3`, `@huggingface/transformers`, or `@napi-rs/canvas` is strictly better
enforcement.

Conversion trigger, to record in the ADR: when a package must be published to npm
independently of the desktop release. It is mechanical — `git mv`, two manifests, one import
prefix.

---

## Execution controls

These govern how the work lands, and override any sequencing implied elsewhere in this
document.

**Stage 0 spikes are evidence, not a commit.** They produce recorded findings and throwaway
scripts. Nothing from Stage 0 is committed as production code.

**Phase 1 must leave no committed dual-writer or incompatible shared-database state.** Core
plus store extraction ships together with the minimum Electron cutover required to make the
first implementation commit safe and green. A standalone core that still permits the old
`sql.js` writer against the same database is not an acceptable commit.

This is not a stylistic preference. `persistDatabase()` (`src/semanticIndex.ts:117-120`) calls
`saveDatabase(Array.from(db.export()))`, which `electron/semantic.ts:54-58` turns into a
whole-file overwrite. Every save serialises the entire database and replaces the file, so any
row another writer added since the renderer loaded it is lost. That data loss is the
demonstrated failure — the concurrent-index test reproduces it through duplicate chunk
identifiers. Whether such an overwrite could also corrupt a file another process holds open was
not demonstrated and is not claimed.

**Phase boundaries.**

| Phase | Content |
| --- | --- |
| **0** | Spikes. Evidence only, no commit. |
| **1** | Core extraction, the `better-sqlite3` store, and the minimum Electron cutover that removes the `sql.js` writer. |
| **2** | Markdown-as-index: PDF Inspector, heading- and table-aware chunks, page anchors, lazy reindexing, and the planned tests. |
| **3** | The CLI, the install and status flow, and darwin-arm64 packaging validation. |
| **4** | The MCP server. |

**Phase 4 is now in scope.** A thin stdio-first adapter over the proven core exposing
`outline`, `search`, `read_pages`, and `to_markdown`. It reuses the same schemas, document
identities, consent and allowlist policy, page-index boundary, and explicit output budgets as
the CLI. The official MCP SDK may be used and is recorded as authorized for this phase.
Requirement-derived contract and acceptance coverage plus packaging verification are required.
No broader roadmap features attach here.

**Checkpoint at the end of every phase.** Stop before committing and report: exact Red
evidence, Green and refactor results, mutation-proof results, which gates were run, the
changed files, and remaining uncertainty. The user inspects the diff and tests, gives
corrections, and explicitly authorizes the commit and the next phase.

**Never push.**

**Preserve unrelated work.** The existing `CHANGELOG.md` entries are not valid Keep a Changelog
structure. Replace only the related placeholder entries with accurate ones under `Unreleased`,
and only once the first code phase is accepted.
`docs/mcp-and-agent-integration-plan.md` remains the governing strategy document.

**Each phase commit is independently coherent and green.** No skips, no todos, no weakened
assertions, and no deferring required proof to a later phase.

---

## What the code actually is

Verified against source. Several of these change the work materially; the ones marked
**unverified** have a named spike.

### Cheaper than the strategy document assumes

- **pdf.js needs no worker configuration in Node.** `pdfjs-dist/legacy/build/pdf.mjs:22311-22314`
  sets `#isWorkerDisabled = true` and dynamic-imports the worker in-process.
- **`@napi-rs/canvas` is already installed** as an optional dependency of `pdfjs-dist@5.7.284`,
  and `pdf.mjs:21531` selects `NodeCanvasFactory` automatically when `isNodeJS` — which is
  true in the Electron main process (`process.type === "browser"`) and false in the renderer.
  Exactly the discrimination needed.
- **`onnxruntime-node` is already installed** as a non-optional dependency of
  `@huggingface/transformers@4.2.0`.
- **The Docling runner is nearly portable.** `electron/documentConversion.ts` (649 lines) is
  pure Node except three `app.getPath()` calls at lines 115 and 607.
- **`better-sqlite3` v13 needs no rebuild.** It is N-API with eight flat prebuilds;
  `lib/binding.js` loads `prebuilds/{platform}-{arch}.node`.
- **The Playwright Electron harness exists.** `tests/e2e/bookmarks.spec.ts:1,98-102` launches
  the real binary against `dist-electron/bootstrap.js`.

### Traps

- **pdf.js asset options must be plain filesystem paths with a trailing separator, not
  `file://` URLs.** `pdf.mjs:16022-16026` — `node_utils_fetchData` is `fs.readFile(url)`.
- **Tesseract v7 in Node ignores `corePath` entirely** and resolves its own worker
  (`src/worker/node/defaultOptions.js:11`, `worker-script/node/getCore.js:12-31`). Worse,
  `cachePath` defaults to `'.'` (`worker-script/index.js:112,181`), so the `langPath` route
  writes `eng.traineddata` into the user's current working directory. Pass the traineddata as
  bytes via `createWorker([{ code: "eng", data }])` and bypass all three options.
- **`sharp` is a static top-level import** in `transformers.node.mjs:17741`, and
  `onnxruntime-node`'s darwin dylib is 35.9 MB. Both ship today but are never loaded, so
  nobody has noticed they are not `asarUnpack`ed. The moment inference runs in main, both must
  be dlopen-able.
- **Semantic search silently requires network today.** `@huggingface/transformers/src/backends/onnx.js:350`
  defaults the ONNX WASM runtime to jsdelivr. Migration removes a ~13 MB first-use fetch.
- **`PRAGMA foreign_keys` has never been enabled**, so the `ON DELETE CASCADE` clauses at
  `src/semanticIndex.ts:98,109` are inert. Measured against the real index, this has caused no
  orphans (see Stage 0 findings) because the delete path at `src/semanticIndex.ts:364-377`
  deletes embeddings explicitly and never relied on the cascade. Enable the pragma anyway so
  the declarations stop being decorative, and keep deleting explicitly.
- **WAL will break two existing functions.** `clearSemanticDatabase` (`electron/semantic.ts:60-62`)
  removes one path — with WAL it must close the connection and remove `-wal` and `-shm`, or the
  next open resurrects committed data. `getSemanticDatabaseInfo` (`:64-71`) stats one file and
  must sum three.
- **The app data directory is lowercase `markpdf`.** electron-builder strips the `build` block
  from the packaged `package.json`, so `app.getName()` returns the `name` field. Verified on
  disk: `find ~/Library/Application\ Support -maxdepth 1 -iname markpdf` returns `markpdf`, and
  the current index is `~/Library/Application Support/markpdf/semantic-search/semantic-index.sqlite`
  at 5,074,944 bytes. Both spellings appear to work only because APFS is case-insensitive.
  `electron/main.ts` must always pass `app.getPath("userData")` explicitly so the app and the
  CLI fallback cannot diverge.
- **The snippet is load-bearing for highlighting.** `src/App.tsx:2931-2939` feeds
  `result.snippet` into `semanticHighlight.text`, and `getSemanticHighlightRects`
  (`src/App.tsx:4339-4405`) matches it against the pdf.js text layer. A snippet containing `##`
  or `|` matches nothing and the yellow highlight silently disappears. No type checker catches
  this.

### Corrections to "already pure"

`src/types.ts` type-imports `PDFDocumentProxy` and carries renderer UI state (`ThemeMode`,
`PdfTab`, `DocumentTab` at `:3-6,112-169`) — split it. `src/semanticModels.ts` imports from
`./global`, the ambient file that also declares `Window.pdfReader`. `engineSelection.ts`
value-imports `OPS` from pdf.js. `collectMarkdownPages` (`fidelity.ts:52-87`) calls
`extractPageText`, so it is pdf.js-dependent even though the rest of `fidelity.ts` is pure.
`getTextDensitySamplePages` is module-private (`src/pdf/ocr.ts:43`), not exported.
`SemanticSearchSettings` is declared three times — `src/global.d.ts:55-61`,
`electron/semantic.ts:7-13`, and mirrored in `electron/documentConversion.ts:32-41`.

Conversely, `embedSignatureImage` is already Node-safe: `atob`/`btoa`/`TextEncoder` are Node 22
globals. The only genuinely browser-only code in `src/pdf/document.ts` is `convertImageToPng`
(`:644-676`) and `loadBrowserImage` (`:678-685`).

### Errors in the strategy document

**Finding 1 is wrong about what the AI layer powers.** It says the provider layer "powers
exactly one feature: semantic search." It powers nothing. `src/semanticIndex.ts:1-13` calls
Transformers.js directly against a local ONNX model, and `electron/ai.ts` is settings and
CLI-agent detection — nothing in the application performs an LLM completion.

**It contradicts itself on ordering.** Line 293 says the roadmap leads with MCP; Phase 2a at
`:320-358` and D8 at `:457-458` say the CLI ships first. D8 is operative.

**Its `mode` vocabulary does not match the code.** It says `page-preserving | clean`;
`src/global.d.ts:68` declares `"readable" | "page-preserving"`. Keep the persisted values and
alias `clean` at the CLI boundary.

**Open question 4 is answered.** `@firecrawl/pdf-inspector` is MIT with prebuilds for
`darwin-arm64`, `win32-x64-msvc`, and four Linux targets; `darwin-x64` returns 404. With D6
dropping Intel, it is viable. Only win32-arm64 remains uncovered, and `build.win` has no arm64
target today.

---

## The shape

```
markpdf/                    one npm package, manifest shape unchanged
  electron/  → dist-electron/   tsconfig.electron.json    gains semantic IPC
  core/      → dist-core/       tsconfig.core.json        NEW. Pure Node.
  cli/       → dist-cli/        tsconfig.cli.json         NEW. The markpdf command.
  src/       → dist/            tsconfig.json + vite      loses the semantic pipeline
```

**The import rule is one greppable sentence: everything outside `core/` imports core through
`dist-core/`.** `import { openSemanticStore } from "../dist-core/store/index.js"`.

This typechecks because `tsconfig.electron.json` has `rootDir: "electron"`, and `.d.ts` files
are not program sources — so no TS6059. It runs because the emitted specifier resolves the
same way inside `app.asar`. The renderer imports type-only and pure-data modules the same way;
`tsconfig.json:7` has `skipLibCheck: true`, so core's declarations are never re-checked under
the DOM lib.

`tsconfig.core.json` **does not extend `tsconfig.json`**. Omitting `lib: ["DOM"]` is the
enforcement mechanism: `document`, `window`, `caches`, and `import.meta.env` will not
typecheck in core. The rule becomes mechanical rather than a convention.

### `AGENTS.md` amendment, in the same change

`:5-18` gains two boundaries — `core/` is pure Node with no Electron or DOM imports, compiled
to `dist-core/`, called only by `electron/` and `cli/`; `cli/` parses arguments, calls core,
and formats output, with no document logic. `:27-29` keeps its sentence with one clause added:
`core/` and `cli/` are directories inside the single npm package, not separate npm packages.

---

## Stage 0 — Spike findings (executed 2026-08-22)

Run in a scratch directory outside the repository. No production code, no dependency added to
`package.json`. The real index was copied before being touched; the original was not modified.

### S0.1 — PDF Inspector page indexing: **two bases in one return object**

The suspicion was that the package was inconsistent. It is worse than that, and a single shared
offset constant would have been wrong for four fields out of five.

Stage 0 measured two fixtures: a 3-page fixture carrying a unique sentinel per page, and a
second fixture whose second page is image-only. Those two filled four of the five page-bearing
fields. `pagesWithColumns` stayed empty on both, and Stage 0 left its base taken from the type
declaration.

Phase 2 added a third fixture — a dense two-column page — and measured it. The table below marks
which stage produced each row, because "measured" and "declared" are not the same evidence and
the difference decided whether a normalizer could be mutation-proved against the real package:

| Field of `extractPagesMarkdownAsync` | Base | Measured in | Evidence |
| --- | --- | --- | --- |
| `pages[].page` | **0-based** | Stage 0 | `.page=0` carries the page-one sentinel |
| `pagesWithTables` | **1-based** | Stage 0 | returns `[2]`; the table is on `.page=1` |
| `pagesNeedingOcr` | **1-based** | Stage 0 | returns `[2]`; the scanned page is `.page=1`, `needsOcr=true` |
| `ocrReasonsByPage[].page` | **1-based** | Stage 0 | returns `{"page":2,"reasons":["scanned"]}` |
| `pagesWithColumns` | **1-based** | **Phase 2** | returns `[2]`; the two-column page is on `.page=1` |

All five were re-confirmed independently against the installed `1.17.0` during Phase 2, on fresh
pdf-lib fixtures. `pages[].page` came back `[0,1,2]` with engine page 0 holding the page-one
sentinel. The first field and the other four disagree inside one return object, which is the
whole reason for what follows.

**Column detection needs a dense page, and that is a fixture property worth writing down.** Nine
short lines per column are read as ordinary prose and report no columns at all; forty-five lines
are recognised, stably across gutter widths of 40 and 80 points and across two and three
columns. A sparse fixture would have made `pageFromColumnsList` look untestable when it is not.

`classifyPdfAsync().pagesNeedingOcr` is different again — it returned `[0,1,2]` for that
fixture, because it classifies the whole document as `ImageBased` rather than reporting
per-page need. Different semantics, not merely a different base. Do not use it as a per-page
signal.

**Consequence for the design:** the adapter needs one named validating *function* per field —
not a constant, shared or otherwise. A constant is a value a caller can pass wrongly, and it
would also mean one mutation breaks every normalizer at once so no test could show which one it
protects. `pages[].page` is the only field whose function applies an offset; the rest are
identity. Each carries its own range check, and the fixture asserting "the table is on page 2"
catches a regression in either direction. See the normalizer contract in Phase 2, which is the
binding statement of this rule.

### S0.1b — Extraction quality confirms the premise

Page 2 of the fixture came back as:

```markdown
# Financial Results

## Revenue by Segment

|Segment|Q1|Q2|Q3|
|---|---|---|---|
|Enterprise|1,204|1,318|1,455|
|SMB|402|440|487|

PAGETWO-SENTINEL-BBB
```

Real headings, a real GFM table with its rows intact. This is the concrete form of the
improvement Phase 2 exists to deliver — today `extractPageText` would flatten all of that into
one whitespace-collapsed line.

### S0.2 — Native modules: no rebuild needed, proven rather than inferred

`better-sqlite3@13.0.3` installed with **no `build/` directory**, so node-gyp never ran, and
shipped eight flat prebuilds. The **same** `darwin-arm64.node` then loaded successfully under
both:

| Runtime | Node | V8 modules ABI |
| --- | --- | --- |
| plain `node` | 25.9.0 | 141 |
| `ELECTRON_RUN_AS_NODE=1 electron` | 22.22.1 | 140 |

Two different V8 ABIs, one binary, both working. That is Node-API demonstrated, not assumed,
and it settles the `@electron/rebuild` question. Both report SQLite **3.53.4** — bundled by the
package, so the app and the CLI share one SQLite version, which is the pinning advantage over
`node:sqlite` (Electron would supply 3.51.2 and host Node 3.53.0).

`@firecrawl/pdf-inspector` resolved its `darwin-arm64` optional package cleanly.

### S0.3 — The real index, and one corrected claim

Opened a copy of the live database (5,074,944 bytes) with `better-sqlite3`:

- `user_version = 0`, `journal_mode = delete`, `quick_check = ok`
- 24 documents, 1,051 chunks, 1,051 embeddings — all `chunking_version = 1`, profile
  `balanced`, model `Xenova/bge-small-en-v1.5` at 384 dimensions
- Vector blobs are 1,536 bytes for 384 dimensions — 4 bytes per dimension, confirming the
  float32 layout
- **`foreign_keys` reads as `1`** under better-sqlite3, which enables it by default

**Correction to an earlier claim in this plan.** Earlier drafts said orphaned `chunk_embeddings`
rows have been accumulating on every reindex because the cascades are inert. Measured against
the real database: **zero orphans.** The cascade declarations are genuinely inert, but the
consequence was predicted wrongly — the delete path at `src/semanticIndex.ts:364-377` explicitly
deletes embeddings before chunks and never relied on the cascade. The orphan sweep in the
migration is cheap insurance, not the repair of an observed bug, and the plan should not claim
otherwise.

`user_version = 0` with a populated `documents` table confirms the migration detection rule.
Bumping `semanticChunkingVersion` to 2 will invalidate all 1,051 chunks across 24 documents for
this user, which reindex lazily under D9.

### S0.4 — WAL and cross-process concurrency

On the copy: `PRAGMA journal_mode = WAL` succeeded and persisted. Then, **while this process
held an open write transaction**, a separate `node` process opened the same file read-only and
read all 1,051 chunk rows at full speed. The write then committed normally.

That is the property the app-plus-CLI coexistence depends on, demonstrated across real OS
processes rather than argued from documentation. A clean `close()` after
`wal_checkpoint(TRUNCATE)` removed the sidecar files.

### Still unverified, deferred to the phase that needs it

ESM loading from inside `app.asar` under `ELECTRON_RUN_AS_NODE` (Phase 3); hardened-runtime and
notarization acceptance of the added `.node` files (Phase 3); real embedding latency batched
versus unbatched (informational, measure during Phase 1); and the Gemini CLI extension manifest
shape (Phase 3).

---

## Scope rulings taken after Stage 0

Two questions surfaced once PDF Inspector was settled as the extractor. Both resolve the same
way: **Phase 1 builds only what Phase 1 needs.**

### R1 — `core/` depends on neither `pdfjs-dist` nor `pdf-lib`

> **Superseded in Phase 3, in part.** Phase 3 brought `pdfjs-dist` into `core/` after all, to
> rasterise scanned pages for OCR (`core/ocr/rasterisePages.ts`). `pdf-lib` is still out. The
> ruling below stands as the Phase 1 decision and as the reason `outline` was deferred to Phase 3;
> it is no longer a live constraint on `outline`, and the paragraph at the end of this section is
> corrected there.

With PDF Inspector doing extraction, the only remaining reason for pdf.js in `core/` was
outline extraction (`src/pdf/document.ts:105-175`), which is entangled with the module-scope
Vite import at `src/pdf/document.ts:2`. Phase 1 does not ship an `outline` command, so `core/`
needs none of it.

**Ruled: `core/` takes no pdf.js and no pdf-lib in Phase 1.** Both stay renderer-only and
untouched, which also means `src/pdf/document.ts`, `src/pdf/ocr.ts`, and
`src/documentConversion/**` do not change at all — and their existing tests keep passing
without edits.

The Phase 3 `outline` command then has a real choice to make on its own merits: derive the
heading tree from the cached page-preserving Markdown (loses native PDF bookmarks), or bring
pdf.js into `core/` at that point. Deferred deliberately rather than settled by inertia.

**Settled in Phase 3, and not by this ruling.** `pdfjs-dist` did come into `core/` — for
rasterising, not for outlines — so by the time `outline` was written the library was there and
the ruling no longer decided anything. `outline` still derives from the extracted Markdown, on
the merits: the heading tree is the case that needs serving, a document with no bookmarks still
has headings, and reading both sources would give one question two answers.

### R2 — OCR stays in the renderer for Phase 1

Putting Tesseract in `core/` would drag `pdfjs-dist` and `@napi-rs/canvas` back in purely as a
rasteriser, plus `tesseract.js-core` and the language data — roughly 34 MB and four more
`asarUnpack` entries, with an unresolved `new Worker(path)`-from-asar question.

**Ruled: no core-side OCR in Phase 1.** The app's OCR is unchanged, and the renderer passes
`ocrPages` into `semantic:index`, so scanned PDFs opened in the reader are still indexed with
their OCR text exactly as today. No user-visible regression.

Phase 3 revisits it for the CLI, where the interesting option is PDF Inspector's own
`processPdfWithOcr(buffer, { mode, offline, modelDirectory })` — one native call that could
replace the entire Tesseract stack, subject to a spike on model redistribution and size.

---

## Phase 1 — The store and the Electron cutover

**Scope, as actually delivered.** Phase 1 is narrower than earlier drafts of this document
described on the pipeline itself, and wider on two things those drafts had parked in later
phases. It moves the semantic pipeline — chunking, embedding, storage, search — into `core/`
running in the main process, replaces the `sql.js` writer with `better-sqlite3`, and cuts the
renderer over to IPC.

It also ships two changes that cannot honestly wait, both explained where they belong below:

- **Continuous integration** (`.github/workflows/ci.yml`), because Phase 1 is the first commit
  whose correctness depends on a compiled `dist-core/` and a native module, and the repository
  had no test workflow at all. See Verification.
- **Removal of Intel macOS support**, because Phase 1 excludes the `darwin-x64` prebuild of
  `better-sqlite3` from the package, so an x64 artifact would build and ship without its SQLite
  binary. See Packaging.

And one new renderer file, `src/pdf/pageText.ts`, described under what Phase 1 does not include.

**What Phase 1 does not include, and why.** Everything below was in earlier drafts of this
section and has been moved to Phase 2, where the work that needs it actually lives:

- **Splitting `src/pdf/document.ts` at its pdf.js / pdf-lib seam.** Not needed: with PDF
  Inspector as the extractor, `core/` depends on neither library (ruling R1). `src/pdf/document.ts`
  and `src/pdf/ocr.ts` are unchanged and their tests pass unedited. Phase 1 does add one file
  there, `src/pdf/pageText.ts`, which collects page text with the existing OCR-fallback rule and
  hands it to the main process; it disappears when Phase 2 moves extraction into core.
- **Node substitutions for pdf.js assets, `@napi-rs/canvas`, and Tesseract.** Not needed for
  the same reason (ruling R2): OCR stays in the renderer and the renderer passes finished page
  text over IPC.
- **A bounded top-K heap in search.** Deferred. The current implementation collects matching
  rows and sorts, which is what the renderer already did. It matters when `--scope library`
  arrives in Phase 3, not before.
- **Corruption quarantine and recovery.** Deferred. `PRAGMA quick_check` and the
  rename-to-`*.corrupt-<timestamp>` path are designed but not implemented; a corrupt file
  currently surfaces the underlying error.
- **Markdown caching, `heading_path` population, and structure-aware chunking.** Phase 2 by
  definition. The `heading_path` column exists and is written as an empty array; the chunker is
  the previous word-window algorithm, ported unchanged.

**`semanticChunkingVersion` stays at 1 through Phase 1.** Chunk output is byte-identical to the
renderer implementation, so an existing index remains valid and no user pays for a reindex that
buys them nothing. Phase 2 raises it when chunking actually changes.

**Bounded main-process work is Phase 1, not deferred.** `BoundedScheduler` caps index jobs at
one at a time, and `scheduleIndexJob` fixes the order — register, then queue, then re-check
cancellation after the permit. Without it, ten open tabs meant ten unbounded jobs, because the
only serialisation was per content hash and ten tabs are ten different hashes. The rationale for
a cap of one, and the mutation proofs, are in the pipeline ADR.

**Delivered in Phase 1:** `core/` as a Node-only boundary enforced by an omitted DOM lib and a
two-directional import test; the `better-sqlite3` store behind a narrow interface with WAL,
`foreign_keys`, and `secure_delete`; in-place migration from the legacy sql.js file with the v1
DDL frozen verbatim and an orphan sweep; validated row and pragma reads; an injected clock;
per-content-hash serialisation of index jobs; the new IPC surface with request guards across
handler, preload and declaration; deletion of `src/semanticIndex.ts` and removal of `sql.js`.

## Phase 2 — Markdown as the index representation

**Status: delivered.** `@firecrawl/pdf-inspector` 1.17.0 extracts per-page Markdown behind one
adapter; the main process indexes from document bytes rather than renderer-supplied text; chunks
are split by structure under a measured token budget; oversized tables become lossless row
windows; snippets are plain text; and chunk identity carries a fingerprint of the text so a
re-extraction that changes it rebuilds rather than reuses. `semanticChunkingVersion` is 2, so
every stored chunk re-indexes lazily, one document at a time.

Three ADRs record the decisions: `2026-08-23-PDF-Inspector-Extractor.md`,
`2026-08-23-Embedding-Input-Budget.md` and `2026-08-23-Structure-Aware-Chunking.md`.

Measured by `scripts/bench/chunkingBenchmark.mjs`, which reports two scenarios separately.

On the **six-page ground-truthed fixture**: before, 6 chunks with one past the 510-token encoder
limit and a largest of 695 tokens, intact-table rate 0.752. After, 14 chunks, largest 415, none
over the 420-token chunking target or the encoder limit, intact-table rate 1.000. The full table
of ranking figures is under Verification.

On the **400-row stress scenario**, one oversized table on one page: before, 4 chunks with three
past the encoder limit and a largest of 1,052 tokens, of which 287 of 400 rows reached the model.
After, 12 chunks, largest 420, none over either limit, and 400 of 400 rows reached.

**The crux is solved by the API, not by parsing.** `extractPagesMarkdownAsync` returns
`{ page, markdown, needsOcr, ocrReason? }` per page, so page identity is a property of the
return type. No markers to emit, none to find, no `## Unmatched Page Markers`. **The planned
page-anchor parser is deleted from the plan** — nothing in this stage parses Markdown MarkPDF
did not produce, and building it would be speculative work maintained against dialects nothing
emits.

For contrast, this is what the Docling path does and why it cannot feed the index:
`findPageInsertionPoint` (`fidelity.ts:186`) returns −1 for a page with fewer than six tokens;
the cursor advances monotonically (`:359`) so one bad match desynchronises every later page;
and `safeMarkdownInsertionPoint` (`:290-300`) deliberately pushes an anchor **past** a table,
attributing that table to the previous page — precisely the case the exit criterion measures.

**One adapter owns the boundary, with a named normalization function per external field.**
`core/extract/pdfInspector.ts` is the only file importing the package and the only place engine
page numbers exist.

Do **not** model the conventions as configurable numeric constants. Four fields are 1-based and
one is 0-based in a single return object, every one of them measured against `1.17.0`; a shared
offset would be wrong for four of five, and a per-field integer constant still lets a caller
apply the wrong one. Instead
give each external field its own small named function that validates integer and range
semantics and returns the single internal 1-based `PageNumber` type:

```ts
type PageNumber = number & { readonly __brand: "PageNumber1Based" };

pageFromMarkdownResult(engineValue, pageCount): PageNumber   // 0-based source
pageFromTablesList(engineValue, pageCount): PageNumber       // 1-based source
pageFromColumnsList(engineValue, pageCount): PageNumber      // 1-based source
pageFromOcrList(engineValue, pageCount): PageNumber          // 1-based source
pageFromOcrReason(engineValue, pageCount): PageNumber        // 1-based source
```

`pagesWithColumns` is carried rather than dropped, and is fixture-measured like the rest. Every
page-bearing field the engine returns is either normalized through a named function or
deliberately excluded with a recorded reason — letting one cross the adapter unvalidated is the
failure the adapter exists to prevent.

Each rejects non-integers and anything falling outside `1..pageCount` after normalization, so a
convention change upstream throws immediately rather than shifting every citation silently. The
branded type means an un-normalized engine number cannot reach storage or a result by accident.

**The adapter exposes full-document extraction only, so no page number ever crosses it inward.**
`extractPagesMarkdown(buffer, pages)` accepts a **0-based** `pages` array — a third convention,
on the input side, verified against `1.17.0` by passing `[1]` and receiving the second page. Phase
2 has no caller that needs partial extraction, so the adapter simply does not offer it, and the
inverse conversion has nothing to get wrong. A future partial-extraction API must add its own
named inverse function, `enginePagesFromPageNumbers`, at the point it acquires a real caller —
never speculatively, and never by inlining `page - 1` at a call site.

**`classifyPdfAsync` stays separate and never feeds per-page logic.** Stage 0 showed it
returning `[0,1,2]` for a document where only one page lacked text, because it classifies the
whole document rather than reporting per-page need. It is a document-level signal only. There
is deliberately no normalization function for its `pagesNeedingOcr`, so there is no way to
route it into page-level code.

Three fixtures are needed, not two, and between them they exercise **every** one of these
functions non-empty: the 3-page sentinel-and-table fixture fills `pages[].page` and
`pagesWithTables`, the scanned fixture fills `pagesNeedingOcr` and `ocrReasonsByPage`, and the
dense two-column fixture fills `pagesWithColumns`. Each normalizer must bite under an
implementation mutation *against a fixture*, not only against a focused boundary test — a
normalizer whose only coverage is a hand-written value has never met the engine.

`classifyPdfAsync`'s own result is narrowed by `classificationPageCount`, which reads
`pageCount` and nothing else. It is third-party output like any other and is not destructured at
the call site: an unchecked `pageCount` of `undefined` would turn every `1..pageCount` range
check into a silent no-op, which is the failure mode the range checks exist to prevent.

**Chunking** splits at headings; carries the heading stack **across page boundaries** so a
table on page 8 still knows its heading from page 7; prepends the breadcrumb to `embedText`
only, never to stored `text` or the snippet.

### The embedding input budget

**Truncation is silent and applies to every input, not only to tables.** Verified in the
installed package: `src/pipelines/feature-extraction.js:89-92` calls the tokenizer with
`{ padding: true, truncation: true }` and no `max_length`, and the pipeline exposes no way to
pass one. `src/tokenization_utils.js:405,428` then clamps the length to the tokenizer's
`model_max_length`. Anything longer is cut, nothing is raised, and the tail contributes nothing
to the vector. A search over such a chunk cannot return what was cut, and the index looks
healthy while doing it.

That makes an earlier draft of this section wrong twice over. It said chunking "keeps a table
atomic regardless of size", which is unsafe; and it framed the problem as a table problem, which
it is not. `contextual` is 640 words plus a breadcrumb, against models whose limits are counted
in hundreds of tokens — so ordinary prose overflows too, and it has been overflowing since
before this programme started.

**One budget, in tokens, measured rather than assumed.** Phase 2 defines a single
`embeddingTokenBudget` that covers the whole assembled input: breadcrumb, separator, body, and
the tokenizer's own special tokens. The word-count presets stay as the user-facing knob and keep
their meaning, so a precise/balanced/contextual choice still needs no migration — but they become
*targets* under a hard ceiling rather than the limit itself. Assembly measures with the real
tokenizer; nothing estimates tokens from word or character counts.

The order of operations, because it decides what survives when something has to go:

1. Measure the breadcrumb. If it alone takes more than a fixed fraction of the budget, drop
   headings from the **outside in** — the nearest heading carries the most signal and is kept
   last. The breadcrumb is never allowed to crowd out the body it is supposed to describe.
2. Give the body the rest. A word-window candidate that measures over budget is reduced until
   it fits, at a word boundary.
3. Emit. No chunk is ever handed to the embedder without having been measured.

**Where the budget number comes from.** `model_max_length` is a property of each downloaded
tokenizer configuration, not something MarkPDF can hardcode — and
`src/tokenization_utils.js:324` returns `Infinity` when the configuration omits it. Phase 2 must
treat a missing or infinite `model_max_length` as an error at model-load time, not as "no
limit": an unbounded budget is how oversized input reaches a model that will then fail or
produce nonsense rather than truncate.

**The budget is a floor across the curated catalogue, not the active model's own.** This is
the answer to what happens when limits differ by model, and it is forced by the schema rather
than chosen for convenience. `document_chunks.id` is the primary key and carries no model
column, while `chunk_embeddings` is keyed `(chunk_id, model_id, model_version)` — one chunk of
text, one vector per model. That design is why switching models today re-embeds instead of
re-chunking. Making chunk text depend on the active model's budget would break it: the same id
would have to hold different text for different models, which a primary key cannot do.

So Phase 2 chunks to a budget safe for every curated model. Model switching stays a re-embed.
The cost is that a user on a larger-budget model gets smaller chunks than that model could take,
which is a quality trade-off rather than a correctness one.

**The minimum `model_max_length` is not, by itself, that floor.** Taking the smallest limit
across the catalogue assumes every curated tokenizer turns the same string into the same number
of tokens, and nothing has established that. Two BERT-family models can share a vocabulary size
and still differ in normalizer, lower-casing, unknown-token handling, or how many special tokens
they add — so the same table row can cost more tokens under one than another, and a chunk built
against the smallest *limit* can still overflow a different model with the same limit. Phase 2
must therefore do one of exactly two things, and record which:

- **Canonical tokenizer, proven.** Hash each curated model's `tokenizer.json` (and the fields of
  its `tokenizer_config.json` that affect counting). If every hash matches, one tokenizer counts
  for all, and that hash is stored beside the recorded floor. A test asserts the hashes still
  agree, so adding a model with a different tokenizer fails loudly rather than silently
  invalidating the budget.
- **Worst case across all tokenizers.** If the hashes do not all agree, every candidate chunk is
  measured against *every* curated tokenizer and the largest count is the one that must fit. It
  is N times the tokenization work, and it is the only correct fallback.

The implementation picks the first path when the hash test passes and the second when it does
not; it must never assume the first without the test.

**Whichever path is in force, the tokenizers must be present at runtime — so Phase 2 bundles
them.** This is the gap that would otherwise sink the second path: a user who downloaded only
the active embedding model has exactly one tokenizer on disk, and "measure against every curated
tokenizer" has nothing to measure with. Three options were considered and one is chosen:

- **Bundle the tokenizer artefacts with the application. Chosen.** They are small next to the
  weights — a BERT WordPiece `tokenizer.json` is on the order of a megabyte against 133 MB, 90 MB
  and 438 MB of ONNX — and chunking must work before any model is downloaded, because Phase 1
  already records a document's row when the model is unavailable. Bundling also closes the gap
  the recorded hash otherwise leaves: **the ADR hash is the hash of the bundled file**, checked
  by a test, so the artefact that counts tokens at runtime is provably the artefact that was
  measured. A hash recorded from a model card and a file fetched later are two different things.
- **Fetch each curated tokenizer on demand, under the existing download timeout.** Rejected.
  It makes chunk boundaries depend on the network, so the same document could chunk differently
  on a machine that was offline, and `semanticChunkingVersion` could not describe the difference.
- **Block indexing with a typed prerequisite error until every tokenizer is present.** Rejected
  as the primary design — it turns a first run without network into a dead end — but retained as
  the *failure* behaviour: if a bundled tokenizer is missing or its hash does not match the
  recorded one, indexing raises a typed `TokenizerUnavailableError` rather than falling back to
  an unverified count. A silently wrong budget is the corruption this whole section exists to
  prevent, and failing closed is the only safe response.

This is viable in the installed version rather than hoped for: `PreTrainedTokenizer.from_pretrained`
(`src/tokenization_utils.js:231,303`) loads a tokenizer without touching the ONNX weights, and
`env.allowLocalModels` with `env.localModelPath` (`src/env.js:214-216,262-263`) resolves it from a
directory with no network access at all.

**Tokenizers are loaded once and reused for the life of the process.** One `from_pretrained` per
curated model, cached; never a fetch, a file read, or a reconstruction per chunk. A document of
1,500 chunks measured against three tokenizers is 4,500 *encode* calls, which is fine, and would
be 4,500 tokenizer constructions, which is not.

One constraint that follows from Phase 1 and must not be rediscovered later: `env` is a
process-wide singleton, which is why `installBoundedFetch` installs one fixed policy rather than
one per job. `allowLocalModels` and `localModelPath` are on that same object, so Phase 2 must
establish one arrangement that serves both the bundled tokenizers and the downloaded weights,
set once. Toggling `env` per operation would race a settings-dialog download against an index
job, and the scheduler's cap of one does not prevent that — it bounds index jobs, not downloads.

**The floor is measured and versioned, never written from memory. Measured 2026-08-23 against
`@huggingface/transformers` 4.2.0:**

| Model | `tokenizer.json` sha256 (first 16) | `model_max_length` |
| --- | --- | --- |
| `Xenova/bge-small-en-v1.5` | `d241a60d5e8f04cc` | 512 |
| `Xenova/bge-base-en-v1.5` | `d241a60d5e8f04cc` | 512 |
| `Xenova/all-MiniLM-L6-v2` | `da0e79933b9ed517` | 512 |

**The hashes do not all agree, so worst-case measurement is the mode in force.** Two distinct
files for three models, and the budget is `min(512) − 2 = 510` body tokens, the two being the
`[CLS]`/`[SEP]` pair every BERT-family tokenizer adds.

Two findings worth recording rather than smoothing over. First, the two files differ **only** in
their `truncation` and `padding` blocks — vocabulary, normalizer, pre-tokenizer, post-processor
and added tokens are byte-identical — and this library ignores both blocks when encoding, so the
two demonstrably count every input identically. Mode selection is driven by the hashes anyway,
because "the files differ" is a fact and "the difference happens not to matter today" is a
judgement that a future artifact could invalidate silently. Second, MiniLM's `tokenizer.json`
declares `truncation.max_length: 128`, which is **inert**: encoding a 1,726-token string through
it returned all 1,726 tokens, and only the `model_max_length` from `tokenizer_config.json`
truncates, at 512 for every model. A budget of 128 would have been wrong by a factor of four.

`tokenizer_config.json` is bundled and hashed alongside, and the recorded 512 is verified
against it at load time — so no number above rests on a note. Adding a future model whose budget
is below the recorded floor, or whose tokenizer hash differs, is a `semanticChunkingVersion`
bump, which D9 re-indexes lazily and per document.

**The breadcrumb reservation is a number, so it can be tested.** The breadcrumb may occupy at
most `BREADCRUMB_TOKEN_SHARE = 0.15` of the budget, floored to a whole number of tokens. Over
that, headings are dropped from the outside in — the nearest heading is kept last — until the
remainder fits. Two tests state the consequence directly: the body of every emitted chunk is
allotted at least `budget - floor(budget * 0.15) - separatorTokens`, and a pathological
breadcrumb of twenty nested headings still leaves that much room. Mutation proof: remove the
reservation and the second test must fail.

### Rows that do not fit

**"Never split a row" and "never exceed the budget" cannot both hold, so one has to give.** A
single row — a wide table, a long cell of prose — can exceed the whole budget by itself. The
earlier wording asserted both invariants and was therefore unimplementable. The rule Phase 2
implements instead, in order:

- A table that fits entirely: one chunk, header and all rows.
- A table that does not: consecutive row windows, each repeating the header row, each carrying
  the same `heading_path` and page, overlapping by one row so a comparison spanning a window
  boundary survives intact inside one of them.
- **A single row that does not fit even alone beside its header: split into continuation parts,
  at cell boundaries first, and within a cell at a word boundary only if one cell is itself over
  budget.** Each part repeats the header and carries a part index in its identifier.

**Continuation is lossless, and that is the property under test.** Concatenating a row's parts
in order, with the repeated headers removed, must reproduce the original row exactly — no
dropped cell, no dropped word, no inserted separator. The test states it that way: build a row
whose token count is a small multiple of the budget, chunk it, reassemble, and compare against
the original string. A second test proves retrieval rather than structure: put the answer in the
**final** part and assert it is findable, because a fixture whose answer sits near the top passes
under exactly the truncating implementation this section exists to prevent.

**The default embedder cannot prove a truncation bug, so the proof cannot rest on retrieval
alone.** `createDeterministicEmbedder` hashes whatever string it is handed; it has no tokenizer
and no limit, so it embeds an oversized chunk exactly as faithfully as a small one. Restoring
atomic oversized tables would therefore leave the retrieval assertion passing, and the mutation
would not bite — the proof would be theatre. Phase 2 needs both of these:

- **A direct assertion on the assembled input.** For every chunk the chunker emits, the measured
  token count of `embedText` is at most the budget. This is the invariant itself, it is
  independent of any embedder, and it fails the moment a chunk is built too large.
- **A truncating test double.** `createTruncatingEmbedder(limit)` embeds only the first `limit`
  tokens of its input, reproducing what the real pipeline does silently. Only against this does
  "the answer is in the final row and the search finds it" mean anything, and only against this
  does restoring atomic tables turn the retrieval test red.

Mutation proofs, all four required: restore atomic oversized tables and both the token-count
assertion and the truncating-embedder retrieval must fail; drop the last continuation part and
the losslessness comparison must fail; remove the breadcrumb reservation and the body-allotment
test must fail; replace the worst-case tokenizer measurement with the minimum limit while the
tokenizer hashes disagree, and the token-count assertion must fail.

**Snippets are converted to plain text** by a `toPlainText` step, for the highlighting reason
above. Table rows become `Enterprise 1,204 1,318` — close enough to the text layer's reading of
the same row that the highlight has a real chance. Failure is already graceful:
`getSemanticHighlightRects` returns `[]` when nothing matches.

**Chunk identity must start covering the text, not only its position.** Phase 1 decides
whether an index can be reused by comparing stored chunk identifiers against expected ones
(`core/index/indexDocument.ts:118-135`). An identifier is
`{contentHash}:{profile}:{chunkingVersion}:{page}:{index}`, so it covers the file's bytes and
the chunk's position within its page, but not the chunk's content. OCR output is not
deterministic, so the same file can extract to different text and still produce the same
identifiers, and the reuse path then keeps stale text. Phase 1 records this limitation in the
source rather than claiming it away, and a forced rebuild is the only way out of it today.

Phase 2 must remove it, because Phase 2 is where extraction moves into `core/` and the
extracted text becomes something `core/` can hash. The fix is to fold a hash of the chunk's
normalized text into its identity, so changed text is a different chunk and the reuse check
fails closed instead of open. Its test indexes a fixture, re-indexes with one page's extracted
text changed and the file's bytes untouched, and asserts the new text is searchable without
`--force`. Mutation proof: drop the text hash from the identifier and that test must fail.

**The identifier stays model-blind, and that is deliberate.** It would be natural to add the
model to the identity now that chunking has a token budget. Do not: chunking to the catalogue
floor is what keeps chunk text model-independent, and a model-scoped identifier would silently
license a future change that makes text depend on the active model — the change the schema
cannot absorb. The text hash is what makes identity honest; the model belongs in
`chunk_embeddings`, where it already is.

### OCR arbitration moves from pdf.js to PDF Inspector

**This is a deliberate behaviour change, not preservation, and the affected set is measured.**

Before Phase 2, `src/pdf/pageText.ts` arbitrated per page with a pdf.js rule: if a page's native
text held fewer than 100 non-space characters and OCR text existed for it, the OCR text won.
Phase 2 deletes that rule. PDF Inspector's per-page `needsOcr` decides instead, and renderer OCR
becomes a *candidate* offered to it rather than a command — which is why the IPC field is
`ocrCandidates`, not `ocrOverrides`.

Measured against `1.17.0`, on fixtures whose page 2 carries exactly 30, 60 and 99 non-space
characters:

| Page shape | Old rule | PDF Inspector | Agree? |
| --- | --- | --- | --- |
| Scan with a 30/60/99-character text stamp | OCR | `needsOcr=true`, reason `scanned`, **no markdown returned** | **yes** |
| Text-only page of 30/60/99 characters | OCR | `needsOcr=false`, markdown returned | **no** |

So the case the old rule was written for — a scan with a thin stamp — behaves identically, and
arguably better: the extractor discards the stamp rather than mixing a fragment of native text
into a scanned page.

**The affected set is pages in an OCR-triggered document whose native text runs 1–99 non-space
characters and which PDF Inspector reads successfully.** It is reachable, not theoretical:
`detectOcrNeed` returns a document-level verdict from a page sample and `runDocumentOcr` then
scans every page, so candidates arrive for readable pages too. Those pages now keep their native
Markdown.

**Reinstating the old rule was considered and rejected.** OCR text is a flat run of words; the
native Markdown for such a page may be a table, a heading, or a list. Letting a character count
replace structured Markdown with flat OCR would discard exactly the representation PDF Inspector
was chosen to preserve — the `|Enterprise|1204|1318|` that the Electron acceptance journey
proves reaches the index.

**Non-selection is reported, not silent.** The post-extraction progress message reads
`Read 3 pages, 1 of 3 OCR candidates used` whenever candidates were offered, so a candidate the
extractor did not need is an observable outcome. There is no warning API; this uses the progress
surface that already exists.

**Failure handling is functional only, never architectural.** A binding that will not load, a
malformed PDF, and a page needing OCR each have defined behaviour. Critically, **an unanchored
index is never written**: D2 makes page anchoring mandatory, and a confidently wrong page
number is worse than no result.

---

## Phase 3 — The CLI

```
markpdf index   <path...>  [--recursive] [--force]
markpdf search  <query>    (--path <pdf> | --id <hash>) [--top-k 12] [--min-score 0.3]
markpdf outline <path>     [--depth 3]
markpdf convert <path...>  [--pages 3-7] [--mode page-preserving|clean] [--out file.md]

global: [--json] [--help] [--version] [--data-dir <dir>] [--no-input]
        [--allow-read <dir>] [--allow-write <dir>] [--revoke-read <dir>] [--revoke-write <dir>]
```

**Four global options were added to the shape above, and one moved.** `--json` is global rather
than repeated per command, so `ParsedOptions.declared` can tell a command's own options from the
global ones — asking for an option a command never declared is then a programming error the table
catches rather than a plausible `undefined`. `--data-dir` and `--no-input` are the two knobs a
non-interactive caller needs. The four grant options are global because a refusal prints its remedy
as something pastable in front of the command that was refused, and the same options have to work
on their own.

**`--revoke-read` and `--revoke-write` are an addition to the plan, not a restatement of it.**
"Deletion is withdrawal of consent" is below; consent that can be given and not taken back is not
consent, and V8's own scenario — a folder no longer granted — needs a way to reach that state
through the product rather than by editing a file.

Arguments via `node:util.parseArgs` plus a hand-written command and option table. The deciding
reason is not bundle size: the table is a data structure that generates `--help`, validates
argv, and later generates the MCP tools' JSON Schemas. A third-party parser owns its own schema
format and that reuse is lost.

Results on stdout, progress on stderr. Exit codes distinguish `0` success (including zero
search results — an empty result is an answer), `2` usage, `3` not found, `4` not indexed,
`5` access denied, `6` parse failed, `7` partial batch failure, `8` missing dependency,
`9` index busy, `69` app unavailable, `130` interrupted.

**The consent model is enforced by code paths, not policy.** `search --path` resolves against
`documents.file_path` first, as a pure database query with no filesystem call, falling back to
reading and hashing only if that misses. That is what makes the highest-traffic command need no
filesystem permission at all, and it is directly testable.

The allowlist lives in **core**, not the CLI (D9 in the strategy document), so the MCP server
inherits identical enforcement later. Symlinks resolve before the containment check —
mandatory on macOS, where `/tmp` is a symlink to `/private/tmp` and every fixture uses
`mkdtemp`, so without it the acceptance test refuses its own fixture. Containment uses
`path.relative`, never `startsWith`, because `/Users/t/Papers2` starts with `/Users/t/Papers`.
Read roots never imply write roots.

**The empty default versus the acceptance test** is resolved rather than fudged. Interactive
runs offer a one-keystroke grant scoped to the file's parent directory. Non-interactive runs
never prompt and exit 5 with the remedy printed as a runnable command — so the `--allow` grant
appears inside the command a human approves in their agent's permission prompt.

**Deletion is withdrawal of consent and must be real.** `secure_delete = ON`, explicit
deepest-first deletes, `wal_checkpoint(TRUNCATE)` then `VACUUM`. The test indexes a fixture
containing a distinctive phrase, forgets it, then reads the database file as bytes and asserts
the phrase is absent. **Delivered**, and reached from the user-facing paths: `forgetDocument` is
what the application's delete calls, and `clear` runs the same sequence. `deleteDocument` remains
for testing the cascade and is documented as not a consent-withdrawal API.

**Correction to the consent model, found during Phase 3.** Storing roots resolved is only half the
guarantee. The checks originally resolved the *stored* root again on every call, so deleting a
granted directory and putting a symbolic link to somewhere else at the same name silently moved the
grant with it. Roots are now treated as canonical boundaries and only the request is resolved;
withdrawal compares the same way, or a replaced directory escapes it. Both have regression tests
and both mutations bite.

**`--pages` bounds the recognition, not just the output.** Reading the whole document and filtering
afterwards would rasterise and recognise every scanned page of a 400-page book to return one. The
selection is passed into the read, and every page is still returned so that a selection naming a
page the document does not have is still detectable.

**Correction to the OCR plan.** `createWorker([{ code: "eng", data }])` does not work in the
installed `tesseract.js` 7.0.0: `src/worker-script/index.js:101` reads `_lang.code` when loading
the file but `:238` reads `_lang.data` when naming the language to initialise, so the engine is
asked to open a data file named after the entire byte array. The working configuration is the
string form with a local `langPath` and `cacheMethod: "none"` — the second of which is still
required, because `:181` otherwise writes `eng.traineddata` into the current working directory.
Recorded in the CLI packaging ADR.

**`outline` derives headings from the extracted Markdown — on the merits, not on ruling R1.** That
ruling's premise is spent: `core/ocr/rasterisePages.ts` imports `pdfjs-dist` to rasterise scanned
pages, so a PDF library *is* available in `core/`. `pdf-lib` is still not. Nothing about outlines
needs either. Native PDF bookmarks are not read, and heading *level* is the
extractor's judgement from font statistics — measured against the test fixture, it reports a 20pt
title and a 16pt section heading both as level 1. Stated in the ADR rather than left to be
discovered.

**Ruling R2 resolved: OCR runs in `core/` for the command line.** `pdfjs-dist` and
`@napi-rs/canvas` rasterise, `tesseract.js` recognises, and the language data is bundled. PDF
Inspector's own `processPdfWithOcr` was rejected: its README states the native package embeds no
OCR models, PDFium or ONNX Runtime, so routed OCR needs those shared libraries on the platform
search path plus a downloaded model set — a new native artifact on the notarised release path,
outside the approved dependency set. The application's renderer path is unchanged: a caller that
supplies OCR text still wins, and only pages nobody accounted for are recognised here.

**Runtime: `ELECTRON_RUN_AS_NODE=1` against the bundled Electron binary**, installed as a shim
script that bakes in the app path and the data directory. This avoids a second Node binary —
one more signing target and roughly 55 MB — and avoids depending on whichever of nvm, volta,
asdf, or mise wins on the user's PATH. The shim carries a version marker so status can
distinguish not-installed, current, stale, pointing-elsewhere, foreign-binary conflict, and
shadowed-on-PATH.

**Two states were added and one comparison widened.** *Not on PATH* and *PATH unknown* exist
because the install destination is often not on `PATH` and because an application launched from
Finder inherits `launchd`'s minimal environment rather than the login shell's — so
`process.env.PATH` cannot substantiate a claim about which `markpdf` runs. The login shell is asked
instead, with a fixed argument list and a three-second timeout, and when that fails the status says
so rather than guessing. Staleness compares **every** field of the marker, not only the version: a
shim at today's version with yesterday's entry point runs yesterday's code, and one with a
different data directory writes to a second index.

**Elevation is not implemented, and the destination differs from what this plan implied.** Measured
on macOS 25.5: `/usr/local/bin` is the first line of `/etc/paths` and is therefore on the default
`PATH`, but it is `root:wheel` mode 755 and not writable without elevation; `~/.local/bin` is
writable and is *not* on this account's login `PATH`. The install action therefore uses
`/usr/local/bin` when this user can already write there and `~/.local/bin` otherwise, and tells the
person plainly when the directory is not on their `PATH`. Writing to a root-owned directory from a
document reader means an administrator prompt and a privileged shell command, which deserves its
own design rather than being added at the end of a phase. Recorded with this evidence in
`docs/adr/2026-08-23-CLI-Packaging-And-Install.md`; it is the paragraph to revisit if elevation is
wanted.

`electron/defaultApp.ts` is the precedent for the **module and IPC shape only** — a status
type, a getter, a setter, one settings section. It manipulates LaunchServices and writes
nothing to disk, so the PATH install is designed from scratch.

---

## Phase 3 — Packaging

The renderer cutover — deleting `src/semanticIndex.ts`, routing through IPC, and removing
`sql.js` — is **Phase 1**, not this phase. It cannot be deferred: until it lands there are two
implementations writing one database, which is the hazard D4 exists to prevent.

**Intel removal is also Phase 1**, and for a concrete reason rather than tidiness. Phase 1
excludes the `darwin-x64` prebuild of `better-sqlite3` from the package. Leaving the x64 scripts
and the x64 release matrix entry in place would mean an x64 artifact that builds and ships
without its SQLite binary — broken at launch, in a phase that is otherwise green. Either both
move together or neither does, so both moved.

**Delivered in Phase 1, in full.** The `x64` entry is gone from the `release-macos.yml` build
matrix. `dist:mac:x64` and `release:mac:x64` are gone from `package.json`, and `dist:mac` is
pinned to `--arm64`. `build.mac.target` names `arm64` explicitly for both `dmg` and `zip`, so an
accidental `--x64` invocation produces nothing rather than a broken artifact. The `darwin-x64`
prebuild of `better-sqlite3` is excluded from the package. The Intel download link is gone from
`README.md`, which now states that MarkPDF requires an Apple Silicon Mac. `CHANGELOG.md` records
under `Removed` that existing Intel users stop receiving updates. Historical changelog entries
describing the Intel release assets are left as written, because they were accurate when made.

`asarUnpack` as shipped in Phase 1 is `**/*.node`, `node_modules/onnxruntime-node/bin/**`, and
`node_modules/@img/**`. The wildcard covers `better-sqlite3`'s prebuild without naming it, so a
version bump that relocates a `.node` file cannot silently re-pack it inside the asar. The
`@img/**` and `onnxruntime-node/bin/**` entries are new and newly required: both ship today but
are never loaded, so nobody has noticed they were packed — the moment inference runs in the main
process, both must be dlopen-able.

Phase 2 adds the bundled curated tokenizer artefacts, which are ordinary data files and need no
`asarUnpack` entry — they are read, not `dlopen`ed. Phase 3 adds only what its own work needs:
`tesseract.js/src/worker-script/**`, `tesseract.js-core/**`, and the traineddata, once OCR runs
outside the renderer.

**What has and has not been verified, precisely.** Verified during Phase 1, against an unpacked
darwin-arm64 `--dir` build: `better-sqlite3`, `onnxruntime-node` and `sharp` all load under the
packaged Electron runtime with `fetch` replaced by a throwing stub, producing SQLite 3.53.4,
libvips 8.17.3 and a usable `InferenceSession`. That is what makes the Phase 1 `asarUnpack` set
evidence-backed rather than hopeful, and it is recorded in
`docs/adr/2026-08-22-Native-Semantic-Index-Store.md`.

**Verified in Phase 3, against a signed, unpacked arm64 `--dir` build on 2026-08-23.** The command
line runs from inside `app.asar` under `ELECTRON_RUN_AS_NODE=1` through an installed shim, with the
network blocked in the process and in its worker threads: it starts, writes its consent record to
the baked data directory, opens `better-sqlite3` and `@firecrawl/pdf-inspector` for `outline`,
rasterises a scan with pdf.js and `@napi-rs/canvas` and recognises it with `tesseract.js` for
`convert`, and writes nothing into the working directory. `codesign --verify --deep --strict`
reports the bundle valid and satisfying its designated requirement, with the hardened runtime on
(`flags=0x10000`), and the unpacked native modules verify individually. That retires the
hardened-runtime question for a `--dir` build.

**Still not verified.** `index` and `search` inside the packaged application: a packaged build
refuses the offline test embedder by design, so proving them there needs a 133 MB model download.
Notarizing a distributable is also unverified — credentials are not set in this worktree, and
notarization is currently failing on Apple's side for this account.

Net size: Phase 3 adds roughly 2.9 MB installed — the `4.0.0_best_int` language data at 2.8 MB plus
`dist-cli`. `tesseract.js-core` already shipped for the reader's own OCR and moves out of the
archive rather than being added, and the 10 MB `4.0.0` language variant is excluded from the
package. Semantic search and command-line OCR are now genuinely offline-capable, which V10 checks
by blocking the network rather than by asserting configuration.

**An unrelated observation, recorded rather than acted on.** The `--dir` build's `app.asar` is
705 MB, dominated by pre-existing content: `dist/` at 338 MB, `onnxruntime-web` at 131 MB (unused
in the main process), `mermaid` at 83 MB and `lucide-react` at 25 MB. None of it is Phase 3's, and
none of it is in Phase 3's scope, but the number is worth someone's attention before a release.

---

## How the work is sequenced

Vertical capabilities per `AGENTS.md`'s *Double-loop TDD for cross-layer features* — each independently useful with its own outer
acceptance test, rather than one long-running failing test around the whole feature.

| # | Phase | Observable outcome |
| --- | --- | --- |
| V1 | 1 | The store opens a legacy sql.js file, migrates to v2, preserves its rows, and cascades on delete |
| V2 | 1 | Parse → index → search under plain `node`, no Electron, no browser |
| V3 | 1 | The same document indexed twice at once completes both jobs and leaves one correct set of chunks |
| V4 | 1 | The deterministic embedder is selected only when unpackaged, explicitly opted in, and pointed at a test directory |
| **V9** | **1** | **The Electron exit criterion: open a document, search it by meaning, jump to the page that answers the query, and see the highlight** |
| V5 | 2 | Content known to be on PDF page 1 is stored with `page_number = 1`; the fixture's table is on page 2 |
| V6 | 2 | Searching a table-heavy PDF returns an intact table row with the right page and heading path |
| V7 | 3 | `markpdf index <path outside allowlist>` exits 5, prints a runnable remedy, and writes nothing |
| V8 | 3 | With the fixture directory removed from the allowlist, `markpdf search --path <fixture>` still returns the hit and exits 0 |
| V10 | 3 | `markpdf index <scanned fixture>` reads text that exists only as pixels, with the network blocked in the process and its worker threads, and a later search returns it |
| V11 | 3 | The command line runs from inside a signed, packaged `--dir` build: it starts from `app.asar`, opens SQLite and the extractor, and recognises a scan offline |

**V9 is the Phase 1 Electron exit criterion.** The table-aware journey that earlier drafts
listed here belongs to Phase 2, because it depends on structure-aware chunking that Phase 1
does not deliver.

V7 and V8 are the negative checks the strategy document requires, and both belong to Phase 3.
**V8 proves the consent model is implemented rather than asserted**, and gets mutation proof:
make path resolution hash the file unconditionally and confirm V8 turns red. **Delivered, and the
mutation was run: it turns V8 red.** V7 goes further than the row above describes — it extracts the
remedy from stderr and runs it through a real shell, against a library directory whose name
contains a space, so the shell quoting is under test rather than the wording.

**V10 and V11 were added during Phase 3** and are recorded here rather than left out of the table.
V10 is the check that the offline claim is a claim about behaviour: the network is blocked with a
`NODE_OPTIONS` preload, which propagates into `worker_threads` — verified — and the recognition
engine runs in one. V11 is the packaged-application check the Packaging section previously listed
as unverified. Its limit is stated there.

Dependency order: spikes → tsconfigs and test discovery → core types and paths → store →
index and search → **IPC cutover** (all Phase 1, and the cutover ships with the store) →
extractor and chunker (Phase 2) → CLI and packaging (Phase 3) → MCP adapter (Phase 4). CI
arrives with Phase 1 and grows with each phase.

---

## Verification

**Test discovery had to change first.** `vitest.config.ts` included only `src/**/*.test.ts`,
so core and CLI tests would have silently not run. It now includes `core/**/*.test.ts` and
`cli/**/*.test.ts`, and excludes `**/*.live.test.ts`, which run through `npm run test:live`
against `vitest.live.config.ts` with a timeout sized for a cold model download.

**Fixtures are generated with `pdf-lib` at test time**, following the existing pattern at
`src/pdf/document.test.ts:18-31`. `makeScannedPdf` draws text onto a `@napi-rs/canvas`, encodes
PNG, and embeds it — a genuine OCR fixture with no text layer and no binary in git.

**Expected values are written down before the extractor exists and reviewed against a rendered
page image**, never pasted from extractor output (`AGENTS.md`'s *Test design rules*). An assertion generated
by the implementation proves only that the implementation is deterministic.

The table fixture puts a decoy on page 3 reading "Enterprise revenue is discussed on page 2",
which catches an implementation returning the right words from the wrong page — the exact
failure class this work exists to prevent. Putting the table on page 2 catches an index shift
in either direction.

**The embedding model is a replaced boundary** in the default suite, via a deterministic stub.
What that does **not** prove, and must be reported as such: that the real model downloads or
loads at all; that ONNX Runtime initialises; that `dtype: "q8"` quantisation works; that
rankings are useful; that `defaultSemanticScoreThreshold = 0.3` is still calibrated for
breadcrumb-prefixed chunks; and that `--offline` refuses against a genuinely cold cache. An
opt-in live check covers those, run on demand rather than per PR.

**Mutation proof** is required for the store, the derived cache, WAL concurrency, the
allowlist, the consent path, and the page-index boundary — all named in `AGENTS.md`'s *Verify that the test protects the behavior*.
Concretely, each named against the vertical it protects and the phase that owns it: set
`PRAGMA foreign_keys = OFF` and V1's enforcement assertion must fail (Phase 1); make the reuse
check compare chunk counts instead of chunk identifiers and V3 must fail (Phase 1); apply the
wrong page-normalization function and V5 must fail (Phase 2); restore atomic oversized tables
and V6 must fail (Phase 2); remove `secure_delete` and the forget test must fail (Phase 3).

**One correction, measured rather than assumed.** An earlier draft of this section said that
*removing* `PRAGMA foreign_keys = ON` must make the cascade assertion fail. It does not, and the
mutation was run to find that out: better-sqlite3 enables foreign keys by default (Stage 0
measured the live database reading `foreign_keys = 1`), so deleting the line changes nothing.
Worse, the cascade test deletes through an independent connection, and enforcement is
per-connection — so it was never testing the store's pragma at all. Phase 1 therefore adds an
explicit assertion that the store's own connection enforces foreign keys, surfaced as
`diagnostics.foreignKeysEnforced`, and the mutation that bites is `ON` → `OFF`.

The residual limit is stated rather than papered over: replacing the read-back with a hardcoded
`true` does **not** fail any test, because no environment this suite can create has foreign keys
off. The pragma line and its read-back exist so the guarantee survives a driver whose default
differs; only the `OFF` mutation can demonstrate that today.

**Phase 3 found the same shape twice more, and both are reported rather than smoothed over.**
`secure_delete` and the reclaim step are individually sufficient for the byte-level forget test —
removing either alone leaves it green, removing both fails it — so both are kept for the different
ways they fail, and the `secure_delete` guarantee is asserted through
`diagnostics.secureDeleteEnabled`, which the `OFF` mutation does bite. And the atomic write of the
consent record survives every mutation this suite can express, because no in-process test can
interrupt a write; it is a design property, not a proven one.

**A before/after benchmark**, opt-in, belongs to Phase 2. Phase 1 changes where the pipeline
runs, not what it produces, so there is nothing yet to compare — `semanticChunkingVersion` stays
at 1 precisely because the output is byte-identical.

The baseline is not lost even though `src/semanticIndex.ts` is deleted. `chunkPages`
(`core/index/chunking.ts`) is the renderer's algorithm ported unchanged; the OCR-fallback
extraction rule survives verbatim in `src/pdf/pageText.ts`; and the deleted file itself is
recoverable from git history at the Phase 1 parent commit. Phase 2 copies that pair into
`scripts/bench/` at the point it replaces them, rather than committing dead code now.

The benchmark reports page accuracy@1, recall@5, MRR, and **intact-table rate**, against a fixed
six-page fixture whose seven queries each have one correct page written down when the fixture was
built. It also reports how the two OCR arbitration rules disagree, and how much of each chunk
actually reaches the model.

**Measured, and one prediction half-corrected.** This document said intact-table rate was "zero
today by construction". That is true of a *structural* reading — no word-window chunk ever
contained a GFM table row, because pdf.js never produced one — and false of the reading that
matters, which is whether a row's cells reach the model in order. Both are now reported, and the
distinction is the point.

Each side is driven by its own representation: the old pipeline gets a realistic pdf.js
reading-order string, the new one gets PDF Inspector's Markdown. Feeding Firecrawl's output to
the old chunker would have credited it with work it could not do.

| | before | after |
| --- | --- | --- |
| intact-table rate (cells in order, reaching the model) | **0.752** | **1.000** |
| GFM rows preserved (structural) | **0 of 125** | **125 of 125** |
| page accuracy@1 | 0.857 | **1.000** |
| recall@5 | 1.000 | 1.000 |
| MRR | 0.905 | **1.000** |
| chunks over the encoder limit | 1 of 6 | 0 of 14 |
| largest chunk | 695 tokens | 415 tokens |

Two token numbers are kept apart throughout, because conflating them misreports the old
pipeline. The **chunking target** is 420 — the user's profile choice, capped by the catalogue
floor — and is what new chunks are built to. The **encoder payload limit** is 510, the smallest
`model_max_length` less the special-token pair, and is where the installed models actually
truncate. Truncation is simulated at 510; charging the old chunker at 420 would have blamed it
for tokens the model would have accepted.

A separately reported stress scenario — one 400-row table on one page — shows the failure mode
where it dominates: **287 of 400 rows reached the model before, 400 of 400 after**, with three of
four chunks over the encoder limit and a largest chunk of 1,052 tokens against 510.

**The ranking figures are deterministic regression proxies, not evidence about the real model.**
They are computed with `createDeterministicEmbedder`, a normalized bag of words. This document
already states that a replaced boundary proves nothing about whether the real weights rank
usefully, whether ONNX Runtime initialises, or whether the score threshold is calibrated — and
that applies here. What they do prove is that a change to chunking did not move retrieval
backwards under a fixed, reproducible scorer.

recall@5 was already 1.000 and stays there — on a fixture this small every correct page is within
the top five either way, and reporting it unchanged is more useful than choosing a fixture that
made it move. OCR arbitration disagrees on exactly one page of six, the readable-but-sparse case
recorded above as the affected set.

**CI ships in Phase 1.** `.github/workflows/ci.yml` runs on push to `main` and on every pull
request: renderer, core and Electron typechecks, the unit suites, and a build, plus a second job
running the Electron journeys. `release-macos.yml` previously ran no tests at all. Both jobs use
`macos-15` because arm64 is the only supported target and the native modules that ship only load
there. **No lint step** — `AGENTS.md`'s *Verification commands* requires reporting it unavailable rather than
claiming it passed.

Stale-build protection is by npm pre-hooks. `pretest`, `pretest:e2e` and `pretypecheck:core`
each run `build:core`, and `npm run build` runs `typecheck`, `typecheck:core` and `build:core`
before it compiles `electron/` or the renderer. `electron:dev` and `test:e2e` rebuild core too.
No gate can therefore pass against yesterday's `dist-core/`, which matters because everything
outside `core/` imports the compiled output rather than the sources.

Commands, per `AGENTS.md`'s verification table: `npm test`, `npm run typecheck`,
`npm run typecheck:core`, `npm run typecheck:cli`, `npm run typecheck:tests`,
`npx tsc -p tsconfig.electron.json --noEmit`, `npm run build`, and `npm run test:e2e`.

**The journeys job installs no browser.** All three specs launch through `_electron.launch`
with `executablePath` set to the `electron` package's own binary, so they drive Electron's
bundled Chromium and never open a Playwright-managed browser. Verified rather than assumed:
`PLAYWRIGHT_BROWSERS_PATH` is unset on the development machine and the default cache
`~/Library/Caches/ms-playwright` does not exist, yet the full four-journey suite passes. An
`npx playwright install chromium` step would download roughly 140 MB per CI run for nothing.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| A broken signed, notarised release from newly dlopen'd native modules | Partly retired: an unpacked arm64 `--dir` build loads all three native modules offline (see Packaging). Still open: index and search inside a fully packaged app, and signing plus notarization of a distributable. Both are Phase 3 and must run before any tag; CI does not build a release |
| The page-index inconsistency produces systematically wrong citations | One named boundary, a range check as tripwire, a decoy fixture, and mutation proof |
| Notarization is already failing on Apple's side | This work adds signing surface at a bad time. Validate packaging with a local `--dir` build well before a tagged release |
| Two writers on one file | WAL plus `busy_timeout`, and a content-hash serial queue for jobs inside one process. There is deliberately **no** retry or backoff layer; a statement to that effect was removed rather than left unimplemented |
| Main-process jank during indexing | 512-row transactions; documented `utilityProcess` escalation at a measured 50 ms trigger |
| Users re-download the 133 MB model | Expected and stated; surface it in the settings copy and the changelog |
| A young native Rust package on the open-a-file path | Pin the exact version; keep the narrow adapter so it is one file to swap |

---

## ADRs

Following `docs/adr/2026-08-22-Mermaid-Markdown-Rendering.md`'s Status / Context / Decision /
Consequences / Alternatives considered format, each naming its verifying verticals per
`AGENTS.md`'s *Documentation policy*:

1. **Node core layer** — the `core/` and `cli/` boundaries and the `AGENTS.md` amendment.
   Alternatives: npm workspaces, with the full cost comparison; leaving the logic in the renderer.
2. **SQLite index engine** — `better-sqlite3`, WAL, `foreign_keys`, the concurrency model, and
   the batching-safety invariant. Alternatives: `sql.js` with file locking; `node:sqlite`;
   `sqlite-vec`.
3. **Semantic pipeline in the main process** — why the renderer cannot hold a filesystem cache,
   the IPC surface, progress and cancellation. Alternatives: `env.useCustomCache` bridged over
   IPC, rejected with evidence; `utilityProcess`, deferred with a trigger.
4. **PDF Inspector extractor** — the dependency, the platform matrix including the win32-arm64
   gap, and the page-index finding. Alternatives: Docling per page; fuzzy anchors; a hand-written
   structural extractor on `groupSyntheticTextLines`.
5. **Markdown as index representation and schema v2** — `heading_path`, the id format including
   its text hash, delete-not-keep, and the inert-cascade fix.
6. **The embedding input budget** — the measured token floor across the curated catalogue, why
   a shared floor rather than the active model's own limit, the numeric breadcrumb reservation,
   and the lossless row-continuation rule. Must record, with dates and model revisions, the
   measured `model_max_length` and tokenizer hash of every curated model, state which of the two
   counting modes is in force, and record that the hashes are of the **bundled** artefacts so the
   files that count at runtime are the files that were measured. Alternatives: per-model chunking with a model-scoped chunk
   identity, rejected because `chunk_embeddings` exists precisely so that switching models
   re-embeds rather than re-chunks; taking the minimum `model_max_length` as the budget,
   rejected because equal limits do not imply equal counts; estimating tokens from word counts,
   rejected because it cannot be safe at the boundary.
7. **CLI packaging and install** — `ELECTRON_RUN_AS_NODE`, the shim, elevation, and the rejected
   alternatives (bundled Node, symlink, npm publication).
   Delivered as `docs/adr/2026-08-23-CLI-Packaging-And-Install.md`. It records elevation as a
   **departure**: it is not implemented, the destination is chosen by writability instead, and the
   measured `PATH` and permission evidence for that choice is in the ADR rather than in a comment.
8. **The command line's contracts** — added during Phase 3, because the consent model is a
   substantial architectural decision that none of the six above covers. Records why the allowlist
   lives in `core/`, why stored roots are canonical and only requests are resolved, the read/write
   asymmetry, the database-first lookup that makes `search --path` need no permission, secure
   forgetting, the stream split, and the exit-code table including why `parseFailed` is claimed
   only for errors from the parse boundary. Delivered as
   `docs/adr/2026-08-23-Command-Line-Consent-And-Contracts.md`.

`CHANGELOG.md` gets an entry per completed task, per `AGENTS.md`'s *Documentation policy*.

---

## Phase 4 — The MCP server

A thin stdio-first adapter over the core the previous three phases proved, exposing exactly
four tools: `outline`, `search`, `read_pages`, and `to_markdown`. It reuses the CLI's schemas,
document identities, consent and allowlist policy, page-index boundary, and output budgets —
if any of those need changing to fit MCP, that is a signal the CLI got them wrong, not a reason
to fork them.

`read_pages` exists as a distinct tool only because MCP has no flags; in the CLI the same
capability is `convert --pages`. The official MCP SDK is authorized for this phase.

Requirement-derived contract and acceptance coverage is required, plus packaging verification.
The negative checks matter as much as the positive ones: a path outside the allowlist is
refused, and an `[index]`-class tool succeeds with no filesystem permission granted at all.

No broader roadmap features attach here — no resources, no prompts, no Streamable HTTP, and
none of Tier 2 or Tier 3 from the strategy document, until a second consumer exists and has
complained.

---

## Deliberately not in this plan

`list`, `tables`, `annotate`, and `images-to-pdf` commands; MCP resources and prompts;
Streamable HTTP transport; moving OCR out of the renderer for the app; a hand-written
structural extractor; ANN search; index eviction; and any Intel macOS support. Each has a
named place to attach later.
