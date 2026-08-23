# MarkPDF CLI / MCP / Electron parity plan — revision 2

Supersedes `mcp-cli-parity-plan.md`. Branch `cwik-tech/mcp-cli`.
Planning only — no repository file created, edited, committed or pushed.
`git status --porcelain` was empty at start and at finish.

**Shared-worktree constraints, unchanged and still in force.** A Kimi session is doing UI work in
this same worktree. Every unrelated or newly appearing change is user-owned and must not be
touched. Never use bare `git stash` / `git stash pop` — the stash stack is shared. Note also that
`npm test` runs the `pretest` hook, which rebuilds `dist-core/`, `dist-cli/` and `dist-mcp/`; those
are gitignored (`.gitignore` lists `dist/`, `dist-electron/`, `dist-core/`, `dist-cli/`,
`dist-mcp/`), so no tracked file changes, but a concurrent `npm run dev` in the other session
watches those directories. Coordinate before running a full suite, or run
`npx vitest run <file>` directly when `dist-*` is already current.

**All evidence from revision 1 is preserved.** Section 12 carries it forward with the new
measurements added. Sections 2–11 are rewritten where the review findings changed them.

---

## 0. What changed in this revision

| Review finding | Resolution |
|---|---|
| 1 — Electron still bypasses core OCR geometry | **Accepted and traced.** Electron's renderer-supplied candidates suppress the core resolver. Fixed by making the core resolver the single OCR producer for the index and removing the candidate contract end to end. Renderer OCR is preserved for the window only. New phase boundary, new fixture variant, new Electron-indexed search assertion. §2 F1c, §4 P1. |
| 2 — F1b must be implemented, not gated | **Accepted.** Promoted from decision gate G3 to its own phase **P3**, with a measured pdf.js operator-list detection route inside installed dependencies. §2 F1b, §4 P3, §5 page 4. |
| 3 — Markdown tabs: saved as well as unsaved; no permanent truncation | **Accepted.** Snapshot now spans the whole tab lifetime and is deleted only on close/window death/quit. Separate 5 MB local ceiling; MCP reads are paginated by offset. §4 P7. |
| 4 — `indexedAt` from `lastOpenedAt` is untruthful | **Accepted.** `created_at` is INSERT-only and `last_opened_at` is written on every upsert including reuse. Replaced with `snapshotRecordedAt` from `document_markdown.created_at` for `read_pages`, and a new `documents.chunks_written_at` for `search`. §2 F14, §4 P6. |
| 5 — Internal inconsistencies | **Fixed.** Phase count stated (P0–P9, ten phases). ADR filenames use the implementation date, not a hard-coded one. Commands verified against the installed Vitest 4.1.9. §4, §8, §11. |
| 6 — P1/P2 boundaries after the Electron change | **Accepted.** Both outer tests are now Electron journeys through the real desktop path. CLI/MCP parity is a separate journey in P5, never a substitute. §4 P1, P2, P5. |

Two new measurements also changed the design and are load-bearing:

- **The deterministic embedder cannot rank the natural query correctly, and a page-level ranking
  assertion does not discriminate the fix.** Measured, §12. The acceptance assertions were rebuilt
  around this rather than around an assumption.
- **pdf.js operator-list image detection costs 2.8 ms/page** and separates a 0.7 % logo from a
  10.6 % figure cleanly. Measured, §12. This is what makes P3 affordable.

---

## 1. Current-state model

Four surfaces over one core. The table is unchanged from revision 1 except the Electron OCR row,
which the review corrected.

| Surface | Reads pages via | OCR producer for the index | Settings freshness | Score default |
|---|---|---|---|---|
| Electron | `indexPdfDocument` (`electron/semantic.ts:188`) | **The renderer**, via `ocrCandidates` (`src/App.tsx:792`); core resolver absent (`electron/semantic.ts:188-200`) | Per operation (`electron/main.ts:722`) | `settings.minSemanticScore` (`electron/semantic.ts:217`) |
| CLI | `indexPdfDocument` / `readDocumentPages` / `resolveDocumentPages` | Core (`cli/ocrResolver.ts:15-23`; wired at `indexCommand.ts:161`, `convertCommand.ts:54`, `outlineCommand.ts:33`) | Per invocation (`cli/run.ts:142`) | Fixed `0.3` (`cli/spec.ts:134`) |
| MCP | `resolveDocumentPages` (`mcp/operations.ts:164,270,299`) | Core (`mcp/context.ts:74`) | **Read once at startup** (`mcp/context.ts:69`) | Fixed `0.3` via schema default (`mcp/toolSchemas.ts:159` → `mcp/arguments.ts:79`) |

### Intentional boundaries preserved

Unchanged from revision 1 and unaffected by anything below: MCP grants/indexes/deletes nothing
(`mcp/toolSchemas.ts:130-135`); named access classes (`core/documents/documentPages.ts:22-37`);
lexical, filesystem-free path lookup (`core/index/documentLookup.ts:30-41`); no text and no path in
the open-documents record (`core/session/openDocuments.ts:18-23`,
`mcp/openDocumentOperations.ts:16-20`); two separate bounds in core (`core/output/budget.ts:58,72`);
deliberate cross-page heading inheritance for embedding (`core/index/markdownBlocks.ts:95-96`);
table headers already excluded from stored chunk text (`core/index/structuredChunking.ts:151-156`).

---

## 2. Findings

Severity: **S1** silently wrong answers · **S2** wrong-looking answers or lost capability ·
**S3** cost/robustness risk.

### F1 — Image-only pages dropped at Electron index time. Confirmed. S1.

Chain verified in revision 1 and unchanged: `src/pdf/ocr.ts:43-48` samples `1,2,3,ceil(n/2),n`
(never page 10 of 13) → `src/pdf/ocr.ts:34-36` declares the document text-rich →
`src/App.tsx:887-896` sets `ocrStatus: "skipped"` and leaves `tab.ocrPages` empty →
`src/App.tsx:792` sends `ocrCandidates: []` → `electron/semantic.ts:188-200` supplies no
`resolveOcr` → `core/extract/readDocumentPages.ts:114` skips recovery → page 10 becomes
`source: "none"` (`:131`) → dropped from chunks (`core/index/indexPdfDocument.ts:57`) and cached as
`""` (`:139`) → `core/documents/documentPages.ts:130-140` serves that `""` and returns before the
read-time resolver at `:165` can run.

The audit's "unreliable `needsOcr`" premise remains **disproved** — see §12.

### F1c — Renderer OCR candidates suppress the core resolver entirely. **New. Confirmed. S1.** (Review finding 1)

This is the half of F1 that revision 1 missed, and it is the one that survives P1's resolver fix.

`core/extract/readDocumentPages.ts:107,110`:

```
const accountedFor = new Set(supplied.map((candidate) => candidate.page));
const unread = extracted.pages
  .filter((page) => page.needsOcr && !accountedFor.has(page.page) && …)
```

A supplied candidate removes its page from `unread`, so `resolveOcr` is never called for it. The
candidate carries **text only** — `core/ipc/requests.ts:104-108` validates and constructs
`{page, text}`, and `src/semanticSource.ts:39-46` produces exactly that. So whenever renderer OCR
runs at all, Electron's index is built from flat renderer text and core's geometry, table
reconstruction and OCR contract are bypassed for every recognised page.

**The adversarial fixture as designed in revision 1 hides this**, because 11 of its 13 pages are
text-rich, `detectOcrNeed` does not fire, and no candidate is ever produced. A second fixture
variant is required — §5, `"scanned"`.

**Direction chosen: the core resolver becomes the single OCR producer for the index.** The
alternative the review offered — extend the IPC contract to carry geometry — was rejected on
evidence, not preference: the two OCR stacks are genuinely different programs. The renderer runs a
WebAssembly tesseract build over a browser canvas at `renderScale = 2`
(`src/pdf/ocr.ts:8,57-59` — `workerPath`/`corePath` into `public/tesseract*`), while core runs the
Node build in a `worker_threads.Worker` over `@napi-rs/canvas` at 200 dpi
(`core/ocr/tesseractEngine.ts:97-99,142-149`; `core/ocr/rasterisePages.ts:59-62`). Geometry from two
different rasterisers and two different engine builds cannot be guaranteed identical, so carrying it
across IPC would **narrow** the Electron/CLI gap without closing it. Parity needs one producer.
Recorded in the ADR with this reasoning and with the rejected alternative.

**Cost, stated plainly.** A scanned document opened in Electron is now recognised twice: once by the
renderer for the window, once by core for the index. Mitigating facts, all verified: core
recognition runs in a worker thread, not on the main thread
(`core/ocr/tesseractEngine.ts:97-99`); rasterisation becomes per-page streaming in P9; and the
existing justification for reuse (`src/semanticSource.ts:30-34`, ruling R2) was written when core
had no rasteriser, a premise `core/ocr/rasterisePages.ts` has since spent — the same observation
`core/outline/documentOutline.ts:14-19` already makes about ruling R1.

### F1b — Image content on a text-bearing page is unreachable by every surface. **Confirmed. S1. Now implemented, not gated.** (Review finding 2)

```
probe 4: a text-rich page carrying a 180×90 / 320×160 / 500×250 pt image
         → needsOcr=false, len≈830, and "Sales & Marketing 5170" from the image is absent.
```

The page is non-empty and unflagged, so `core/extract/readDocumentPages.ts:109-111` never offers it
and P1's defensive "empty page ⇒ OCR anyway" rule cannot reach it.

**Route, measured and inside installed dependencies.** `pdfjs-dist` is already imported by core
(`core/ocr/rasterisePages.ts:60`) and exports `OPS`. Walking `page.getOperatorList()` with a
save/restore/transform CTM stack yields each image paint's device-space area — for pdf.js an image
is painted into the unit square, so its area is `|det(CTM)|` — with no rendering at all:

```
probe 8, one document, five pages:
  page 1 (text only)          images=0  coverage=0.0%    textChars=590
  page 2 (80×40 logo)         images=1  coverage=0.7%    textChars=590
  page 3 (320×160 figure)     images=1  coverage=10.6%   textChars=590
  page 4 (500×250 figure)     images=1  coverage=25.8%   textChars=590
  page 5 (full-page raster)   images=1  coverage=100.0%  textChars=0
probe 9, cost on the 13-page mixed fixture:
  document open 35.4 ms · operator scan 36.4 ms total (2.8 ms/page)
  pdf-inspector extraction of the same document, for scale: 10.5 ms
```

A 0.7 % logo and a 10.6 % figure separate cleanly, which is what makes a threshold defensible rather
than arbitrary. **No new dependency.** Full design in §4 P3.

### F2 — Heading provenance leaks across pages. Confirmed. S2.

`core/index/markdownBlocks.ts:100-113` walks back unbounded (intentionally);
`core/index/structuredChunking.ts:181-196` uses the same array for the embedding breadcrumb *and*
the stored/returned `headingPath`, which reaches `core/store/index.ts:342`,
`core/index/search.ts:12,68`, `cli/commands/searchCommand.ts:14` and `mcp/operations.ts:225`.

### F3 — Low-signal blocks become standalone chunks. Confirmed. S2.

`core/index/markdownBlocks.ts:32-37` recognises only `#` headings, so `**T R A C T I O N**` is a
paragraph; `core/index/structuredChunking.ts:186-198` emits a chunk for every block with no
minimum-signal and no cross-page repetition rule.

### F4 — MCP settings and embedder drift. Confirmed. S2.

`mcp/context.ts:69` reads settings once at startup and `mcp/operations.ts:212` uses that stale
profile; `mcp/context.ts:57` reads settings **again** when the embedder is first built, so the
cached profile and the live model come from two different reads; the embedder is then never
replaced (`mcp/context.ts:56`). Electron keys a map per model (`electron/semantic.ts:79,106-120`).

### F5 — `to_markdown` can serve a stale cached document. Confirmed. S1.

`core/documents/documentPages.ts:114-120` proves permission, then matches lexically
(`core/index/documentLookup.ts:56-59`) and returns the cache at `:131-139`. The store states the
limitation itself: `getDocumentByPath` returns "the **latest indexed version** of that path and makes
no claim that the file on disk still matches it" (`core/store/index.ts:145-150`). CLI `convert` reads
current bytes every time (`cli/commands/convertCommand.ts:52-59`).

### F6 — OCR differs by entry point; the audit's implied direction is backwards. Confirmed. S2.

| | Renderer (`src/pdf/ocr.ts`) | Core (`core/ocr/`) |
|---|---|---|
| Scale | `renderScale = 2` ≈ 144 dpi (`:8`) | `dpi ?? 200` (`rasterisePages.ts:62`) |
| Engine | `OEM.LSTM_ONLY` (`:57`) | `OEM.LSTM_ONLY` (`tesseractEngine.ts:149`) |
| Page segmentation | `PSM.SPARSE_TEXT` (`:73`) | engine default |
| Interword spaces | `preserve_interword_spaces: "1"` (`:74`) | not set |
| Whitespace | `\s+ → " "` (`:106`) | `.trim()` only (`ocrPages.ts:73`) |

Measured (§12): 144 dpi and 200 dpi produce **byte-identical** text; `PSM.SPARSE_TEXT` destroys row
structure that the core default preserves. So core's configuration is the one to centralise on, and
DPI parity is housekeeping.

### F7 — Score/profile precedence. Confirmed. S2.

`mcp/arguments.ts:79` substitutes the schema `default` when an argument is absent, so
`mcp/operations.ts:214` cannot tell "absent" from "explicitly 0.3". `ParsedOptions`
(`cli/parse.ts:37-46`) has no presence accessor, so `cli/commands/searchCommand.ts:84` has the same
problem. Electron is already correct (`electron/semantic.ts:217`).

### F8 — MCP is silent during long work. Confirmed; SDK support verified on disk. S2.

`RequestHandlerExtra.sendNotification` exists
(`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:203-207`);
`notifications/progress` needs no declared capability
(`.../dist/esm/server/index.js:193-195`); the client attaches `progressToken: messageId` exactly
when `onprogress` is supplied (`.../dist/esm/shared/protocol.js:643-644,649`);
params are `{progressToken, progress, total?, message?}` (`.../dist/esm/types.d.ts:931-936`).
`mcp/server.ts:145-153` reads neither `_meta` nor `sendNotification`; `mcp/context.ts:62` builds the
embedder with no `onProgress`, leaving `core/index/embeddings.ts:81-87` unwired on this surface;
`core/ocr/ocrPages.ts:10,72` already emits per-page progress and `mcp/context.ts:74` passes nothing.

### F9 — `currentPage` withheld. Confirmed; intentional, with a stated cost. S2 capability gap.

`src/openDocuments.ts:16-19` reads it and deliberately drops it; `:25-30` gives the churn reason,
which is real because `src/App.tsx:1363-1375` writes only when the serialized report changes.

### F10 — Markdown tabs listed but unreadable, saved and unsaved alike. Confirmed. S2 capability gap. (Review finding 3)

`mcp/toolSchemas.ts:201` and `src/openDocuments.ts:34-36` list them; `mcp/openDocumentOperations.ts:158-163`
refuses them. The record carries no text and must not (`core/session/openDocuments.ts:20-23`), and
MCP is a separate process (`mcp/main.ts`), so there is no in-process route to a tab's buffer.
The review is right that this is about **every** open Markdown tab: a saved tab is just as
unreadable today, and routing saved tabs through a path-based permission check while unsaved ones
use a snapshot would make the tool's behaviour depend on whether the user had pressed Save.

### F11 — OCR/table layout lost; dependency gate closed by measurement. Confirmed. S1 for the target query.

Renderer OCR computes line boxes then discards them into page text (`src/pdf/ocr.ts:107,120-133`;
only `text` crosses at `src/App.tsx:792`); core's recogniser returns a bare string
(`core/ocr/tesseractEngine.ts:4`). Core's row-per-line output is then classified as *paragraph*
(`core/index/markdownBlocks.ts:32-37`) and consecutive lines merge into one block (`:79`), so a whole
recognised table becomes a single chunk. The installed Node `tesseract.js@7.0.0` **does** return
word geometry (§12, probe 6), so reconstruction needs no new dependency.

### F12 — OCR memory and concurrency. Confirmed as a risk, not reproduced. S3.

`core/ocr/ocrPages.ts:46` awaits the full `PageImage[]` before the first recognition at `:68`;
`core/ocr/rasterisePages.ts:73,87` accumulates. `mcp/context.ts:29,77` allows four concurrent tool
calls on one shared scheduler, so four scans can rasterise at once and a cheap `search` queues
behind a slow one. `core/index/boundedScheduler.ts:47-60` has no `AbortSignal`, so a client that
cancels while queued still takes its turn — `mcp/server.ts:94` notices one tick too late.

### F14 — No stored timestamp truthfully describes an index snapshot. **New. Confirmed. S2.** (Review finding 4)

Revision 1 proposed `StoredDocument.lastOpenedAt`. The write behaviour disproves it.

- `documents.created_at` is supplied on INSERT and **is not in the `DO UPDATE SET` list**
  (`core/store/index.ts:467-484`), so it means "when this content hash was first seen". A document
  re-indexed after an extractor change keeps its original `created_at` while its cached text is new.
- `documents.last_opened_at` **is** in the update list (`core/store/index.ts:480`) and
  `upsertDocument` runs at `core/index/indexDocument.ts:200` — before any chunk is written, on the
  `reused` path (`:260-269`), and on runs later cancelled at `:274` or `:288`. It means "row last
  touched", not "snapshot written".

Two truthful sources exist or can be added cheaply:

- **`read_pages` serves the Markdown cache**, and `document_markdown.created_at`
  (`core/store/schema.ts:26`) is written by `putMarkdown` in one transaction with the row itself
  (`core/store/index.ts:570-576`). That is exactly the snapshot being cited.
- **`search` serves the chunk set**, which has no timestamp column at all. A new
  `documents.chunks_written_at`, stamped after the final batch commits, is the honest addition.

Naming: `snapshotRecordedAt`, never `indexedAt`.

### F13 — Other asymmetries found by tracing. Classified.

| # | Observation | Evidence | Class |
|---|---|---|---|
| a | Cached pages always reported `source: "pdf"` even when the text came from OCR | `core/documents/documentPages.ts:135-137` | **Intentional** and documented in place; superseded by P1's per-page provenance |
| b | A blank page costs a rasterise + recognise on every read, forever | probe 2 (blank page → `needsOcr=true`); `core/ocr/ocrPages.ts:74` drops empty results so nothing records "read, found empty" | **Defect** (cost) — folded into P1 |
| c | `search` is index-only but never says its answer is a snapshot | `mcp/operations.ts:198-241` | **Defect** (disclosure) — folded into P6 |
| d | Electron indexes one document at a time; MCP allows four | `electron/semantic.ts:143`; `mcp/context.ts:29` | **Intentional** — different resources, both reasoned in place |
| e | Publish debounce is a fixed 250 ms regardless of what changed | `src/App.tsx:1367`; `core/session/openDocumentsRequest.ts:33-36` | **Unverified risk** — becomes real only once `currentPage` is published, which is why the churn rule ships in the same phase |
| f | `readSemanticSettings` throws on a present-but-unreadable settings file | `core/settings/appSettings.ts:48` | **Intentional**, reasoned at `:34-39` — P5 must not turn a per-call read into a per-call throw |

---

## 3. Phase order — ten phases, P0 through P9

Each is independently useful, ends green, and has its own outer acceptance loop.

| Phase | Delivers | Journey | Depends on |
|---|---|---|---|
| **P0** | Adversarial fixture builder + frozen expectations (test support) | — | — |
| **P1** | Core OCR is the single index producer; no page silently unread | **A1** (Electron) | P0 |
| **P2** | One versioned OCR contract + deterministic table reconstruction | **A2** (Electron) | P1 |
| **P3** | Image regions on text-bearing pages (F1b) | **I** (new) | P2 |
| **P4** | Honest heading provenance + low-signal block rule | focused | P2 |
| **P5** | Per-call MCP settings, per-model embedder, score precedence | **B**, **C** | — |
| **P6** | Filesystem-class freshness + truthful snapshot disclosure | **D** | — |
| **P7** | `currentPage` + open Markdown tabs, saved and unsaved | **E** (Electron) | P5 |
| **P8** | MCP progress notifications | **F** | P1, P5 |
| **P9** | Streaming OCR, resource-specific concurrency, abortable queueing | **H** | P2, P3 |

Journey **G** (OCR configuration parity and layout preservation at focused layers) is not a phase —
it is the focused-test set inside P2 and P3, which is where the brief asked it to live.

P5 and P6 have no dependency on P1–P4 and can proceed in parallel if two people work on this.

---

## 4. Phase detail

Format for each: **outer test → expected Red → minimum Green → inner loops → refactor →
verification**. Lint is unavailable in this repository (AGENTS.md, "Verification commands"); no
delivery may claim it passed.

### P0 — Adversarial fixture (no production change)

Test support; AGENTS.md exempts it from Red. It ships with a self-check that proves the builder
produced what the expectations claim, using pdf-lib page counts and image-operator presence only —
**never** the production extractor.

Add `cli/journeys/adversarialFixture.test-support.ts` exporting `buildAdversarialPdf(variant)`,
`buildAdversarialMarkdown()`, `buildScannedStressPdf(n)` and a frozen `ADVERSARIAL` object (§5).
Add `cli/journeys/adversarialFixture.test.ts`.

- Command: `npm test -- cli/journeys/adversarialFixture.test.ts`
- Green criterion: `"mixed"` has 13 pages, page 10 carries exactly one image paint op and zero
  text-showing ops, page 4 carries one image ≥ 10 000 pt², page 2 carries one image < 5 000 pt²;
  `"scanned"` has raster on pages 1, 2, 3, 7, 13 and 10; `v1`/`v2` differ only in the sentinel and
  are the same byte length.

### P1 — Core OCR becomes the single index producer, and no page is silently unread

Merges revision 1's P1 with the review's finding 1. Both changes are needed for the same
user-visible outcome, and splitting them would leave a phase that is green on the text-rich fixture
and wrong on the scanned one.

**Outer — Electron journey.** `tests/e2e/mixed-document-ocr.spec.ts`, modelled on
`tests/e2e/open-documents-mcp.spec.ts`.

> *A1: MarkPDF opens and indexes the mixed document; an agent reads page 10 and gets the table that
> exists only as a picture.*

Launch Electron on `buildAdversarialPdf("mixed")`, wait for indexing exactly as
`tests/e2e/open-documents-mcp.spec.ts:193-202` does, connect a real MCP client, call
`read_open_document { pages: "10" }`, assert the markdown contains `"Sales & Marketing"` and
`ADVERSARIAL.page10.salesMarketing2028` (`"5170"`), and assert the reply contains no filesystem path
(the same assertion as `tests/e2e/open-documents-mcp.spec.ts:238-239`).

- Command: `npx playwright test tests/e2e/mixed-document-ocr.spec.ts`
- **Expected Red:** `pages[0].markdown` is `""`.

**Second outer test in the same file, for the suppression path.**

> *A1b: the same is true for a document whose renderer OCR did run.*

Launch on `buildAdversarialPdf("scanned")` — five of `detectOcrNeed`'s five sampled pages are raster,
so `src/pdf/ocr.ts:34-36` fires and the renderer produces candidates for every unreadable page.
Assert page 10's markdown contains `"| Sales & Marketing |"` — the reconstructed pipe form, which
only core's path can produce.

- **Expected Red:** after the resolver fix alone, page 10 is non-empty but carries flat renderer text
  with no pipes. That is precisely the defect the review identified, made observable.

*(This assertion depends on P2's reconstruction, so A1b is written Red in P1 and goes Green in P2.
It is listed here because the fixture variant and the candidate removal belong to P1; state it in
the delivery as a known cross-phase Red rather than letting it look like a failure.)*

**Inner loop 1 — the candidate contract is removed end to end.**
Red (`src/semanticSource.test.ts`, `core/ipc/requests.test.ts`): the index request no longer carries
`ocrCandidates`, and a request that includes one is ignored rather than honoured.
Green — the exact change set:

| File | Change |
|---|---|
| `src/semanticSource.ts:39-46` | delete `buildOcrCandidates` |
| `src/App.tsx:792` | delete the `ocrCandidates` argument |
| `src/global.d.ts` | remove `ocrCandidates` from `SemanticIndexRequest` |
| `core/ipc/requests.ts:86-111,118,147` | remove `requireOcrCandidates` and the field |
| `electron/semantic.ts:192` | remove `ocrCandidates:`; add `resolveOcr: (request) => ocrPages(request, {})` |
| `core/index/indexPdfDocument.ts:27,96` | remove `ocrCandidates` from the input |
| `core/extract/readDocumentPages.ts:31,97-111,125` | remove `ocrCandidates`; `unread` becomes the flag test alone |

Removing the parameter rather than leaving it unused is deliberate: a second OCR producer that
*could* reappear is exactly the drift this closes.

**Inner loop 2 — a boundary tripwire.** Red (`core/boundaries.test.ts`): a new test in the style of
the existing unbounded-text guard (`core/boundaries.test.ts:105-114`) asserting that no production
file under `src/` mentions `ocrCandidates`. Cheap, durable, and it fails the moment somebody
reintroduces the shortcut.

**Inner loop 3 — an unresolved page is not "ready".** Red
(`core/index/indexPdfDocument.test.ts`): a document whose only `needsOcr` page cannot be resolved
returns `status: "incomplete"` with `unresolvedPages: [10]`; today `core/index/indexDocument.ts:342`
returns `"ready"`. Green: widen `IndexStatus`; carry the set on the result.

**Inner loop 4 — the cache records why a page is empty.** Red
(`core/store/markdownCache.test.ts`): `putMarkdown` stores per-page provenance and `getMarkdown`
returns it. Green: schema v3 adds `document_markdown.page_provenance TEXT` — JSON
`[{page, source, status}]`, `source ∈ pdf|ocr|mixed`, `status ∈ read|empty|unresolved`. `NULL` is
legacy (§7).

**Inner loop 5 — a cached unresolved page is not served as an answer.** Red
(`core/documents/documentPages.test.ts`): with page 10 cached `unresolved`, an `index-first` caller
falls through to `readDocumentPages` instead of returning at
`core/documents/documentPages.ts:131-139`, and an `index-only` caller reports it as unresolved rather
than as an empty page. Green: partial-cache branch — serve cached pages, re-read only when an
unresolved page falls inside the requested selection.

**Inner loop 6 — a blank page is recorded read-and-empty.** Red (`core/ocr/ocr.test.ts`): a page that
recognises to nothing yields `{source: "ocr", status: "empty"}` instead of being dropped at
`core/ocr/ocrPages.ts:74`. Without this, probe 2's blank page 13 is rasterised and recognised on
every read forever.

**Inner loop 7 — the bounded defensive rule.** Red
(`core/extract/readDocumentPages.test.ts`): a page with `needsOcr: false` and empty extracted text is
offered to `resolveOcr`. Green: widen `core/extract/readDocumentPages.ts:109-111` to
`page.needsOcr || page.markdown.trim().length === 0`. **Bounded, and it does not address F1b** —
say so in the ADR rather than letting a reader assume otherwise.

**Mutation proof (required — recovery, caching, provenance, cross-process):**
(i) restore `ocrCandidates` in `electron/semantic.ts` → A1b must fail;
(ii) drop `resolveOcr` from `electron/semantic.ts` → A1 must fail;
(iii) serialize `"unresolved"` as `"read"` → inner loop 5 must fail;
(iv) return `"ready"` unconditionally → inner loop 3 must fail.
Restore each and re-run.

**Refactor checkpoint.** Extract the unresolved-page decision into one named core function used by
both `indexPdfDocument` and `resolveDocumentPages`, so the two cannot drift.

**Verification.**
```
npm test -- core/extract/readDocumentPages.test.ts core/index/indexPdfDocument.test.ts \
            core/documents/documentPages.test.ts core/store/markdownCache.test.ts \
            core/ocr/ocr.test.ts core/ipc/requests.test.ts core/boundaries.test.ts \
            src/semanticSource.test.ts
npm test
npm run typecheck
npm run typecheck:core
npx tsc -p tsconfig.electron.json --noEmit
npx playwright test tests/e2e/mixed-document-ocr.spec.ts
```

### P2 — One versioned OCR contract, and layout that survives it

**Outer — Electron journey**, per review finding 6. `tests/e2e/mixed-document-search.spec.ts`.

> *A2: MarkPDF indexes the mixed document; an agent searching it gets the cell from the picture,
> not a neighbouring row and not a decoy.*

Launch Electron on `"mixed"`, wait for indexing, connect an MCP client, call `read_open_document {}`
to obtain `contentHash` (`mcp/openDocumentOperations.ts:202` returns it; no path is disclosed), then
`search { id: contentHash, query: ADVERSARIAL.query, min_score: 0.1, top_k: 12 }` and assert:

1. `results[0].page === 10`;
2. `results[0].snippet` contains `"Sales & Marketing"` and `"5170"`;
3. `results[0].snippet` contains **neither** `"3020"` nor `"1180"` — the R&D and G&A values;
4. no snippet on page 10 contains `"4980"` (the page-3 decoy) or `"1140"` (the chart decoy).

Assertion 3 is the discriminator, and it is the one the measurement forced. See §12: a page-level
ranking assertion alone would pass *without* reconstruction, so it is not Red evidence. Under flat
OCR the whole page is one block (`core/index/markdownBlocks.ts:79` merges consecutive paragraph
lines), so its snippet necessarily carries the other rows.

- Command: `npx playwright test tests/e2e/mixed-document-search.spec.ts`
- **Expected Red:** assertion 3 fails — the top hit's snippet is the whole page.
- **Soundness dependency, stated so a later fixture edit cannot silently defeat it:** page 10's table
  has exactly three body rows, keeping the flat block under `createSnippet`'s 260-character cut
  (`core/index/chunking.ts:28`). Widen that table and assertion 3 stops discriminating.

**Inner loop 1 — one versioned contract, two named profiles.** New `core/ocr/ocrContract.ts`
exporting `OCR_CONTRACT_VERSION` and `ocrProfile("index" | "overlay")`.
Red (`core/ocr/ocr.test.ts` and `core/modelParity.test.ts`): the `index` profile is
`{ engine: LSTM_ONLY, pageSegmentation: default, preserveInterwordSpaces: true, dpi: 200 }` and the
`overlay` profile keeps `PSM.SPARSE_TEXT` at scale 2.

Two profiles rather than one is the honest outcome of the measurement, not a compromise: the
`index` profile keeps table rows intact, and the `overlay` profile's per-cell boxes are what the
window's highlight rectangles are drawn from (`src/App.tsx:3967`). Both are declared in one
versioned module with the measurement that justifies each — which is exactly the brief's
"renderer/core rendering-engine differences only where measured and explicit." The renderer cannot
import core (`core/boundaries.test.ts:74-80`), so the constant is mirrored and
`core/modelParity.test.ts` asserts the two spellings agree — the existing parity-harness pattern,
and cheaper than an IPC round trip for a compile-time constant.

`src/pdf/ocr.ts` otherwise stays as it is: its four remaining consumers — Markdown-engine selection
(`src/App.tsx:1735`), conversion (`:1817`), in-window text search (`:2323`) and the page overlay
(`:3967`) — are unaffected by P1's removal of the fifth.

**Inner loop 2 — geometry reaches core.** Red (`core/ocr/ocr.test.ts`, from a recorded engine result,
not a live engine): `TextRecogniser` returns `{text, lines: [{text, bbox, words: [{text, x0, x1}]}]}`.
Green: `core/ocr/tesseractEngine.ts:160` calls
`worker.recognize(buffer, {}, { blocks: true, text: true })` — available in the Node build, §12 probe
6 — and narrows `blocks` as defensively as `textFromRecognitionResult` narrows `data.text`
(`core/ocr/tesseractEngine.ts:59-65`).

**Inner loop 3 — deterministic table reconstruction.** New `core/ocr/tableFromLines.ts`.
Red (`core/ocr/tableFromLines.test.ts`), from the probe's literal word positions and no engine:

```
| Line item | Approved 2026 | Approved 2027 | Approved 2028 | Approved 2029 |
| --- | --- | --- | --- | --- |
| Sales & Marketing | 4110 | 4620 | 5170 | 5890 |
```

Rule, deterministic and with no runtime tuning knobs: cluster word `x0` across lines; a column exists
when at least 60 % of candidate lines have a word starting within one median-space-width of the
cluster centre; require ≥ 3 lines and ≥ 2 columns, otherwise emit the lines unchanged. Edge cases in
the same file: single column (not a table), ragged row (missing cell becomes an empty cell, never a
shifted row), a single wide title line (excluded from clustering).

**Inner loop 4 — the chunker sees a table.** Red (`core/index/structuredChunking.test.ts`): a
reconstructed OCR page yields one chunk per body row, each carrying the repeated header in
`embedText` only. **Green needs no new code** — `core/index/markdownBlocks.ts:29` already classifies
`|…|` as `table` and `core/index/structuredChunking.ts:147-157` already windows it. Say so in the
delivery, so the reviewer knows the outer test went green through existing machinery.

**Opt-in ranking check.** `core/index/tableRetrieval.live.test.ts`, picked up by
`vitest.live.config.ts` and excluded from the default run (`vitest.config.ts:8`). Runs the **real**
embedding model against the natural query `"Sales & Marketing spend in 2028"` and asserts page 10
wins. This is where retrieval *quality* is actually checked; the default suite proves the pipeline,
which is the division `core/index/embeddings.live.test.ts` already documents. Reported as
verification, never as Red evidence.

**Version impact:** bump `OCR_EXTRACTION_VERSION` (`core/models.ts:88`) and
`semanticChunkingVersion` (`:73`). §7.

**Mutation proof (required — cross-layer with a substituted engine boundary):** set the column
threshold to 0 so every line is one column → inner loop 3 and the outer test must both fail.

**Verification.**
```
npm test -- core/ocr/ocr.test.ts core/ocr/tableFromLines.test.ts \
            core/index/structuredChunking.test.ts core/modelParity.test.ts
npm test
npm run typecheck
npm run typecheck:core
npx playwright test tests/e2e/mixed-document-search.spec.ts
npm run test:live          # reported separately
```

### P3 — Image regions on text-bearing pages (F1b)

Promoted from decision gate G3 at the review's direction. One genuinely material product choice
remains and is isolated as gate **G3′** below, but the implementation path includes this phase.

**Outer — focused, because the failure is not desktop-specific.**
`core/extract/imageRegions.test.ts` plus one MCP journey assertion.

> *I: a figure that exists only inside a picture on an ordinary text page is retrievable, and no
> ordinary text page was rasterised to find it.*

`mcp/journeys/imageRegions.test.ts`: index `"mixed"` with the CLI, search for
`ADVERSARIAL.page4.channelRebate` (`"Channel rebate"`), assert a hit on page 4 whose snippet contains
`"6420"`; and assert — through the injected rasteriser seam — that the set of rasterised pages is
exactly `{4, 10}`, never page 2 (the 0.7 % logo) and never any text-only page.

- Command: `npm test -- mcp/journeys/imageRegions.test.ts core/extract/imageRegions.test.ts`
- **Expected Red:** no hit on page 4 at all; the string exists nowhere in the index.

**Inner loop 1 — detection.** New `core/extract/imageRegions.ts`:
`findImageRegions(bytes, {pages, signal, document?}): Promise<PageImageRegions[]>`.
Red (`core/extract/imageRegions.test.ts`), literals from probe 8: a page with a 80×40 image reports
`qualifies: false`; 320×160 and 500×250 report `true`; a text-only page reports no regions; a
full-page raster reports one region at 100 % coverage.
Green: walk `page.getOperatorList()` with a `save`/`restore`/`transform` CTM stack, treat
`OPS.paintImageXObject | paintInlineImageXObject | paintImageMaskXObject | paintJpegXObject` as
paints, and take each image's device-space area as `|det(CTM)|` and its bbox as the unit square
mapped through the CTM.

Qualification rule, with the measurement behind each number:

- total image coverage ≥ **5 %** of page area — page 2's logo is 0.7 %, page 3's figure is 10.6 %;
- **and** at least one single image of device area ≥ **10 000 pt²** (≈ 100 × 100 pt) — the logo is
  3 200 pt², so a rule/icon/logo can never qualify on coverage alone;
- **and** the page is one `readDocumentPages` did *not* already flag `needsOcr` — flagged pages go
  through the existing whole-page path, so nothing is scanned twice.

**Inner loop 2 — cost.** Red (`core/extract/imageRegions.test.ts`): `findImageRegions` accepts an
already-open pdf.js document so the 35 ms open is paid once, and `page.cleanup()` is called per page.
Green: share the handle with `core/ocr/rasterisePages.ts`. Measured cost, stated in the ADR: 2.8 ms
per page scanned, plus one document open, against 10.5 ms for the whole structural extraction of a
13-page document (§12 probe 9). A 400-page document therefore pays roughly 1.2 s once, and pages
that do not qualify are never rendered.

**Inner loop 3 — region OCR.** Red (`core/ocr/ocrPages.test.ts`): given a qualifying page, the
rasteriser is asked for that page once and the recogniser receives a **crop** of the padded union of
its qualifying regions, not the whole page. Green: rasterise at the `index` profile DPI, crop with
`@napi-rs/canvas` (already a dependency), recognise, reconstruct via `tableFromLines`.

**Inner loop 4 — merge and dedupe with provenance.** Red
(`core/extract/readDocumentPages.test.ts`): a text-bearing page with a qualifying region returns
`source: "mixed"`, its markdown is the native text followed by a blank line and the reconstructed
region text, and an OCR line whose normalized text already occurs in the native text is dropped.
Green: normalize both sides with the existing `toPlainText`
(`core/index/structuredChunking.ts:40-54`) and do a substring test; append rather than interleave.

**Ordering is appended, not interleaved, and that is a documented limitation.** Native markdown comes
from pdf-inspector while region geometry comes from pdf.js, so there is no common coordinate space
to interleave against without a third alignment pass. Appending is deterministic; the provenance
record carries each region's bbox so the position is not lost, only the ordering. Recorded in the
ADR.

**Mutation proof (required — cost and correctness):** lower the single-image floor to 0 → the
"page 2 was never rasterised" assertion must fail; drop the dedupe → the merge test must fail.

**Verification.**
```
npm test -- core/extract/imageRegions.test.ts core/extract/readDocumentPages.test.ts \
            core/ocr/ocrPages.test.ts mcp/journeys/imageRegions.test.ts
npm test
npm run typecheck:core
npm run typecheck:mcp
```

### P4 — Honest heading provenance and a low-signal rule

Unchanged from revision 1's P3 except the phase number.

**Loop 1 — provenance.** Red (`core/index/structuredChunking.test.ts`): a page-11 chunk under a
page-9 heading exposes `headings: [{title: "Operating Plan", page: 9}]` and `localHeadings: []`,
while its `embedText` breadcrumb is unchanged. Green: `headingPathAt`
(`core/index/markdownBlocks.ts:100-113`) also returns each heading's page; `StructuredChunk` gains
`headings`. `document_chunks.heading_path` is already free-form JSON
(`core/store/index.ts:342`), so the reader accepts both `string[]` (legacy → `page: null`) and the
new shape — **no DDL**, and the P2 chunking-version bump re-indexes lazily anyway.
Public contract: MCP `search` keeps `heading_path` and adds `headings` and
`heading_inherited: boolean`; CLI human output prefixes an inherited heading with its page
(`cli/commands/searchCommand.ts:14`).

**Loop 2 — low-signal blocks.** Three tests, one contract each:

1. `**T R A C T I O N**` alone on page 6 followed by prose produces **no** standalone chunk; its text
   prefixes the following same-page chunk's `embedText` and appears in that chunk's `localHeadings`.
2. `**S U M M A R Y**` as the last block of page 11 **is** emitted — a genuine page title is never
   deleted.
3. The repeated footer produces no standalone chunk on any page, and is still present in
   `read_pages` output.

Rules, stated so they can be argued with rather than tuned:

- **Label:** a single-line `paragraph` block whose `toPlainText` is ≤ 48 characters, has no
  sentence-ending punctuation, and is either wholly emphasis-wrapped or ≥ 80 % upper-case letters and
  spaces.
- **Running text:** a block whose `toPlainText` is ≤ 80 characters and appears identically on
  `max(3, ceil(0.4 × pageCount))` or more distinct pages.
- Neither is removed from the document — only from the standalone chunk set, retained as `embedText`
  context. This is a retrieval rule, not an extraction rule.
- **The score is untouched.** Nothing here lowers a threshold or reweights a hit.

Version impact: `semanticChunkingVersion` bumps again. Lazy per-document re-index, as
`core/models.ts:64-71` describes.

**Mutation proof:** extend the label rule to also drop the no-follower case → test 2 must fail.

**Verification.**
```
npm test -- core/index/structuredChunking.test.ts core/index/markdownBlocks.test.ts \
            core/outline/documentOutline.test.ts mcp/operations.test.ts cli/commands.test.ts
npm test
npm run typecheck:core
npm run typecheck:cli
npm run typecheck:mcp
```

### P5 — MCP session freshness and score precedence (journeys B and C)

**Outer.** `mcp/journeys/liveSettings.test.ts`.

> *C: a connected MCP session follows a model, profile and threshold change without restarting.*

Connect; search; rewrite `semanticSearch` in `config.json` (the file
`core/settings/appSettings.ts:22` names); re-index at the new profile with the CLI; search again on
the same connection. Poll the tool result rather than sleeping, as
`tests/e2e/open-documents-mcp.spec.ts:326-334` does.

- **Expected Red:** the second search returns the old profile's results (`mcp/operations.ts:212`).

> *B: CLI and MCP agree under the same live settings.* Second test in the same file: index once, run
> `markpdf search --json` and the MCP `search` tool with identical arguments, assert identical page
> and `chunk_id` ordering. **This is its own journey, never a substitute for A1/A2.**

**Inner loop 1 — one settings read per call.** Red (`mcp/operations.test.ts`): `ToolContext.settings`
becomes `() => SemanticSearchSettings`; a stub counts exactly one call per tool call and every
consumer within that call sees the same object. Green: `mcp/context.ts:69` becomes a function;
`resolving()` (`mcp/operations.ts:144-157`) takes the once-read settings so profile and model can
never come from two reads. Keep `readSemanticSettings`'s throw-on-unreadable contract
(`core/settings/appSettings.ts:48`) but catch it at the tool boundary so a broken settings file
refuses one call rather than killing a session — `mcp/server.ts:114-116` already converts a throw
into a refusal, so this is message quality, not a new mechanism.

**Inner loop 2 — per-model embedder lifecycle.** Red (`mcp/context.test.ts`, new): two model ids give
two embedders; one id twice gives the same instance; a third distinct id evicts the least recently
used. Green: the map from `electron/semantic.ts:79,106-120`, capped at 2 — an ONNX session per model
is the resource, and two covers "switched and switched back" without unbounded growth.

**Inner loop 3 — precedence declared in the one table.** Red (`cli/parse.test.ts`,
`mcp/toolSchemas.test.ts`): `search --min-score` absent uses the live setting, present uses the
argument, and the published tool schema for `min_score` carries **no** `default`. Green: `OptionSpec`
(`cli/spec.ts:21-30`) gains `settingsDefault?: keyof SemanticSearchSettings`; `toProperty`
(`mcp/toolSchemas.ts:63-79`) omits `default` for such an option so `mcp/arguments.ts:79` leaves it
absent; `mcp/operations.ts:214` and `cli/commands/searchCommand.ts:84` read
`argument ?? settings.minSemanticScore`. `--help` says the fallback is the application's setting.
Electron is already correct and is left alone.

**Mutation proof (required — settings, cross-process):** re-cache the settings object behind the
function → outer test must fail. Remove the LRU cap → inner loop 2 must fail.

**Verification.**
```
npm test -- mcp/journeys/liveSettings.test.ts mcp/operations.test.ts mcp/context.test.ts \
            mcp/toolSchemas.test.ts cli/parse.test.ts cli/commands.test.ts
npm test
npm run typecheck:mcp
npm run typecheck:cli
```

### P6 — Filesystem-class freshness and truthful snapshot disclosure (journey D)

**Outer.** `mcp/journeys/staleDocument.test.ts`.

> *D: after a file is replaced at the same path, `to_markdown` shows the new bytes while `read_pages`
> still shows the indexed snapshot and says when that snapshot was recorded.*

Index v1; overwrite the same path with v2; then `to_markdown` must contain `ADVERSARIAL.v2Sentinel`
and not v1; `read_pages` must contain v1, carry `indexSnapshot: true` and a `snapshotRecordedAt`
earlier than the overwrite; after `markpdf index --force`, both show v2.

- **Expected Red:** `to_markdown` returns the v1 sentinel (`core/documents/documentPages.ts:131-139`).

**Inner loop 1 — verify content before serving cache to a `filesystem` caller.** Red
(`core/documents/documentPages.test.ts`): with `access: "filesystem"` and a file whose bytes no
longer hash to the stored `contentHash`, the resolver re-reads instead of serving cache. Green: after
the existing permission proof (`core/documents/documentPages.ts:114-120`), read the bytes through the
existing `readOnce` memo (`:76-83`) and compare `hashBytes` to `lookup.document.contentHash`; serve
cache only on a match. The read is already in-contract for this class, and `readOnce` keeps
`to_markdown` to one open. `index-only` and `index-first` are untouched — that distinction is the
whole point of the access classes.

**Inner loop 2 — a truthful snapshot timestamp.** Red (`core/store/markdownCache.test.ts`,
`core/store/store.test.ts`):

- `getMarkdown` also returns `document_markdown.created_at`, which
  `putMarkdown` writes in one transaction with the row (`core/store/index.ts:570-576`;
  column at `core/store/schema.ts:26`). This is the snapshot `read_pages` actually serves.
- A new `documents.chunks_written_at`, added in the same v3 migration and stamped by a new
  `markChunksComplete(scope, at)` called after the final batch commits in
  `core/index/indexDocument.ts` (after the loop ending at `:339`). This is the snapshot `search`
  actually serves. `NULL` for legacy rows, reported as `null`.

Neither `created_at` nor `last_opened_at` on `documents` is used, and the test asserts why:
`created_at` is absent from the `DO UPDATE SET` list (`core/store/index.ts:467-484`) so it survives
re-indexing, and `last_opened_at` is written on every upsert including the `reused` path
(`core/index/indexDocument.ts:200,260-269`).

**Inner loop 3 — disclosure.** Red (`mcp/operations.test.ts`): `read_pages` and `search` carry
`indexSnapshot: true` and `snapshotRecordedAt`; `to_markdown` carries `indexSnapshot: false`. Tool
descriptions (`mcp/toolSchemas.ts:152,169`) gain one sentence each. The field is **never** named
`indexedAt`.

**Mutation proof (required — caching, freshness):** compare file size instead of hash → inner loop 1
must fail on the same-size v1/v2 replacement, which the fixture is built to be (§5).

**Verification.**
```
npm test -- core/documents/documentPages.test.ts core/store/markdownCache.test.ts \
            core/store/store.test.ts mcp/operations.test.ts mcp/journeys/staleDocument.test.ts
npm test
npm run typecheck:core
npm run typecheck:mcp
```

### P7 — Open-document context: current page, and every open Markdown tab (journey E)

Rewritten against review finding 3.

**Outer — Electron journey.** `tests/e2e/open-document-context.spec.ts`.

> *E: an agent can tell which page the person is on, and can read the notes beside it — saved or
> not, short or long — without ever learning where either file lives.*

Open `"mixed"` and a Markdown tab, type into the notes without saving, navigate the PDF to page 10,
leave the PDF active. Then over MCP: `list_open_documents` reports `currentPage: 10` for the PDF and
`unsavedChanges: true` with `contentChars > 0` for the notes; `read_open_document { ref: <notes> }`
returns `ADVERSARIAL.markdownTabSentinel`; **save the notes and read again** — still readable, same
sentinel, `unsavedChanges: false`; and neither reply contains a filesystem path
(same assertion style as `tests/e2e/open-documents-mcp.spec.ts:238-239`).

- **Expected Red:** `currentPage` absent (`src/openDocuments.ts:16-19`); the Markdown read refused
  (`mcp/openDocumentOperations.ts:158-163`).

**Inner loop 1 — publish `currentPage` without churn.** Red (`src/openDocuments.test.ts`):
`projectOpenDocuments` carries `currentPage` for a PDF tab and `null` for a Markdown tab; a new pure
rule `publishDelayFor(previous, next)` returns the short delay when identity changed and a longer one
when only `currentPage` changed. Green: extend the projection; `src/App.tsx:1363-1375` uses the
returned delay instead of the constant `250` and compares two serializations, one excluding
`currentPage`, so page turns coalesce while tab changes stay responsive.

**Inner loop 2 — validate at the receiving boundary.** Red
(`core/session/openDocumentsRequest.test.ts`): `currentPage` must be `null` or an integer in
`1..pageCount`; anything else is refused in the existing style
(`core/session/openDocumentsRequest.ts:62-67`).

**Inner loop 3 — a lifetime-long content snapshot.** Red (`core/session/openDocumentContent.test.ts`,
new). The lifecycle the review asked for, stated exactly:

| Event | Snapshot |
|---|---|
| Markdown tab opened | written |
| buffer edited | rewritten (debounced) |
| **tab saved** | **rewritten, not deleted** — the tab is still open, so it stays readable |
| tab closed | deleted |
| window closed or reloaded | deleted for that window |
| app quits | deleted for that process |
| owning pid not running | ignored **and** deleted by the reader |

Storage: `<dataDir>/open-documents/content/<pid>-<window>-<tabId>.md`, mode `0600`, written with the
`mkdtemp` + atomic-rename discipline already at `core/session/openDocuments.ts:118-133`, and read
with the same pid-liveness rule as `core/session/openDocuments.ts:236-252`.

**Local ceiling, separate from the reply budget.** `OPEN_DOCUMENT_SNAPSHOT_CEILING = 5_000_000`
bytes. A document larger than that is stored up to the ceiling and the record carries
`snapshotTruncated: true` — **not** `DEFAULT_CONTENT_BUDGET`, which is a per-reply bound
(`core/output/budget.ts:58`) and would have made the only stored copy permanently short.

**The metadata record still carries no text.** It gains `hasContentSnapshot: boolean`,
`contentChars: number`, `contentBytes: number`, `snapshotTruncated: boolean` — counts, not content —
so `core/session/openDocuments.ts:20-23` stays true as written.

**Inner loop 4 — bounded pagination.** Red (`core/output/budget.test.ts`): a new
`boundTextFrom(text, offset, budget): {text, offset, nextOffset, totalChars, truncated, omittedBytes, totalBytes}`
reusing the existing `fittingLength` code-point walk (`core/output/budget.ts:170-192`) so a cut never
lands inside a character. Offsets are **UTF-16 code units**, matching the convention
`core/store/markdownDocument.ts:28` already states.

**Inner loop 5 — the tool answers for a Markdown tab.** Red
(`mcp/openDocumentOperations.test.ts`), five contracts:

1. a **saved** open tab is readable and reports `unsavedChanges: false`;
2. an **unsaved** open tab is readable and reports `unsavedChanges: true`;
3. a **long** document is readable across successive calls — start at `offset: 0`, follow
   `nextOffset` until it is `null`, and the concatenation equals the source exactly;
4. a **stale** tab (pid gone) is refused with the existing no-path wording
   (`mcp/openDocumentOperations.ts:222-235`) and its file is removed;
5. a tab beyond the ceiling reports `snapshotTruncated: true` and still paginates over what is
   stored.

Schema (`mcp/toolSchemas.ts`, `read_open_document`):

| Argument | Type | Meaning |
|---|---|---|
| `ref` | string, default `"active"` | unchanged |
| `pages` | string | **PDF refs only.** Given with a Markdown ref → refused with a sentence naming `offset` |
| `offset` | integer ≥ 0, default 0 | **Markdown refs only.** Given with a PDF ref → refused with a sentence naming `pages` |

Refusing rather than ignoring follows the codebase's refuse-don't-repair style
(`core/ipc/settings.ts:89-94`).

Reply for a Markdown ref: `{ ref, name, kind: "markdown", unsavedChanges, text, offset, nextOffset,
totalChars, totalBytes, truncated, omittedBytes, snapshotTruncated }`. `nextOffset` is `null` exactly
when the end was reached. No path, ever.
`list_open_documents` gains `currentPage`, `hasContentSnapshot`, `contentChars`, `contentBytes`,
`snapshotTruncated`, so an agent can plan its pagination before it starts.

**Consent — decision gate G1 (§10).** Recommended: reading an open Markdown tab needs **no**
filesystem grant, and saved and unsaved tabs behave identically. The authority is "the person has
this open in MarkPDF", which is the authority `list_open_documents` already relies on; the content
never leaves the machine's own processes; it is bounded by the same reply budget as everything else;
and no path is disclosed. Routing saved tabs through a path grant instead would make the tool's
behaviour depend on whether the user had pressed Save — the inconsistency the review flagged.

**Mutation proof (required — cross-process, privacy, lifecycle):** (i) delete the snapshot on save →
the saved-tab half of the outer journey must fail; (ii) skip the pid-liveness check → inner loop 5
case 4 must fail; (iii) include the path in the Markdown reply → the outer journey's privacy
assertion must fail; (iv) clamp the snapshot at `DEFAULT_CONTENT_BUDGET` → inner loop 5 case 3 must
fail.

**Verification.**
```
npm test -- src/openDocuments.test.ts core/session/openDocuments.test.ts \
            core/session/openDocumentsRequest.test.ts core/session/openDocumentContent.test.ts \
            core/output/budget.test.ts mcp/openDocumentOperations.test.ts mcp/toolSchemas.test.ts
npm test
npm run typecheck
npm run typecheck:core
npm run typecheck:mcp
npx tsc -p tsconfig.electron.json --noEmit
npx playwright test tests/e2e/open-document-context.spec.ts
```

### P8 — Progress notifications (journey F)

**Outer.** `mcp/journeys/progress.test.ts`.

> *F: a long tool call reports progress to a client that asked for it.*

Call `to_markdown` on the scanned fixture with
`client.callTool(request, undefined, { onprogress })`; assert at least one notification arrives whose
`message` names a page, and that `progress` never decreases. No sleeps — the assertion is on what was
collected by the time the call resolves.

- **Expected Red:** zero notifications (`mcp/server.ts:145-153`).

**Inner loop 1 — the reporter.** Red (`mcp/server.test.ts`): `callTool` given a progress token emits
notifications; given none, emits nothing; and emits at most one per 500 ms besides the first and the
last. Green: `callTool` gains an optional reporter; `createMarkpdfServer` builds it from
`extra._meta?.progressToken` and `extra.sendNotification` (§2 F8). Bound the `message` with
`boundText` after `safeForTerminal`, as refusals already are (`mcp/server.ts:50-52`) — a notification
is reply text too. No capability declaration is needed
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:193-195`), so
`mcp/server.ts:133` stays `{ tools: {} }`.

**Inner loop 2 — the two producers.** Red (`mcp/context.test.ts`): `resolveOcr` forwards per-page
progress (`core/ocr/ocrPages.ts:72` already emits it), and the embedder is constructed with an
`onProgress` that publishes download bytes. Green: `mcp/context.ts:74` passes `onProgress`;
`mcp/context.ts:62` passes `onProgress` into `createTransformersEmbedder`, reusing `ModelProgressHub`
(`core/index/modelProgress.ts`) exactly as `electron/semantic.ts:89,115` does so a second concurrent
call also sees the download.

**Mutation proof:** drop the "always emit the last" rule → inner loop 1 must fail. (A throttle that
never emits is otherwise indistinguishable from a working one.)

**Verification.** `npm test -- mcp/server.test.ts mcp/context.test.ts mcp/journeys/progress.test.ts`,
then `npm test`, `npm run typecheck:mcp`.

### P9 — Streaming OCR, resource-specific concurrency, cancellation (journey H)

**Outer — focused.** `core/ocr/ocrStreaming.test.ts`, fast because the rasteriser is replaced at the
seam that already exists for it (`core/ocr/ocrPages.ts:16-23`).

> *H: recognising a long scan holds one page image at a time, and a cheap call never waits behind it.*

- **Expected Red:** the injected rasteriser is asked for all N pages before the first recognition
  (`core/ocr/ocrPages.ts:46` versus `:68`).

**Inner loop 1 — per-page streaming.** Green: add
`rasterisePdfPagesStreaming(bytes, options): AsyncIterable<PageImage>` in
`core/ocr/rasterisePages.ts`; keep `rasterisePdfPages` as a thin collector over it so every existing
test stays green; have `ocrPages` consume the iterable. The existing between-page cancellation checks
(`core/ocr/ocrPages.ts:63,71`; `core/ocr/rasterisePages.ts:75`) move with the loop, and the honest
"one page's render is not preemptible" note stays true.

**Inner loop 2 — abortable queueing.** Red (`core/index/concurrency.test.ts`): a queued unit of work
whose signal aborts gives up its place and never runs. Green: `BoundedScheduler.run(work, signal?)`
removes its waiter on `abort` (`core/index/boundedScheduler.ts:47-60`). Event-driven, no timers, no
polling — matching `JobRegistry.whenIdle`'s discipline (`core/index/jobRegistry.ts:112`).

**Inner loop 3 — two schedulers.** Red (`mcp/context.test.ts`): a `search` runs while an OCR call
holds the OCR permit. Green: `mcp/context.ts` keeps `scheduler` at 4 for tool calls and adds
`ocrScheduler = new BoundedScheduler(1)`, acquired inside the `resolveOcr` closure at
`mcp/context.ts:74`; `search` is index-only (`mcp/operations.ts:198-204`) and never touches it.
Update the comment at `mcp/context.ts:20-28`, which currently claims the two "do not contend for the
same resource" — with one shared scheduler they do.

**Opt-in stress.** `core/ocr/ocrMemory.live.test.ts`, picked up by `vitest.live.config.ts` and
excluded from the default run (`vitest.config.ts:8`). Builds `buildScannedStressPdf(60)` and asserts
peak RSS growth stays under a ceiling stated when the test is written, not guessed now. Reported as
verification, not Red evidence.

**Mutation proof (required — concurrency):** raise the OCR scheduler to 4 → inner loop 3's
companion "concurrent OCR stays capped" assertion must fail.

**Verification.**
```
npm test -- core/ocr/ocrStreaming.test.ts core/index/concurrency.test.ts mcp/context.test.ts
npm test
npm run typecheck:core
npm run typecheck:mcp
npm run test:live      # reported separately
```

---

## 5. Fixture and expected literals

`cli/journeys/adversarialFixture.test-support.ts`, generated at test time with the installed
`pdf-lib` and `@napi-rs/canvas` — both already used for exactly this
(`cli/journeys/fixtures.test-support.ts:1-2,60-75`). **No new dependency.** Every literal is a
property of the builder, written in the expectations module and never read back from extractor
output (AGENTS.md, "Use an independent expected result").

### `"mixed"` — 13 pages

| Page | Content | Purpose |
|---|---|---|
| 1 | `# Operating Plan 2026-2029`, prose, `v1Sentinel` | Text-rich; sampled |
| 2 | `# Method`, prose, **80×40 pt logo image**, footer | Sampled; the P3 negative control — must never be rasterised |
| 3 | `## Indicative spend (superseded)` + **native-text table**, cols 2026-2029, rows Sales & Marketing / R&D / G&A, footer | Sampled; the decoy table |
| 4 | `## Marketing`, prose, **320×160 pt image carrying a small table**, footer | **F1b**: financial sentinel present only as pixels on a text-rich page; also near-collision label #1 |
| 5 | `## Total Sales`, prose, footer | Near-collision label #2 |
| 6 | `**T R A C T I O N**` then two prose paragraphs, footer | Label with a follower (P4 test 1) |
| 7 | `# Commercial` + **46-row table**, header repeated every 12 rows, footer | Sampled; crosses the 420-token balanced budget |
| 8 | continuation of page 7's table, **no heading of its own**, footer | Inherited-heading case |
| 9 | `# Operating Plan` heading + one prose line, footer | The heading page 10 inherits |
| 10 | **full-page raster, no text layer** — the answer table, **exactly 3 body rows** | F1, F11, the target query |
| 11 | `# Appendix A`, prose, footer, then `**S U M M A R Y**` as the last block | Fresh page title; label with no follower (P4 test 2) |
| 12 | **image-only chart**, overlapping labels and numbers, none of them the answer | Decoy |
| 13 | **genuinely blank** | Blank-page provenance (F13b) |

### `"scanned"` — the variant that exercises F1c

Same content, but pages **1, 2, 3, 7 and 13** are drawn as raster images as well as page 10. All five
of `detectOcrNeed`'s sampled pages (`src/pdf/ocr.ts:43-48` → `1,2,3,7,13` for n=13) are then
textless, so `src/pdf/ocr.ts:34-36` fires, the renderer OCRs the document, and candidates are
produced for every unreadable page — including page 10. Without P1's candidate removal, Electron
indexes flat renderer text and A1b fails.

### Frozen expectations

```ts
export const ADVERSARIAL = Object.freeze({
  pageCount: 13,
  imageOnlyPage: 10,
  blankPage: 13,
  chartPage: 12,
  logoPage: 2,                                   // must never be rasterised
  // The answer. Only ever pixels, on page 10. Exactly three body rows — see the P2 soundness note.
  page10: {
    rowLabel: "Sales & Marketing",
    columnPrefix: "Approved",                    // the disambiguator the query needs
    salesMarketing2028: "5170",
    row2026: "4110", row2027: "4620", row2029: "5890",
    otherRows: { rd2026: "3020", ga2026: "1180" }, // must NOT appear in the winning snippet
  },
  // F1b: pixels on a text-rich page. These words appear in no native text anywhere.
  page4: { channelRebate: "Channel rebate", channelRebate2028: "6420" },
  page3:  { salesMarketing2028: "4980" },        // native-text decoy
  chart:  { marketing2028: "1140" },             // image-chart decoy
  nearCollisionLabels: ["Marketing", "Sales & Marketing", "Total Sales"],
  footer: "MarkPDF planning pack — confidential draft",   // pages 2-12
  slideLabelWithFollower: "T R A C T I O N",     // page 6
  slideLabelAlone: "S U M M A R Y",              // page 11, last block
  inheritedHeading: { title: "Operating Plan", page: 9, appliesToPage: 10 },
  localHeading:     { title: "Appendix A",     page: 11 },
  longTable: { page: 7, bodyRows: 46, headerRepeatEvery: 12 },
  // The query the default suite uses. See §12 for why the natural phrasing cannot be used with
  // the deterministic embedder, and where the natural phrasing IS checked.
  query: "Approved 2028 Sales Marketing operating plan",
  v1Sentinel: "SENTINEL-ALPHA-7731",
  v2Sentinel: "SENTINEL-BRAVO-7731",             // same byte length as v1
  markdownTabSentinel: "NOTE-CHARLIE-9042",
  longMarkdownChars: 120_000,                    // forces multi-call pagination in P7
});
```

**Why these values survive OCR.** Measured, not assumed: probe 5 recognised
`Sales & Marketing 4110 4620 5170 5890` exactly at both 144 and 200 dpi with the core configuration,
from a 1224×1584 canvas at 34 px Helvetica. The builder uses those drawing parameters. Four-digit
values with no shared prefix keep a single-character misread from turning one decoy into another.

**Same-length sentinels** are the point of the v1/v2 pair: a freshness check implemented as a
size comparison would pass, and P6's mutation proof depends on that failing.

**Variants:** `buildAdversarialPdf("mixed" | "scanned" | "v1" | "v2")`,
`buildAdversarialMarkdown({ chars })`, `buildScannedStressPdf(60)` — the last used **only** by
`core/ocr/ocrMemory.live.test.ts`, never in the default suite.

**Tab arrangement for the Electron journeys:** open the PDF and the notes, navigate the PDF to
page 10, leave the PDF active. That makes `currentPage: 10` and "the table I am looking at" a real
question rather than a coincidence.

---

## 6. Files and public contract impact

### Added

| File | Phase |
|---|---|
| `cli/journeys/adversarialFixture.test-support.ts`, `.test.ts` | P0 |
| `core/ocr/ocrContract.ts` + test | P2 |
| `core/ocr/tableFromLines.ts` + test | P2 |
| `core/extract/imageRegions.ts` + test | P3 |
| `core/session/openDocumentContent.ts` + test | P7 |
| `mcp/context.test.ts` | P5 |
| `mcp/journeys/imageRegions.test.ts`, `liveSettings.test.ts`, `staleDocument.test.ts`, `progress.test.ts` | P3/P5/P6/P8 |
| `core/ocr/ocrStreaming.test.ts` | P9 |
| `core/index/tableRetrieval.live.test.ts`, `core/ocr/ocrMemory.live.test.ts` | P2/P9, opt-in |
| `tests/e2e/mixed-document-ocr.spec.ts`, `mixed-document-search.spec.ts`, `open-document-context.spec.ts` | P1/P2/P7 |
| 4 ADRs under `docs/adr/` | §8 |

### Changed

`core/extract/readDocumentPages.ts` · `core/extract/pdfInspector.ts` (unchanged behaviour; comment
only) · `core/index/indexPdfDocument.ts` · `core/index/indexDocument.ts` ·
`core/documents/documentPages.ts` · `core/store/schema.ts` · `core/store/index.ts` ·
`core/ocr/ocrPages.ts` · `core/ocr/rasterisePages.ts` · `core/ocr/tesseractEngine.ts` ·
`core/index/markdownBlocks.ts` · `core/index/structuredChunking.ts` · `core/index/search.ts` ·
`core/index/boundedScheduler.ts` · `core/ipc/requests.ts` · `core/models.ts` ·
`core/output/budget.ts` · `core/session/openDocuments.ts` · `core/session/openDocumentsRequest.ts` ·
`core/boundaries.test.ts` · `cli/spec.ts` · `cli/parse.ts` · `cli/commands/searchCommand.ts` ·
`mcp/context.ts` · `mcp/operations.ts` · `mcp/openDocumentOperations.ts` · `mcp/server.ts` ·
`mcp/toolSchemas.ts` · `electron/semantic.ts` · `electron/openDocuments.ts` · `electron/main.ts` ·
`electron/preload.ts` · `src/global.d.ts` · `src/openDocuments.ts` · `src/semanticSource.ts` ·
`src/pdf/ocr.ts` · `src/App.tsx`

### Public contract changes

**Removed (P1).** `SemanticIndexRequest.ocrCandidates` from `src/global.d.ts`,
`ParsedIndexRequest.ocrCandidates` from `core/ipc/requests.ts`, and `ocrCandidates` from
`IndexPdfDocumentInput` and `ReadDocumentInput`. A narrowing, and the point of it: after this change
nothing produces one, and a parameter kept only so a second OCR producer could reappear is the drift
being closed.

**MCP schemas.** `min_score` and `top_k` lose their published `default`. `read_open_document` accepts
Markdown refs and gains `offset`; `pages` becomes PDF-only with an explicit refusal for the mismatch.
Descriptions on `search`, `read_pages` and `read_open_document` gain a snapshot sentence.

**MCP replies (all additive; every existing field keeps its meaning; all pass both bounds).**
`search` adds `headings`, `heading_inherited`, `indexSnapshot`, `snapshotRecordedAt`.
`read_pages` adds `indexSnapshot`, `snapshotRecordedAt`, and a per-page `status` for unresolved pages.
`list_open_documents` adds `currentPage`, `hasContentSnapshot`, `contentChars`, `contentBytes`,
`snapshotTruncated`.
`read_open_document` adds `kind`, `currentPage`, and for Markdown refs `text`, `offset`,
`nextOffset`, `totalChars`, `truncated`, `omittedBytes`, `snapshotTruncated`.

**Core.** `IndexStatus` widens with `"incomplete"`; `IndexedDocumentResult` gains `unresolvedPages`;
`PageSource` gains `"mixed"`; `ReadPage` gains a provenance `status`;
`StructuredChunk`/`SemanticSearchResult` gain `headings`; `SemanticStore` gains per-page provenance
on `putMarkdown`/`getMarkdown`, a `created_at` on the `getMarkdown` result, and
`markChunksComplete`; `TextRecogniser` returns geometry; `BoundedScheduler.run` takes an optional
signal; `boundTextFrom` is new.

**IPC.** `ReportedOpenDocument` gains `currentPage`, `hasContentSnapshot`, `contentChars`,
`contentBytes`, `snapshotTruncated`; a new `open-documents:publish-content` channel carries a
Markdown tab's buffer. Handler, preload bridge and `src/global.d.ts` change together, as AGENTS.md
requires.

**CLI.** `--min-score`/`--top-k` help text names the settings fallback. `markpdf index` reports
`incomplete` for a document with unresolved pages. Exit codes unchanged.

---

## 7. Cache migration, invalidation, backward compatibility

**Store schema v2 → v3** (`core/store/schema.ts:6`). Two additive columns, nothing rewritten,
nothing deleted:

```sql
ALTER TABLE document_markdown ADD COLUMN page_provenance TEXT;   -- P1
ALTER TABLE documents         ADD COLUMN chunks_written_at TEXT; -- P6
```

`SchemaTooNewError` (`core/store/errors.ts`) already protects a v3 file opened by an older build, so
a downgrade refuses cleanly rather than corrupting. Say so in the CHANGELOG.

**Legacy cache rule.** A `NULL`-provenance cache is trusted for every **non-empty** page. An empty
page in a legacy cache is treated as `unknown`, which behaves like `unresolved` for an
`index-first`/`filesystem` caller (re-read) and is reported honestly to an `index-only` caller. That
repairs F1's existing bad caches lazily, one document at a time, with no migration pass and without
invalidating text that was never wrong.

**Version bumps** (`core/models.ts`):

| Constant | Change | Effect |
|---|---|---|
| `OCR_EXTRACTION_VERSION` (`:88`) | 1 → 2 (P2) | Diagnostic; marks rows read under the new contract |
| `TEXT_EXTRACTION_VERSION` (`:82`) | unchanged | Structural extraction did not change |
| `MARKDOWN_VERSION` (`:100`) | **unchanged — see gate G2** | |
| `semanticChunkingVersion` (`:73`) | 2 → 3 (P2), 3 → 4 (P4) | Chunk output changes; lazy per-document re-index as `:64-71` describes |

**Why `MARKDOWN_VERSION` stays at 1 (gate G2, recommended default).**
`getMarkdown(documentId, engineId, markdownVersion)` is an exact match (`core/store/index.ts:183`),
so a bump makes every existing cache invisible at once. `outline`, `to_markdown` and
`read_open_document` are `index-first`/`filesystem` and would simply re-read — correct, slower once.
But `read_pages` is `index-only`, so it would return `no-stored-text`
(`core/documents/documentPages.ts:141`) until each document is re-indexed: a real, temporary
regression for an agent mid-session. Per-page `page_provenance` gives the same invalidation at page
granularity with no such regression, so it is the recommendation.

---

## 8. ADRs and CHANGELOG

Four ADRs under `docs/adr/`, named **`YYYY-MM-DD-Short-Name.md` using the date the ADR is actually
written** — AGENTS.md's documentation policy states the pattern, and revision 1 wrongly hard-coded a
future date. Each follows the Status/Context/Decision/Consequences shape of
`docs/adr/2026-08-23-MCP-Server-Adapter.md` and names its verification tests.

1. **`<date>-Core-OCR-As-The-Single-Index-Producer.md`** (P1, P2) — the candidate-suppression trace,
   why the geometry-over-IPC alternative was rejected on evidence, the two named profiles in one
   versioned contract with the measurements behind each, per-page provenance, the unresolved-page
   contract, the double-recognition cost and its mitigations, and the explicit statement that the
   defensive empty-page rule does **not** address F1b.
2. **`<date>-Image-Regions-On-Text-Bearing-Pages.md`** (P3) — the pdf.js operator-list route, the
   measured coverage numbers and per-page cost, the two thresholds and why each is defensible, the
   append-don't-interleave limitation, and the merge/dedupe provenance model.
3. **`<date>-Chunk-Heading-Provenance-And-Low-Signal-Blocks.md`** (P4) — local versus inherited
   headings, the label and running-text rules with their thresholds, and the explicit non-goal of
   touching the score.
4. **`<date>-MCP-Session-Freshness-And-Open-Document-Context.md`** (P5, P6, P7, P8) — per-call
   settings, per-model embedder lifecycle, argument-over-setting precedence declared in `cli/spec.ts`,
   content verification for the `filesystem` class, why `last_opened_at` and `created_at` are both
   untruthful as snapshot timestamps and what replaces them, the open-document content snapshot with
   its lifetime and ceiling, the consent position with its alternative (G1), and progress
   notifications with the SDK version evidence.

**CHANGELOG.md** — one entry per phase under `## [Unreleased]`, in the existing user-facing voice
(no file paths). Drafts:

- *Fixed* — "A page that is only a picture is no longer skipped. MarkPDF reads it when it indexes the
  document, so searching for something that appears only in a scanned table finds it. A page that
  could not be read is reported as unread rather than counted as an empty page."
- *Changed* — "Scanned pages are now read the same way whether a document is indexed in the app or
  from the command line. The app previously indexed its own on-screen reading of a scan, which
  flattened tables into a list of numbers; both now go through one reading that keeps rows and
  columns intact. On-screen text selection and highlighting are unchanged."
- *Fixed* — "A figure that appears only inside a picture on an otherwise ordinary page is now found.
  MarkPDF looks for pictures large enough to carry information and reads those, and leaves ordinary
  pages alone."
- *Changed* — "A search result now says which page its heading came from, so a passage no longer
  appears to claim a heading from an earlier page. Short slide labels and repeated page footers are
  used as context for nearby text instead of being returned as results of their own."
- *Changed* — "An assistant connected to MarkPDF now follows changes to the embedding model,
  chunking profile and minimum score without being restarted, and an explicit minimum score in a
  tool call takes precedence over the setting."
- *Fixed* — "Converting a document to Markdown through an assistant now reads the file as it is now.
  Previously, replacing a file with a new one at the same path could return the old contents.
  Searching and reading pages still answer from the index, and now say so and when that copy was
  recorded."
- *Added* — "An assistant can see which page you are on and read any Markdown tab you have open,
  saved or not, a portion at a time for a long document — without being told where either file
  lives."
- *Added* — "Assistants that show progress now see it during a model download or a long scan, instead
  of a call that looks stuck."
- *Changed* — "Long scans are read one page at a time rather than all held in memory at once, and a
  search no longer waits behind one."

---

## 9. Concurrency, cancellation, privacy, failure states

**Concurrency.** Two schedulers in MCP (calls 4, OCR 1). Electron's index scheduler stays 1
(`electron/semantic.ts:143`, reasoned in place). Per-document exclusivity stays `runExclusive`
(`core/index/indexDocument.ts:166`). Snapshot and content files are one per tab, replaced by atomic
rename — no lock, matching `electron/openDocuments.ts:18-22`.

**Cancellation.** `AbortSignal` end to end; no new polling, no `sleep`. New abort points:
`BoundedScheduler` acquisition (listener-based, removes the waiter), the streaming rasteriser's
per-page yield, the image-region scan between pages, and the progress reporter. The honest limits
stay honest and stay documented: `@firecrawl/pdf-inspector` offers no cancellation
(`core/extract/pdfInspector.ts:311-315`); one page's render is not preemptible
(`core/ocr/rasterisePages.ts:39`); one recognition is not preemptible (`core/ocr/ocrPages.ts:69-70`).

**Privacy.** No path in any MCP reply, including new fields and including refusals — the
code-not-message rule (`mcp/openDocumentOperations.ts:28-45`) extends to the Markdown branch. Content
files are `0600` in the data directory, keyed by pid/window/tabId with no path component, deleted on
tab close, window close, app quit, and by any reader whose pid check fails. Progress messages carry
page numbers and byte counts only, and are bounded and terminal-safed like refusals. `currentPage` is
a bare integer.

**Failure states.**

| Situation | Behaviour |
|---|---|
| OCR engine will not start | Unchanged: named error, exit 8 at the CLI (`cli/journeys/scannedDocument.test.ts:153-178`); refusal at MCP |
| A page cannot be recognised | Recorded `unresolved`; index reports `incomplete`; reads say so; never a silent empty page |
| A page recognises to nothing | Recorded `empty`; not retried on the next read |
| A qualifying image region recognises to nothing | Page keeps its native text; provenance records the region as `empty` |
| Settings file present but unreadable | Core still throws (`core/settings/appSettings.ts:48`); MCP turns it into a refusal for that call, not a dead session |
| Content snapshot missing or truncated | Reported through `hasContentSnapshot` / `snapshotTruncated`; never inferred from the metadata record |
| Legacy cache with empty pages | Treated as `unknown` → re-read where permitted, reported honestly where not |
| Client sends no progress token | No notifications, and no work done to decide that |

---

## 10. Decision gates

**No dependency gate is open.** Both candidates were closed by measurement: table reconstruction
needs only `tesseract.js`'s existing word geometry (probe 6); image-region detection needs only
`pdfjs-dist`'s already-imported `OPS` and operator list (probe 8); the fixture needs only `pdf-lib`
and `@napi-rs/canvas`, both already used for exactly this (`cli/journeys/fixtures.test-support.ts:1-2`).

| Gate | Question | Recommended default | Cost of the alternative |
|---|---|---|---|
| **G1** | Does reading an open Markdown tab need a filesystem grant? | **No**, and saved and unsaved behave identically. The authority is "the person has it open in MarkPDF", the same authority `list_open_documents` already relies on. Bounded, no path, never leaves the machine's processes. | Requiring a grant fails for an unsaved buffer that has no path to grant, and makes behaviour depend on whether Save was pressed. |
| **G2** | Bump `MARKDOWN_VERSION`, or invalidate per page via provenance? | **Per page.** No `read_pages` regression; repairs bad caches lazily. | A bump is simpler to implement and makes every `read_pages` call return `no-stored-text` until each document is re-indexed. |
| **G3′** | The image-region thresholds: 5 % coverage and a 10 000 pt² single-image floor. | **Ship these**, measured against probe 8 (0.7 % logo excluded, 10.6 % figure included). Expose them as named constants in `core/extract/imageRegions.ts`, not as user settings. | Lower thresholds rasterise pages carrying decorative art and headers, which is a measurable cost with no retrieval benefit; higher ones miss small inline figures. This is the one genuinely material product choice left in P3, which is why it is named rather than buried. |
| **G4** | `IndexStatus` gains `"incomplete"`, or `"ready"` carries `unresolvedPages`? | **Add `"incomplete"`.** The compiler then forces every consumer to decide. | Keeping `"ready"` is non-breaking but preserves the silent-success shape the fix exists to remove. |

---

## 11. Commands

All forms below were verified against the installed **Vitest 4.1.9** with `npx vitest list`, which
resolves a filter without running anything: bare substring (`core/ocr`), trailing slash
(`core/ocr/`), and several explicit paths in one invocation are all accepted. Explicit paths are used
above for precision; `npx vitest list <filter>` is the cheap way to confirm a filter matches before
committing to a run.

**Focused:** listed per phase. General form `npm test -- <path…>` (AGENTS.md, "Verification
commands").

**Before merging:**

```
npm test
npm run build          # runs all five typechecks, then builds core/cli/mcp/electron/renderer
npx tsc -p tsconfig.electron.json --noEmit
npx playwright test tests/e2e/mixed-document-ocr.spec.ts
npx playwright test tests/e2e/mixed-document-search.spec.ts
npx playwright test tests/e2e/open-document-context.spec.ts
npm run test:e2e       # after P1, P2 and P7
```

**Opt-in, reported separately, never in the default suite:**

```
npm run test:live      # adds core/index/tableRetrieval.live.test.ts (P2)
                       # and core/ocr/ocrMemory.live.test.ts (P9)
```

**Lint: unavailable.** No lint script and no checked-in ESLint configuration (AGENTS.md). Every
delivery must report it as unavailable rather than claiming it passed.

**Budgets.** Existing Vitest journeys run at 180–300 s timeouts
(`mcp/journeys/toolSession.test.ts:123`, `cli/journeys/scannedDocument.test.ts:68`); Playwright is
60 s by default with per-test overrides to 240 s (`playwright.config.ts:7`,
`tests/e2e/open-documents-mcp.spec.ts:205`). New tests stay inside those. The `"mixed"` fixture pays
for exactly three recognitions in the default suite — page 10 whole, page 12 whole, page 4's region
crop — not thirteen. The `"scanned"` variant is used by one Electron test only.

**Shared-worktree note.** `npm test` triggers `pretest`, rebuilding `dist-core/`, `dist-cli/` and
`dist-mcp/`. All are gitignored, so no tracked file changes — but the parallel Kimi session may be
running `npm run dev`, which watches them. Coordinate before a full-suite run, or use
`npx vitest run <file>` when `dist-*` is already current.

---

## 12. Falsification pass

Everything inspected that could have disproved the plan, and what it did. Revision 1's evidence is
preserved; the new measurements are marked **NEW**.

### Disproved — three audit hypotheses (revision 1, unchanged)

1. *"`needsOcr` metadata is unreliable, so empty pages must trigger OCR regardless."* Against the
   installed `@firecrawl/pdf-inspector@1.17.0`, a whole-page raster is correctly flagged
   `needsOcr: true, reason "scanned"`; so are a page with an image and a caption, and a genuinely
   blank page. The metadata is **over**-inclusive. Root cause is the missing Electron resolver
   (`electron/semantic.ts:188-200`), and — the review's addition — the candidate suppression at
   `core/extract/readDocumentPages.ts:107,110`. The defensive rule stays but is labelled defensive.
2. *"OCR differs by DPI, so DPI parity matters."* 144 dpi and 200 dpi produced byte-identical text.
   The asymmetry that matters is `PSM.SPARSE_TEXT` in the renderer. Planning "make core match the
   renderer" would have made every surface worse.
3. *"Repeated table headers pollute results."* `core/index/structuredChunking.ts:151-156` already
   keeps the repeated header out of stored text (reasoning at `:135-138`). No work planned; the
   fixture still carries repeated headers so a regression would be caught.

### **NEW** — Disproved: the acceptance assertion revision 1 proposed

I embedded the competing chunk texts with the real `createDeterministicEmbedder`
(`core/index/deterministicEmbedder.ts`, a normalized bag-of-words hash) and measured cosine
similarity. Two results forced a redesign:

```
query "Sales & Marketing spend in 2028"          query "Approved 2028 Sales Marketing operating plan"
  0.4781  p12 chart decoy          ← wins          0.6708  p10 row (reconstructed)      ← wins
  0.3814  p3 decoy row                             0.6378  p10 row (FLAT renderer OCR)  ← also beats every decoy
  0.3464  p4 "Marketing"                           0.5217  p10 R&D row (wrong row)      ← also beats every decoy
  0.3162  p5 "Total Sales"                         0.4352  p3 decoy row
  0.2449  p10 row (reconstructed)  ← 5th           0.4216  p4 "Marketing"
  0.1747  p10 row (flat OCR)                       0.3273  p12 chart decoy
  0.0816  p10 R&D row                              0.2887  p5 "Total Sales"
```

- **The natural query cannot be used in the default suite.** The deterministic embedder ranks the
  chart decoy first and the correct chunk fifth, regardless of implementation quality. The fixture
  query therefore carries the `"Approved"` disambiguator, and the natural phrasing is checked in the
  opt-in live test against the real model (`core/index/tableRetrieval.live.test.ts`).
- **A page-level ranking assertion does not discriminate the fix.** Flat renderer OCR ranks second
  and already beats every decoy, so `results[0].page === 10` would be green *before* P2 — which
  AGENTS.md explicitly says is not Red evidence ("A test that never observed the missing behavior is
  not Red evidence"). The discriminator was rebuilt around snippet **content**: under flat OCR the
  whole page is one block (`core/index/markdownBlocks.ts:79`), so the winning snippet necessarily
  carries the R&D and G&A values. Hence P2 assertion 3, and the three-body-row constraint that keeps
  the flat block under `createSnippet`'s 260-character cut (`core/index/chunking.ts:28`).
- **Stated here so nobody later "fixes" a failing ranking by lowering `min_score`** — which the brief
  forbids, and which this measurement makes tempting.

### **NEW** — Confirmed: the F1b implementation route, and its cost

`pdfjs.OPS` is exported from the legacy build core already imports
(`core/ocr/rasterisePages.ts:60`). Walking the operator list with a save/restore/transform CTM stack
separates a logo from a figure cleanly and needs no rendering: 0.0 % / 0.7 % / 10.6 % / 25.8 % /
100.0 % across the five probe pages. Cost measured on the 13-page fixture: 35.4 ms document open plus
2.8 ms per page scanned, against 10.5 ms for the whole structural extraction of the same document.
That is roughly 7× the extraction, which is why the plan shares the pdf.js handle with the rasteriser
and scans only unflagged pages — and why the number is stated in the ADR rather than glossed. Had
`OPS` not been exported or the CTM walk not resolved image geometry, F1b would have needed a new
dependency and G3′ would have been a dependency gate.

### **NEW** — Confirmed: no truthful snapshot timestamp exists today

`documents.created_at` is supplied on INSERT and absent from the `DO UPDATE SET` list
(`core/store/index.ts:467-484`), so it survives re-indexing. `documents.last_opened_at` **is** in that
list (`:480`) and `upsertDocument` runs before any chunk is written, on the `reused` path, and on
runs later cancelled (`core/index/indexDocument.ts:200,260-269,274,288`). Revision 1's proposed
`indexedAt` would have been a confident, wrong timestamp on every reply — exactly the class of error
the plan exists to remove. Replaced with `document_markdown.created_at` (written in one transaction
with the cache, `core/store/index.ts:570-576`) and a new `documents.chunks_written_at`.

### **NEW** — Confirmed: the command forms

`npx vitest list core/ocr`, `npx vitest list "core/ocr/"` and
`npx vitest list <fileA> <fileB>` all resolve against the installed Vitest 4.1.9 and list matching
tests without running them. Revision 1's command forms were therefore valid, but unverified when
written; they are now verified and tightened to explicit paths.

### Confirmed and unchanged from revision 1

`RequestHandlerExtra.sendNotification` (`…/shared/protocol.d.ts:203-207`); `notifications/progress`
exempt from capability assertion (`…/server/index.js:193-195`); client token attachment
(`…/shared/protocol.js:643-649`) — had any been absent, P8 would have needed
`notifications/message`, which **does** require declaring `capabilities.logging`
(`…/server/index.js:164-167`). Node `tesseract.js@7.0.0` returns line and word bounding boxes
(probe 6), closing F11's dependency question. Renderer OCR is genuinely a different stack from core's
(`src/pdf/ocr.ts:57-59` versus `core/ocr/tesseractEngine.ts:97-99,142-149`), which is what decides
F1c's direction.

### Checked and found already correct — so no work is planned

Per-call consent (`mcp/context.ts:65`); per-call open-documents reads (`mcp/context.ts:68`);
per-call Electron settings (`electron/main.ts:722`); Electron's score fallback
(`electron/semantic.ts:217`); the lossless table-window partition
(`core/index/tableWindows.ts:281-306`); the atomic snapshot write and pid liveness rule
(`core/session/openDocuments.ts:118-133,236-252`); the two-bound reply discipline
(`core/output/budget.ts`); and `src/pdf/ocr.ts`'s four remaining renderer-local consumers
(`src/App.tsx:1735,1817,2323,3967`), which is what makes P1's removal of the fifth a clean cut.

### Remaining unverified, and how the plan handles it

- Exact OCR text of page 7's 46-row table and page 12's chart. They are decoys and budget-crossers;
  no assertion depends on their exact recognition. Only page 10's and page 4's literals are asserted,
  and both were measured.
- Whether `detectOcrNeed` fires on `"mixed"`. It should not, and `"scanned"` exists precisely so the
  other branch is exercised deliberately rather than assumed. Both outer tests assert outcomes, not
  the sampler.
- Peak-RSS ceiling for P9's opt-in stress test — deliberately left to be measured when written.
- Whether the `overlay` profile's per-cell boxes remain the better choice for the window's highlight
  rectangles after P2. Kept as-is on the conservative reading that today's visible behaviour should
  not change; if a future measurement says otherwise, it is one constant in `core/ocr/ocrContract.ts`.
- **F13e** (publish churn) stays an unverified risk, not a defect. Nothing measured a problem today;
  it becomes real only once `currentPage` is published, which is why the churn rule ships in P7.
