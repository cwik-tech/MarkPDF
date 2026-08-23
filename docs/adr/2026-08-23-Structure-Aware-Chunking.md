# Structure-aware chunking, and what makes two chunks the same chunk

## Status

Accepted

## Context

Phase 1 chunked by word window: fixed-size overlapping spans of a page's text, with
`headingPath` written as an empty array and no notion of a table. Two things follow from that.
A table was cut wherever the word count ran out, and a chunk had no idea what section it was in,
so a hit could quote a row and say nothing about which table it belonged to.

Chunk identity was `{contentHash}:{profile}:{version}:{page}:{index}` — the file's bytes and the
chunk's position, but not its content. Extraction is not deterministic, so the same file can
yield different text at the same position; the reuse check compared identical identifiers and
kept the stale copy. Phase 1 recorded that limitation in the source rather than claiming it away.

## Decision

**Blocks, not windows.** `splitIntoBlocks` turns per-page Markdown into headings, paragraphs,
lists and tables. A block never spans two pages even when a sentence obviously does, because the
page number is what makes a hit citable and a chunk with two pages has neither.

**The heading stack is computed by walking back**, so it crosses page boundaries for free: a
table opening page 8 keeps the heading that closed page 7. A heading's own title is in its own
path, so a heading indexed as a chunk describes itself.

**The breadcrumb is prepended to `embedText` only** — never to the stored text, which is what a
citation quotes and a highlight matches. It is capped at 15 percent of the budget and trimmed
outside-in.

**Oversized tables become row windows carrying structured provenance.** Each window repeats the
header in `embedText` — so the model knows what the columns are — and stores only the body
fragments. Whole rows overlap by one where the budget allows.

**A row larger than the budget becomes continuation parts**, split at cell boundaries first, then
at word boundaries inside a cell, then by code point for a single unbroken word. Each part
carries `row`, `partIndex`, `partCount`, `offset`, `firstColumn`, `lastColumn` and its exact
bytes. `reassembleRows` reconstructs the original string **exactly** from that metadata — character for
character, since a JavaScript string is UTF-16 code units and not a byte sequence, which is
the executable statement of losslessness.

An earlier draft tried to infer reconstruction from the rendered Markdown alone and then narrowed
the contract — refusing an oversized cell — because the pieces of one cell are indistinguishable
from separate cells in text. Carrying the fragments as data removes the ambiguity instead of
avoiding it.

**Snippets are plain text, derived at search time.** The stored text is Markdown, and the snippet
is matched against pdf.js's reading of the page to place the highlight, where no pipe, hash or
emphasis marker appears. `searchDocument` runs `toPlainText` before trimming. Keeping the header
out of the stored text is what makes that work: `header … row` is not contiguous anywhere on the
page.

**Chunk identity folds in a fingerprint of the normalized text**, plus the continuation part
index. Changed text is a different chunk, so reuse fails closed. Whitespace is collapsed first —
layout is not content, and a re-extraction that re-wraps a paragraph must not invalidate an index
that is still correct. The readable prefix is kept so a stored row can be traced to a document
without a query; only the fingerprint is opaque.

**`semanticChunkingVersion` rises to 2.** Output genuinely changed, so every stored chunk is
invalidated — and re-indexed lazily, one document at a time, on next open, per D9.

## Consequences

- A hit can report its heading path and the page it came from.
- Existing users re-index once, silently, as they open documents.
- The identifier is longer but still well inside a text primary key.
- Users with very large tables gain the most. Measured by `scripts/bench/chunkingBenchmark.mjs`
  on a six-page ground-truthed fixture, each side driven by its own representation — a pdf.js
  reading-order string for the old pipeline, PDF Inspector Markdown for the new: intact-table
  rate 0.752 → 1.000, GFM rows preserved 0 → 125 of 125, page accuracy@1 0.857 → 1.000,
  MRR 0.905 → 1.000, recall@5 unchanged at 1.000, chunks over the encoder limit 1 → 0, largest
  chunk 695 → 415 tokens. The script's separate 400-row stress scenario: 287 of 400 rows reached
  the model before, 400 of 400 after. Truncation is simulated at the 510-token encoder payload
  limit, not at the 420-token chunking target — they are different numbers and only the first is
  where the model cuts.
- The ranking figures above are **deterministic regression proxies**, computed with
  `createDeterministicEmbedder`. They show that chunking did not move retrieval backwards under a
  fixed scorer; they say nothing about whether the real model ranks usefully, which only the
  opt-in live check can address.

## Verification

`core/index/markdownBlocks.test.ts`, `core/index/tableWindows.test.ts`,
`core/index/structuredChunking.test.ts`, `core/index/chunkIdentity.test.ts` and
`core/index/truncationRetrieval.test.ts` and `core/index/reuseIdentity.test.ts`.
`scripts/bench/chunkingBenchmark.mjs` reports the before/after figures on demand, including the
OCR arbitration disagreement.

Mutation-proved: the final fragment dropped; the last window dropped; part indices flattened;
the header omitted from `embedText` or added to stored text; cell boundaries not preferred; the
budget not enforced when packing; fragments normalized before storing; the breadcrumb stored,
trimmed inside-out or given the whole budget; tables split as prose; the snippet left as
Markdown; the text fingerprint or continuation index dropped from identity; and the fingerprint
made case-insensitive or whitespace-sensitive.

## Alternatives considered

- **A persisted snippet column.** Would work, but it is a schema migration for something
  derivable at search time from text the store already holds.
- **Refusing an oversized cell.** Simpler, and rejected: the plan requires losslessness, and
  "refuse" is not lossless, it is just a louder way to lose.
- **Keeping word windows and raising the preset sizes.** Does not address structure at all, and
  larger windows overflow the token budget sooner.
