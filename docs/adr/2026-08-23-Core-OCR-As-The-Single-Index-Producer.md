# Core OCR is the single producer of page text for the index

## Status

Accepted.

## Context

A page with no text layer reaches the semantic index only if something recognises it. Until now
three surfaces answered that differently.

`cli/` and `mcp/` supply a resolver built on `core/ocr/ocrPages.ts` — the command line at
`cli/ocrResolver.ts`, wired into `index`, `outline` and `convert`; the server at
`mcp/context.ts`. Electron supplied none. Instead its window recognised scanned pages for its own
display and offered that text over IPC as `ocrCandidates`, which `readDocumentPages` preferred over
calling a resolver at all.

Two failures followed, and both were measured against the installed dependencies rather than
inferred.

**A page the window never looked at was a page nothing looked at.** `src/pdf/ocr.ts:43-48` samples
five pages — the first three, the middle and the last — and `:34-36` decides from that sample
whether the whole document is a scan. A thirteen-page report with a text layer on eleven pages and a
financial table drawn as a picture on page ten passes the sample comfortably, so
`src/App.tsx:887-896` set `ocrStatus: "skipped"` and no page was recognised. Page ten was then stored
with no text at all, cached as an empty string, and served as an empty page to every later reader —
including the MCP `read_pages` tool, which reads the index only and so had no way to repair it.

**A page the window did look at entered the index shaped by a different engine.** The window runs a
WebAssembly Tesseract build over a browser canvas at `renderScale = 2` with `PSM.SPARSE_TEXT`
(`src/pdf/ocr.ts:8,57,73`) and then collapses all whitespace (`:106`). Core runs the Node build in a
`worker_threads.Worker` over `@napi-rs/canvas` at 200 dpi with the engine's default page
segmentation (`core/ocr/tesseractEngine.ts:97-99,142-149`, `core/ocr/rasterisePages.ts:59-62`).
Measured on a rendered financial table, the core configuration returns each row on its own line —
`Sales & Marketing 4110 4620 5170 5890` — while `PSM.SPARSE_TEXT` returns every cell as a separate
paragraph, which the whitespace collapse then flattens into an unrecoverable sequence. The same file
therefore indexed differently depending on whether the application or the command line had read it,
and the application's version was the worse one.

## Decision

### Recognition for the index has one producer, in core

`electron/semantic.ts` now supplies `resolveOcr: (request) => ocrPages(request, {})`, exactly as the
command line and the MCP server do. Every surface reads a document the same way.

### The candidate contract is removed rather than left unused

`ocrCandidates` is gone from `SemanticIndexRequest` (`src/global.d.ts`), from `parseIndexRequest`
(`core/ipc/requests.ts`), from `IndexPdfDocumentInput`, and from `ReadDocumentInput`. `buildOcrCandidates`
is deleted.

Leaving the parameter in place and simply not passing it was considered and rejected. A parameter
whose only purpose is to let a second producer of page text reappear is the drift this decision
exists to close, and the next person to find a slow scan would have had an obvious lever to pull.
`core/boundaries.test.ts` carries a second net: no production source under `src/` may mention
`ocrCandidates`, which catches the shortcut being reintroduced under a type declaration the compiler
would otherwise accept.

### The alternative — carrying geometry across IPC — was rejected on evidence

The other way to close the gap is to keep the window's recognition and send its word geometry over
IPC, so core reconstructs tables from it. That was rejected because it cannot deliver what it
promises. The two stacks are different programs: different rasterisers, different Tesseract builds,
different page-segmentation settings. Geometry produced by one and interpreted by the other narrows
the difference between the application and the command line without removing it, and it widens the
IPC surface to carry per-word coordinates for every page of a scan. Parity needs one producer, not
two producers agreeing more closely.

### A page that was not read is recorded as not read

Recognising every page is only half the problem. The other half is what happens when recognition
still cannot answer — no engine installed, a page it fails on, a selection that narrowed it away.

`ReadPage` now carries a `status` of `read`, `empty` or `unresolved`, and the distinction between
the last two is the point: a blank page and a page nobody read both have no text, and storing them
identically is why the original defect could not be repaired without re-indexing every document in
the library. `empty` means something looked and there was nothing there — so it is not looked at
again. `unresolved` means nobody looked.

That status is carried through every layer that could otherwise lose it:

- `indexDocument` returns **`incomplete`** rather than `ready` for a document with an unresolved
  page, and names the pages. A separate member of the union rather than a flag, so the compiler
  makes each consumer decide.
- Schema **v3** adds `document_markdown.page_provenance`, so the cache records each page's outcome
  alongside its text. Additive and nullable: `NULL` is the honest answer for every row written
  before the column existed.
- `resolveDocumentPages` treats an unresolved cached page as a gap rather than as the page's
  contents. A caller that may open the file re-reads it; one that may not is told which pages are
  missing and keeps the pages that are there.
- The `read_pages` tool reports `unresolvedPages` on every reply, including when it is empty — an
  agent that cannot tell "no gaps" from "gaps not reported" has to assume the worse of the two.
- The tab says so. `semanticIndexOutcome` keeps an incomplete document searchable, because the rest
  of it is, and names the unread pages beside the badge.

**A cache written before this existed is repaired lazily.** An empty page in a row with no
provenance is read as unknown, not as blank, so the documents this change exists to fix are
re-read the next time somebody who can open the file asks for them. No migration pass, no
re-indexing of documents that were never wrong.

### The window keeps its own recognition, for the window

`src/pdf/ocr.ts` is unchanged and still runs. Its output serves four things that are properties of
the window rather than of the index: the selectable text layer over a scanned page
(`src/App.tsx:3967`), in-window text search (`:2323`), the Markdown conversion engine's choice
(`:1735`), and conversion itself (`:1817`). None of it is sent to the main process.

## Consequences

**A scanned document opened in Electron is now recognised twice** — once by the window for display,
once by core for the index. That cost is accepted for now. Core's recognition runs in a worker
thread rather than on the main thread (`core/ocr/tesseractEngine.ts:97-99`), so it does not stall
the interface, and per-page streaming of the rasteriser is planned separately. The original
justification for reuse — that core had no rasteriser — was already spent by
`core/ocr/rasterisePages.ts`, the same way `core/outline/documentOutline.ts:14-19` records ruling R1
being spent.

**A document can now come back `incomplete`, and every caller has to handle it.** That is the
intended cost of making the union wider rather than adding a flag somewhere easy to miss.

**A schema migration is one-way.** A v3 file opened by an older build is refused by
`SchemaTooNewError` rather than silently misread, which is the right failure but is still a failure
if somebody downgrades.

**A page recorded as `empty` is never looked at again**, which is correct for a blank page and wrong
if recognition improves later. The extraction and OCR version columns are what a future change would
key a re-read off; nothing does that yet.

**`pageNeedsRecognition`'s second branch guards a case the installed extractor does not produce.**
Measured: `@firecrawl/pdf-inspector` 1.17.0 reports a blank page, a page with a caption under a large
image, and a whole-page raster all as `needsOcr`. The branch exists because that is a claim about a
dependency's behaviour rather than about ours — but it is currently unreachable through the real
extractor, and its test drives the rule directly for that reason.

## Verification

- `tests/e2e/mixed-document-ocr.spec.ts` — the acceptance journey: MarkPDF opens and indexes a
  thirteen-page report whose tenth page is only a picture, and an agent reading page ten over MCP
  gets the table. Proved to bite by removing `resolveOcr` from `electron/semantic.ts` and observing
  the empty page return.
- `core/ipc/requests.test.ts`, "what a window may put into the index" — an index request carries no
  page text, and page text a window offers anyway is ignored.
- `core/boundaries.test.ts`, "keeps the window out of deciding what a page says" — the tripwire.
  Proved to bite by reintroducing the name in `src/semanticSource.ts`.
- `core/extract/readDocumentPages.test.ts`, "asks about every page the extractor could not read,
  with no way for a caller to answer first".
- `core/index/indexPdfDocument.test.ts`, "recognises the pages the extractor flagged and no others,
  however thin their text".
- `core/extract/readDocumentPages.test.ts`, "deciding whether a page still needs reading" — the
  recognition rule on its own, including the page the extractor claims to have read and returned
  nothing for. Proved to bite by narrowing the rule back to the extractor's flag alone.
- `core/extract/readDocumentPages.test.ts`, "says of every page whether it was read, found empty, or
  never resolved".
- `core/index/indexPdfDocument.test.ts`, "reports a document with a page nothing read as incomplete,
  not as ready". Proved to bite by making the status decision ignore the unresolved set.
- `core/store/markdownCache.test.ts`, "recording why a cached page is empty" — including that a row
  from an older build reports no provenance rather than claiming every page was read.
- `core/documents/documentPages.test.ts`, "a cached page that nobody managed to read" — named for an
  index-only caller, re-read for one that may open the file, still answered when the grant is gone,
  and the legacy-cache case. Proved to bite by treating a provenance-free empty page as blank.
- `mcp/operations.test.ts`, "names the pages of an indexed document that nothing managed to read".
- `src/semanticSource.test.ts`, "what a finished index job leaves on the tab".
- `cli/journeys/adversarialFixture.test.ts` — that the fixture those journeys rely on is what it
  claims to be, checked with pdf.js rather than with the extractor under test. Covers the decoy
  values, the repeated footer, both letter-spaced labels, the inherited and local headings, the
  46-row table across its page break, and that every literal meant to be ink is absent from every
  text layer.
