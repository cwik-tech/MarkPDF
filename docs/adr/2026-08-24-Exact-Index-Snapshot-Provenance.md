# Exact Index Snapshot Provenance

## Status

Accepted

## Context

`read_pages` serves the cached Markdown row, while `search` serves chunks selected by a full scope:
document, chunking profile and version, embedding model and version, and vector dimensions. Multiple
search scopes can coexist for one document. A timestamp stored only on `documents` could therefore
be overwritten by one scope and then be incorrectly reported for another scope that still exists.

`to_markdown` has a different contract. It is a filesystem-class operation and must describe the
bytes currently at the permitted path. Proving permission without checking those bytes allowed a
complete Markdown cache for an older file to be returned after the path was replaced.

## Decision

Schema version 4 adds `chunk_scope_snapshots`, keyed by the complete searchable scope. Indexing
removes affected completion rows when chunk replacement begins and writes the exact scope's
completion time only after its final chunk batch commits. Existing scopes have no fabricated time;
they report `null` until rebuilt.

The Markdown cache returns its own `document_markdown.created_at`, written atomically with the cached
text. `read_pages` reports that value. `search` constructs one shared scope definition for both the
query and its timestamp lookup, then reports that scope's completion value.

For filesystem-class reads, MarkPDF hashes the bytes at the canonical permitted path before serving
cached pages. Matching bytes may use the cache; different bytes are extracted from the same single
read. `to_markdown` consequently reports `indexSnapshot: false`, while index-only tools report
`indexSnapshot: true` and `snapshotRecordedAt`.

> **Learning note:** Chunk text belongs to a chunking profile, but its embeddings belong to a model.
> The timestamp key needs both halves; otherwise changing models makes a valid older scope appear as
> though it was written by the newer run.

## Consequences

- Databases upgrade additively from schema version 3 to 4 without re-indexing existing documents.
- Legacy and interrupted search scopes truthfully disclose a `null` recording time.
- Starting replacement withdraws completion claims for every model whose shared chunks are removed.
- `to_markdown` performs one file read even on a cache hit so it can establish byte identity.
- `index-first` and `index-only` operations retain their no-read cache-hit behavior.

## Alternatives Considered

- A `documents.chunks_written_at` column was rejected because one document can retain multiple
  searchable scopes and the most recent write is not necessarily the scope being searched.
- `documents.created_at` was rejected because it survives re-indexing.
- `documents.last_opened_at` was rejected because reuse and ordinary upserts change it without
  writing chunks.
- File size was rejected as a freshness check because different PDFs can have the same byte length.

## Verification

- `mcp/journeys/staleDocument.test.ts` proves the complete same-path replacement journey.
- `core/documents/documentPages.test.ts` proves same-size replacements are detected by content.
- `core/store/store.test.ts` proves per-scope completion, invalidation, and the v3-to-v4 migration.
- `core/store/markdownCache.test.ts` proves cached-page timestamps follow cache rewrites.
- `mcp/operations.test.ts` proves disclosure on search, page reads, and both Markdown reply branches.
- `mcp/toolSchemas.test.ts` proves clients are told which tools return snapshots.
