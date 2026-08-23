# PDF Inspector as the extractor, with one adapter owning its boundary

## Status

Accepted

## Context

Before Phase 2 the renderer read page text with pdf.js and sent it to the main process. That
text is a flat run of words: pdf.js reports positioned glyphs, so a table arrives as its cells
in reading order with no indication that they were ever a table. A search hit could quote the
right words and give no way to tell which table, or which section, they came from.

`@firecrawl/pdf-inspector` 1.17.0 (MIT, native, `darwin-arm64` among six platform packages)
returns per-page Markdown with structure preserved. Measured against a ruled three-column
fixture, page two came back as a GFM table:

```
|Segment|Revenue 2025|Revenue 2026|
|---|---|---|
|Enterprise|1204|1318|
```

The package is also internally inconsistent about page numbering, in a way that would produce
citations that are confidently and systematically wrong.

## Decision

`core/extract/pdfInspector.ts` is the only file in the repository that imports the package. It
treats everything the package returns as external input and reconstructs it field by field.

**One named validating function per page-bearing field, never a shared constant.** Measured
against 1.17.0:

| Field | Base | Measured in | Evidence |
| --- | --- | --- | --- |
| `pages[].page` | 0-based | Stage 0 | `.page=0` carries the page-one sentinel |
| `pagesWithTables` | 1-based | Stage 0 | returns `[2]`; the table is on `.page=1` |
| `pagesNeedingOcr` | 1-based | Stage 0 | returns `[2]`; the scanned page is `.page=1` |
| `ocrReasonsByPage[].page` | 1-based | Stage 0 | `{"page":2,"reasons":["scanned"]}` |
| `pagesWithColumns` | 1-based | Phase 2 | returns `[2]`; the two-column page is on `.page=1` |

A shared offset would be wrong for four of the five. A per-field *constant* would still let a
caller apply the wrong one, and would mean one mutation broke every normalizer at once so no
test could show which it protects. Each function carries its base as a literal and returns a
branded `PageNumber`, which is constructible only after both a type and a range check.

**`classifyPdfAsync` never feeds per-page logic.** It returned `[0,1,2]` for a document where
one page of three was a scan, because it classifies the whole document. Only its `pageCount` is
read, through `classificationPageCount`, and that gives an independent count to check the
extraction's completeness against — 3.4 ms against 109 ms for the extraction itself.

**Full-document extraction only.** The `pages` *input* argument is 0-based, a third convention.
Phase 2 has no caller needing partial extraction, so the adapter does not offer it and no page
number crosses the boundary inward.

**Refuse, never repair.** Duplicate pages, gaps, wrong order, out-of-range values, and
disagreement between `needsOcr` and `pagesNeedingOcr` all raise. Sorting or clamping would hide
the one thing that must never be hidden: that the engine's contract changed underneath us.

## Consequences

- A search hit can cite a table row and say which page and which section it came from. Column
  provenance is validated inside the adapter but is **not** exposed on a result:
  `SemanticSearchResult` carries id, page, snippet, score and heading path. Surfacing columns
  would need a new field and a consumer for it, and neither exists yet.
- One file to change if the package is replaced; `grep` finds every use of it.
- Intel macOS stays out of scope: `darwin-x64` is not published.
- `win32-arm64` is uncovered, and `build.win` has no arm64 target today.
- Error formatting is total — no `JSON.stringify` on unknown values, which throws on BigInt and
  recurses on cycles. A guard that dies composing its own message loses the diagnosis.

## Verification

`core/extract/pdfInspector.test.ts` drives three real fixtures through the real binding: a
sentinel-and-table document, a document whose middle page is a rasterised scan, and a dense
two-column document. `core/extract/pageNumbers.test.ts` covers the pure rules and every
malformed-result case without touching a PDF.

Mutation-proved: each normalizer gaining or losing its offset; the range and integer checks; the
source-order, completeness, duplicate and OCR-agreement rules; the classification's page count
taken from the extraction instead of independently; `isRecord` accepting arrays; and the error
formatter reverted to `JSON.stringify`.

## Alternatives considered

- **Docling per page.** `findPageInsertionPoint` returns −1 for a page under six tokens, the
  cursor advances monotonically so one bad match desynchronises every later page, and
  `safeMarkdownInsertionPoint` deliberately pushes an anchor past a table — attributing it to the
  previous page, the exact failure this work exists to prevent.
- **A hand-written structural extractor** over `groupSyntheticTextLines`. Months of work to
  reproduce what the package already does, maintained against every PDF generator in existence.
- **Keeping pdf.js text.** Cannot produce table structure at all; the structure is not in the
  text layer to be recovered.
