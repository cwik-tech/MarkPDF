# OCR is a phase of index progress, not a kind of checking

## Status

Accepted. Amended on 2026-08-30: recognition counters describe the recognition queue rather than
the document. The rest of the decision stands, and the amendment is written into the Decision and
Consequences below rather than left to be inferred from a later record.

## Context

Preparing a document for semantic search is three jobs that a reader experiences as one wait. The
window samples five pages to decide whether the document needs a selectable recognition overlay
(`src/pdf/ocr.ts`). The main process reads the document, recognising any page the structural
extractor could not (`core/index/indexPdfDocument.ts` through `core/ocr/ocrPages.ts`). Only then are
embeddings built.

Only the last of the three was visible. `indexPdfDocument` reported `checking` before and after the
whole read, so every page recognised inside the index job was reported as though the index were
merely being examined; the toolbar translated that to "Checking index". The recogniser could already
describe each page it read, but nothing was ever put in the request's progress field
(`core/extract/readDocumentPages.ts` never set `onProgress`), so the per-page detail was produced
and discarded. Separately, the window hid a successful `skipped` result entirely, so a document
whose pages carry text said nothing at all about the check that had just run.

Measured against the mixed-document fixture, the events crossing the bridge while a picture-only
page was recognised were `index:checking:1/4` through `index:checking:4/4` — four pages of
recognition, reported as checking.

The progress object crosses the preload/IPC boundary, so naming the phase changes a contract that
the main process, the preload narrowing, and the renderer all depend on.

## Decision

Add `ocr` as a member of the progress status discriminant, in core (`IndexProgress`), at the IPC
boundary (`core/ipc/progress.ts`), and in the renderer's mirror of that contract (`src/global.d.ts`,
`src/types.ts`).

Recognition progress becomes a structured value rather than a sentence. `OcrPageProgress` carries
the document page being read, the position of that page in the current run, the run's total, and a
message. It also carries the complete document page count. `ocrPages` emits one per page;
`readDocumentPages` forwards it through a new
`onOcrProgress` input; `indexPdfDocument` translates it into an `IndexProgress` with
`status: "ocr"`.

**The counters are the recognition queue's** (amended 2026-08-30). This ADR originally used the
document page as `current` and the document's page count as `total`, so that a smaller set of OCR
targets was never presented as the PDF's extent. Measured against a 628-page book with 59 pages to
recognise, that reads as `437/628`: a bar that fills to seven per cent, stops, and never arrives,
because the other 569 pages are never going to be recognised. It describes work nobody is doing.
`indexPdfDocument` now forwards the run's own position and total — `42/59` for that page — and
leaves the document page where the recogniser already put it, in the message.

**Where the message actually appears.** The toolbar badge renders the label and the bar, and
nothing else: `documentPreparationBadge` produces `OCR 42/59` and the page number is not in it.
The message reaches the reader as the badge's `title` — the tooltip on hover — and as the line the
Semantic Search panel shows while an index is being prepared (`src/App.tsx`). So the counter is
what a reader sees at a glance, and the page is there for the reader who asks for it. Saying the
page is "named beside the counter" would be a claim the interface does not keep.

**OCR counters are required at the boundary.** Every other status may arrive without counts —
"Checking index" is looking at a database, not working through a list — but an OCR event always
names one page out of a known set. `parseSemanticProgressEvent` therefore rejects an OCR event whose
counters are missing, fractional, negative, non-finite, or outside `1 <= current <= total`, rather
than rendering a badge reading "OCR undefined/undefined" or a bar drawn from nothing.

**One badge for the whole of preparation.** `src/documentPreparation.ts` chooses a single badge from
the window's recognition state and the index job's progress, in this order: a failure, then
recognition in either process, then the index job's own states, and last the window's finished
"Native text detected" result. A finished check can therefore never cover work that is still
running.

**The pre-recognition read stays indeterminate.** `@firecrawl/pdf-inspector` exposes no per-page
callback, so nothing can honestly count pages while the structural parse runs. That stage keeps its
two `checking` events and no bar.

## Consequences

- A reader watching the 42nd of 59 pages that need recognising sees `OCR 42/59` with a bar that
  fills as the queue empties, then `Index 12/32` once embedding starts. Which document page is
  being read is in the badge's tooltip and in the Semantic Search panel, not in the badge itself.
- The counter no longer says how far through the document recognition has reached, because on a
  mixed document that is not a quantity anything is working through. A thirteen-page report with
  four pages to read counts `1/4` to `4/4` rather than `4/13`, `10/13`, `12/13`, `13/13`.
- A native-text document shows "Checking text", then "Native text detected" for six seconds, and
  never claims recognition ran.
- A reused index emits no OCR event, so it displays no recognition work.
- The status union is wider. A consumer that switches exhaustively over the progress status must
  handle `ocr`; the compiler reports every such site in this repository.
- An older renderer paired with a newer main process would receive an unknown status and discard the
  event, leaving the badge on its previous state rather than showing a wrong one. Both halves ship in
  one application, so the pairing is not one this repository has to support, and the narrowing
  already fails closed.
- Recognition counters are stricter than the other statuses'. A future emitter that wants to report
  recognition without an extent would have to widen the boundary deliberately rather than by
  accident.

## Alternatives considered

- **A separate IPC channel for recognition.** Rejected: it would need its own job ownership and
  cancellation gate, and `src/semanticProgress.ts` already has one that works. Recognition happens
  inside the index job, and progress that belongs to a job should travel with it.
- **Keeping the free-form message and parsing numbers out of it.** Rejected: a progress bar built by
  reading integers back out of an English sentence breaks the first time the sentence is reworded.
- **Leaving `skipped` hidden and adding no notice.** Rejected: silence is indistinguishable from a
  check that never ran, which is the specific confusion that made a healthy tagged book look as
  though it needed recognising.
- **Two badges, one per job.** Rejected: they can both be busy at once, and side by side they made
  the reader decide which to believe.

## Verification

- Structured per-page emission: `core/ocr/ocrPages.test.ts`, "reports every page it reads against
  the full document page count".
- Forwarding through the read: `core/extract/readDocumentPages.test.ts`, "gives the recognition seam
  somewhere to report each page it reads".
- Translation to the index phase, its counters, and its absence when nothing needed recognising:
  `core/index/indexPdfDocument.test.ts`, "counts recognition against the pages it has to read, and
  reports it before any indexing" and "invents no recognition phase for a document that never needed one".
- Boundary narrowing, including rejection of missing and malformed counters:
  `core/ipc/progress.test.ts`.
- Tab ownership and cancellation of the new status: `src/semanticProgress.test.ts`.
- Badge choice, precedence and percentages: `src/documentPreparation.test.ts`.
- The visible desktop outcome: `tests/e2e/mixed-document-ocr.spec.ts`, which records the real
  progress stream and the toolbar text while the application recognises a picture-only page.
- Mutation proof: mapping the core OCR event back to `checking` in `core/index/indexPdfDocument.ts`
  failed both `core/index/indexPdfDocument.test.ts` and the Electron journey — the journey recorded
  `index:checking:1/4` through `index:checking:4/4`, which is exactly the defect. The mapping was
  restored and both were rerun green.
- Mutation proof for the 2026-08-30 amendment: restoring `progress.page` / `progress.totalPages` as
  the forwarded counters failed the focused test and the Electron journey, the journey recording
  `index:ocr:4/13`, `index:ocr:10/13`, `index:ocr:12/13` and `index:ocr:13/13` for a document with
  four pages to recognise. The forwarding was restored and both were rerun green.
