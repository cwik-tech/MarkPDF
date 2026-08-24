import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { semanticIndexPath } from "../paths.js";
import { CURRENT_SCHEMA_VERSION, migrate, type MigrationReport } from "./schema.js";
import { SchemaTooNewError, StoreDataError } from "./errors.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "./vector.js";
import { indexSizeOnDisk } from "./size.js";
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

export { SchemaTooNewError, StoreDataError, CURRENT_SCHEMA_VERSION };
export type { MigrationReport };

/** Rows committed per transaction. Bounds WAL growth and the write lock held per commit. */
const INSERT_BATCH = 512;
/** Milliseconds a statement waits for a competing writer before reporting SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

export type TextSource = "pdf" | "ocr" | "mixed" | "none";

export interface UpsertDocumentInput {
  contentHash: string;
  name: string;
  filePath: string | null;
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
   * so a partial or differently-distributed set re-indexes on next open. The disclosure timestamp
   * is withdrawn here and written only after the final batch; it never decides reuse. Counting
   * alone is not sufficient — see `indexDocument`.
   */
  beginChunkReplace(scope: ChunkScope): void;
  /** Mark the exact searchable scope complete after its final chunk batch committed. */
  markChunksComplete(scope: ChunkScope): void;
  /** The completion time for this exact searchable scope, or null for legacy/incomplete rows. */
  chunksWrittenAt(scope: ChunkScope): string | null;
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
   * Cache the Markdown a document was extracted to.
   *
   * Raises rather than returning a flag when the pages are not exactly `1..pageCount` for this
   * document. A cache that does not describe the whole document would later be served as though
   * it did, and a boolean nobody is obliged to read is how that gets missed.
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

function toStoredDocument(value: unknown): StoredDocument {
  const row = asRow(value, DOCUMENT_CONTEXT);
  return {
    id: requireInteger(row, "id", DOCUMENT_CONTEXT),
    contentHash: requireString(row, "content_hash", DOCUMENT_CONTEXT),
    name: requireString(row, "name", DOCUMENT_CONTEXT),
    filePath: requireNullableString(row, "file_path", DOCUMENT_CONTEXT),
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
  const insertChunkStatement = db.prepare(
    `INSERT INTO document_chunks (id,document_id,page_number,chunk_index,text,chunking_profile,chunking_version,heading_path)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insertEmbeddingStatement = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id,model_id,model_version,dimensions,vector,created_at)
     VALUES (?,?,?,?,?,?)`,
  );

  const writeMarkdown = db.transaction((documentId: number, input: MarkdownCacheInput) => {
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
    // comes to advertise a cache it does not have.
    db.prepare("UPDATE documents SET markdown_engine = ?, markdown_version = ? WHERE id = ?").run(
      input.engineId,
      input.markdownVersion,
      documentId,
    );
  });

  const insertBatch = db.transaction((scope: ChunkScope, chunks: readonly ChunkInsert[]) => {
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

  const markScopeComplete = db.transaction((scope: ChunkScope) => {
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
  });

  const removeDocument = db.transaction((hash: string): boolean => {
    const found = getDocumentStatement.get(hash);
    if (found === undefined) return false;
    const id = requireInteger(asRow(found, DOCUMENT_CONTEXT), "id", DOCUMENT_CONTEXT);
    db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id = ?)").run(id);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM document_markdown WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
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

  /**
   * Run something with this connection as the only one attached to the database.
   *
   * Reclaiming space is not merely slower with a second connection attached — it does not happen.
   * So exclusivity is established **before** anything is deleted: `BEGIN IMMEDIATE` under
   * `locking_mode = EXCLUSIVE` either succeeds, in which case nothing else can attach until it is
   * released, or raises `SQLITE_BUSY` having changed nothing at all. That ordering is what makes
   * the refusal safe: somebody who is told their document could not be forgotten still has it,
   * and can try again, rather than being left with a withdrawal that half happened and was
   * reported as done.
   *
   * `busy_timeout` still applies, so this waits for a passing writer rather than failing on one.
   */
  function withExclusiveAccess<T>(body: () => T): T {
    db.pragma("locking_mode = EXCLUSIVE");

    // A discriminated outcome rather than a nullable result, so the success value never has to be
    // asserted back into existence after the release step below.
    type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
    let outcome: Outcome;
    try {
      // Forces the transition; the lock is not taken until a transaction actually starts.
      db.exec("BEGIN IMMEDIATE; COMMIT;");
      outcome = { ok: true, value: body() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    try {
      db.pragma("locking_mode = NORMAL");
      // And released: the mode change only takes effect at the next transaction.
      db.exec("BEGIN IMMEDIATE; COMMIT;");
    } catch (releaseError) {
      // Not swallowed. A connection left in exclusive mode locks every other process out of the
      // index for the rest of its life, which is a worse outcome than the operation failing — so
      // when nothing else went wrong, this is the failure to report. When something else did, that
      // one is the more useful of the two and this would only hide it.
      if (outcome.ok) {
        const reason = releaseError instanceof Error ? releaseError.message : String(releaseError);
        throw new StoreDataError(`The index could not be returned to shared access: ${reason}`);
      }
    }

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  const wipe = db.transaction(() => {
    db.exec("DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM document_markdown; DELETE FROM documents;");
  });

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    diagnostics,

    getDocument(contentHash) {
      const row = getDocumentStatement.get(contentHash);
      return row === undefined ? null : toStoredDocument(row);
    },

    upsertDocument(input) {
      const now = clock().toISOString();
      const row = db
        .prepare(
          `INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,
             text_extraction_version,ocr_extraction_version,created_at,last_opened_at,
             markdown_engine,markdown_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(content_hash) DO UPDATE SET
             name = excluded.name, file_path = excluded.file_path, file_size = excluded.file_size,
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
          input.markdownEngine, input.markdownVersion,
        );
      return toStoredDocument(row);
    },

    beginChunkReplace(scope) {
      clearScope.immediate(scope);
    },

    markChunksComplete(scope) {
      markScopeComplete.immediate(scope);
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
      const context = "indexed chunk id";
      return db
        .prepare(
          `SELECT c.id FROM chunk_embeddings e
             JOIN document_chunks c ON c.id = e.chunk_id
            WHERE c.document_id = ? AND c.chunking_profile = ? AND c.chunking_version = ?
              AND e.model_id = ? AND e.model_version = ? AND e.dimensions = ?`,
        )
        .all(scope.documentId, scope.chunkingProfile, scope.chunkingVersion, scope.modelId, scope.modelVersion, scope.dimensions)
        .map((row) => requireString(asRow(row, context), "id", context));
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
      return withExclusiveAccess(() => {
        if (!removeDocument.immediate(contentHash)) return false;
        reclaimSpace();
        return true;
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
      withExclusiveAccess(() => {
        wipe.immediate();
        reclaimSpace();
      });
    },

    close() {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
