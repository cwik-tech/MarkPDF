# Image regions on text-bearing pages are read by recognition

## Status

Accepted. Implements failure F1b of `docs/mcp-cli-electron-parity-plan.md` (journey I).

## Context

`@firecrawl/pdf-inspector` 1.17.0 decides a page is a scan by the balance of text to picture, not
by picture alone: measured against the adversarial fixture, a page that is nothing but a raster is
flagged `needsOcr: true`, while the same raster beside ordinary prose is not. So a figure painted
onto a text-rich page — a schedule, a table, a chart with numbers in it — enters the index with
its pixels unread, on all three surfaces at once, and a search for a number that exists only
inside the picture finds nothing. The figure in the fixture ("Channel rebate … 6420", page 4) is
retrievable by no command until something reads regions on pages that read perfectly well.

The cost constraint is the reason this had not been done naively. Rasterising and recognising a
whole page costs hundreds of milliseconds per page, and most text-bearing pages carry no figure
worth reading: a 400-page report would pay for 400 recognitions to find one figure.

## Decision

### Qualification is a walk of the operator list, not a render

`core/extract/imageRegions.ts` walks each candidate page's operator list with a CTM stack
(`save`/`restore`/`transform`, plus `paintFormXObjectBegin`/`End`, whose matrix arrives as an
argument rather than as a transform, exactly as the renderer applies it), working from the
shared `openPdfDocument` handle `core/ocr/rasterisePages.ts` exports: a caller holding one open
pays the measured 35 ms once. Every image paint contributes the unit square it paints into,
transformed by the CTM. The walk measures 2.8 ms per page where a render costs hundreds. Each
page gives its operator-list resources back the moment its walk is done — `page.cleanup()` in
the page's own `finally`, so a page declined for a degenerate box pays its way back too.

The thresholds are named constants with their justification measured against the fixture:

- `MIN_IMAGE_COVERAGE = 0.05` — the measured logo covers 0.7 % of its page, the measured figure
  10.6 %; 5 % separates them with room on both sides.
- `MIN_SINGLE_IMAGE_AREA_PT2 = 10_000` — the logo is 3 200 pt², the figure 51 200 pt². Coverage
  alone would send a page of decorative icons to the recogniser when the icons together clear
  5 %; the floor keeps a page qualified only when one picture is actually worth reading.

Two honest limits, stated rather than guessed: a page turned sideways (`rotate !== 0`) declines
to qualify because the crop arithmetic is stated for upright pages, and image paints inside
repeat operators (`paintImageXObjectRepeat`) are not counted — neither arises in the probe
document, and both degrade to the pre-change behaviour: the page keeps its native text.
`paintJpegXObject` is named in the plan but no longer defined by the installed pdfjs-dist 5.4;
the paint set is built from the operators the installed build exports.

### Reading a region crops it; reading never re-renders a page

`core/ocr/ocrPages.ts` accepts `imageRegions` on its request. A page named there renders with
the whole-page work in one rasterisation pass, and the recogniser receives not the page but the
padded union of its qualifying regions — `REGION_CROP_PADDING_PT = 10` points on each side,
clamped at the page edge, because the engine misses words at the very edge of its input and a
crop reaching past the page would hand it invented margins. Table reconstruction applies to a
region's reading exactly as it does to a whole page.

`core/extract/readDocumentPages.ts` opens the document **once**, when any text-bearing page is
worth a look: the region walk and the recognition seam both work from that one handle. The read
asks its injected `resolveOcr` seam once for the union of flagged pages and qualifying region
pages — so both paths share one render pass and one engine — and hands the seam the open
document on the request (`ResolveOcrRequest.document`); `ocrPages` borrows it for the render
instead of opening the same bytes again, and the read releases it once the seam returns, on
every path out. The seam stays injected: a resolver that does not render simply ignores the
handle. The request type is declared where the seam is declared, and `IndexPdfDocumentInput`,
`DocumentPagesInput` and the MCP `ToolContext` all name it — no caller re-authors the shape.

### Merge appends and deduplicates; provenance keeps the position

The merged page is the native text, a blank line, then the region's reading. Deduplication is
line by line, both sides normalised through the existing `toPlainText`, dropping an OCR line
whose normalised text already occurs in the native text — a picture that repeats the words
beside it would otherwise be indexed twice. Appending rather than interleaving is a documented
limitation: there is no way back to where on the page the picture sat relative to the words.
The position itself is not lost: such a page comes back `source: "mixed"` carrying
`imageRegions` — each region's box and whether its recognition added text (`read`) or nothing
(`empty`) — and `PageSource` gains `"mixed"` through `PageText` and `MarkdownPage` so the
provenance survives chunking to `documents.text_source`.

A region that recognises to nothing leaves the page exactly as the extractor read it: native
text, `source: "pdf"`, the region recorded as `empty`. The page is still `read`, never
`unresolved` — its text layer was always complete.

### Which pages ever rasterised is observable through a guarded seam

Journey I asserts the cost contract across a real CLI index: which pages rendered. The seam is
`core/ocr/rasterisationRecord.ts`, guarded exactly like the deterministic embedder — unpackaged,
the exact opt-in token (`MARKPDF_E2E_RASTERISATION_RECORD=record`), and a test data directory —
and writes only inside that directory. The journey arms it for the indexing run alone and reads
the record afterwards. Against the mixed fixture the rendered pages are exactly 4, 10, 12, 13 —
the region crop, the two flagged scans, and the blank page the extractor cannot account for —
never the 0.7 % logo on page 2 and never a text-only page. (The plan anticipated `{4, 10}`; the
chart page and the blank page are both flagged `needsOcr` and so render whole. The invariant the
assertion protects — nothing text-only rasterises — holds as planned.)

## Consequences

- A figure on a text page is retrievable through every surface, because the reading happens in
  the one composition all three share. The journey proves it over a real MCP client after a real
  CLI index.
- Ordinary text pages pay the 2.8 ms walk, bounded by `ocrOnlyPages` exactly as recognition is;
  nothing pays a render or an engine unless a region qualifies, and a read that looks for
  regions pays exactly one open of the document, shared by the walk and the render.
- The merged text is cached like any other reading, so a later `read_pages` or `convert` serves
  the figure's text from the index and never re-reads it.

## Verification

- Detection rules: `core/extract/imageRegions.test.ts` (probe literals; the many-small-images
  page protects the single-image floor; a counted cleanup on a degenerate-box page proves the
  resources are returned on the no-walk path too).
- Crop pipeline: `core/ocr/ocrPages.test.ts` (one render, cropped input, clamped padding, table
  reconstruction, whole pages beside region pages in one pass, and rendering from a supplied
  handle while the bytes given would not open — proof the renderer borrows rather than reopens).
- Merge, deduplication and provenance: `core/extract/readDocumentPages.test.ts`, including the
  one-open regression: the seam receives the read's own handle, live while borrowed and
  destroyed afterwards.
- Journey I: `mcp/journeys/imageRegions.test.ts`.
- Mutation proof: lowering `MIN_SINGLE_IMAGE_AREA_PT2` to 0 fails the many-small-images test
  (the plan's expectation that the page-2 journey assertion fails is disproved: the logo page is
  independently protected by the coverage rule); removing the deduplication line fails the
  merge test. Both restored, both suites green.
