# Native PDF Search, OCR Status, and Link Navigation Plan

Status: Implemented
Date: 2026-08-29

## Solution in brief

Do not OCR this 628-page book wholesale. It is a healthy tagged PDF with embedded text on every non-blank body page and real PDF link annotations in its table of contents.

The solution has three independent parts:

1. Fix MarkPDF's PDF.js text-layer integration so tagged-content wrapper spans are laid out correctly, excluded from the search index, and highlights use the browser's actual text-range rectangles.
2. Render a narrow internal-link layer from the PDF's link annotations so table-of-contents links navigate within the open document.
3. Report OCR as a distinct, truthful progress phase. Show the renderer's existing OCR check and recognition progress, forward main-process per-page OCR progress that currently disappears inside indexing, and only then show embedding/index progress.
4. Keep raw PDF bytes out of rendered React props and defer OCR and optional metadata until the first page has rendered, so large books do not freeze the development application while React inspects component properties.

## What was analysed

The complete source document `Data Engineering/dama-dmbok-data-management-body-of-knowledge-2nd-edition.pdf` was structurally scanned with the repository's installed PDF.js version, not only inspected from the screenshot.

| Finding | Result |
|---|---:|
| Pages scanned | 628 |
| Pages with embedded text | 618 |
| Extracted non-whitespace characters | 1,345,994 |
| PDF.js text items | 54,822 |
| Pages containing PDF marked-content records | 619 |
| Marked-content boundary records | 25,770 |
| Extracted occurrences of `framework` | 187 |
| PDF outline entries | 1,079 |
| PDF link annotations | 905 |
| Internal links | 903 |
| External links | 2 |
| Pages containing links | 194 |
| Link annotations on PDF page 5 | 47 |

The ten pages with no extractable characters are pages 1, 4, 18, 20, 126, 220, 272, 306, 350, and 500. A visual contact-sheet check found page 1 is the image-only front cover and the other nine are blank. This means Acrobat is mostly reading the PDF's embedded text layer; it is not evidence that all 628 pages required OCR. Acrobat also renders the existing `/Link` annotations, which is why the table of contents is clickable there.

The renderer's current five-page OCR sample examines pages 1, 2, 3, 314, and 628. Those pages produced 6,105 non-whitespace characters with only one textless page, so the current rule correctly returns `shouldRunOcr: false` for the document as a whole (`src/pdf/ocr.ts:27-54`).

## Root causes

### 1. Search finds the text but highlights the page origin

MarkPDF asks PDF.js to include tagged marked content when it renders the text layer (`src/App.tsx:4154-4160`). That is valid, but the local stylesheet implements only a partial PDF.js text-layer contract (`src/styles.css:1181-1198`). It is missing the installed version's rules that:

- make `.markedContent` wrappers use `display: contents`;
- derive font size from `--font-height` and `--total-scale-factor`; and
- apply `--scale-x` and `--rotate` to leaf text spans.

The installed PDF.js contract is visible in `node_modules/pdfjs-dist/web/pdf_viewer.css:916-935`.

The search code then indexes every descendant span (`src/App.tsx:4495-4527`). In a tagged PDF, that includes both structural wrapper spans and their leaf text spans, so the same text is indexed more than once and the first match can point to a zero-width wrapper at the page origin. The highlight geometry compounds the problem by estimating a partial word as a proportion of the whole span width (`src/App.tsx:4576-4604`) instead of measuring the matching DOM text range. The scrolling code trusts that bad marker rectangle, sees it as already visible, and does not move to the real match (`src/App.tsx:4611-4639`).

The copied text-layer rules also omitted PDF.js's transparent `br::selection` rule. PDF.js inserts absolutely positioned line-break elements; selecting across them therefore painted narrow blue bars at the text layer's origin, along the left edge of the page.

This was reproduced against PDF page 5. The active highlight marker was at the page's top-left with a `2 x 14` pixel rectangle, while the real leaf span for “3. Data Management Frameworks” had the correct PDF position data. The PDF coordinates are therefore not the defect; MarkPDF's rendered text-layer contract and span selection are.

### 2. OCR work is hidden behind “Checking index”

There are two OCR paths:

- Renderer OCR builds a selectable overlay for broadly scanned documents. It already emits page and engine progress (`src/pdf/ocr.ts:57-112`) and stores it in the tab (`src/App.tsx:837-917`). The toolbar explicitly hides the successful `skipped` result and renders no OCR progress bar (`src/App.tsx:2874-2885`).
- Core OCR repairs individual unread pages and qualifying image regions before semantic indexing. This is the correct path for a mixed document such as this book, whose image-only cover is surrounded by native-text pages. Main wires that OCR into indexing (`electron/semantic.ts:189-203`), but `indexPdfDocument` reports only generic `checking` messages before and after the complete read (`core/index/indexPdfDocument.ts:79-109`). Although the recogniser can emit a message for each OCR page (`core/ocr/ocrPages.ts:122-160`), no live OCR callback is added to the request passed through `readDocumentPages` (`core/extract/readDocumentPages.ts:250-275`).

The IPC contract has no OCR progress state (`core/ipc/progress.ts:3-16`, `src/global.d.ts:136-145`), and the toolbar translates `checking` to “Checking index” (`src/App.tsx:3133-3159`). The application can therefore be doing OCR while the user is shown only an indexing/checking indicator.

### 3. Table-of-contents links are present but never rendered

The source PDF contains real link annotations. PDF page 5 alone has 47 internal links whose rectangles align with the table-of-contents rows. MarkPDF renders a canvas, text layer, search-highlight layer, and editing overlay (`src/App.tsx:4252-4368`), but it never reads page annotations and has no annotation or native-link layer. Acrobat renders those annotations; MarkPDF currently discards them.

### 4. Large PDF bytes freeze the development renderer

The open path stored the complete 11.3 MB `Uint8Array` in each `PdfTab` and passed that full object through rendered component props. React 19's development performance instrumentation recursively describes component props. Its traversal reached the typed array and enumerated all 11,301,466 byte entries. A renderer CPU profile attributed about 8.0 seconds to React's property traversal and about 2.0 seconds to garbage collection. The production React build did not run this diagnostic path, which is why the same PDF opened normally there.

The view now receives a byte-free projection while the full tab remains authoritative application state. First-page render completion also gates renderer OCR and optional form, outline, and editable-overlay loading, so those jobs cannot delay the page the user is waiting to see.

## Scope

### Included

- Correct native-text search highlighting and scrolling for tagged and untagged PDFs.
- Correct geometry at different zoom levels and supported page rotations.
- Clickable internal PDF links, including named and explicit destinations used by table-of-contents pages.
- A visible sequence of document preparation phases: checking text, OCR when required, and indexing.
- Determinate OCR progress against the complete document page count.
- Responsive opening of large PDFs in both development and production builds.
- Native text selection without line-break artifacts at the page edge.
- A short, non-busy “Native text detected” result when renderer OCR is not required.
- Strict runtime validation of annotation data and progress events at their boundaries.

### Excluded

- Blanket OCR of native-text pages.
- Replacing PDF.js or Tesseract.
- Changing recognition quality, language selection, or OCR persistence.
- Rendering forms, comments, scripts, attachments, or other PDF annotation types.
- Opening the source PDF's two external URLs. External navigation needs a separate allowlisted Electron boundary and security decision; the 903 internal links, including the table of contents, require no new privileged capability.

No new dependency is required. The repository already has `pdf-lib` for deterministic test fixtures and PDF.js for rendering and destination resolution (`package.json:54-55`).

## Acceptance criteria

### Native search

- Searching for `framework` in the supplied book reports the existing 187 matches.
- Activating the page-5 table-of-contents match scrolls page 5 into view.
- Every visible highlight rectangle overlaps the glyphs of the active occurrence and is not at the page origin.
- Previous/next navigation selects the corresponding occurrence when a page contains repeated text.
- The result remains correct at 100%, 110%, and 150% zoom and after supported rotation.

### Internal links

- Clicking a table-of-contents row on page 5 navigates to the destination encoded in that row's PDF link annotation.
- Named and explicit internal destinations resolve to stable one-based document pages.
- Clicking an internal PDF link does not navigate the Electron renderer away from MarkPDF and does not open a browser.
- Non-link annotations and malformed annotation values create no interactive element.

### OCR and indexing status

- Opening a native-text PDF visibly transitions through “Checking text” to a brief “Native text detected” result; it does not claim OCR ran.
- When renderer OCR runs, the toolbar shows `OCR page/total` and a whole-document progress bar. Per-page recognition progress may refine the current segment without moving the whole-document bar backwards.
- When core OCR repairs pages before indexing, the semantic progress stream reports an explicit OCR state using the actual document page as `current` and the complete document page count as `total`. The toolbar says `OCR page/document pages`, not “Checking index” or the smaller OCR-target count.
- Embedding progress is labelled `Index current/total` only after document reading and any OCR work.
- Reused indexes do not show invented OCR work.
- Cancellation and errors clear or replace the active indicator without allowing a late progress event to restore stale state.

## Implementation plan

### Capability 1: Tagged native-text search lands on the real glyphs

Observable journey: a user opens a tagged PDF, searches for a word inside marked content, and the active match scrolls into view with a highlight over the word.

#### Red

1. Add a deterministic tagged-PDF fixture using the installed `pdf-lib`. It must wrap visible text in marked-content operators so an ordinary untagged fixture cannot accidentally pass.
2. Add an Electron regression journey under `tests/e2e/pdf-native-navigation.spec.ts` that opens the fixture at a non-default zoom, searches for a known word, and asserts that the active marker overlaps the target leaf text range and is separated from the page origin.
3. Run:

   ```sh
   npx playwright test tests/e2e/pdf-native-navigation.spec.ts --grep "highlights tagged PDF text"
   ```

4. Expected Red: the marker is measured at or near the page origin rather than over the matching text.

#### Green

1. Bring `src/styles.css` into conformance with the installed PDF.js 5.7.284 text-layer rules, adapted to MarkPDF's `.text-layer` class. Set `--total-scale-factor` from the rendered viewport scale and support `.markedContent { display: contents; }`, leaf font size, scale, and rotation.
2. Change the search index to consume only leaf text spans, excluding `.markedContent` wrappers while retaining OCR overlay spans.
3. Replace proportional span-width estimates with `Range.setStart`, `Range.setEnd`, and `Range.getClientRects()` over the actual text node. Convert every non-empty client rect into highlight-layer coordinates.
4. Keep the existing marker-based scroll path; correct geometry should make its current visibility test and centring behavior valid.
5. Apply the same leaf-span and DOM-range logic to semantic highlights so the second highlight path cannot retain the same defect.

#### Refactor and mutation proof

- Extract the shared search-index and range-rectangle code into a focused renderer module rather than duplicating it in `src/App.tsx`.
- Temporarily include `.markedContent` wrappers again or remove their `display: contents` rule. The Electron test must fail, then pass after restoration.

### Capability 2: Table-of-contents links navigate inside the document

Observable journey: a user clicks an internal link in a PDF table of contents and MarkPDF moves to that link's destination without leaving the application.

#### Red

1. Extend the deterministic PDF fixture with one explicit internal destination and one named destination, each with a link rectangle over visible table-of-contents text.
2. Add a second Electron journey in `tests/e2e/pdf-native-navigation.spec.ts` that clicks the rendered link hitbox and asserts the destination page becomes current and visible.
3. Run:

   ```sh
   npx playwright test tests/e2e/pdf-native-navigation.spec.ts --grep "follows an internal PDF link"
   ```

4. Expected Red: no native-link hitbox exists and the current page does not change.

#### Inner loop

1. Add `src/pdf/internalLinks.test.ts` first for a pure boundary parser that accepts `unknown`, admits only finite four-number rectangles plus supported internal destinations, and rejects URLs, actions, malformed rectangles, and unrelated annotation subtypes.
2. Add a focused `src/pdf/internalLinks.ts` module that resolves named destinations through the open `PDFDocumentProxy`, resolves explicit page references through PDF.js, and returns a narrow page target.
3. Keep annotation access in the page-rendering shell. Read `page.getAnnotations({ intent: "display" })`, validate the returned external data, transform each accepted rectangle through the current `PageViewport`, and render transparent accessible buttons in a `.native-link-layer` between the text and editing overlays.
4. Route link activation through the existing tab/page state so current-page state, scrolling, and multi-tab identity remain authoritative. Do not change `window.location` and do not add Electron IPC.

#### Refactor and mutation proof

- Keep destination parsing/resolution independent from React and DOM layout.
- Temporarily remove the destination callback from a valid link. The link journey must fail on the unchanged page before the behavior is restored.

### Capability 3: OCR is a first-class progress phase

Observable journey: a user opens a mixed PDF with one image-only page and sees OCR progress before indexing progress, while a native-text PDF says OCR was not needed.

This changes the progress object crossing the preload/IPC contract. Implementation therefore also requires an accepted ADR under `docs/adr/` describing the new progress state and compatibility consequences.

#### Red

1. Add a focused core test in `core/index/indexPdfDocument.test.ts` requiring a structured OCR progress event to be forwarded while an unread page is resolved.
2. Add parser tests in `core/ipc/progress.test.ts` requiring the new OCR state and rejecting malformed counters.
3. Add a renderer mapping test in `src/semanticProgress.test.ts` requiring OCR to remain associated with the owning tab and to be ignored after cancellation.
4. Extend `tests/e2e/mixed-document-ocr.spec.ts` to record the real application's progress stream and toolbar text while it recognises the existing image-only page. Require an OCR event and a visible `OCR current/total` stage before the index completes.
5. Run each focused test before implementation. Expected Red is the absence or rejection of the OCR progress state; the Electron journey currently records generic checking/indexing only.

#### Green

1. Replace the OCR callback's free-form string with a structured core value containing document page, complete document count, current target, total targets, and message in `core/extract/readDocumentPages.ts` and `core/ocr/ocrPages.ts`.
2. Have `core/index/indexPdfDocument.ts` inject that callback when it invokes the OCR resolver and translate it to an `IndexProgress` member with `status: "ocr"`, using document page and complete document count for `current` and `total`.
3. Extend and validate the progress discriminant in `core/ipc/progress.ts`; mirror it in `src/global.d.ts`, `src/types.ts`, and the preload-facing contract. Keep malformed external values rejected rather than cast.
4. Let `src/semanticProgress.ts` route OCR events through the existing job-ownership and cancellation gate.
5. Update the toolbar presentation in `src/App.tsx` and `src/styles.css`:
   - show renderer OCR checking/running progress with a bar;
   - briefly show “Native text detected” instead of suppressing `skipped` immediately;
   - show core OCR progress as OCR, not indexing;
   - show at most one active document-preparation badge, prioritising active OCR over embedding progress; and
   - preserve the existing separate model-download state.
6. Keep the stages truthful. The PDF parser itself exposes no per-page callback, so the pre-OCR read remains indeterminate rather than displaying fabricated page counts (`core/index/indexPdfDocument.ts:91-95`).

#### Refactor and mutation proof

- Centralise toolbar stage selection and percentage calculation in a pure renderer rule covered by `src/semanticProgress.test.ts` or a focused adjacent test.
- Temporarily map the core OCR event back to `checking`. The focused renderer test and mixed-document Electron journey must fail, then pass after restoration.

## Expected files

The exact implementation diff may be narrower after the Red tests, but the current evidence points to:

- `src/App.tsx`
- `src/styles.css`
- `src/types.ts`
- `src/global.d.ts`
- `src/pdf/textLayerSearch.ts` and its focused test, if pure logic can be separated without inventing a DOM harness
- `src/pdf/internalLinks.ts`
- `src/pdf/internalLinks.test.ts`
- `src/semanticProgress.ts`
- `src/semanticProgress.test.ts`
- `core/extract/readDocumentPages.ts`
- `core/extract/readDocumentPages.test.ts`
- `core/ocr/ocrPages.ts`
- `core/ocr/ocrPages.test.ts`
- `core/index/indexDocument.ts`
- `core/index/indexPdfDocument.ts`
- `core/index/indexPdfDocument.test.ts`
- `core/ipc/progress.ts`
- `core/ipc/progress.test.ts`
- `electron/semantic.ts`
- `tests/e2e/pdf-native-navigation.spec.ts`
- `tests/e2e/mixed-document-ocr.spec.ts`
- `docs/adr/2026-08-29-OCR-Index-Progress-Phases.md`
- `CHANGELOG.md`

No compiled `dist*` directory will be edited.

## Verification

The tests that cover each decision in this document:

| Decision | Tests |
|---|---|
| Tagged text-layer contract, leaf-span indexing and range-measured highlights | `src/pdf/textLayerSearch.test.ts`; `tests/e2e/pdf-native-navigation.spec.ts` — "highlights a tagged PDF's text over the matching glyphs and steps to the next occurrence" |
| Correct geometry under a supported rotation | `tests/e2e/pdf-native-navigation.spec.ts` — "keeps a tagged PDF's highlight over the glyphs after the page is rotated" |
| Which annotations become links, and where each one goes | `src/pdf/internalLinks.test.ts` |
| Following an internal link without leaving the application | `tests/e2e/pdf-native-navigation.spec.ts` — "follows an internal PDF link from the table of contents" |
| Structured per-page recognition progress | `core/ocr/ocrPages.test.ts`; `core/extract/readDocumentPages.test.ts` |
| Recognition as its own index phase, and its absence when unneeded | `core/index/indexPdfDocument.test.ts` |
| Narrowing the new progress state at the boundary | `core/ipc/progress.test.ts` |
| Tab ownership and cancellation of the new state | `src/semanticProgress.test.ts` |
| Which preparation badge is shown, and its percentage | `src/documentPreparation.test.ts` |
| Raw PDF bytes excluded from rendered component props | `src/pdf/pdfViewState.test.ts` |
| First page shown before OCR and optional metadata | `src/pdf/openPdfInStages.test.ts` |
| The visible desktop outcome and document-relative OCR count for a mixed document | `tests/e2e/mixed-document-ocr.spec.ts` |

The deterministic fixture the renderer journeys use is
`cli/journeys/nativeNavigationFixture.test-support.ts`. The supplied 628-page book is used for
manual verification only.

During each Red → Green → Refactor loop, run only the focused command named above. Before delivery, run:

```sh
npm test
npm run typecheck
npm run typecheck:core
npm run typecheck:tests
npx tsc -p tsconfig.electron.json --noEmit
npm run build
npx playwright test tests/e2e/pdf-native-navigation.spec.ts tests/e2e/mixed-document-ocr.spec.ts
```

Then manually open the supplied 628-page book in the built Electron application and verify:

1. `framework` on PDF page 5 is highlighted over the word and centred in the document pane.
2. At least three table-of-contents links on page 5 navigate to their encoded destinations.
3. The native-text result does not falsely claim whole-document OCR.
4. If core chooses the image-only cover as an OCR target during a forced fresh index, the toolbar shows that OCR stage before indexing.
5. Selecting several lines paints no selection bars at the left edge of the page.
6. Opening the book through the development server presents page 1 without a multi-second renderer long task.

This repository has no lint command or checked-in ESLint configuration, so lint cannot be reported as passed.

## Falsification pass

- **Could the PDF contain bad text coordinates?** No for the reproduced page-5 match. PDF.js returned a plausible glyph transform and bounding box at the visible row; the DOM wrapper and marker were at the origin.
- **Could forced OCR fix the highlight?** No. Search prefers native text whenever a page has at least 100 non-whitespace characters (`src/pdf/document.ts:424-443`), and the renderer adds OCR overlay text only when the native text layer is empty (`src/App.tsx:4642-4665`). Page 5 contains 3,367 non-whitespace characters.
- **Could the links merely be Acrobat-generated guesses?** No. The source file contains 905 `/Link` annotations, including 47 on page 5, with internal destinations and row-aligned rectangles.
- **Could the current renderer OCR indicator already cover core OCR?** No. Renderer OCR uses tab-local `ocrStatus`; core OCR is inside the semantic index job and crosses the bridge only as generic index progress. These are separate paths and the latter drops live per-page progress.
- **Could every zero-text page require OCR?** No. Visual rendering showed nine are blank. Only the image-only cover contains visible content without embedded text.

## Delivery requirements for the implementation task

- Record each focused Red failure, final Green result, and mutation proof.
- Re-read the complete diff for accidental changes and debug code.
- Update `CHANGELOG.md` under `## [Unreleased]` because the implementation changes visible behavior.
- Do not commit or push unless explicitly requested.
