# 2026-10-31 Library search and exact-word search

## Status

Accepted on 2026-10-31 under the user's instruction to implement the reviewed plan in
`docs/library-search-plan.md` with the recommended option for each open question, and the more
restrictive option for a consent, security or data-loss question.

This decision supersedes, for library search only, the consequence in
`2026-08-23-Command-Line-Consent-And-Contracts.md` that "someone who indexes a library and then
withdraws the grant can still search it". A single named document is still answered after its grant
is withdrawn. It also extends the tool list of `2026-08-23-MCP-Server-Adapter.md` from seven tools to
eight. The decision text of both earlier ADRs is unchanged.

## Context

Search covered one named document and ranked by meaning only. A person could not ask "where did I
read about X?" across the library, and an agent needed one call for each document. Ranking by
meaning is weak on exact strings: a clause number, a name, an invoice number.

The bundled SQLite (3.53.4 in `better-sqlite3` 13.0.3) has FTS5 with `bm25`, so no new package is
needed. Probes and an independent Codex review found five facts that shaped the design:

- FTS5 keeps a deleted row's tokens in its segment records until the index is merged, so the
  existing forget sequence left a forgotten document's words in the file.
- `document_chunks` has a text primary key, and `VACUUM` may renumber the implicit rowid of such a
  table, so the full-text index cannot key on it.
- An older MarkPDF process that has the index open keeps writing after another process upgrades the
  schema, under rules that do not include the new forget step.
- The app records the path the renderer sends, without resolving links, so a lexical grant check on
  an app-recorded path can pass through a link to a folder outside the grant.
- One file path can have several `documents` rows, one for each version of the file that was indexed.

## Options considered

Consent for library results:

- **A. The index is consent.** Every surface searches every indexed document. Rejected: a removed
  grant would not limit what agents discover.
- **B. A grant filter everywhere.** Rejected: the app has no consent gate, so the filter would
  restrict the person at the window and not restrict agents any further than C.
- **C. Per surface, with path provenance.** Chosen.
- **D. A separate library roster.** Rejected: a second consent model nobody asked for.

Full-text table:

- External content on `document_chunks`. Rejected: its rowid is not stable through `VACUUM`.
- A copy of the text in an ordinary FTS5 table. Rejected: a second copy of every document's text.
- **A contentless table keyed by an `INTEGER PRIMARY KEY` key table, maintained by triggers.** Chosen.

Ranking:

- A weighted sum of normalized scores. Rejected: `bm25` and cosine have unrelated scales.
- **Reciprocal Rank Fusion with `k = 60`.** Chosen.

MCP surface:

- Extend `search` so that no identity means the library. Rejected: the schema types cannot express
  "none of path, id, ref", and a missing identity would widen the search without intent.
- **A new tool, `search_library`.** Chosen.

## Decision

1. **Discovery follows current grants for agents.** The command and MCP library searches include a
   document only when `documents.path_provenance` is `resolved` and the recorded path is inside a
   current read root. `resolved` means that the writer resolved the path through the consent check
   and read the bytes from it. The check is lexical and makes no filesystem call. The command's index run writes
   `resolved`. The app and every bytes request write `NULL`, and the value is overwritten with the
   path on every upsert. Rows written before schema 5 have `NULL` until `markpdf index` runs on their
   folder again. The reply gives the number of documents left out, never their names or paths. The
   app's Library scope searches every indexed document.
2. **Schema 5** adds `path_provenance`, the contentless FTS5 table `chunk_text_fts`
   (`unicode61 remove_diacritics 2`), the key table `chunk_text_keys`, an insert trigger and a delete
   trigger on `document_chunks`, and a trigger that refuses any update of a chunk's id or text.
3. **The upgrade** reads the schema version inside the write transaction. An existing file is upgraded
   only under exclusive access, and refuses with `StoreUpgradeBusyError` (exit 9 on the command line)
   when another connection has it open. A new file needs no exclusive access.
4. **The backfill** adds pre-existing chunks to the index in transactions of 500 chunks, from a
   `(document_id, id)` cursor kept in the same transaction. A pass ends with a check for any missing
   chunk in the same transaction before the index is recorded complete. A search in `exact` or
   `hybrid` mode finishes the backfill first. The app runs it as one registered background job.
5. **Forget and clear** record an owed erase in the same transaction as the delete, then merge the
   full-text index with `optimize` before the existing checkpoint, `VACUUM` and checkpoint, and clear
   the record last. An interrupted forget is finished by the next forget or clear.
6. **Queries** reach FTS5 only through `buildExactMatch`: every part is a quoted FTS5 string, parts
   join as AND, control characters are refused, and the limits are 1,000 characters and 32 parts.
7. **Modes**: `semantic`, `exact` and `hybrid`, chosen by `--mode` in `cli/spec.ts`, from which both
   MCP tools take their schema. The default is `hybrid`. An explicit minimum score in exact mode is
   refused. Every reply states its mode.
8. **Ranking**: one read snapshot for every stage after the query embedding. The exact ranking uses
   the same six-field scope as the semantic ranking. Library answers take at most three passages from
   one document, and the candidate depth doubles up to 1,600 when that cap leaves the answer short.
9. **Bounds**: every changed command and MCP search reply, and the app's library reply, pass through
   `boundSearchReply`, which applies the content bound and then the reply bound from `budget.ts`.

## Consequences

- An agent's library search returns nothing for documents indexed only by the app until the person
  grants the folder and runs `markpdf index` on it. The stderr note and the tool description say so.
- Discovery is restricted, not access. A document an agent can name by its hash is still searched
  and read after its grant is removed.
- The first opening of an older index by this build fails while any other MarkPDF process has the
  index open. If two new processes open an older index at the same moment, both can refuse, and
  opening again succeeds.
- `score` means cosine in `semantic` mode, `-bm25` in `exact` mode and the RRF value in `hybrid` mode.
  `semanticScore` always carries the cosine when there is one. Callers that compared `score` with a
  cosine threshold see a change under the new default.
- "Exact" means exact words, not exact characters: case and diacritics are folded, and a phrase matches
  consecutive tokens.
- Measured on 2026-10-31 (`docs/records/2026-10-31-library-search-measurement.md`): a library of
  10,000 chunks answers a hybrid search in under 90 ms, but 100,000 chunks need about 0.9 s and
  500,000 chunks about 4.8 s, mostly for the scan by meaning. The backfill of an upgraded index takes
  about 8 s for 100,000 chunks, once.
- Clearing the whole index is protected twice: `delete-all` on the full-text table, and the merge.
  Measured: deleting every row already empties every segment, so the clear test cannot tell the two
  apart. The forget case is the one that proves the merge.

## Verification

- `cli/journeys/exactSearch.test.ts`: exact words in one document through the real command.
- `cli/journeys/librarySearch.test.ts`: library search, the latest version of a changed file, and a
  removed grant.
- `mcp/journeys/toolSession.test.ts`: eight tools, hybrid ranking through `search`, and
  `search_library` before and after a grant is removed in one session.
- `tests/e2e/library-search.spec.ts`: a closed document found from the Library scope opens at the
  page with the passage highlighted, and stays there.
- `core/store/exactIndex.test.ts`: the triggers after every public write, immutability, key reuse,
  and the exact ranking's scope rules.
- `core/store/exactIndexUpgrade.test.ts`: the upgrade of a schema 4 file, the busy refusal, the
  version read under the lock, bounded batches, gap repair, cancellation and clear.
- `core/store/forget.test.ts`: no token in the file, its log or the index vocabulary after forget or
  clear, and recovery of an interrupted erase.
- `core/index/exactQuery.test.ts`, `core/index/searchMode.test.ts`, `core/index/fusion.test.ts`,
  `core/index/exactSearch.test.ts`, `core/index/librarySearch.test.ts`,
  `core/output/searchReply.test.ts`, `core/ipc/requests.test.ts`, `src/libraryHitTarget.test.ts`,
  `mcp/operations.test.ts`, `mcp/toolSchemas.test.ts`, `mcp/server.test.ts` and `cli/commands.test.ts`.
- Mutation proofs for each high-risk rule are recorded in `docs/library-search-plan.md`.
- Performance: `scripts/bench/librarySearchBenchmark.mjs`, with results in
  `docs/records/2026-10-31-library-search-measurement.md`.

## Revisit when

- A performance target in the measurement record fails at a library size people use.
- A person needs substring search (the `trigram` tokenizer) or a query language.
- The app gains its own consent gate, which would make option B worth reconsidering.
