# Chunk heading provenance and the low-signal rule

## Status

Accepted. Implements failure F13b of `docs/mcp-cli-electron-parity-plan.md`.

## Context

Two retrieval defects shared one root: the chunk set was computed from text alone, with no
record of where a heading stood or of which blocks were content at all.

**A passage appeared to claim a heading from an earlier page.** The breadcrumb followed
headings across page boundaries — correctly, because a table opening page 8 really does sit
under the heading that closed page 7 — but the stored breadcrumb was a list of titles with no
pages. An agent receiving `heading_path: ["Operating Plan"]` for a passage on page 10 could not
tell that the heading closed page 9; it read as the passage's own heading, on the passage's own
page.

**Slide labels and page footers competed with content.** A one-line label such as
`**T R A C T I O N**` became its own chunk, and a footer repeated on every page became one chunk
per page. Measured against the fixture, the footer appears on eight of thirteen pages; with a
selective top-k it pushes content out of the cut, and a search whose query shares a word with
the footer ranks noise above the passage that answers.

## Decision

### The breadcrumb records each heading's page; the document text is untouched

`headingPathAt` returns `{title, page}` entries, chunks carry them as `headings` beside the
unchanged title-only `headingPath`, and `semanticChunkingVersion` is raised to 4 so rows
written before the bump re-chunk lazily. `document_chunks.heading_path` stays free-form JSON
with no DDL change: writes store the entries; the reader (`parseHeadingEntries`) accepts the
new shape and the legacy list of bare titles, whose pages read as `null` — genuinely unknown,
never invented.

Search adds provenance without breaking the old field: MCP `search` keeps `heading_path` and
adds `headings` and `heading_inherited`; the command line's JSON mirrors the core shape, and
its human output prefixes an inherited heading with its page (`p9: Operating Plan`) while a
heading on the passage's own page prints bare. `heading_inherited` is decided by the passage's
*nearest* heading: true when it stands on an earlier page, false when it stands on the
passage's page or its page was never recorded. Ancestors further out do not inherit the flag: a
passage under its own page's section heading claims that heading even if the section nests
under a chapter from page 1.

### Low-signal blocks leave the chunk set, never the document

Two rules, both confined to paragraph blocks — headings, tables and lists carry structure that
is signal whatever their size:

- A **label** is a single-line paragraph, at most 48 plain characters, without sentence-ending
  punctuation, that is either fully wrapped in emphasis or at least 80 % capital letters and
  spaces. With a chunk after it on the same page it folds into that chunk: prefixed to its
  `embedText` and recorded in its `localHeadings`. With nothing after it — the label that ends a
  page — it stays a chunk, because folding it into nothing would lose it.
- **Running text** is a paragraph of at most 80 plain characters appearing identically on
  `max(3, ceil(0.4 × pageCount))` or more distinct pages. It produces no chunk on any page.

Neither rule removes text from the document: extraction, the Markdown cache, `read_pages` and
`convert` all still serve every word. The rules change the standalone *chunk* set — a retrieval
decision — and nothing else; scores and thresholds are untouched. Both constants sit above the
measured fixture values (labels at 13 and 15 characters, the footer on 8 of 13 pages) with room
on both sides.

## Consequences

- An agent can distinguish a heading a passage sits under from one it merely follows, for new
  rows; legacy rows report `page: null` and `heading_inherited: false` until re-indexed.
- The footer and its kind no longer occupy retrieval cuts; slide labels reach the model as
  context of the content they introduce.
- The version bump re-chunks documents lazily on next open, exactly as prior bumps did.

## Verification

- Heading provenance: `core/index/markdownBlocks.test.ts`, `core/index/structuredChunking.test.ts`.
- Low-signal rule: `core/index/structuredChunking.test.ts` (label fold, no-follower emission,
  all-caps variant, sentence negative, running text drop and threshold negative, blocks
  untouched).
- Storage and legacy read: `core/store/store.test.ts` (`parseHeadingEntries`).
- Public fields: `mcp/operations.test.ts` (`headings`, `heading_inherited`, kept
  `heading_path`), `cli/commands.test.ts` (JSON shape, human prefix).
- Mutation proof: extending the label rule to drop no-follower labels fails exactly the
  `S U M M A R Y` emission test; restored, suite green.
