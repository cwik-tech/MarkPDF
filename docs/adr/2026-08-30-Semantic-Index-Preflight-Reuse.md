# An unchanged document is recognised as indexed before it is read

## Status

Accepted.

## Context

`indexPdfDocument` read the document first and asked whether the work was needed second. The order
was not incidental: `readDocumentPages` ran the structural parse, rasterised every page the parse
could not read, recognised each of them, walked the drawing instructions of the pages it could read
looking for figures, and recognised those too — and only then did `indexDocument` compare the
resulting chunk identifiers against the stored ones and discover that nothing had changed
(`core/index/indexPdfDocument.ts` before this change; `core/index/indexDocument.ts:302`).

For a text-bearing report that costs a parse. For a scanned book it costs the whole recognition
pass, every time the document is opened, for a document whose index was already complete and whose
bytes were identical. On the 628-page book that prompted this, every open recognised 59 pages again
before concluding it had nothing to do.

The reuse check could not simply be moved earlier as it stood, because it is defined in terms of
the chunks the extracted text produces: it compares stored chunk identifiers against the ones this
run's text would generate, which is the correct test *after* extraction and no test at all before
it. Something else had to stand in for it, and the store already had the material:

- the content hash keys the document row;
- `text_extraction_version`, `ocr_extraction_version`, `markdown_engine` and `markdown_version`
  record how the stored text was produced (`core/store/index.ts`, the `documents` upsert);
- `document_markdown` holds the page-preserving cache, which `getMarkdown` refuses to serve unless
  it parses and covers every page of the document;
- `page_provenance` records what became of each page, so an empty page is distinguishable from a
  page nothing read; and
- `chunk_scope_snapshots` records that one exact searchable scope was written to completion —
  withdrawn by `beginChunkReplace` before a single chunk is cleared, and written by
  `markChunksComplete` only after the final batch commits.

## Decision

Add one read-only store query, `findReusableIndex`, and call it from `indexPdfDocument` after the
content hash and before `readDocumentPages`.

**The query answers one question and every clause of it is load-bearing.** A snapshot is returned
only when all of the following hold: the content hash matches; the text-extraction, OCR-extraction,
Markdown-engine and Markdown-version contracts on the document row equal the ones this build
produces; the cached Markdown parses and covers the document; that cache can say what became of
each page, and no page is recorded as one nothing could read; and a completion row exists for the
exact searchable scope — profile, chunking version, model id, model version and vector width.
Anything else is `null`, and the caller reads the document as it always did.

**The completion marker is the proof, and counting is not.** Chunks on disk are equally consistent
with a finished run and a run that stopped half way. The marker is not: it is withdrawn before a
replacement clears anything and written after the last batch commits. That is what makes the query
safe to run outside `indexDocument`'s per-document lock — a job racing this one either has
finished, in which case its result is the one being reused, or has withdrawn the marker, in which
case this misses and joins the queue behind it.

**That claim was false when this ADR was first written, and the writes had to be reordered to make
it true.** As accepted, `indexDocument` stored the new cache and its extraction versions *before*
calling `beginChunkReplace`. Both are committed transactions, so between them any other process
holding the index open could read a document row and cache describing the new reading of the file
while the completion marker still vouched for embeddings built from the old one — and a preflight
landing there would serve those old passages as though they were the new ones. The lock argument
above was therefore an argument about a marker that had not yet been withdrawn. Every path that
stores a new reading now withdraws the claim first: the rebuild, and the empty path below.

**A gap is outstanding work, so it is never reused.** A cache recording a page nothing could read
is refused outright. Serving it would make the gap permanent: the run that finally has a recogniser
would be answered from the cache instead of being allowed to use it, and every later open would
consult the same cache and reach the same conclusion. Refusing sends that open down the full read
path, which is exactly where the page gets recognised — so a document indexed without recognition
repairs itself the next time it is opened by something that has one. The same applies to a cache
that cannot account for its pages at all: a row written before provenance existed, or one that no
longer parses, is refused rather than guessed complete.

**A finished scope with nothing in it is still finished.** A blank document, or a scan that
recognised to nothing, produces no chunks — and it is the most expensive document to rediscover,
because finding out costs a full rasterisation and recognition pass. `indexDocument` records the
completion marker on that path too, so the answer is stored once. It gets there the same way the
rebuild does: it withdraws the previous scope and clears it, stores the new cache, and only then
records the empty scope as finished. Leaving the old scope in place — which is what an earlier
version of this decision did, marking complete only when the scope happened to be empty already —
left a completed marker over passages the current reading of the document no longer contains, and
a preflight would serve them against an empty cache.

**But an empty reading is only a fact when every page was accounted for.** A run that could not
read a page has discovered nothing about that page, so it must not throw away an index built when
something could. The empty path therefore replaces the scope only when no page is recorded as
unresolved; otherwise it stores its cache — where the gap is recorded, which is how the document
becomes repairable — and leaves the existing chunks and marker alone. Such a cache is refused by
the query anyway, on the unresolved-page rule above, so nothing stale can be served through it.

The query believes a zero-chunk scope **only when the cached text is empty on every page**: a scope
whose pages carry words and whose chunks have gone is damaged, not empty, and serving it would
report a searchable document with nothing in it. A document whose text merely produced no chunk — a
page holding one short label — is read again rather than served as empty, which is the conservative
side to err on. The caller reports such a hit as `empty`, the same word the full path uses, so
nothing downstream can tell whether the answer came from storage or from a fresh read.

**A full read brings the record up to date, so a document settles after one open.** The branch that
finds the stored chunks already identical to the ones this reading produces is where a document
arrives after a build raises an extraction version, or after a database is migrated from before
scope completion was recorded at all. It used to leave both alone: the cache kept saying the
document had been read the old way, and a migrated scope kept saying nothing about its completion,
so the preflight refused the document and the whole read repeated on every open, for ever. That
branch has just extracted the document, so everything it holds — the cache, its page outcomes, the
extraction versions beside them — describes the current reading, and it writes them unconditionally
rather than comparing versions to decide. That costs one row rewrite on a path that has just paid
for a parse, and it needs no new field on any type to work out whether the rewrite is due; the
cheap path is the preflight, which never reaches this function. The identity check the branch just
passed is also the strongest proof of a finished scope this program has, so it records completion
when none was recorded — only when the stamp is missing, because rewriting one that already stands
would move the moment the scope was written to a run that wrote nothing.

**A claim is checked when it is made and retracted by anything that could invalidate it.** The
marker was originally described as proof that a scope was finished, and across two processes it was
not. The application and the command line share one index file (`core/paths.ts`) and the queue that
keeps two jobs off the same document — `runExclusive` — lives inside a single process, so two runs
can rebuild one scope at once. Reproduced with two connections: both call `beginChunkReplace`, one
stores its text, the other writes its chunks and claims the scope, and the first one's last batch
then lands on top. The scope held `first-1`, `first-2` and `second-1`, a mixture neither run
produced, and the query served it as a finished index of three chunks.

Three rules, all of them schema-free and each inside the transaction that could break the invariant:

- `insertChunkBatch` retracts the scope's claim in the same transaction as the insert. A batch from
  a run that is still going therefore destroys any claim it lands on top of, so a mixture can never
  be left under one.
- `completeChunkScope` — which replaces `markChunksComplete` — reads the scope's stored identifiers
  inside its own transaction and compares them, as a set, against every identifier the completing
  run wrote. Not a count: two runs can leave exactly as many chunks as either expected. It answers
  rather than raising, because a second run indexing the same file is not an error.
- That same transaction writes the completing run's Markdown cache and page provenance, **and a
  claim is never published without it**. A claim vouches for the pairing of chunks and text, so a
  run holding only half of one has established nothing: publishing anyway would pair its chunks
  with whatever text happened to be stored, which on a document that has been read before is an
  earlier reading of it. `putMarkdown` retracts every claim over the document for the mirror case —
  a reading stored *after* a claim — which is why the claim is written last inside the completion
  transaction.

The three answers are `claimed`, `unclaimed` and `conflicted`, and the difference between the last
two is the difference between a caller that had nothing to bind and a scope that is no longer what
the caller built. `unclaimed` is ordinary: `indexDocument` accepts page text from callers that
cannot say where it came from, and those runs write searchable chunks and no claim.

**A refused claim is not a successful index.** `conflicted` reaches `indexDocument` on all three of
its paths — the rebuild, the branch that finds the stored chunks identical, and the empty path — and
each one raises `ConcurrentIndexError` instead of reporting `ready`, `reused` or `empty`. Every
member of `IndexStatus` describes a document this run indexed, and after a conflict the run has
nothing to describe: the scope holds chunks it did not write and it cannot tell whether they are
finished. The result union is unchanged; the error is the honest way to say the run did not
complete, and the document is fine either way — the next open reads it again.

Bounded batch writes are unchanged: each batch is still its own transaction with the embedding done
outside it. The cache an interrupted run leaves behind is still there for `read_pages` to serve;
what it no longer carries is a claim.

**The whole decision is taken from one snapshot.** The four questions are four statements, and
another process rebuilding the same document commits between them in the ordinary course of things.
Composed from two snapshots the answer can be one no database ever held — a completion marker read
from before a replacement began, over a chunk count taken half way through it. The lookup therefore
runs inside a deferred `db.transaction`, which is a read transaction: it takes no write lock, and
SQLite holds the read view established by its first statement until it commits.

**The extraction versions are stamped with the cache, not before it.** The preflight decides from
`text_extraction_version` and `ocr_extraction_version`, so those columns have to describe the text
that is actually stored. They used to be written by `upsertDocument` at the start of a run, before
the extraction they describe was cached, so a run interrupted in between left a row claiming a
newer reading of the document than the cache underneath it — and after a version bump the next open
would then reuse the older extraction instead of redoing it. `putMarkdown` now writes them in the
same transaction as the cache row, beside the engine stamp that was already written there for the
same reason. A caller that **omits** them preserves whatever is recorded, so the callers that cache
Markdown without extraction provenance are unaffected; a caller that supplies one has to supply a
real version, and `UNKNOWN_EXTRACTION_VERSION` is refused rather than read as "I did not say".
Omission is the only way to say nothing. No column was added: the values move to a different
statement, not to a new place.

**`force` bypasses the preflight entirely.** A caller passing `force` is saying it does not trust
what is stored; answering it from what is stored would be the one thing it asked not to happen.

**The reuse branch still records where the file was opened from.** It is the only write on the
path, and it is the same `upsertDocument` the reuse branch inside `indexDocument` has always
performed. Path lookups (`core/index/documentLookup.ts`, used by `markpdf search --path` and the
MCP tools) read `file_path` from this row and rank rows by `last_opened_at`, so a reuse that wrote
nothing would answer a renamed file with a stale row — or, where a path has been indexed twice with
different bytes, with the wrong document. The write happens after the last cancellation check, so a
cancelled job still writes nothing at all.

**The scope is defined once.** `activeChunkScopeContract` in `core/index/search.ts` produces the
five fields that decide which stored chunks answer a search, and `searchChunkScope` is now built
from it. The preflight asks about the same contract a search reads under, so the two cannot drift.

**Nothing here loads the model.** The embedder is consulted for its identity and its output width,
both available before any weights are fetched, because an already-complete index must not trigger a
133 MB download to be recognised as complete.

## Consequences

- Opening an unchanged, completely indexed document costs a content hash and a handful of indexed
  SQLite lookups. Nothing is parsed, rasterised, recognised, chunked or embedded.
- Figure recognition on a first index is unaffected. Pictures on readable pages are still read the
  first time a document is indexed; the preflight only decides whether that first index has already
  happened.
- A document with a page nothing could read keeps costing a full read on every open, and that is
  the point: it is the only way the page ever gets recognised. Once something reads it, the
  document becomes reusable like any other.
- A row that predates the Markdown cache or its page provenance always misses, so those documents
  keep taking the full path until a run repairs them. That is the intended direction: the cheap
  answer is only available to documents that can prove they deserve it.
- After a build raises `TEXT_EXTRACTION_VERSION`, or after a database is migrated from before scope
  completion existed, a document costs exactly one more full read. That read brings the record up to
  date and the open after it is free. Before this correction the record was left as it was and the
  document was read in full for ever.
- A document that now reads as empty loses the passages of its previous reading, which is the
  intended direction — the index describes the current reading of the file, not an older one — but
  it is a deletion, and it happens on the strength of one extraction. The guard is that it only
  happens when every page was accounted for; a page nothing could read leaves the previous index in
  place.
- The empty path now clears and re-stamps a scope that was already empty and finished. Two writes
  where none were needed, on a document that has nothing in it. Cheap, and it keeps one rule for the
  whole path rather than a special case that has to be got right twice.
- A run that reaches the reuse branch may record a completion stamp dated now for chunks written
  earlier — a database migrated from before completion was recorded has no earlier date to use. The
  stamp says when the scope was established as complete, which is what was recorded, and it is
  written only when none exists.
- Two runs indexing one document at once now leave it with no claim rather than a false one. Both
  finish, both write, the scope holds whatever the later writer added, and the next open reads the
  document again and rebuilds. Nothing serialises the two runs — this makes the outcome safe, not
  orderly — and a document being indexed from two places is read more often than one that is not.
- The run that loses that race reports a failure. In the window the app displays "Index failed" for
  a document another process may have just indexed perfectly well, and the reader's remedy is to
  open it again. That is the deliberate trade: a rare, self-clearing false alarm in place of a
  routine false claim of readiness.
- A run that supplies page text without saying where it came from — no production surface does, but
  `indexDocument` accepts it — leaves its chunks searchable and publishes no claim at all, so such
  a document is read in full on every open. There is nothing to bind, and binding the text that
  happens to be stored would be inventing provenance.
- A claim is retracted whenever the document's text is stored again, including by a run under a
  different chunking profile or embedding model, because the cache is keyed to the document. Those
  other scopes keep their chunks and re-establish their claims the next time they are read in full.
- Atomicity across the four reads is argued from SQLite's transaction semantics and cannot be
  demonstrated by a test in this repository: forcing another connection to commit *between* two of
  the reads would need a hook inside the store, and adding one to observe the property would be
  worse than the property is worth. The tests cover what is observable — an uncommitted replacement
  on a second connection is invisible, the committed one is seen whole, and no transaction is left
  open afterwards.
- A cache row damaged outside this program — truncated Markdown, unreadable provenance, a
  `text_source` this program does not write — is a miss rather than an error. Refusing to open a
  document over a damaged sidecar would be a worse answer than reading it again.
- The check is cheap enough to be unconditional, so there is no setting and nothing for a reader to
  configure.

## Alternatives considered

- **Leaving the marker as a bare stamp and serialising indexing across processes.** That is a lock
  over a shared file, with the crash-recovery question that comes with one, and it would have to be
  held for the length of a full OCR pass. Making the claim checkable is cheaper and does not depend
  on every writer being well behaved.
- **Recording the completing run's cache identity in the marker row.** It needs a column, and the
  brief forbids a migration. Writing the cache inside the completion transaction gets the same
  binding out of the rows that already exist.
- **Comparing `document_markdown.created_at` against `chunks_written_at` at read time.** No schema
  change either, and no extra writes, but it turns a correctness rule into a timestamp comparison:
  two writes inside one clock tick compare equal, and the store's injected test clock is constant,
  so the check would be inert exactly where it is asserted.

- **Moving the existing chunk-identifier comparison earlier.** Not possible: it is defined against
  the chunks this run's extracted text produces, and before extraction there is no such text.
- **Trusting a chunk count.** Rejected, and the reason is already written into `indexDocument`:
  extraction is not deterministic, so the same total can describe a different set of chunks. A
  count also cannot distinguish a finished write from an interrupted one.
- **Trusting the document row alone.** Rejected: the row is written before any chunk is embedded,
  so its existence says only that indexing started.
- **Persisting OCR per page so an interrupted recognition could resume.** A larger, separate change
  with its own storage question. This one makes a *completed* index free to reopen and leaves the
  interrupted case exactly where it was.
- **Reusing a document that still has a page nothing could read, and reporting it as incomplete.**
  Rejected after review: it is truthful about the page and permanently wrong about the document,
  because the cheap answer would be served to precisely the run that could have fixed it.
- **Rebuilding the query as one SQL statement instead of a transaction.** Also atomic, and it was
  the alternative considered. Rejected because the completeness rules for a cached document live in
  `getMarkdown`, and a single statement would have to restate them — one more place for the two to
  drift apart. A read transaction buys the same guarantee without a second copy.
- **A setting to skip figure recognition.** Rejected here: the expensive repetition was re-reading
  documents that were already indexed, not reading figures once. Turning off figure OCR would lose
  searchable text to save work that this change removes anyway.

## Verification

- The store query, its hit and each of its refusals: `core/store/reusableIndex.test.ts` — the exact
  hit, a document read or found blank throughout, a page nothing could read, unknown bytes, each
  extraction and Markdown contract, a missing cache, a cache with no page outcomes, unreadable
  provenance, a cache that no longer covers the document, a scope never marked complete, a scope
  whose replacement has begun, a marker with no chunks behind text-bearing pages, a finished scope
  whose pages hold no text, every wrong scope, and an unrecognised `text_source`.
- One snapshot, as far as it is observable: `core/store/reusableIndex.test.ts`, "sees only committed
  state, so a replacement another connection has not finished is invisible" and "leaves no
  transaction open, so the index can still be compacted afterwards".
- The journey through the pipeline: `core/index/indexPdfDocument.test.ts`, "reports the stored index
  as reused without reading or recognising a page", which replaces both the recognition seam and the
  embedder with ones that throw; "reads a document again when a page was never resolved, so
  recognition can repair it"; "answers for a document with nothing on its pages without reading it
  again"; "still records the file the document was opened from, so a path finds it"; "reads the
  document again when the caller forces a rebuild"; "reads the document again when the chunking
  profile is not the one that was stored"; and "writes nothing and starts no reading when the caller
  cancels before the preflight".
- The finished-empty scope and its safety rule: `core/index/reuseIdentity.test.ts`, "records the
  scope as finished, so a document with nothing on its pages is not read again", "replaces a
  finished scope whose document now reads as empty, so its old passages cannot be served", and
  "keeps a finished scope when the empty reading is only a page nothing could read". (The name
  cited here before — "does not call the scope finished while chunks from an earlier reading are
  still in it" — was replaced when the empty path started clearing rather than skipping, and this
  entry was left pointing at a test that no longer exists.)
- Extraction versions written with the cache: `core/index/reuseIdentity.test.ts`, "does not advance
  them until the cache they describe has been written" and "advances them with the cache when the
  run completes"; `core/store/markdownCache.test.ts`, "stamps the extraction versions in the same
  write as the text they describe", "leaves the recorded versions alone when the caller does not say
  how the text was read", "records no new version when the cache itself is refused", and "refuses a
  version that is not a positive whole number, and stores nothing".
- Write ordering, the empty path and the settling read: `core/index/reuseIdentity.test.ts`,
  "withdraws the old scope's claim before the new extraction becomes visible" — which watches a
  second connection to the same file at the moment the new cache is stored — "replaces a finished
  scope whose document now reads as empty, so its old passages cannot be served", and "keeps a
  finished scope when the empty reading is only a page nothing could read";
  `core/index/indexPdfDocument.test.ts`, "brings a document read by an older build up to date, so
  the open after that reuses it" and "records completion for chunks an older build wrote before
  completion was recorded".
- The cross-process protocol: `core/store/reusableIndex.test.ts`, "refuses a scope two runs wrote
  into, even though one of them claimed it complete" — two real connections, interleaved as two
  processes interleave — "refuses to claim a scope that does not hold exactly the chunks the run
  wrote", "writes the completing run's text with its claim, so an earlier run's text cannot be
  paired with its chunks", "publishes no claim for a run that cannot say what text its chunks came
  from", and "withdraws the claim when the document's text is written again".
- A refused claim is not reported as success: `core/index/reuseIdentity.test.ts`, "reports a conflict
  instead of ready when another run replaced the scope it rebuilt", "…instead of reused when another
  run replaced the chunks it matched", "…instead of empty when another run wrote chunks into the
  scope it emptied", and — the other side of the rule — "is not a conflict when the run simply has
  no text to bind, and its chunks stay searchable". The first three drive a second connection's
  rebuild through the store at the instant the run tries to publish.
- Mutation proof: disabling the extraction-version clause failed "refuses text read by a different
  extraction version"; accepting a missing completion marker failed "refuses a scope that was never
  marked complete"; allowing a snapshot with an unresolved page failed both the store's refusal test
  and the pipeline's repair test; removing the `force` bypass failed the force test; removing the
  identity write failed the path test; stamping the extraction versions on the document upsert again
  failed the interrupted-upgrade test; and leaking the read transaction failed the compaction test.
  Restoring the old write order failed the second-connection ordering test; dropping the empty
  path's replacement failed the emptied-scope test; clearing regardless of unresolved pages failed
  the gap test; not recording the emptied scope failed three tests across both files; ignoring a
  record that describes another reading failed the older-build test; and not recording completion in
  the reuse branch failed the migrated-scope test. Dropping the batch retraction, comparing chunk
  counts instead of identities, not writing the completing run's text, and letting a new reading
  leave claims standing each failed exactly one of the four cross-process tests. Letting a claim be
  published without the text it was built from failed the cacheless-claim tests at both layers, and
  ignoring a refused claim failed all three conflict tests. Each was restored and rerun green.
