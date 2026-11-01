import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { semanticIndexPath } from "../paths.js";
import { CURRENT_SCHEMA_VERSION, migrate, type MigrationReport } from "./schema.js";
import { SchemaTooNewError, StoreDataError, StoreUpgradeBusyError } from "./errors.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "./vector.js";
import { indexSizeOnDisk } from "./size.js";
import { withExclusiveAccess } from "./exclusive.js";
import {
  parsePagePreservingMarkdown,
  renderPagePreservingMarkdown,
  type MarkdownPageRecord,
} from "./markdownDocument.js";
// Type only, and erased at build. The meanings live where the reader decides them, so the store
// records the same vocabulary rather than inventing a parallel one that could drift.
import type { PageStatus } from "../extract/readDocumentPages.js";
import {
  asRow, countFrom, parseHeadingEntries, pragmaInteger, pragmaText,
  requireBlob, requireInteger, requireNullableString, requireString,
} from "./rows.js";
import type { HeadingEntry } from "./rows.js";

export type { HeadingEntry } from "./rows.js";

export { SchemaTooNewError, StoreDataError, StoreUpgradeBusyError, CURRENT_SCHEMA_VERSION };
export type { MigrationReport };

/** Rows committed per transaction. Bounds WAL growth and the write lock held per commit. */
const INSERT_BATCH = 512;
/** Milliseconds a statement waits for a competing writer before reporting SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

export type TextSource = "pdf" | "ocr" | "mixed" | "none";

/**
 * How a document's recorded path was obtained.
 *
 * `resolved`: the writer resolved the path through the consent check and read the bytes from that
 * resolved path. Nothing else is recorded — `null` means nobody vouched for it, which is the honest
 * value for a path the app passed along unresolved, a path sent beside bytes, and every row written
 * before this column existed.
 */
export type PathProvenance = "resolved";

export interface UpsertDocumentInput {
  contentHash: string;
  name: string;
  filePath: string | null;
  /**
   * Written with `filePath` on every upsert, absent meaning `null`. A later writer that cannot vouch
   * for its path therefore removes an earlier `resolved`, because the path it describes is gone.
   */
  pathProvenance?: PathProvenance;
  fileSize: number;
  pageCount: number;
  textSource: TextSource;
  /**
   * How the page text was produced, if the caller knows.
   *
   * `UNKNOWN_EXTRACTION_VERSION` (0) means it did not say. On an existing row a 0 preserves
   * whatever is recorded rather than downgrading it, so a caller that does not know cannot erase
   * what a caller that did know wrote.
   */
  textExtractionVersion: number;
  ocrExtractionVersion: number;
  markdownEngine: string | null;
  markdownVersion: number | null;
}

export interface StoredDocument {
  id: number;
  contentHash: string;
  name: string;
  filePath: string | null;
  pathProvenance: PathProvenance | null;
  pageCount: number;
  textSource: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ChunkScope {
  documentId: number;
  chunkingProfile: string;
  chunkingVersion: number;
  modelId: string;
  modelVersion: string;
  dimensions: number;
}

/**
 * What a run has to show before its scope may be called finished.
 *
 * The identifiers are every chunk the run wrote, and the only ones the scope may hold. The cache is
 * the text they were built from, written with the claim rather than before it — see
 * `completeChunkScope`. Without it there is nothing to claim: a claim is a statement about a
 * pairing, and a run holding only half of one has not established anything.
 */
export interface ScopeCompletion {
  chunkIds: readonly string[];
  cache?: MarkdownCacheInput;
}

/**
 * What became of a run's attempt to publish its scope.
 *
 * - `claimed` — the scope held exactly this run's chunks, its text was written beside them, and the
 *   claim now stands. This is the only outcome a preflight can act on.
 * - `unclaimed` — the run had no text to bind, so nothing was published and nothing was disturbed.
 *   An ordinary outcome for a caller that was handed page text without being told where it came
 *   from; its chunks are written and searchable, and only the reuse claim is missing.
 * - `conflicted` — the scope no longer holds what this run wrote, because another run rebuilt the
 *   same document while it was working. Nothing is written. The caller cannot vouch for what is
 *   there, and neither can this store.
 */
export type ScopeCompletionOutcome = "claimed" | "unclaimed" | "conflicted";

/**
 * A searchable scope without the document it applies to.
 *
 * Travels as one value so that a caller asking about a document it has not identified yet cannot
 * drop a clause on the way: the profile, the chunking version, the model, its version and its
 * output width decide together which stored chunks answer a search, and four out of five is a
 * different scope rather than a near miss.
 */
export type ChunkScopeContract = Omit<ChunkScope, "documentId">;

/** Everything that has to match before a stored index may be served instead of rebuilt. */
export interface ReusableIndexQuery {
  contentHash: string;
  textExtractionVersion: number;
  ocrExtractionVersion: number;
  markdownEngineId: string;
  markdownVersion: number;
  scope: ChunkScopeContract;
}

/**
 * What a reusable index says about itself.
 *
 * There is no field for pages nothing could read, because a snapshot carrying one is not
 * reusable: a gap is outstanding work, and answering from the cache that records it is what would
 * make it permanent.
 */
export interface ReusableIndex {
  documentId: number;
  pageCount: number;
  textSource: TextSource;
  chunkCount: number;
}

/** What became of one cached page. Mirrors `PageStatus`, which is where the meanings are written. */
export interface CachedPageProvenance {
  page: number;
  status: PageStatus;
}

export interface MarkdownCacheInput {
  engineId: string;
  markdownVersion: number;
  pages: readonly MarkdownPageRecord[];
  /**
   * How the text being cached was produced, when the caller knows.
   *
   * Recorded on `documents` in the same transaction as the cache row, because these columns
   * describe *this* text. Written any earlier and a run interrupted in between would leave a row
   * claiming a reading of the document that nothing had yet stored — and the next reader would
   * take a stale cache for a current one.
   *
   * **Omit them** to preserve whatever is recorded: a caller that does not know how its text was
   * produced must not erase what a caller that did know wrote. A version that is supplied has to
   * be a real one — a positive whole number — and `UNKNOWN_EXTRACTION_VERSION` is refused rather
   * than read as "I did not say", because a caller that names a version is making a claim and 0
   * is not a claim anything can be checked against.
   */
  textExtractionVersion?: number;
  ocrExtractionVersion?: number;
  /**
   * What became of each page, when the caller knows.
   *
   * Optional, because a caller that hands over text without knowing how it was produced cannot
   * honestly say. Absent is recorded as absent rather than as "all read": an empty page in a cache
   * with no provenance is a page whose emptiness nobody established, and the reader has to be able
   * to see that difference.
   */
  pageProvenance?: readonly CachedPageProvenance[];
}

/** A cache row, read back. `provenance` is `null` for a row written before it was recorded. */
export interface MarkdownCacheRecord {
  pages: MarkdownPageRecord[];
  provenance: CachedPageProvenance[] | null;
  createdAt: string;
}

export interface ChunkInsert {
  id: string;
  page: number;
  index: number;
  text: string;
  /** Stored as free-form JSON; the reader accepts this shape and the legacy list of titles. */
  headingPath: readonly HeadingEntry[];
  vector: Float32Array;
}

export interface ScoredChunk {
  id: string;
  page: number;
  snippet: string;
  score: number;
  /** Titles only, in the breadcrumb's order — the shape every caller had before provenance. */
  headingPath: string[];
  /** The same breadcrumb with each heading's page, or `null` for rows that predate it. */
  headings: HeadingEntry[];
}

/** One chunk an exact-word search matched, with its `bm25` rank: lower is better. */
export interface ExactCandidate {
  id: string;
  documentId: number;
  rank: number;
}

export interface ExactRankQuery {
  /** The scope a chunk has to be searchable under: its profile and version, and an embedding under this model. */
  scope: ChunkScopeContract;
  documentIds: readonly number[];
  /** A finished FTS5 expression from `buildExactMatch`. Never a person's raw text. */
  match: string;
  depth: number;
}

/** One chunk the ranking by meaning kept, with its cosine similarity to the query. */
export interface SemanticCandidate {
  id: string;
  documentId: number;
  score: number;
}

export interface SemanticRankQuery {
  scope: ChunkScopeContract;
  documentIds: readonly number[];
  queryVector: Float32Array;
  depth: number;
  minScore: number;
}

/** A chunk's text and position, read for the candidates a ranking kept. */
export interface StoredPassage {
  id: string;
  documentId: number;
  page: number;
  text: string;
  headings: HeadingEntry[];
}

/** What one backfill batch did. */
export interface ExactBackfillBatch {
  /** Chunks added to the exact-word index by this batch. */
  indexed: number;
  /** Chunks this batch looked at, indexed or already present. */
  visited: number;
  state: ExactIndexState;
}

/** Whether every stored chunk is in the exact-word index yet. */
export type ExactIndexState = "complete" | "backfilling";

export interface StoreInfo {
  sizeBytes: number;
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  schemaVersion: number;
}

/**
 * Facts about the opened database that a caller may need to surface. Core does not print:
 * `electron/` renders these in settings, the CLI renders them on stderr.
 */
export interface StoreDiagnostics {
  journalMode: string;
  /** True when write-ahead logging was unavailable, e.g. a network home directory. */
  concurrencyDegraded: boolean;
  /**
   * Read back rather than assumed. SQLite ignores `PRAGMA foreign_keys` inside a transaction,
   * and enforcement is per-connection, so setting it is not the same as having it. The cascades
   * that make document deletion complete depend on this being true.
   */
  foreignKeysEnforced: boolean;
  /**
   * Read back rather than assumed, for the same reason as foreign keys.
   *
   * With it on, SQLite overwrites freed content instead of leaving it in place. The byte-level
   * forget test cannot prove this pragma by itself — reclaiming space rewrites the whole file and
   * would remove the text either way — so the configured guarantee is asserted directly.
   */
  secureDeleteEnabled: boolean;
  migration: MigrationReport;
}

/** Injected so `created_at` and `last_opened_at` are deterministic under test. */
export type Clock = () => Date;

export interface OpenStoreOptions {
  dataDir: string;
  clock?: Clock;
}

export interface SemanticStore {
  readonly schemaVersion: number;
  readonly diagnostics: StoreDiagnostics;
  getDocument(contentHash: string): StoredDocument | null;
  /**
   * The stored index for these exact bytes, read this exact way, under this exact scope — or
   * `null`, meaning the caller has to read the document itself.
   *
   * Read-only, and deliberately narrow: it exists so that orchestration can ask one question
   * instead of assembling an answer out of raw columns and getting a clause wrong. Every clause
   * it checks is a way the stored snapshot could describe something other than the file in hand.
   */
  findReusableIndex(query: ReusableIndexQuery): ReusableIndex | null;
  /**
   * The document recorded at this exact path, if there is one.
   *
   * An exact match on the stored spelling, deliberately: normalising the argument would mean
   * touching the filesystem, and answering a search about an already-indexed document without
   * doing that is the whole point of this lookup.
   *
   * `file_path` is not unique — the upsert conflicts on `content_hash` — so re-indexing a file
   * whose bytes changed leaves more than one row at one path. The most recently opened wins,
   * with the row id breaking a tie. This returns the **latest indexed version** of that path and
   * makes no claim that the file on disk still matches it; verifying that would mean reading the
   * file, which this lookup exists to avoid.
   */
  getDocumentByPath(filePath: string): StoredDocument | null;
  upsertDocument(input: UpsertDocumentInput): StoredDocument;
  /**
   * Clear this document's chunks for the current scope and every superseded version.
   *
   * Paired with `insertChunkBatch` so that embedding — which is asynchronous and slow — never
   * happens inside a transaction. Reuse completeness remains derived:
   * `listIndexedChunkIds` is compared against the identifiers the document is expected to produce,
   * so a partial or differently-distributed set re-indexes on next open. Counting alone is not
   * sufficient — see `indexDocument`.
   *
   * The completion timestamp is withdrawn here and written only after the final batch, and it
   * **does** decide reuse: `findReusableIndex` treats it as proof that a scope was finished. That
   * is why callers withdraw it before they store a new reading of the document rather than after
   * — between those two writes anything else holding this file open can read whatever combination
   * they leave behind.
   */
  beginChunkReplace(scope: ChunkScope): void;
  /**
   * Claim that this exact searchable scope is finished, if it still holds exactly what the run
   * wrote — and bind the text it was built from to that claim.
   *
   * One transaction, and it answers rather than asserts — see `ScopeCompletionOutcome` for what
   * each answer means. Nothing is thrown for either refusal, because a second run indexing the same
   * file is not an error and neither is a caller that has no text to offer.
   *
   * **A claim is never published without `cache`.** It is the text these chunks were built from,
   * written in this same transaction, so a claim cannot end up standing over one run's chunks
   * beside another run's pages. A run that omits it gets `unclaimed`: the scope keeps whatever
   * state it was in and nothing becomes reusable off the back of a pairing nobody established.
   */
  completeChunkScope(scope: ChunkScope, completion: ScopeCompletion): ScopeCompletionOutcome;
  /** The completion time for this exact searchable scope, or null for legacy/incomplete rows. */
  chunksWrittenAt(scope: ChunkScope): string | null;
  /**
   * Add embedded chunks to a scope, and retract any claim that the scope is finished.
   *
   * The retraction is part of the same transaction as the insert, and it is what makes the claim
   * mean something across processes: a batch from a run that is still going cannot land on top of
   * another run's finished index and leave the claim standing over the mixture.
   */
  insertChunkBatch(scope: ChunkScope, chunks: readonly ChunkInsert[]): void;
  replaceChunks(scope: ChunkScope, chunks: readonly ChunkInsert[]): void;
  countIndexedChunks(scope: ChunkScope): number;
  /**
   * Identifiers of every embedded chunk in this scope.
   *
   * Completeness is an identity question, not a counting one: chunk ids embed page and
   * per-page position, so the same total can describe a different set.
   */
  listIndexedChunkIds(scope: ChunkScope): string[];
  search(scope: ChunkScope, queryVector: Float32Array, topK: number, minScore: number): ScoredChunk[];
  /**
   * The chunks that contain every part of an exact-word expression, best first.
   *
   * Only chunks of the given documents, under the scope's profile and version, with an embedding
   * under the scope's model — the same eligibility the semantic ranking uses, so the two rankings
   * describe one set of passages. Ties in `bm25` are broken by chunk id, so the order is stable.
   */
  rankExact(query: ExactRankQuery): ExactCandidate[];
  /**
   * The chunks closest to the query by meaning, best first, at most `depth` of them.
   *
   * Reads identifiers and vectors only; the text is read afterwards, for the chunks that were kept,
   * by `readPassages`. Ties in score are broken by chunk id.
   */
  rankSemantic(query: SemanticRankQuery): SemanticCandidate[];
  /** The text, page and headings of these chunks. A chunk that no longer exists is left out. */
  readPassages(ids: readonly string[]): StoredPassage[];
  /**
   * Run several reads against one snapshot of the database.
   *
   * A deferred transaction: it takes no write lock, and every statement inside it sees the database
   * as the first one found it. A search reads candidates, rankings, text and completion times in
   * separate statements, and another process rebuilding a document commits between them in the
   * ordinary course of things — composed from two snapshots, the answer can be one no database ever
   * held. The work inside must be synchronous.
   */
  readSnapshot<T>(read: () => T): T;
  /** `complete` once every stored chunk is in the exact-word index. */
  exactIndexState(): ExactIndexState;
  /**
   * Add up to `limit` stored chunks that the exact-word index does not have yet, in one transaction.
   *
   * Chunks are visited in `(document_id, id)` order from a cursor kept in the same transaction, so a
   * crash loses at most one batch of work and two processes never repeat each other's. At the end of
   * a pass the same transaction looks for any chunk still missing: none, and the index is recorded
   * complete; some, and the next pass starts again from the beginning to repair them.
   */
  backfillExactIndexBatch(limit: number): ExactBackfillBatch;
  /**
   * Cache the Markdown a document was extracted to, and retract every completion claim over it.
   *
   * Raises rather than returning a flag when the pages are not exactly `1..pageCount` for this
   * document. A cache that does not describe the whole document would later be served as though
   * it did, and a boolean nobody is obliged to read is how that gets missed.
   *
   * The retraction is in the same transaction. A claim says a scope holds exactly one run's chunks
   * *and* that they were built from the text stored beside them, so storing a different reading
   * ends every claim that was relying on the old one. A run that is completing writes its text
   * through `completeChunkScope` instead, which puts its claim back in the same transaction.
   */
  putMarkdown(documentId: number, input: MarkdownCacheInput): void;
  /** The cached Markdown, if this engine wrote it at this version and it still parses. */
  getMarkdown(documentId: number, engineId: string, markdownVersion: number): MarkdownCacheRecord | null;
  /**
   * Remove a document's rows.
   *
   * **Not a consent-withdrawal API.** It leaves freed content recoverable from the file until
   * something reclaims the space, so no user-facing surface calls it — `forgetDocument` and
   * `clear` are the two that do. It stays because the cascade behaviour is worth testing on its
   * own.
   */
  deleteDocument(contentHash: string): boolean;
  /**
   * Remove a document and reclaim the space its text occupied.
   *
   * `deleteDocument` removes the rows; this also makes the bytes unreadable. Deletion here is
   * withdrawal of consent, and a row removed from a B-tree whose contents are still sitting in a
   * freed page has not been withdrawn from anyone holding the file.
   */
  forgetDocument(contentHash: string): boolean;
  listDocuments(limit?: number): StoredDocument[];
  /**
   * The documents a library search starts from: for each recorded path, the row opened most
   * recently (the row id breaking a tie), and every row without a path.
   *
   * The same rule as `getDocumentByPath`. Re-indexing a file whose bytes changed leaves its old row
   * at the same path, and searching every row would answer with passages from versions of the file
   * that are no longer on disk.
   */
  listLibraryDocuments(): StoredDocument[];
  /** Which of these documents have at least one chunk searchable under this scope. */
  listScopedDocumentIds(scope: ChunkScopeContract, documentIds: readonly number[]): number[];
  info(): StoreInfo;
  clear(): void;
  close(): void;
}

const DOCUMENT_CONTEXT = "documents row";

/**
 * Provenance as stored, or `null` if this row has none it can vouch for.
 *
 * Stored as `[[page, status], …]` rather than as objects: the same information, a third of the bytes
 * on a long document, and the shape is fixed so nothing is lost by dropping the key names.
 *
 * Anything unrecognisable is `null` rather than an error. A row that cannot be understood is exactly
 * a row that knows nothing about its pages, which is the state `null` already means — and refusing
 * to serve a document's text over a damaged sidecar would be a worse answer than serving the text
 * and going back for the empty pages.
 */
function parsePageProvenance(raw: unknown, pageCount: number): CachedPageProvenance[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== pageCount) return null;

  const entries: CachedPageProvenance[] = [];
  for (const [position, entry] of parsed.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [page, status] = entry;
    if (page !== position + 1) return null;
    if (status !== "read" && status !== "empty" && status !== "unresolved") return null;
    entries.push({ page, status });
  }
  return entries;
}

/**
 * `text_source` as one of the four values this program writes, or `null` for anything else.
 *
 * A miss rather than an error, consistently with the rest of the cache: a row nobody here wrote
 * cannot be vouched for, and re-reading the document repairs it. Throwing would refuse to open a
 * document because of a column that indexing is about to rewrite anyway.
 */
function toTextSource(value: string): TextSource | null {
  return value === "pdf" || value === "ocr" || value === "mixed" || value === "none" ? value : null;
}

function toStoredDocument(value: unknown): StoredDocument {
  const row = asRow(value, DOCUMENT_CONTEXT);
  return {
    id: requireInteger(row, "id", DOCUMENT_CONTEXT),
    contentHash: requireString(row, "content_hash", DOCUMENT_CONTEXT),
    name: requireString(row, "name", DOCUMENT_CONTEXT),
    filePath: requireNullableString(row, "file_path", DOCUMENT_CONTEXT),
    // Anything but the one recorded value is no provenance at all, the same as a row nobody stamped.
    pathProvenance: requireNullableString(row, "path_provenance", DOCUMENT_CONTEXT) === "resolved" ? "resolved" : null,
    pageCount: requireInteger(row, "page_count", DOCUMENT_CONTEXT),
    textSource: requireString(row, "text_source", DOCUMENT_CONTEXT),
    createdAt: requireString(row, "created_at", DOCUMENT_CONTEXT),
    lastOpenedAt: requireString(row, "last_opened_at", DOCUMENT_CONTEXT),
  };
}

/**
 * Connect, then hand the connection to initialisation under a guard that owns its lifetime.
 *
 * The guard wraps the *whole* of initialisation rather than ending after the last step that
 * looked fallible. An earlier version stopped after `migrate`, which left every `db.prepare`
 * below it outside: `migrate` returns immediately when the stamped version already matches, so
 * a file stamped v2 over tables that cannot support it reaches statement preparation and throws
 * there. The store has not been returned at that point, so no caller can close it, and the
 * connection leaks for the life of the process — holding the -wal and -shm sidecars open, a lock
 * against another writer, and on Windows an undeletable file.
 *
 * Keeping the whole of initialisation inside one function makes that structural instead of a
 * matter of where a brace happens to sit.
 */
export function openSemanticStore(options: OpenStoreOptions): SemanticStore {
  const clock: Clock = options.clock ?? (() => new Date());
  const path = semanticIndexPath(options.dataDir);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    return initialiseStore(db, path, clock);
  } catch (error) {
    try {
      db.close();
    } catch {
      // A close that fails must not replace the error that explains why we are closing.
    }
    throw error;
  }
}

function initialiseStore(db: Db, path: string, clock: Clock): SemanticStore {
  // busy_timeout first, so every statement after it waits for a competing writer rather than
  // failing outright. This is what lets the app and the CLI share one file.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const journalMode = pragmaText(db.pragma("journal_mode = WAL", { simple: true }), "journal_mode");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  const foreignKeysEnforced = pragmaInteger(db.pragma("foreign_keys", { simple: true }), "foreign_keys") === 1;
  db.pragma("secure_delete = ON");
  const secureDeleteEnabled = pragmaInteger(db.pragma("secure_delete", { simple: true }), "secure_delete") === 1;
  db.pragma("temp_store = MEMORY");

  const migration = migrate(db);

  const diagnostics: StoreDiagnostics = {
    journalMode,
    concurrencyDegraded: journalMode !== "wal",
    foreignKeysEnforced,
    secureDeleteEnabled,
    migration,
  };

  const getDocumentStatement = db.prepare("SELECT * FROM documents WHERE content_hash = ?");
  // Every extraction clause in one predicate: the bytes, how their text was read, how their
  // pictures were read, and which engine at which version wrote the cache. A row that fails any
  // of them describes a different reading of this file, so there is nothing here to reuse.
  const reusableDocumentStatement = db.prepare(
    `SELECT id, page_count, text_source FROM documents
      WHERE content_hash = ? AND text_extraction_version = ? AND ocr_extraction_version = ?
        AND markdown_engine = ? AND markdown_version = ?`,
  );
  const scopeChunkIdStatement = db.prepare(
    `SELECT c.id FROM chunk_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id
      WHERE c.document_id = ? AND c.chunking_profile = ? AND c.chunking_version = ?
        AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
  );
  const withdrawScopeClaimStatement = db.prepare(
    `DELETE FROM chunk_scope_snapshots
      WHERE document_id = ? AND chunking_profile = ? AND chunking_version = ?
        AND model_id = ? AND model_version = ? AND dimensions = ?`,
  );
  const withdrawDocumentClaimsStatement = db.prepare(
    "DELETE FROM chunk_scope_snapshots WHERE document_id = ?",
  );
  const insertChunkStatement = db.prepare(
    `INSERT INTO document_chunks (id,document_id,page_number,chunk_index,text,chunking_profile,chunking_version,heading_path)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insertEmbeddingStatement = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id,model_id,model_version,dimensions,vector,created_at)
     VALUES (?,?,?,?,?,?)`,
  );

  // The same six-field eligibility the semantic ranking reads, so both rankings describe one set of
  // passages: the profile and version on the chunk, and an embedding under the active model, its
  // version and its width. Chunk ids carry no model, so the embedding is what decides that part.
  // Ties in `bm25` are broken by id, so the order — and the rank positions fused from it — is the
  // same on every run.
  const rankExactStatement = db.prepare(
    `SELECT c.id, c.document_id, bm25(chunk_text_fts) AS rank
       FROM chunk_text_fts
       JOIN chunk_text_keys k ON k.fts_rowid = chunk_text_fts.rowid
       JOIN document_chunks c ON c.id = k.chunk_id
      WHERE chunk_text_fts MATCH @match
        AND c.chunking_profile = @profile AND c.chunking_version = @version
        AND c.document_id IN (SELECT value FROM json_each(@documentIds))
        AND EXISTS (SELECT 1 FROM chunk_embeddings e
                     WHERE e.chunk_id = c.id AND e.model_id = @modelId
                       AND e.model_version = @modelVersion AND e.dimensions = @dimensions)
      ORDER BY rank, c.id
      LIMIT @depth`,
  );

  const rankSemanticStatement = db.prepare(
    `SELECT c.id, c.document_id, e.vector
       FROM chunk_embeddings e
       JOIN document_chunks c ON c.id = e.chunk_id
      WHERE c.document_id IN (SELECT value FROM json_each(?))
        AND c.chunking_profile = ? AND c.chunking_version = ?
        AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
  );
  const listLibraryStatement = db.prepare(
    `SELECT * FROM (
       SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.file_path ORDER BY d.last_opened_at DESC, d.id DESC) AS version_rank
         FROM documents d WHERE d.file_path IS NOT NULL
     ) WHERE version_rank = 1
     UNION ALL
     SELECT d.*, 1 AS version_rank FROM documents d WHERE d.file_path IS NULL
     ORDER BY id`,
  );
  const scopedDocumentIdsStatement = db.prepare(
    `SELECT DISTINCT c.document_id
       FROM document_chunks c
       JOIN chunk_embeddings e ON e.chunk_id = c.id
      WHERE c.document_id IN (SELECT value FROM json_each(?))
        AND c.chunking_profile = ? AND c.chunking_version = ?
        AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
  );
  const readPassagesStatement = db.prepare(
    `SELECT id, document_id, page_number, text, heading_path
       FROM document_chunks WHERE id IN (SELECT value FROM json_each(?))`,
  );

  function writeMarkdownRows(documentId: number, input: MarkdownCacheInput): void {
    // This is a boundary in its own right — it stamps `documents` atomically, so it cannot lean
    // on a caller having validated first. A blank engine id or a nonsensical version would be
    // written straight into the provenance that later reads key off, and `getMarkdown` would
    // then never match what was stored.
    if (input.engineId.trim().length === 0) {
      throw new StoreDataError(`Cannot cache Markdown for document ${documentId}: the engine id is blank.`);
    }
    if (!Number.isInteger(input.markdownVersion) || input.markdownVersion < 1) {
      throw new StoreDataError(
        `Cannot cache Markdown for document ${documentId}: the representation version must be a positive whole number, not ${String(input.markdownVersion)}.`,
      );
    }
    // The same boundary argument as the engine id. These become the row's account of how its text
    // was read, so a nonsense value written here is a claim every later reader would trust.
    for (const [field, value] of [
      ["textExtractionVersion", input.textExtractionVersion],
      ["ocrExtractionVersion", input.ocrExtractionVersion],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new StoreDataError(
          `Cannot cache Markdown for document ${documentId}: ${field} must be a positive whole number, not ${String(value)}.`,
        );
      }
    }

    // The store is the only place that knows how many pages the document has, so it checks here
    // rather than trusting whoever assembled the cache. A caller reaching past `indexDocument`
    // cannot bypass it.
    const owner = db.prepare("SELECT page_count FROM documents WHERE id = ?").get(documentId);
    if (owner === undefined) {
      throw new StoreDataError(`Cannot cache Markdown for document ${documentId}: no such row exists.`);
    }
    const pageCount = requireInteger(asRow(owner, "documents row"), "page_count", "documents row");
    if (input.pages.length !== pageCount) {
      throw new StoreDataError(
        `Markdown cache for document ${documentId} covers ${input.pages.length} pages, but the document has ${pageCount}.`,
      );
    }

    const rendered = renderPagePreservingMarkdown(input.pages);
    if (rendered === null) {
      throw new StoreDataError(`Markdown cache for document ${documentId} is not a complete run of pages from 1.`);
    }

    // Provenance describes *this* cache, so it has to cover the same pages the text does. A partial
    // record would leave some pages with an outcome and the rest with silence, which reads exactly
    // like an older row and would send the reader back for pages it already knows about.
    const provenance = input.pageProvenance;
    if (provenance !== undefined) {
      if (provenance.length !== input.pages.length) {
        throw new StoreDataError(
          `Page provenance for document ${documentId} covers ${provenance.length} pages, but its Markdown covers ${input.pages.length}.`,
        );
      }
      for (const [position, entry] of provenance.entries()) {
        if (entry.page !== position + 1) {
          throw new StoreDataError(
            `Page provenance for document ${documentId} must run from page 1 without gaps; entry ${position} is page ${entry.page}.`,
          );
        }
      }
    }

    db.prepare(
      `INSERT INTO document_markdown (document_id,engine_id,markdown_version,markdown,created_at,page_provenance)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(document_id) DO UPDATE SET
         engine_id = excluded.engine_id, markdown_version = excluded.markdown_version,
         markdown = excluded.markdown, created_at = excluded.created_at,
         page_provenance = excluded.page_provenance`,
    ).run(
      documentId,
      input.engineId,
      input.markdownVersion,
      rendered,
      clock().toISOString(),
      provenance === undefined ? null : JSON.stringify(provenance.map((entry) => [entry.page, entry.status])),
    );

    // The stamp is part of the same write. Applying it before the row exists is how a document
    // comes to advertise a cache it does not have — and the extraction versions travel with it for
    // the same reason: they describe the text in this transaction, not the run that intended it.
    // An omitted version reaches the statement as zero, which is the same sentinel the document
    // upsert uses for "the caller did not say" and preserves what is recorded. A caller cannot
    // send that zero itself: the check above refuses it, so preserving is something you get by
    // saying nothing rather than by naming a version that means nothing.
    // Named parameters, because each version is read twice and better-sqlite3 binds `?N` by name
    // rather than by position — measured against 13.0.3, where a numbered statement bound
    // positionally raises "Too many parameter values were provided".
    db.prepare(
      `UPDATE documents SET markdown_engine = @engineId, markdown_version = @markdownVersion,
         text_extraction_version =
           CASE WHEN @textExtractionVersion = 0 THEN text_extraction_version ELSE @textExtractionVersion END,
         ocr_extraction_version =
           CASE WHEN @ocrExtractionVersion = 0 THEN ocr_extraction_version ELSE @ocrExtractionVersion END
       WHERE id = @documentId`,
    ).run({
      engineId: input.engineId,
      markdownVersion: input.markdownVersion,
      textExtractionVersion: input.textExtractionVersion ?? 0,
      ocrExtractionVersion: input.ocrExtractionVersion ?? 0,
      documentId,
    });

    // Every claim over this document goes with the old text. A completion marker vouches for two
    // things at once — that a scope holds exactly the chunks one run wrote, and that they were
    // built from the text stored beside them — so a different reading of the document arriving
    // afterwards breaks the second half of that. The cache is keyed to the document rather than to
    // one scope, so all of them are retracted; the run that completes writes its own claim back in
    // the same transaction as its text, and any other scope re-establishes its claim the next time
    // it is read in full.
    withdrawDocumentClaimsStatement.run(documentId);
  }

  const writeMarkdown = db.transaction(writeMarkdownRows);

  /** Every embedded chunk identifier in this exact scope, as the completion check and the public
   *  reader both need it. */
  function storedChunkIds(scope: ChunkScope): string[] {
    const context = "indexed chunk id";
    return scopeChunkIdStatement
      .all(scope.documentId, scope.chunkingProfile, scope.chunkingVersion, scope.modelId, scope.modelVersion, scope.dimensions)
      .map((row) => requireString(asRow(row, context), "id", context));
  }

  function withdrawScopeClaim(scope: ChunkScope): void {
    withdrawScopeClaimStatement.run(
      scope.documentId, scope.chunkingProfile, scope.chunkingVersion,
      scope.modelId, scope.modelVersion, scope.dimensions,
    );
  }

  const insertBatch = db.transaction((scope: ChunkScope, chunks: readonly ChunkInsert[]) => {
    // Any claim over this scope is withdrawn in the same transaction that changes it. Another
    // process's run can be part way through this scope when a claim is written — its remaining
    // batches then land on top of somebody else's finished index — and this is what stops that
    // mixture being served: the batch that creates it also destroys the claim that would vouch
    // for it. Withdrawing first, in the same transaction, leaves no instant where the extra rows
    // exist under a claim that has not yet been retracted.
    withdrawScopeClaim(scope);
    const now = clock().toISOString();
    for (const chunk of chunks) {
      insertChunkStatement.run(
        chunk.id, scope.documentId, chunk.page, chunk.index, chunk.text,
        scope.chunkingProfile, scope.chunkingVersion, JSON.stringify(chunk.headingPath),
      );
      insertEmbeddingStatement.run(
        chunk.id, scope.modelId, scope.modelVersion, scope.dimensions, vectorToBlob(chunk.vector), now,
      );
    }
  });

  const clearScope = db.transaction((scope: ChunkScope) => {
    db.prepare(
      `DELETE FROM document_chunks
        WHERE document_id = ?
          AND (chunking_version < ? OR (chunking_profile = ? AND chunking_version = ?))`,
    ).run(scope.documentId, scope.chunkingVersion, scope.chunkingProfile, scope.chunkingVersion);
    // Chunk rows own embeddings for every model. Clearing them invalidates completion claims for
    // every affected model scope, not only the model that initiated this replacement.
    db.prepare(
      `DELETE FROM chunk_scope_snapshots
        WHERE document_id = ?
          AND (chunking_version < ? OR (chunking_profile = ? AND chunking_version = ?))`,
    ).run(scope.documentId, scope.chunkingVersion, scope.chunkingProfile, scope.chunkingVersion);
  });

  const claimScopeComplete = db.transaction((scope: ChunkScope, completion: ScopeCompletion): ScopeCompletionOutcome => {
    // The identities, not the count. Two runs writing into one scope can leave exactly as many
    // chunks as either of them expected, made of a mixture neither produced; the identifier
    // carries a fingerprint of the text, so comparing the set is what tells them apart.
    //
    // Checked before the text, so that a run which lost the race is told it lost rather than told
    // it had nothing to say.
    const stored = storedChunkIds(scope);
    const expected = new Set(completion.chunkIds);
    if (stored.length !== expected.size || !stored.every((id) => expected.has(id))) return "conflicted";

    // No text, no claim. A claim says these chunks and this document's text came out of one
    // reading, so a run that cannot supply the text has established nothing to publish — and
    // publishing anyway would pair its chunks with whatever text happened to be stored, which on a
    // document that has been read before is an earlier reading of it. Nothing is written here, in
    // either direction: the run's own chunk writes already retracted any claim they invalidated.
    if (completion.cache === undefined) return "unclaimed";

    // The text these chunks were built from is written here, with the claim, in this transaction.
    // Another run that stored its own reading while this one was embedding would otherwise be left
    // paired with these chunks — its pages beside this run's passages — and nothing afterwards
    // could tell. Writing it here also retracts every claim over the document, which is why the
    // claim below is written last.
    writeMarkdownRows(scope.documentId, completion.cache);

    db.prepare(
      `INSERT INTO chunk_scope_snapshots (
         document_id, chunking_profile, chunking_version,
         model_id, model_version, dimensions, chunks_written_at
       ) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(document_id, chunking_profile, chunking_version, model_id, model_version, dimensions)
       DO UPDATE SET chunks_written_at = excluded.chunks_written_at`,
    ).run(
      scope.documentId,
      scope.chunkingProfile,
      scope.chunkingVersion,
      scope.modelId,
      scope.modelVersion,
      scope.dimensions,
      clock().toISOString(),
    );
    return "claimed";
  });

  function getMeta(key: string): string | null {
    const raw = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key);
    return raw === undefined ? null : requireString(asRow(raw, "schema_meta row"), "value", "schema_meta row");
  }

  function setMeta(key: string, value: string): void {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  function markErasePending(): void {
    setMeta("exact_index_erase_pending", "1");
  }

  const backfillVisitStatement = db.prepare(
    `SELECT document_id, id, text FROM document_chunks
      WHERE (document_id, id) > (@documentId, @id)
      ORDER BY document_id, id
      LIMIT @limit`,
  );
  const insertMissingKeyStatement = db.prepare(
    `INSERT INTO chunk_text_keys(chunk_id) SELECT @id
      WHERE NOT EXISTS (SELECT 1 FROM chunk_text_keys WHERE chunk_id = @id)`,
  );
  const insertIndexRowStatement = db.prepare("INSERT INTO chunk_text_fts(rowid, text) VALUES (?, ?)");
  const anyChunkMissingStatement = db.prepare(
    `SELECT EXISTS (SELECT 1 FROM document_chunks c
                     WHERE NOT EXISTS (SELECT 1 FROM chunk_text_keys k WHERE k.chunk_id = c.id)) AS missing`,
  );

  /** The cursor as stored: `[documentId, chunkId]`, or the start when empty or unreadable. */
  function readBackfillCursor(): { documentId: number; id: string } {
    const start = { documentId: -1, id: "" };
    const raw = getMeta("exact_index_cursor");
    if (raw === null || raw.length === 0) return start;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 2) return start;
      const [documentId, id] = parsed;
      if (typeof documentId !== "number" || !Number.isInteger(documentId) || typeof id !== "string") return start;
      return { documentId, id };
    } catch {
      // A cursor nobody can read starts the pass again. Revisiting chunks costs time, not correctness.
      return start;
    }
  }

  const backfillBatch = db.transaction((limit: number): ExactBackfillBatch => {
    if (getMeta("exact_index_state") === "complete") return { indexed: 0, visited: 0, state: "complete" };
    const batchLimit = Math.max(1, Math.floor(limit));
    const cursor = readBackfillCursor();
    const context = "backfill chunk";
    const rows = backfillVisitStatement.all({ documentId: cursor.documentId, id: cursor.id, limit: batchLimit }).map((raw) => {
      const row = asRow(raw, context);
      return {
        documentId: requireInteger(row, "document_id", context),
        id: requireString(row, "id", context),
        text: requireString(row, "text", context),
      };
    });

    let indexed = 0;
    for (const row of rows) {
      const inserted = insertMissingKeyStatement.run({ id: row.id });
      if (inserted.changes === 0) continue;
      insertIndexRowStatement.run(inserted.lastInsertRowid, row.text);
      indexed += 1;
    }

    const last = rows[rows.length - 1];
    if (rows.length === batchLimit && last !== undefined) {
      setMeta("exact_index_cursor", JSON.stringify([last.documentId, last.id]));
      return { indexed, visited: rows.length, state: "backfilling" };
    }

    // The end of a pass. Complete only if nothing is missing anywhere — a chunk below the cursor, or
    // one whose key went missing, is repaired by another pass rather than declared indexed.
    setMeta("exact_index_cursor", "");
    const missing = requireInteger(asRow(anyChunkMissingStatement.get(), "backfill check"), "missing", "backfill check");
    if (missing === 0) {
      setMeta("exact_index_state", "complete");
      return { indexed, visited: rows.length, state: "complete" };
    }
    return { indexed, visited: rows.length, state: "backfilling" };
  });

  const removeDocument = db.transaction((hash: string): boolean => {
    const found = getDocumentStatement.get(hash);
    if (found === undefined) return false;
    const id = requireInteger(asRow(found, DOCUMENT_CONTEXT), "id", DOCUMENT_CONTEXT);
    db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id = ?)").run(id);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM document_markdown WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    // Owed in the same transaction as the delete. The chunk triggers removed the document's rows
    // from the exact-word index, but its tokens stay in the index's segment records until they are
    // merged. Recorded here, an interrupted forget still knows there is an erase to finish.
    markErasePending();
    return true;
  });

  /**
   * Did the checkpoint actually run, or did it give up?
   *
   * `PRAGMA wal_checkpoint` **reports** a busy log rather than raising: with another connection
   * attached it returns `{ busy: 1 }` and carries on. Measured against better-sqlite3 13.0.3 with
   * a second connection holding a read transaction, both checkpoints returned `busy: 1`, `VACUUM`
   * succeeded anyway, and the deleted text was still in the 24 KB log afterwards. An unchecked
   * call is therefore a silent no-op exactly when it matters most.
   */
  function requireCheckpoint(when: string): void {
    const rows = db.pragma("wal_checkpoint(TRUNCATE)");
    const row = Array.isArray(rows) ? rows[0] : rows;
    const busy = asRow(row, "wal_checkpoint result").busy;
    if (busy !== 0) {
      throw new StoreDataError(
        `The write-ahead log could not be truncated ${when}: the index is in use by another connection.`,
      );
    }
  }

  /**
   * Make deleted content unrecoverable from the file.
   *
   * Checkpointing first folds the write-ahead log into the database and truncates it, because the
   * deleted text is sitting in that log as well as in the database. `VACUUM` then rewrites the
   * file without the freed pages, so nothing survives in the slack. The final checkpoint clears
   * the log that `VACUUM` itself wrote. Both checkpoints are checked, not fired and forgotten.
   */
  function reclaimSpace(): void {
    requireCheckpoint("before compacting");
    db.exec("VACUUM");
    requireCheckpoint("after compacting");
  }

  const wipe = db.transaction(() => {
    // The exact-word index first, in one command, so the chunk triggers below find no key to delete
    // row by row. `delete-all` empties a contentless index; its tokens still wait for the merge.
    db.exec(`DELETE FROM chunk_text_keys; INSERT INTO chunk_text_fts(chunk_text_fts) VALUES('delete-all');`);
    db.exec("DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM document_markdown; DELETE FROM documents;");
    setMeta("exact_index_state", "complete");
    setMeta("exact_index_cursor", "");
    markErasePending();
  });

  /**
   * Finish an erase the exact-word index owes, if it owes one.
   *
   * `optimize` merges every segment into one and drops what was deleted, which is the step that
   * makes a forgotten document's tokens leave the file. The flag is cleared only after the space is
   * reclaimed and the log truncated: cleared any earlier, a crash would leave the old segments in
   * the database file with nothing recording that they are still there.
   */
  function finishOwedErase(): boolean {
    if (getMeta("exact_index_erase_pending") !== "1") return false;
    db.exec("INSERT INTO chunk_text_fts(chunk_text_fts) VALUES('optimize')");
    reclaimSpace();
    setMeta("exact_index_erase_pending", "0");
    requireCheckpoint("after recording the erase");
    return true;
  }

  /**
   * The reusable-index decision, taken as one read.
   *
   * Every clause below is read inside a single transaction so that they describe one instant.
   * The four questions are separate statements — the document row, the cache, the completion
   * marker, the chunk count — and another process rebuilding this document commits between
   * them in the ordinary course of things. Composed from two snapshots, the answer can be one
   * no database ever held: a marker from before a replacement began, over a chunk count taken
   * half way through it.
   */
  const readReusableIndex = db.transaction((query: ReusableIndexQuery): ReusableIndex | null => {
    const raw = reusableDocumentStatement.get(
      query.contentHash,
      query.textExtractionVersion,
      query.ocrExtractionVersion,
      query.markdownEngineId,
      query.markdownVersion,
    );
    if (raw === undefined) return null;

    const context = "reusable documents row";
    const row = asRow(raw, context);
    const documentId = requireInteger(row, "id", context);
    const pageCount = requireInteger(row, "page_count", context);
    const textSource = toTextSource(requireString(row, "text_source", context));
    if (textSource === null) return null;

    // The cache decides two things at once: that the text is still servable, and what became of
    // each page. `getMarkdown` already refuses a row that does not parse or does not cover the
    // document, and a row that cannot account for its pages is refused here — an empty page it
    // cannot explain is a gap everywhere else in this program, and this is not the place to
    // start guessing it was blank.
    const cached = store.getMarkdown(documentId, query.markdownEngineId, query.markdownVersion);
    if (cached === null || cached.provenance === null) return null;

    // A page nothing could read is work still outstanding, so this document is not finished and
    // must not be answered from storage. Reuse here would be self-perpetuating: the reader that
    // could recognise the page would never be asked to, and every later open would consult the
    // same cache and reach the same conclusion. The full read path is what repairs it.
    if (cached.provenance.some((page) => page.status === "unresolved")) return null;

    // The completion marker, and only then the count. The marker is withdrawn before a
    // replacement clears anything and written after the last batch commits, so its presence is
    // the one available proof that a scope was finished rather than interrupted. The count is
    // the answer's chunk total, not the proof — chunks on disk are equally consistent with a run
    // that stopped half way.
    const scope: ChunkScope = { documentId, ...query.scope };
    if (store.chunksWrittenAt(scope) === null) return null;
    const chunkCount = store.countIndexedChunks(scope);
    // A finished scope with nothing in it is a real state — a blank document, or a scan that
    // recognised to nothing — and it is the one most worth not reading twice. It is only
    // believable when the cached text is empty too: a scope whose pages carry words and whose
    // chunks have gone is damaged, and serving it would report a searchable document with
    // nothing in it. The test is deliberately the stricter of the two, so a document whose text
    // merely produced no chunk is read again rather than served as empty.
    if (chunkCount === 0 && cached.pages.some((page) => page.markdown.trim().length > 0)) return null;

    return { documentId, pageCount, textSource, chunkCount };
  });

  const store: SemanticStore = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    diagnostics,

    getDocument(contentHash) {
      const row = getDocumentStatement.get(contentHash);
      return row === undefined ? null : toStoredDocument(row);
    },

    findReusableIndex(query) {
      // Deferred, because this reads and never writes: it takes no write lock and cannot make
      // another connection wait. What it does take is one snapshot — SQLite holds the read view
      // established by the first statement until the transaction ends — so the row, the cache, the
      // completion marker and the chunk count all describe the same instant. Without it the four
      // statements could straddle another process's rebuild and compose an answer out of two
      // different databases: a marker from before the replacement began and a chunk count from
      // half way through it.
      return readReusableIndex.deferred(query);
    },

    upsertDocument(input) {
      const now = clock().toISOString();
      const row = db
        .prepare(
          `INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,
             text_extraction_version,ocr_extraction_version,created_at,last_opened_at,
             markdown_engine,markdown_version,path_provenance)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(content_hash) DO UPDATE SET
             name = excluded.name, file_path = excluded.file_path, file_size = excluded.file_size,
             path_provenance = excluded.path_provenance,
             page_count = excluded.page_count, text_source = excluded.text_source,
             last_opened_at = excluded.last_opened_at,
             -- Preserve rather than clear when a caller says nothing. Absence means "I do not
             -- know how this text was produced", not "there is no provenance", and clearing
             -- would discard a record — and leave a cache row — written by a caller that knew.
             markdown_engine = COALESCE(excluded.markdown_engine, markdown_engine),
             markdown_version = COALESCE(excluded.markdown_version, markdown_version),
             text_extraction_version = CASE WHEN excluded.text_extraction_version = 0
               THEN text_extraction_version ELSE excluded.text_extraction_version END,
             ocr_extraction_version = CASE WHEN excluded.ocr_extraction_version = 0
               THEN ocr_extraction_version ELSE excluded.ocr_extraction_version END
           RETURNING *`,
        )
        .get(
          input.contentHash, input.name, input.filePath, input.fileSize, input.pageCount,
          input.textSource, input.textExtractionVersion, input.ocrExtractionVersion, now, now,
          input.markdownEngine, input.markdownVersion, input.pathProvenance ?? null,
        );
      return toStoredDocument(row);
    },

    beginChunkReplace(scope) {
      clearScope.immediate(scope);
    },

    completeChunkScope(scope, completion) {
      return claimScopeComplete.immediate(scope, completion);
    },

    chunksWrittenAt(scope) {
      const raw = db
        .prepare(
          `SELECT chunks_written_at FROM chunk_scope_snapshots
            WHERE document_id = ? AND chunking_profile = ? AND chunking_version = ?
              AND model_id = ? AND model_version = ? AND dimensions = ?`,
        )
        .get(
          scope.documentId,
          scope.chunkingProfile,
          scope.chunkingVersion,
          scope.modelId,
          scope.modelVersion,
          scope.dimensions,
        );
      if (raw === undefined) return null;
      return requireString(asRow(raw, "chunk_scope_snapshots row"), "chunks_written_at", "chunk_scope_snapshots row");
    },

    insertChunkBatch(scope, chunks) {
      if (chunks.length === 0) return;
      insertBatch.immediate(scope, chunks);
    },

    replaceChunks(scope, chunks) {
      clearScope.immediate(scope);
      for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
        insertBatch.immediate(scope, chunks.slice(offset, offset + INSERT_BATCH));
      }
    },

    countIndexedChunks(scope) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM chunk_embeddings e
             JOIN document_chunks c ON c.id = e.chunk_id
            WHERE c.document_id = ? AND c.chunking_profile = ? AND c.chunking_version = ?
              AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
        )
        .get(scope.documentId, scope.chunkingProfile, scope.chunkingVersion, scope.modelId, scope.modelVersion, scope.dimensions);
      return countFrom(row, "countIndexedChunks");
    },

    listIndexedChunkIds(scope) {
      return storedChunkIds(scope);
    },

    search(scope, queryVector, topK, minScore) {
      const context = "document_chunks join chunk_embeddings";
      const rows = db
        .prepare(
          `SELECT c.id, c.page_number, c.text, c.heading_path, e.vector
             FROM chunk_embeddings e
             JOIN document_chunks c ON c.id = e.chunk_id
            WHERE c.document_id = ? AND c.chunking_profile = ? AND c.chunking_version = ?
              AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
        )
        .iterate(scope.documentId, scope.chunkingProfile, scope.chunkingVersion, scope.modelId, scope.modelVersion, scope.dimensions);

      const hits: ScoredChunk[] = [];
      for (const raw of rows) {
        const row = asRow(raw, context);
        const vector = blobToVector(requireBlob(row, "vector", context), scope.dimensions);
        const score = cosineSimilarity(queryVector, vector);
        if (score < minScore) continue;
        const headings = parseHeadingEntries(row.heading_path);
        hits.push({
          id: requireString(row, "id", context),
          page: requireInteger(row, "page_number", context),
          snippet: requireString(row, "text", context),
          score,
          headingPath: headings.map((heading) => heading.title),
          headings,
        });
      }

      // Rank by score, keep the top K, then present in reading order — the ordering the
      // results panel already relies on.
      return hits
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .sort((a, b) => a.page - b.page || b.score - a.score);
    },

    rankExact(query) {
      if (query.documentIds.length === 0) return [];
      const context = "exact-word candidate";
      return rankExactStatement
        .all({
          match: query.match,
          profile: query.scope.chunkingProfile,
          version: query.scope.chunkingVersion,
          documentIds: JSON.stringify(query.documentIds),
          modelId: query.scope.modelId,
          modelVersion: query.scope.modelVersion,
          dimensions: query.scope.dimensions,
          depth: query.depth,
        })
        .map((raw) => {
          const row = asRow(raw, context);
          const rank = row.rank;
          if (typeof rank !== "number" || !Number.isFinite(rank)) {
            throw new StoreDataError(`${context}: column "rank" should be a number.`);
          }
          return {
            id: requireString(row, "id", context),
            documentId: requireInteger(row, "document_id", context),
            rank,
          };
        });
    },

    rankSemantic(query) {
      if (query.documentIds.length === 0 || query.depth < 1) return [];
      const context = "semantic candidate";
      const rows = rankSemanticStatement.raw().iterate(
        JSON.stringify(query.documentIds),
        query.scope.chunkingProfile,
        query.scope.chunkingVersion,
        query.scope.modelId,
        query.scope.modelVersion,
        query.scope.dimensions,
      );
      // Best first, at most `depth` long, kept sorted as it fills so that nothing beyond the depth is
      // ever held: a library is many times larger than any answer.
      const kept: SemanticCandidate[] = [];
      const before = (a: SemanticCandidate, b: SemanticCandidate): boolean =>
        a.score > b.score || (a.score === b.score && a.id < b.id);
      for (const raw of rows) {
        if (!Array.isArray(raw)) throw new StoreDataError(`${context}: expected a row.`);
        const [id, documentId, blob] = raw;
        if (typeof id !== "string") throw new StoreDataError(`${context}: chunk id should be text.`);
        if (typeof documentId !== "number" || !Number.isInteger(documentId)) {
          throw new StoreDataError(`${context}: document id should be an integer.`);
        }
        if (!(blob instanceof Uint8Array)) throw new StoreDataError(`${context}: vector should be a blob.`);
        const score = cosineSimilarity(query.queryVector, blobToVector(blob, query.scope.dimensions));
        if (score < query.minScore) continue;
        const candidate = { id, documentId, score };
        const last = kept[kept.length - 1];
        if (kept.length >= query.depth && last !== undefined && !before(candidate, last)) continue;
        let position = kept.length;
        while (position > 0) {
          const previous = kept[position - 1];
          if (previous === undefined || !before(candidate, previous)) break;
          position -= 1;
        }
        kept.splice(position, 0, candidate);
        if (kept.length > query.depth) kept.pop();
      }
      return kept;
    },

    readPassages(ids) {
      if (ids.length === 0) return [];
      const context = "document_chunks passage";
      return readPassagesStatement.all(JSON.stringify(ids)).map((raw) => {
        const row = asRow(raw, context);
        return {
          id: requireString(row, "id", context),
          documentId: requireInteger(row, "document_id", context),
          page: requireInteger(row, "page_number", context),
          text: requireString(row, "text", context),
          headings: parseHeadingEntries(row.heading_path),
        };
      });
    },

    backfillExactIndexBatch(limit) {
      return backfillBatch.immediate(limit);
    },

    readSnapshot(read) {
      return db.transaction(read).deferred();
    },

    exactIndexState() {
      const raw = db.prepare("SELECT value FROM schema_meta WHERE key = 'exact_index_state'").get();
      // Anything but a recorded `complete` is treated as unfinished: the backfill that follows is
      // the repair, and it writes `complete` only after checking that no chunk is missing.
      if (raw === undefined) return "backfilling";
      return requireString(asRow(raw, "schema_meta row"), "value", "schema_meta row") === "complete" ? "complete" : "backfilling";
    },

    putMarkdown(documentId, input) {
      // One transaction for the row and the stamp on `documents`, because a document claiming an
      // engine with no cache behind it is the false state the provenance rules exist to prevent.
      // Validating inside the transaction means a refusal — or a failure part-way — leaves the
      // previous cache and its stamp exactly as they were, still consistent with each other.
      writeMarkdown.immediate(documentId, input);
    },

    getMarkdown(documentId, engineId, markdownVersion) {
      // The document's own page count comes back with the row, because syntax alone cannot tell
      // a complete cache from a shorter one that happens to parse. A truncated or hand-edited
      // row can be a perfectly valid two-page document; serving it for a three-page document
      // would report pages that were never cached as though they had been.
      const raw = db
        .prepare(
          `SELECT m.markdown AS markdown, m.page_provenance AS page_provenance,
                  m.created_at AS created_at, d.page_count AS page_count
             FROM document_markdown m JOIN documents d ON d.id = m.document_id
            WHERE m.document_id = ? AND m.engine_id = ? AND m.markdown_version = ?`,
        )
        .get(documentId, engineId, markdownVersion);
      if (raw === undefined) return null;

      const context = "document_markdown row";
      const row = asRow(raw, context);
      const pages = parsePagePreservingMarkdown(requireString(row, "markdown", context));
      if (pages === null) return null;
      // A miss, deliberately, and consistently with a malformed row: the caller's remedy for
      // both is the same — extract again — and a corrupt cache must never be served in part.
      if (pages.length !== requireInteger(row, "page_count", context)) return null;
      return {
        pages,
        provenance: parsePageProvenance(row.page_provenance, pages.length),
        createdAt: requireString(row, "created_at", context),
      };
    },

    deleteDocument(contentHash) {
      return removeDocument.immediate(contentHash);
    },

    forgetDocument(contentHash) {
      // Exclusivity first, so a refusal leaves the document exactly where it was.
      return withExclusiveAccess(db, () => {
        const removed = removeDocument.immediate(contentHash);
        // An erase an earlier forget left unfinished runs too, also when this document is already
        // gone: a retry is how somebody whose forget was interrupted gets what they asked for.
        const erased = finishOwedErase();
        if (removed && !erased) reclaimSpace();
        return removed;
      });
    },

    getDocumentByPath(filePath) {
      const row = db
        .prepare("SELECT * FROM documents WHERE file_path = ? ORDER BY last_opened_at DESC, id DESC LIMIT 1")
        .get(filePath);
      return row === undefined ? null : toStoredDocument(row);
    },

    listDocuments(limit = 100) {
      return db
        .prepare("SELECT * FROM documents ORDER BY last_opened_at DESC LIMIT ?")
        .all(limit)
        .map(toStoredDocument);
    },

    listLibraryDocuments() {
      return listLibraryStatement.all().map(toStoredDocument);
    },

    listScopedDocumentIds(scope, documentIds) {
      if (documentIds.length === 0) return [];
      const context = "scoped document id";
      return scopedDocumentIdsStatement
        .all(JSON.stringify(documentIds), scope.chunkingProfile, scope.chunkingVersion, scope.modelId, scope.modelVersion, scope.dimensions)
        .map((row) => requireInteger(asRow(row, context), "document_id", context));
    },

    info() {
      const count = (table: string) =>
        countFrom(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), `count of ${table}`);
      return {
        sizeBytes: indexSizeOnDisk(path),
        documentCount: count("documents"),
        chunkCount: count("document_chunks"),
        embeddingCount: count("chunk_embeddings"),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    },

    clear() {
      // The same sequence as forgetting one document. Clearing is the other way a person
      // withdraws consent and it has to reach the same bytes, under the same exclusivity.
      withExclusiveAccess(db, () => {
        wipe.immediate();
        finishOwedErase();
      });
    },

    close() {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
  return store;
}
