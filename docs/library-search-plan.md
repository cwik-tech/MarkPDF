# Library search and exact-word search plan

Date: 2026-10-31. Branch: `cwik-tech/library-search`, based on `main` at `2125a71`.

## Status and evidence boundary

This plan is revised after an independent Codex review. The review is in
`docs/records/2026-10-31-library-search-plan-codex-review.md`. The section "Review disposition"
lists each finding and what I did with it. The user then asked for implementation in this
worktree, with the recommended option for each open question. The section "Default decisions"
records those choices.

**Implemented in this worktree on 2026-10-31, not committed.** The section "Implementation record"
gives the Red and Green evidence, the mutation results and the deviations. The decision record is
`docs/adr/2026-10-31-Library-And-Exact-Word-Search.md`. The measurement is
`docs/records/2026-10-31-library-search-measurement.md`.

- Every claim about existing behavior cites `file:line` in this worktree at `2125a71`.
- The idea brief is `docs/feature-ideas.md` in the main checkout. It is not committed.
- I ran six small probes against the bundled `better-sqlite3` 13.0.3 with raw SQL that imitates the
  store. They do not run the production code path. Their numbers are indicative only. Codex ran
  its own probes, which the review describes. The probe sources are not kept in the repository.
- A claim without a citation or a probe is marked **unverified**.

## Summary

MarkPDF can search one indexed document at a time, by meaning only. This plan adds two
capabilities that share one ranking path:

1. **Library search.** One query searches every indexed document that the caller may discover.
   The reply is one ranked list of passages. Each passage names its document and page.
2. **Exact-word search.** A full-text index (SQLite FTS5, ranked with `bm25`) finds passages that
   contain the query words. A caller selects `semantic`, `exact` or `hybrid`. The `hybrid` mode
   fuses the two rankings with Reciprocal Rank Fusion (RRF).

The surfaces are the `markpdf search` command, the MCP server and the app's search sidebar. The
command table in `cli/spec.ts` stays the single source of the MCP argument schemas.

Three safety rules come from the probes and the review:

- Forget and clear must merge the full-text index, or a forgotten document's words stay in the file.
- The schema upgrade must run with no other connection attached, because an older MarkPDF process
  that stays open does not know the new forget rule.
- Agents discover only documents whose recorded path MarkPDF itself resolved, inside a current
  read grant. A path that the app recorded can pass through a link to a folder outside the grant.

## Default decisions

The user asked me to apply the recommended option for each open question, and to choose the more
restrictive option for a consent, security or data-loss question.

| Question | Decision | Reason |
| --- | --- | --- |
| 1. Consent rule for library results | Option C with path provenance. The app searches every indexed document. The command and MCP search only documents whose path MarkPDF resolved when it read the file, inside a current read root | This is more restrictive than option A and than option C as first written. Option B restricts only the person in the app, who has no consent gate today (`electron/main.ts:582-590`), so it gives agents no extra restriction. Option D adds a second consent model, and the user did not ask for one |
| 2. Default mode | `hybrid` for the command and both MCP tools. The app always sends a mode | Recommended option. Not a consent, security or data-loss question. Every reply now states its `mode`, so a caller can see the meaning of `score` |
| 3. Eighth MCP tool | A new tool `search_library` | Recommended option. Codex also judged it defensible (finding 15) |
| 4. App placement | The Library scope in the search sidebar only | Recommended option. The start-screen search box stays a later decision |

## Verification of the idea brief

| Brief claim | Result | Evidence |
| --- | --- | --- |
| `markpdf index` accepts a directory with `--recursive` | Confirmed | `cli/spec.ts:121-123` |
| `markpdf search` requires exactly one of `--path` or `--id` | Confirmed | `cli/spec.ts:150`, enforced at `cli/parse.ts:315-321` |
| The store query filters on one `document_id` | Confirmed | `core/store/index.ts:982-989` |
| A search of one indexed document needs no file permission, also after the grant is removed | Confirmed. This is a documented, intended property | `core/index/documentLookup.ts:27-42`, `docs/adr/2026-08-23-Command-Line-Consent-And-Contracts.md:43-47` and `:156-157`, test `cli/journeys/consent.test.ts:63` |
| The search compares the query vector with every stored passage of the document | Confirmed | `core/store/index.ts:979-1014` |
| Nobody has measured the cost at library scale | Before this work, no measurement record existed in `docs/records/`. Whether anyone measured it elsewhere is **unverified** | Probe P5 gave a first indicative number. `docs/records/2026-10-31-library-search-measurement.md` now holds the measurement |
| None of the seven MCP tools does an exact-text search | Confirmed | `mcp/toolSchemas.ts:146-253`, `README.md:153-163` |
| `better-sqlite3` 13.0.3 supports FTS5 with `bm25` | Confirmed under Electron and under plain Node | `package.json`, probe P1. SQLite is 3.53.4 with `ENABLE_FTS5` |
| The feature needs no new package | Confirmed for FTS5 | Probe P1 |
| The README roadmap lists "make semantic search state-of-the-art" | Confirmed | `README.md:73` |

The brief does not mention five facts that change the design:

1. FTS5 can keep a forgotten document's words in the file (probes P2 to P4, and the Codex probes).
2. `document_chunks` has a `TEXT` primary key (`core/store/legacySchema.ts:24-33`). SQLite documents
   that `VACUUM` can change rowids of a table without an `INTEGER PRIMARY KEY`
   (https://www.sqlite.org/lang_vacuum.html). Thus an FTS5 table cannot key on the implicit rowid
   of `document_chunks`.
3. One file path can have more than one `documents` row. A file whose bytes changed and that was
   indexed again keeps its old row (`core/store/index.ts:263-268`).
4. The app records the path that the renderer sends, without resolving links. `file:read-pdf`
   returns the requested spelling (`electron/main.ts:582-589`), the index job forwards it
   (`electron/semantic.ts:185-197`), and the store keeps it (`core/index/indexDocument.ts:269-272`).
   A bytes request can carry a path that nothing checked (`core/ipc/requests.ts:87-95`).
5. The upsert overwrites `file_path` on every write of a known hash (`core/store/index.ts:901-904`).
   A document that the command indexed can later carry a path that the app recorded.

## Baseline: how search works today

### Store

- The schema is at version 4 (`core/store/schema.ts:6`). `migrate` reads the version before it takes
  the write lock, then runs in one `IMMEDIATE` transaction (`core/store/schema.ts:79-111`). Two
  processes that both read version 4 can both try the same DDL.
- `SchemaTooNewError` is checked only at open (`core/store/schema.ts:81`, `core/store/index.ts:462`).
  A process that opened the file before an upgrade keeps its old code.
- Other processes wait for a writer for at most 5,000 ms (`core/store/index.ts:31-32`, `:453`).
- Chunks live in `document_chunks` with a `TEXT` primary key. Vectors live in `chunk_embeddings`
  (`core/store/legacySchema.ts:24-44`).
- The only insert statement for chunks is `insertChunkStatement` (`core/store/index.ts:495-498`),
  called by `insertBatch` (`:638-656`). No code updates a chunk row.
- Chunks are deleted in three places: `clearScope` (`:658-671`), `removeDocument` (`:717-726`) and
  `wipe` (`:809-811`).
- These internal transactions sit behind the public store methods. `insertChunkBatch` and
  `replaceChunks` use `insertBatch` (`:951-961`). `beginChunkReplace` and `replaceChunks` use
  `clearScope` (`:924-926`, `:956-957`). `deleteDocument` and `forgetDocument` use `removeDocument`
  (`:1053-1064`). `clear` uses `wipe` (`:1092-1099`).
- `search` reads every row of one document's scope with six scope fields, computes a full cosine,
  sorts, cuts to `topK` and returns page order (`core/store/index.ts:979-1014`).
- `readReusableIndex` reads its several statements in one deferred transaction, so that they
  describe one instant (`core/store/index.ts:813-823`, `:882-891`).
- Chunk identifiers carry the profile and a text fingerprint, not the model
  (`core/index/chunkIdentity.ts:42-55`).

### Search and lookup

- `searchDocument` embeds the query, calls `store.search`, and turns each chunk into a plain-text
  snippet of at most 260 characters (`core/index/search.ts:71-107`, `core/index/chunking.ts:26-29`).
- `findIndexedDocument` answers a path or a hash from the database before any filesystem call
  (`core/index/documentLookup.ts:27-42`).

### Consent

- Grant roots are canonical absolute paths. Containment is lexical through `path.relative`
  (`core/consent/allowlist.ts:15-21`, `:106-118`).
- `isAllowed` and `requireAccess` resolve the target with `realpathSync` (`:84-104`, `:126-158`).
- The command stores the resolved path of each file it indexes (`cli/commands/indexCommand.ts:117`,
  `:124`, `:137`, `:152`). Both upsert callers write the path again on a reuse run
  (`core/index/indexPdfDocument.ts:122-140`, `core/index/indexDocument.ts:269-272`).
- The consent ADR: "Someone who indexes a library and then withdraws the grant can still search
  it" (`docs/adr/2026-08-23-Command-Line-Consent-And-Contracts.md:156-157`).
- `search` and `read_pages` are `index-only` (`docs/adr/2026-08-23-MCP-Server-Adapter.md:79-85`).
- Forget runs `secure_delete`, a checked checkpoint, `VACUUM` and a second checkpoint under
  exclusive access (`core/store/index.ts:756-807`, `:1057-1064`, `:1092-1099`). Exclusive access is
  taken before anything is deleted (`:762-775`). The byte-level test looks for a phrase with capitals
  and hyphens (`core/store/forget.test.ts:41`, `:106-114`).
- No command and no MCP tool forgets a document (`cli/spec.ts:116-189`, `README.md:171`).

### MCP

- Tool schemas come from the command table through `propertyFromOption` (`mcp/toolSchemas.ts:98-104`).
  `query` is written by hand (`mcp/toolSchemas.ts:172`). A boolean option throws (`:85-87`).
- `SchemaBranch` can require and forbid fields, but not express "none of these" (`mcp/toolSchemas.ts:30-33`).
- `parseToolArguments` fills defaults, then checks `oneOf` (`mcp/arguments.ts:75-104`). It refuses
  control characters in text (`mcp/arguments.ts:30-35`).
- `runSearch` maps each hit field by name and bounds the reply (`mcp/operations.ts:300-331`). It
  replaces an absent `min_score` with the setting before core sees it (`mcp/operations.ts:292-294`).
  The command does the same (`cli/commands/searchCommand.ts:108-110`).
- The server refuses any reply over the reply budget (`mcp/server.ts:199-210`).

### Output bounds

- `DEFAULT_CONTENT_BUDGET` is 20,000 bytes and `DEFAULT_REPLY_BUDGET` is 48,000 bytes
  (`core/output/budget.ts:58`, `:72`). `boundItems` keeps whole items (`:333-350`). `fitReply` fits
  the finished JSON (`:117-140`).
- The command's `search` output does not use `budget.ts` (`cli/commands/searchCommand.ts:118-128`).

### App

- The search box runs a search 250 ms after the text reaches three characters
  (`src/App.tsx:2620-2637`). Semantic search runs only for a ready, active PDF tab, under one request
  id (`src/App.tsx:2582-2603`).
- The Semantic Search pane renders only when a PDF tab is active (`src/App.tsx:2707-2708`, `:3246`).
  It shows results with page and score (`src/App.tsx:5309-5343`). A click sets `semanticHighlight`
  on the active tab (`src/App.tsx:3296-3305`).
- The IPC search handler is `semantic:search` (`electron/main.ts:806-808`, `electron/semantic.ts:219-231`).
- The index job yields to the event loop between batches through an injected `setImmediate`
  (`electron/semantic.ts:209-211`).

## Scope

In scope:

- Library search through `markpdf search --library`, a new MCP tool `search_library`, and a Library
  scope with a mode control in the app's search sidebar.
- An exact-word index with FTS5 and `bm25`, its schema upgrade, its backfill, and its removal on
  forget and clear.
- Path provenance for documents, so that agent discovery uses only paths MarkPDF resolved.
- Three search modes on the command and on both MCP tools. In the app, the Library scope offers
  the three modes. The per-document panel stays `semantic`, because the find bar covers exact words
  in the open document. This is a deliberate scope reduction.
- Output bounds through `core/output/budget.ts` for every changed command and MCP search reply,
  and for the app's library reply.
- A measurement script and performance targets.
- An ADR and the documentation updates.

Out of scope:

- A vector extension such as `sqlite-vec` (a new package) and any per-process vector cache.
- Substring search with the `trigram` tokenizer.
- A query language beyond words and quoted phrases.
- A `forget` command or MCP tool.
- A library search box on the app's start screen.

## Proposed public contract

### Command line

```
markpdf search <query> (--path <pdf> | --id <hash> | --library)
               [--mode hybrid|semantic|exact] [--top-k <n>] [--min-score <n>]
```

Changes to the `search` entry of `cli/spec.ts` (`cli/spec.ts:127-151`):

- Add `library`, a boolean: "Search every indexed document you have granted, not one document."
- Add `mode`, a `choice` of `hybrid`, `semantic` and `exact`, with `default: defaultSearchMode`
  from `core/models.ts`: "Rank by meaning, by exact words, or by both."
- Change the `min-score` description to "Discard semantic matches scoring below this."
- Change `exactlyOneOf` to `["path", "id", "library"]`. The parser leaves an absent boolean unset,
  so the rule works without parser changes (`cli/parse.ts:295-308`, `:315-321`).

Rules, implemented once in core and used by the command, MCP and IPC:

- The adapters pass the raw optional `--min-score`. Core decides. An explicit `--min-score` with
  `--mode exact` is refused: "--min-score has no effect with --mode exact." The settings fallback
  applies only in `semantic` and `hybrid` mode.
- An `exact` query must contain a word. A query without one is refused: "The query has no words to
  match exactly." In `hybrid` mode such a query runs the semantic ranking only, and the reply says
  `exactQuery: null`.
- An `exact` query never loads or calls the embedder.
- Every search reply, single-document and library, carries `mode`.

Library JSON:

```json
{
  "command": "search",
  "scope": "library",
  "mode": "hybrid",
  "documentsSearched": 41,
  "documentsNotDiscoverable": 3,
  "documentsOutsideActiveScope": 2,
  "candidatesTruncated": false,
  "truncated": false,
  "omittedResults": 0,
  "omittedBytes": 0,
  "totalBytes": 5120,
  "results": [
    {
      "contentHash": "…",
      "name": "Lease 2024.pdf",
      "path": "/Users/me/Contracts/Lease 2024.pdf",
      "page": 12,
      "score": 0.0325,
      "semanticScore": 0.71,
      "matchedBy": ["semantic", "exact"],
      "headingPath": ["4 Payment"],
      "headings": [{ "title": "4 Payment", "page": 12 }],
      "headingInherited": false,
      "snippet": "…",
      "id": "…"
    }
  ]
}
```

- The single-document JSON keeps its fields and adds `mode`, `semanticScore`, `matchedBy`,
  `truncated`, `omittedResults`, `omittedBytes` and `totalBytes`.
- Both JSON shapes pass through the shared content and reply budgets. The human output renders the
  same bounded hit list, and a stderr note says when results were left out.
- Library human line: `Lease 2024.pdf  p12  0.033  semantic+exact  4 Payment`.

### MCP

- `search` gains `mode: propertyFromOption("search", "mode")`, and its result mapper adds `mode`,
  `semantic_score` and `matched_by`.
- New tool `search_library` with `query` (one shared hand-written constant with `search`), `top_k`,
  `min_score` and `mode`, each valued option from `propertyFromOption("search", …)`. No identity
  property, no `oneOf`, `additionalProperties: false`.
- Description: "Find the passages that answer a question across the indexed PDFs that MarkPDF
  read from a folder under a current read grant. Each hit names its document by content hash and
  name, with its page and headings. Reads the index only and never opens a file. Documents outside
  your read grants, or indexed by the app, are counted but not searched."
- `search_library` reply keys follow `mcp/operations.ts:305-329`:

```json
{
  "mode": "hybrid",
  "indexSnapshot": true,
  "documentsSearched": 41,
  "documentsNotDiscoverable": 3,
  "documentsOutsideActiveScope": 2,
  "candidatesTruncated": false,
  "truncated": false,
  "omittedResults": 0,
  "omittedBytes": 0,
  "totalBytes": 5120,
  "results": [
    {
      "contentHash": "…",
      "name": "Lease 2024.pdf",
      "page": 12,
      "heading_path": ["4 Payment"],
      "headings": [{ "title": "4 Payment", "page": 12 }],
      "heading_inherited": false,
      "snippet": "…",
      "score": 0.0325,
      "semantic_score": 0.71,
      "matched_by": ["semantic", "exact"],
      "chunk_id": "…",
      "snapshotRecordedAt": "2026-10-30T09:12:44.000Z"
    }
  ]
}
```

- The reply gives no file path. An agent continues with `read_pages` by `id`.
- `indexSnapshot: true` means that the reply comes from the index, not from the current file. Each
  hit carries its document's `snapshotRecordedAt` from `chunksWrittenAt`
  (`core/store/index.ts:932-949`), read in the same database snapshot as the ranking.
- `RUNNERS` gains `search_library` (`mcp/server.ts:34-48`). The access class is `index-only`.

### App

- The Semantic Search pane gets a scope switch, "This document" and "Library", and in the Library
  scope a mode switch, "Both", "Meaning" and "Words". The defaults are "This document" and "Both".
- Library state belongs to the app, not to a tab: query, mode, results, loading, error and its own
  request id. The Library scope does not depend on the active tab's index status. A Library search
  works when the active PDF is not indexed.
- A response is dropped when the query, scope, mode or settings changed after its request. The
  request id is the check.
- The request carries `query`, `mode`, `chunkingProfile`, `minScore` and `topK`. The parser
  `parseLibrarySearchRequest` allows `topK` from 1 to 100 and refuses control characters.
- The reply passes through the shared content and reply budgets, with the same omission fields.
- Each result shows the document name, page, snippet, a "words" marker when `matchedBy` includes
  `exact`, and `semanticScore` with two decimals when it is not null.
- A click uses a pure rule, `libraryHitTarget(tabs, hit)`:
  1. A tab whose `semanticContentHash` equals the hit's hash: switch to it, then set the page and
     highlight.
  2. A hit with a path and no such tab: open the path through `openFilePaths`
     (`src/App.tsx:1207-1240`) with a pending page and highlight for the new tab. A failed open
     clears the pending target and shows "This document is in the index, but its file is not at
     <path>."
  3. A hit without a path: show "This document is in the index without a file path."
- New IPC, changed together: `semantic:search-library` in `electron/main.ts` and
  `electron/semantic.ts`, the bridge in `electron/preload.ts`, the declaration in `src/global.d.ts`,
  and the parser in `core/ipc/requests.ts`.
- When a file changed after it was indexed, the page and highlight can miss. This is a known limit.

## Consent decision

### The question

A search of one named document needs no permission, also after the grant is removed
(`docs/adr/2026-08-23-Command-Line-Consent-And-Contracts.md:156-157`). Library search changes the
exposure. Today an agent must know a path or a hash. With library search, one broad query lists
passages from every document that the search can see.

### Options

| Option | Rule | For | Against |
| --- | --- | --- | --- |
| A. Index is consent | Every surface searches every indexed document | Matches the current ADR | A removed grant does not limit discovery. Agents discover documents that were never granted |
| B. Grant filter everywhere | Every surface searches only granted documents | One rule | Restricts the person in the app, who has no consent gate, and gives agents no extra restriction over C |
| C. Per surface, with provenance (chosen) | The app searches every indexed document. Agents discover only documents with a resolved path inside a current read root | Agent discovery follows the person's current grants. No filesystem call | Two rules to explain |
| D. Library roster | A new consent record lists folders for library search | Explicit | A second consent model |

### The rule

- `documents.path_provenance` records how the path was obtained. The value `resolved` means that
  the writer resolved the path through `requireAccess` and read the bytes from that resolved path.
  Any other writer stores `NULL`.
- The command's index run writes `resolved`. The app and every bytes request write `NULL`. The
  value is written with `file_path` on every upsert, so a later app write of the same document
  removes it.
- Rows written before version 5 have `NULL`. A person makes them discoverable again with
  `markpdf index <folder> --recursive`. That run reuses the index and records the provenance
  (`core/index/indexPdfDocument.ts:122-140`).
- The check compares the stored path with each canonical read root through `containsPath`. It makes
  no filesystem call and never calls `isAllowed` or `requireAccess`.
- The reply gives `documentsNotDiscoverable` as a number, without names or paths. The number reveals
  how many other documents the index holds. I accept that, because it explains an empty answer and
  gives the remedy. The command prints the remedy on stderr.
- Option C restricts discovery. It does not change access to a known document. A single-document
  search and `read_pages` by hash still work after a grant is removed, as the consent ADR records.
  `cli/journeys/consent.test.ts:63` stays green.
- MCP has no option that widens the rule.

## Exact-word index

### Schema version 5

```sql
ALTER TABLE documents ADD COLUMN path_provenance TEXT;

-- A stable integer key for each chunk. VACUUM can renumber an implicit rowid.
CREATE TABLE chunk_text_keys (
  fts_rowid INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE
);

CREATE VIRTUAL TABLE chunk_text_fts USING fts5(
  text,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER document_chunks_text_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO chunk_text_keys(chunk_id) VALUES (new.id);
  INSERT INTO chunk_text_fts(rowid, text)
    VALUES ((SELECT fts_rowid FROM chunk_text_keys WHERE chunk_id = new.id), new.text);
END;

CREATE TRIGGER document_chunks_text_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM chunk_text_fts
   WHERE rowid = (SELECT fts_rowid FROM chunk_text_keys WHERE chunk_id = old.id);
  DELETE FROM chunk_text_keys WHERE chunk_id = old.id;
END;

-- Chunks are immutable. An update would need a key that a legacy row does not have yet.
CREATE TRIGGER document_chunks_immutable BEFORE UPDATE OF id, text ON document_chunks BEGIN
  SELECT RAISE(ABORT, 'document_chunks id and text are immutable');
END;
```

Notes:

- The key table has no foreign key. The delete trigger owns the key row, so the rule does not depend
  on `foreign_keys` (`core/store/index.ts:456-457`).
- `schema_meta` (`core/store/schema.ts:29`) gets three keys: `exact_index_state`
  (`complete` or `backfilling`), `exact_index_cursor`, and `exact_index_erase_pending`.
- The DDL does not tokenize existing text. Its duration was not measured on its own. The backfill,
  which does the tokenizing, is in the measurement record.

### The upgrade protocol

Codex reproduced two faults (review finding 2). A second process that read version 4 before the
lock tried the DDL again. An old process that stayed open kept writing after the upgrade, and its
forget left words in the file.

1. Read the version inside the write transaction, not before it. A process that finds the work done
   does nothing. This also fixes the same race for versions 1 to 4.
2. For an existing file below version 5, take exclusive access first, with the same method as forget
   (`core/store/index.ts:775-807`). If another connection is attached, refuse with
   `StoreUpgradeBusyError`, change nothing, and say: "MarkPDF must upgrade its index, but another
   MarkPDF window, command or agent session has it open. Close them and try again." The command maps
   it to exit 9, index busy.
3. A brand-new file (version 0) needs no exclusive access. No older process can have it open with
   its old rules.
4. Install the version 5 DDL and stamp the version in the same transaction.

### Backfill of documents that are already indexed

- `store.backfillExactIndexBatch(limit)` runs one `IMMEDIATE` transaction. It reads the cursor, a
  pair of `document_id` and chunk `id`. It reads the next `limit` chunk rows in that order, adds a
  key row and an index row for each row without a key, and moves the cursor. The default `limit`
  is 500 chunks.
- When a batch reaches the end, the same transaction checks for any chunk without a key. When there
  is none, it writes `complete`. When there is one, it resets the cursor, and the next batches
  repair all gaps in the same bounded way.
- When the state is already `complete`, a batch does nothing. Clear sets `complete`.
- `completeExactIndex(store, { signal, yieldControl, onProgress })` calls batches until `complete`.
  It checks the signal and awaits `yieldControl` between batches, so cancellation and progress can
  run.
- Who runs it:
  1. The app's main process. One shared job, registered with the job registry, starts after the
     store opens. A library search awaits the same job. Clear drains it
     (`core/index/clearIndex.ts:13-17`), and quit cancels it.
  2. The command and MCP, before an `exact` or `hybrid` search, when the state is not `complete`.
     The command shows progress on stderr. MCP sends progress notifications when the client gave a
     token (`mcp/operations.ts:40-41`).
- Two processes can run batches at the same time. The cursor is read inside each write transaction.

### Forget and clear

Probes P2 to P4 and the Codex probes show that deleted rows can leave their words in FTS5 segment
records. Secure delete and `VACUUM` alone did not remove them. FTS5 `optimize` did.

- `removeDocument` and `wipe` set `exact_index_erase_pending` in their own transaction.
- `forgetDocument`, inside exclusive access:
  1. Remove the document, if it exists.
  2. If the erase flag is set, run `optimize`, then the existing `reclaimSpace`.
  3. Clear the flag and run one more checked checkpoint.
- A crash or a failure after step 1 leaves the flag set. The next forget or clear, also for a
  document that no longer exists, finishes the erase before it reports success.
- `clear` runs `delete-all` on the FTS table, then the same steps.
- The existing refusal before deletion stays (`core/store/index.ts:762-775`).

## Query handling for exact words

`buildExactMatch(query)` in `core/index/exactQuery.ts` returns an expression or a refusal:

1. Refuse a control character, including NUL, with "The query contains a control character."
   Codex showed that NUL makes FTS5 fail even inside quotes.
2. Refuse a query longer than 1,000 characters or with more than 32 parts.
3. Split into quoted phrases and bare words. An unmatched quote is a normal character.
4. Drop each part that has no token character. The rule matches the `unicode61` tokenizer and is
   checked against real FTS5 in the tests.
5. Write each part in double quotes with each inner `"` doubled. Join the parts with spaces, which
   FTS5 reads as AND. Bind the result as a parameter.
6. Return "no words" when no part is left.

| Input | Expression |
| --- | --- |
| `clause 4.2(b)` | `"clause" "4.2(b)"` |
| `"net 30" invoice` | `"net 30" "invoice"` |
| `text:secret` | `"text:secret"` |
| `NEAR(a b)` | `"NEAR(a" "b)"` |
| `say "hi` | `"say" """hi"` |
| `() --` | no words |
| `abc\u0000def` | refused |

"Exact" means exact words. The tokenizer folds case and removes diacritics. A phrase matches
consecutive tokens, so "clause 4.2(b)" also matches "Clause 4-2 b".

## Ranking and modes

All reads of one library search run in one deferred read transaction: candidate documents, both
rankings, the text of the selected hits, and `chunksWrittenAt`. The query embedding runs before it.
This is the rule of `readReusableIndex` (`core/store/index.ts:813-823`).

### Candidate set

1. Documents: for each recorded path, the row with the latest `last_opened_at`, then the highest
   `id` (`core/store/index.ts:1066-1071`). Each row without a path counts on its own. This selection
   runs first, so a newer version that a later step excludes cannot bring back an older one.
2. Command and MCP: keep rows with `path_provenance = 'resolved'` inside a current read root.
3. Active scope: a chunk is eligible when it has the active profile and version and an embedding with
   the active model, model version and dimensions. Both rankings use this rule, through `EXISTS` on
   `chunk_embeddings` in the exact ranking. A document with no eligible chunk counts in
   `documentsOutsideActiveScope`.

### Rankings

- Semantic: pass one reads `chunk_id` and `vector` only and keeps the best `depth` candidates. Pass
  two reads text and headings for those. The cosine stays a full cosine (`core/store/vector.ts:27-31`).
  `minScore` filters before fusion. Order: score descending, then chunk id.
- Exact:

```sql
SELECT c.id, c.document_id, bm25(chunk_text_fts) AS rank
  FROM chunk_text_fts
  JOIN chunk_text_keys k ON k.fts_rowid = chunk_text_fts.rowid
  JOIN document_chunks c ON c.id = k.chunk_id
 WHERE chunk_text_fts MATCH :match
   AND c.chunking_profile = :profile AND c.chunking_version = :version
   AND c.document_id IN (SELECT value FROM json_each(:documentIds))
   AND EXISTS (SELECT 1 FROM chunk_embeddings e
                WHERE e.chunk_id = c.id AND e.model_id = :model
                  AND e.model_version = :modelVersion AND e.dimensions = :dimensions)
 ORDER BY rank, c.id
 LIMIT :depth;
```

### Fusion and depth

- `depth` starts at `min(400, max(50, 4 × topK))` for each ranking.
- `hybrid`: `fused(c) = Σ 1 / (60 + rank(c))`, rank from 1. Ties: a chunk in both rankings first,
  then the higher cosine, then the chunk id.
- `semantic`: cosine only. It embeds any query that is not empty after trimming, also a query with
  no words (`core/index/search.ts:81-82`). `exact`: `bm25` only.
- Library: at most `libraryHitsPerDocument = 3` passages from one document, then `topK`.
- When the list is shorter than `topK` and a ranking filled its `depth`, double `depth` and rank
  again, up to 1,600. When a ranking still fills 1,600, set `candidatesTruncated: true`.
- Single-document search uses the same function with one document and no cap, and keeps page order
  (`core/store/index.ts:1008-1013`). A library list stays in rank order.

| Field | `semantic` | `exact` | `hybrid` |
| --- | --- | --- | --- |
| `score` | Cosine | `-bm25`, higher is better | RRF value |
| `semanticScore` | Cosine | `null` | Cosine, or `null` |
| `matchedBy` | `["semantic"]` | `["exact"]` | One or both |

## Output bounds

- `boundSearchReply` in `core/output/searchReply.ts` takes the hits, the fixed fields and a render
  function. It runs `boundItems` on the document text of each hit (snippet, heading titles, document
  name and path), then `fitReply` on the finished JSON.
- It is used by: the command's single-document and library JSON, MCP `search_library`, and the app's
  library IPC reply. MCP `search` keeps its own two-step code and adds the new fields.
- The command's human output renders the bounded hit list from the same call.

## Performance at library scale

### Probe results (indicative)

| Chunks | Store size | Today's per-row work | Vectors only | FTS, two common words | FTS, rare word | Backfill, one statement |
| --- | --- | --- | --- | --- | --- | --- |
| 20,000 | 72 MB | 78 ms | 53 ms | 23 ms | < 1 ms | 144 ms |
| 100,000 | 357 MB | 420 ms | 279 ms | 111 ms | < 1 ms | 858 ms |

Warm cache, one machine, a 20-word synthetic vocabulary, no query embedding. At 100,000 chunks a
separate probe measured forget: `optimize` 1,065 ms and `VACUUM` 2,964 ms on a 436 MB file. That
probe used vectors in the chunk row and about 2,500 generated words, so its file is larger.

### Targets

| Size | Meaning | Target |
| --- | --- | --- |
| S, 10,000 chunks | About 100 PDFs | Hybrid p95 ≤ 150 ms |
| M, 100,000 chunks | About 1,000 PDFs | Hybrid p95 ≤ 500 ms. Exact p95 ≤ 200 ms. Backfill ≤ 3 s in total |
| L, 500,000 chunks | About 5,000 PDFs | Hybrid p95 ≤ 2.5 s. No backfill transaction over 250 ms |

These are store-level targets. They exclude the query embedding and are not an app responsiveness
guarantee.

### Measured result

`docs/records/2026-10-31-library-search-measurement.md` has the full table. The 10,000-chunk target is
met (hybrid p95 87 ms). Every target at 100,000 and 500,000 chunks is not met: hybrid p95 924 ms and
4.8 s, exact p95 322 ms at 100,000 chunks, backfill 7.8 s at 100,000 chunks, and the longest backfill
transaction 368 ms at 500,000 chunks. The scan by meaning sets the hybrid cost, and a fixed cost per
search grows with the library. One attempt to cut the fixed cost was slower in a partial second run
and is reverted. The next step is a decision for the user.

### Measurement plan

1. After the implementation, `scripts/bench/librarySearchBenchmark.mjs` was added. It follows
   `scripts/bench/chunkingBenchmark.mjs:1-16`: plain JavaScript against `dist-core/`.
2. The script writes stores through the production API at S, M and L, with skewed document sizes and
   a vocabulary of at least 20,000 words.
3. It reports p50 and p95 per mode for rare, common, multi-word and no-hit queries; the first query in
   a new process; backfill time and the longest backfill transaction; trigger overhead on writes;
   forget and clear time; store size with and without the exact index; and peak resident memory.
4. Run it with `heavy-run --label markpdf -- node scripts/bench/librarySearchBenchmark.mjs` after
   `npm run build:core`. Record the result in `docs/records/<date>-library-search-measurement.md`.
5. If a target fails, the next steps are a decision for the user. A per-process cache needs a local
   write counter in addition to `PRAGMA data_version`, because `data_version` does not change for the
   connection's own commits (review finding 14).

## Test plan

### Loop shape

This is a new cross-layer user capability. Each vertical capability starts with an outer
acceptance test that runs Red first. Inner loops drive the rules. Each capability ends Green after
refactor. When a first Red is a missing option or export, I add the minimum interface and run the
test again to reach a behavioral failure before the implementation.

### Capability 1: exact words in one document, on the command line

- Outer test: `cli/journeys/exactSearch.test.ts`. A three-page PDF has "clause 4.2(b) applies" on
  page 1, and "clause 2.4(b) applies" on page 2. `markpdf search "clause 4.2(b)" --path <pdf>
  --mode exact --json` returns one result, page 1, `matchedBy: ["exact"]`, `mode: "exact"`.
- The test embedder is a bag of words (`core/index/deterministicEmbedder.ts:4-10`), so only the phrase
  match separates the two pages.
- Inner loops: `core/index/exactQuery.test.ts` with each expression executed against real FTS5;
  `core/store/exactIndex.test.ts` for the triggers after every public write method, immutability and
  rowid reuse; the exact ranking's scope rule with mixed models in one document; `cli/parse.test.ts`
  and the core mode rule for `--min-score` with `exact`.

### Capability 2: forget and clear remove the exact-word index

- Outer test: extend `core/store/forget.test.ts`. Index three documents in three transactions with a
  long lowercase token in the middle one. Forget it. The file and its WAL do not contain the token,
  and `fts5vocab` has no row for it. A surviving document is still found by an exact search. The same
  for `clear`.
- Recovery test: delete a document's chunks while the erase flag is set, as a crash would leave it.
  `forgetDocument` of a missing hash then removes the token.

### Capability 3: an existing index is upgraded and backfilled

- Outer test: `core/store/exactIndexUpgrade.test.ts`. Write a version 4 file with its own DDL and
  real chunks. Open it with the new store. Run `completeExactIndex`. An exact search finds a word
  from before the upgrade.
- Inner loops: an attached second connection makes the upgrade refuse and change nothing; two
  connections that both saw version 4 upgrade once; one document larger than one batch; gaps below the
  cursor; cancellation between batches; clear during a backfill.

### Capability 4: hybrid ranking and modes through MCP `search`

- Outer test: extend `mcp/journeys/toolSession.test.ts`. On the same fixture, `search` with
  `mode: "hybrid"`, `top_k: 1` and `query: "clause 4.2(b)"` returns page 1 with `matched_by` that
  contains `exact`, and `mode: "hybrid"`.
- Inner loops: `core/index/fusion.test.ts` with hand-written RRF values and ties;
  `mcp/toolSchemas.test.ts` and `mcp/arguments.test.ts` for `mode`; the explicit-versus-absent
  `min_score` rule.

### Capability 5: library search on the command line and through MCP

- Outer test, command line: `cli/journeys/librarySearch.test.ts`. Grant folders A and B. Index one
  PDF in each. Write a changed version of the A file at the same path and index it again. Remove the
  grant for B. `markpdf search "<phrase>" --library --json` returns hits from the current A document
  only, `documentsNotDiscoverable: 1`, and nothing from the old A version.
- Outer test, MCP: in one session, `search_library` lists eight tools, returns hits from the granted
  documents in rank order with `contentHash` and no path, and stops returning a document after its
  grant is removed.
- Inner loops: `core/index/librarySearch.test.ts` for the latest row per path before the grant filter,
  the provenance rule, a pathless row, a stored path whose folder became a link to another folder (it
  stays discoverable, which proves that no path is resolved), the per-document cap and the depth
  expansion; `core/output/searchReply.test.ts` for long names, escaping, an oversized first hit and an
  empty list; `mcp/server.test.ts` for the reply budget.

### Capability 6: Library scope in the app

- Outer test: `tests/e2e/library-search.spec.ts`. Open and index two PDFs. Close the second. Switch the
  pane to Library and search for a phrase that only the second PDF has. Click the hit. The second PDF
  opens at the page with the passage highlighted.
- Inner loops: `src/libraryHitTarget.test.ts` for the three targets and the stale-response rule;
  `core/ipc/requests.test.ts` for `parseLibrarySearchRequest`.

### Test layers

| Rule | Layer |
| --- | --- |
| MATCH expression, mode rule, RRF, per-document cap, discovery, latest row per path | `core/**/*.test.ts` |
| Triggers, immutability, backfill, upgrade protocol, forget, clear | `core/store/*.test.ts` with real temporary files |
| Reply bounds | `core/output/searchReply.test.ts`, `mcp/server.test.ts` |
| Argument parsing, exit codes, JSON shape, stderr note | `cli/**/*.test.ts` and `cli/journeys/` |
| Tool schemas, argument checks, adapter rules | `mcp/**/*.test.ts` |
| Tool list and a real stdio session | `mcp/journeys/toolSession.test.ts` |
| IPC request parser | `core/ipc/requests.test.ts` |
| Hit target and stale-response rules | `src/libraryHitTarget.test.ts` |
| Library scope, open and highlight | `tests/e2e/library-search.spec.ts` |
| Retrieval quality with the real model | Deferred. An opt-in `npm run test:live` test needs the 133 MB model and a fixture with written ground truth |

### Mutation proofs for high-risk rules

| Rule | Mutation | Test that must fail |
| --- | --- | --- |
| Grant filter for agents | Return every document | Capability 5 command journey |
| Provenance rule | Ignore `path_provenance` | `core/index/librarySearch.test.ts` |
| No path resolution | Resolve the stored path with `realpathSync` | The linked-folder case |
| Latest row per path | Search every row | Capability 5 command journey |
| Forget erase | Remove `optimize` | Capability 2 forget case |
| Clear erase | Remove `delete-all` and `optimize` | Capability 2 clear case |
| Erase recovery | Clear the flag in the delete transaction | Capability 2 recovery test |
| Upgrade exclusivity | Skip exclusive access | Capability 3 attached-connection case |
| Version read under the lock | Read the version before the lock | Capability 3 two-connection case |
| Immutability | Drop the immutability trigger | `core/store/exactIndex.test.ts` |
| Delete trigger | Drop the trigger | `core/store/exactIndex.test.ts` |
| Backfill completion | Write `complete` without the gap check | Capability 3 gap case |
| Exact model scope | Remove the `EXISTS` clause | Mixed-model case |
| RRF fusion | Return the semantic ranking | Capability 4 outer test |
| Safe MATCH expression | Pass the raw query | `core/index/exactQuery.test.ts` |
| Reply bound | Skip `fitReply` | `core/output/searchReply.test.ts` |

## Crash and timing windows

| Window | Handling |
| --- | --- |
| Crash during the upgrade | One transaction. SQLite rolls it back |
| Old process attached during the upgrade | The upgrade refuses before any change |
| Two processes upgrade at once | The version is read under the lock. The second does nothing |
| Crash during a backfill batch | One transaction per batch, with its cursor |
| Index job during the backfill | The insert trigger indexes new chunks |
| Crash between forget's delete and its erase | The erase flag stays set. The next forget or clear finishes the erase |
| Clear during the app's backfill | The backfill is a registered job. Clear drains it first |
| A writer between the stages of a library search | One read transaction for all stages |
| Grant removed during a search | The allowlist is read once per call |

## Documentation and ADR

- New ADR `docs/adr/2026-10-31-Library-And-Exact-Word-Search.md`. The work needs one, because it
  changes the store schema, adds a derived index that consent withdrawal must erase, changes a
  consent consequence of an earlier ADR, and adds an MCP tool to a list an earlier ADR keeps small.
  It records the consent rule with provenance, the FTS5 design, the upgrade protocol, the erase rule,
  the ranking and the eighth MCP tool. Its Verification section names the tests above. It states which consequences of the two
  earlier ADRs it supersedes. The earlier ADRs keep their decision text.
- `README.md`: the MCP table (eight tools), the command usage, and what "exact" means.
- `skills/markpdf-retrieval/SKILL.md`: add the library route. The skill searches by hash
  (`skills/markpdf-retrieval/SKILL.md:14`) and by open-document ref (`:19`).
- `CHANGELOG.md`: entries for the completed work, under Added and Fixed.

## Falsification pass

| Assumption | Check | Result |
| --- | --- | --- |
| FTS5 is available in the bundled SQLite | Probe P1 | Holds |
| `VACUUM` keeps the rowid of `document_chunks` | SQLite documentation, probe P6 | Not guaranteed. The design uses its own integer key |
| Forget already removes all text | Probes P2 to P4, Codex probes | False for FTS5. The plan adds the erase rule |
| An app path fails the lexical check | Codex symlink probe | False. The plan adds path provenance |
| The triggers never meet an old writer | Codex probe with an open version 4 connection | False. The upgrade takes exclusive access |
| The update trigger is safe | Codex probe | False before backfill. Chunks are now immutable |
| Quoting makes any input safe | Codex NUL probe | False. Control characters are refused |
| One row per path | `core/store/index.ts:263-268` | False. The latest row is taken |
| A backfill inside the migration is safe at 500,000 chunks | Extrapolation from 858 ms at 100,000 | Not measured. The plan uses bounded batches |

## Probe evidence

All probes ran on 2026-10-31 with `better-sqlite3` 13.0.3 and SQLite 3.53.4, under Electron 39.8.10
(`ELECTRON_RUN_AS_NODE=1`). P1 also ran under Node 24.21.0.

| Probe | Result |
| --- | --- |
| P1 | FTS5, `secure-delete`, `contentless_delete` and `trigram` are available. `"4.2" "b"` and `"INV-2024-0042"` match |
| P2 | 50 chunks per document, three transactions: the token stayed after delete and `VACUUM`, with or without `secure-delete`. `optimize` removed it |
| P3 | 200 chunks per document, one transaction: `secure-delete` alone removed it. `optimize` removed it in every case |
| P4 | 50 chunks per document, one or three transactions: `secure-delete` alone left it. `optimize` removed it |
| P5 | Scale and forget cost, see "Probe results" |
| P6 | `VACUUM` kept the rowids of a `TEXT` primary key table in this run. SQLite does not guarantee it |

## Delivery order

1. Capability 1, with the version 5 schema, the triggers and the immutability rule.
2. Capability 2.
3. Capability 3.
4. Capability 4.
5. Capability 5.
6. Capability 6.
7. The measurement script and its record.
8. ADR, README, skill and CHANGELOG.

Before the merge: `npm test`, `npm run build`, the typecheck commands of AGENTS.md, `npm run test:e2e`
through `heavy-run`. There is no lint command in this repository.

## Implementation record

### Red and Green for each capability

| Capability | Outer test | First failure | Behavioral Red | Green |
| --- | --- | --- | --- | --- |
| 1. Exact words, command line | `cli/journeys/exactSearch.test.ts` | Exit 2: `--mode` was an unknown option | After the option was added: "expected undefined to be 'exact'" | Passes |
| 2. Forget and clear | `core/store/forget.test.ts`, three new cases | None needed: existing interface | The token was still in the file after forget, after clear and after an interrupted erase | 15 of 15 |
| 3. Upgrade and backfill | `core/store/exactIndexUpgrade.test.ts` | The backfill module was missing | With a stub: the exact search after the upgrade returned `[]` instead of `[1]` | 7 of 7 |
| 4. Hybrid through MCP `search` | `mcp/journeys/toolSession.test.ts`, new case | "mode is not an argument this tool takes" | After the schema property: "expected undefined to be 'hybrid'" | Passes |
| 5. Library, command line | `cli/journeys/librarySearch.test.ts` | Exit 2: `--library` was unknown | After the flag: exit 4, not indexed | Passes |
| 5. Library, MCP | `mcp/journeys/toolSession.test.ts`, two cases | Seven tools listed, `search_library` missing | Same | Passes |
| 6. App Library scope | `tests/e2e/library-search.spec.ts` | Timeout: no Library button | Same | Passes in 7.8 s |

Inner loops, each Red before Green: `core/index/exactQuery.test.ts` (15 assertion failures against a
stub, then 30 of 30), `core/store/exactIndex.test.ts` (11 failures against a stub, then 15 of 15),
`core/index/searchMode.test.ts` and `core/index/exactSearch.test.ts` (exact mode returned pages 1, 2
and 3 and embedded the query, then 11 of 11), `cli/commands.test.ts` (2 new failures, then Green),
`core/index/librarySearch.test.ts` (9 failures against stubs, then 9 of 9),
`core/output/searchReply.test.ts` (5 failures against a stub, then 6 of 6), `core/ipc/requests.test.ts`
and `src/libraryHitTarget.test.ts` (missing exports, then 31 of 31).

Two pieces of code were written before their tests: the upgrade protocol (in the schema step of
capability 1) and the hybrid branch of the fusion (in the semantic step of capability 1). For both,
the mutation that removes the rule is the Red evidence: the protocol tests and `core/index/fusion.test.ts`
fail under it and pass when the code is restored.

### Mutation results

| Rule | Mutation | Result |
| --- | --- | --- |
| Grant filter for agents | Allow every document | 3 core tests and the command journey fail |
| Provenance rule | Ignore `path_provenance` | 2 core tests fail |
| No path resolution | Resolve the stored path with `realpathSync` | The linked-folder test fails |
| Latest row per path | Search every row | 2 core tests and the command journey fail |
| Forget erase | Remove `optimize` | The forget and recovery tests fail |
| Clear erase | Remove `delete-all` and `optimize` | **Did not bite.** Deleting every row empties every FTS5 segment, so `secure_delete` and `VACUUM` remove the tokens anyway. Both steps stay as a second guard |
| Erase recovery | The delete does not record the owed erase | The forget and recovery tests fail |
| Upgrade exclusivity | Upgrade without exclusive access | The attached-connection test fails |
| Version read under the lock | Use the stale observation | The two-process test fails |
| Immutability | Drop the trigger | The immutability test fails |
| Delete trigger | Drop the trigger | The one-row-per-chunk test fails |
| Backfill completion | Write `complete` without the gap check | The gap repair test fails |
| Exact model scope | Remove the `EXISTS` clause | The mixed-model test fails |
| RRF fusion | Return the semantic ranking in hybrid mode | 2 fusion tests and the MCP journey fail |
| Safe MATCH expression | Pass the raw query | 13 builder tests fail |
| Reply bound | Skip `fitReply` | The escaping test fails |
| App ignores the per-document search in the Library scope | Remove the early return | At first the journey still passed: it asserted before the delayed search cleared the highlight. I added a check after the window settles. Now the journey fails under the mutation and passes restored |
| Hit target by content hash | Match any PDF tab | 3 rule tests fail |

### Defects and design problems that the tests found

- The existing forget sequence left the exact-word tokens of a forgotten document in the file.
- The first Electron journey asserted too early to see a highlight being cleared.
- Two older migration tests write a version 2 file without `schema_meta`. The version 5 step now
  creates that table when it is missing.
- The core boundary test forbids the identifier `document`, which my first library code used.
- A library test indexed documents without their cached text, so their scope was never claimed and
  `snapshotRecordedAt` was `null`. The fixture now stores the text, as real indexing does.

### Existing tests that changed, and why

- `cli/commands.test.ts` and `mcp/operations.test.ts`: the threshold-source tests now pass
  `mode: semantic`, because under the new `hybrid` default an exact match is not filtered by the
  threshold. This is the intended contract change.
- `cli/help.test.ts`: the synopsis now lists `--library`.
- `mcp/toolSchemas.test.ts` and `mcp/journeys/toolSession.test.ts`: eight tools.

### Verification

| Command | Result |
| --- | --- |
| `npm test` on an export of the base commit, through `heavy-run` | 117 files, 1,427 tests passed |
| `npm test` on the implementation, through `heavy-run`, 23:20 | 126 files passed, 2 failed: the help synopsis and the core boundary rule. Both fixed, and their files then passed (3 files, 31 tests) |
| `npx vitest run core` after later edits, 23:30 | 71 files, 1,005 tests passed. This run included the performance change that was later reverted |
| `npm run typecheck`, `typecheck:core`, `typecheck:cli`, `typecheck:mcp`, `typecheck:tests`, `npx tsc -p tsconfig.electron.json --noEmit` | All clean at 23:24, after fixing two type errors in new tests. Electron checked again clean at 23:32 |
| `npx playwright test tests/e2e/library-search.spec.ts`, `CI=1`, through `heavy-run` | Passed in 7.8 s |
| The six typecheck commands on the final code, 2026-11-01 00:28 | All clean |
| `npm test` on the final code, through `heavy-run` | 128 files, 1,538 tests passed, in 44.5 s |
| `npm run build`, through `heavy-run` | Passed. Vite built the renderer in 5.95 s |
| `npm run test:e2e`, all journeys, `CI=1`, through `heavy-run` | 37 passed, in 2.6 min |
| Lint | No lint command exists in this repository |

The user stopped all heavy runs from 23:51 to 00:28. The final runs above cover every edit made
before and during that pause.

### Documentation delivered

- `docs/adr/2026-10-31-Library-And-Exact-Word-Search.md`, with its Verification section.
- `docs/records/2026-10-31-library-search-measurement.md`.
- `README.md`: the command usage, `--library`, `--mode`, and the MCP table with eight tools.
- `skills/markpdf-retrieval/SKILL.md`: the library route and the exact mode.
- `CHANGELOG.md`: three entries under Added and two under Fixed.

### Deviations from the plan

- The opt-in retrieval quality test with the real model is not written.
- The Electron journey covers the main outcome. Switching to an open tab, a missing file and a
  pathless hit are covered by `src/libraryHitTarget.test.ts`, not by separate journeys.
- `migrateFrom` is exported so that a test can pass a stale observation of the version.
- If two new MarkPDF processes open an older index at the same moment, both can refuse the upgrade.
  Opening again succeeds. The ADR records this.

## Review disposition

Codex reviewed the plan at 22:33 on 2026-10-31. Its findings and my decisions:

| Finding | Decision | Reason and change |
| --- | --- | --- |
| 1. Option C does not fail closed for app paths | Accepted | Confirmed in code (`electron/main.ts:582-589`, `core/index/indexDocument.ts:269-272`). Added `path_provenance`, and agents discover only `resolved` rows. Disclosed that C restricts discovery, not access by hash, and that the count reveals inventory size |
| 2. Upgrade does not exclude old clients or recheck the version | Accepted | Confirmed (`core/store/schema.ts:80-108`). Added exclusive access for an existing file, a version read under the lock, and a typed busy refusal |
| 3. Backfill batches are unbounded and do not yield | Accepted | Batches are 500 chunks with a `(document_id, id)` cursor. `completeExactIndex` awaits an injected yield. Completion is checked in the same transaction |
| 4. The update trigger creates unmapped FTS rows | Accepted | Replaced it with an immutability trigger. No code updates chunks today |
| 5. Forget has a crash window between delete and optimize | Accepted | Added the erase flag, written with the delete, and recovery in forget and clear |
| 6. The exact SQL misses the model scope | Accepted | Added `EXISTS` on `chunk_embeddings`. Latest row per path runs first |
| 7. Multi-stage reads need one snapshot | Accepted | One deferred read transaction for all stages |
| 8. Quoting does not make NUL safe | Accepted | Control characters are refused, with limits, and each case runs against real FTS5. Exact mode does not embed |
| 9. Depth then cap can hide the library | Accepted | Depth doubles up to 1,600, `candidatesTruncated` reports the limit, and each ranking has stable ties |
| 10. App mode control and state ownership | Accepted in part | Added a mode switch to the Library scope and app-level library state with stale-response rejection. The per-document panel stays `semantic` as a documented scope reduction. One E2E journey covers the main outcome. The stale-response and target rules are pure tests, as AGENTS.md prefers for rule matrices |
| 11. Output bounds were narrowed | Accepted | The command's single-document and library JSON, the human output, `search_library` and the app library reply all use `budget.ts` |
| 12. Mode, score units and explicit min-score | Accepted, except the default | Every reply carries `mode`. The `min-score` text says "semantic". The adapters pass the raw value. I kept `hybrid` as the default, because the user told me to apply the recommended option. Every reply now states its mode |
| 13. Tests leave high-risk rules unproved | Accepted | Separate pages in the fixture, `top_k: 1` in the hybrid test, a linked-folder test for no path resolution, MCP revocation in one session, and the new mutation rows |
| 14. The cache fallback can serve stale data | Accepted | Removed the cache from the plan. The benchmark runs after the implementation and measures the longest transaction and memory |
| 15. Citations and ADR wording | Accepted | Corrected the skill citation, marked unmeasured claims, and the ADR supersedes consequences without editing the earlier decision text |

## Open questions for the user

The user asked for the recommended options. The section "Default decisions" records them. On
2026-11-01 the user decided that this work adds neither a new performance step, nor a package, nor a
start-screen search box. The two points stay open as follow-ups:

1. A library search box on the app's start screen.
2. What to do about the performance targets that failed at 100,000 and 500,000 chunks: a cheaper
   active-scope check, a cache with local write counters, a vector extension that needs a new
   package, or other backfill batch sizes. The measurement record lists them.
