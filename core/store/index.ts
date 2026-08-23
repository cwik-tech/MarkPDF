import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { semanticIndexPath } from "../paths.js";
import { CURRENT_SCHEMA_VERSION, migrate, type MigrationReport } from "./schema.js";
import { SchemaTooNewError, StoreDataError } from "./errors.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "./vector.js";
import { indexSizeOnDisk } from "./size.js";
import { OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";
import {
  asRow, countFrom, parseHeadingPath, pragmaInteger, pragmaText,
  requireBlob, requireInteger, requireNullableString, requireString,
} from "./rows.js";

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

export interface ChunkInsert {
  id: string;
  page: number;
  index: number;
  text: string;
  headingPath: string[];
  vector: Float32Array;
}

export interface ScoredChunk {
  id: string;
  page: number;
  snippet: string;
  score: number;
  headingPath: string[];
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
  upsertDocument(input: UpsertDocumentInput): StoredDocument;
  /**
   * Clear this document's chunks for the current scope and every superseded version.
   *
   * Paired with `insertChunkBatch` so that embedding — which is asynchronous and slow — never
   * happens inside a transaction. The gap between the two is safe because completeness is
   * derived rather than stamped: `listIndexedChunkIds` is compared against the identifiers the
   * document is expected to produce, so a partial or differently-distributed set re-indexes on
   * next open. Counting alone is not sufficient — see `indexDocument`.
   */
  beginChunkReplace(scope: ChunkScope): void;
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
  deleteDocument(contentHash: string): boolean;
  listDocuments(limit?: number): StoredDocument[];
  info(): StoreInfo;
  clear(): void;
  close(): void;
}

const DOCUMENT_CONTEXT = "documents row";

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
  db.pragma("temp_store = MEMORY");

  const migration = migrate(db);

  const diagnostics: StoreDiagnostics = {
    journalMode,
    concurrencyDegraded: journalMode !== "wal",
    foreignKeysEnforced,
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
             markdown_engine = excluded.markdown_engine, markdown_version = excluded.markdown_version
           RETURNING *`,
        )
        .get(
          input.contentHash, input.name, input.filePath, input.fileSize, input.pageCount,
          input.textSource, TEXT_EXTRACTION_VERSION, OCR_EXTRACTION_VERSION, now, now,
          input.markdownEngine, input.markdownVersion,
        );
      return toStoredDocument(row);
    },

    beginChunkReplace(scope) {
      clearScope.immediate(scope);
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
        hits.push({
          id: requireString(row, "id", context),
          page: requireInteger(row, "page_number", context),
          snippet: requireString(row, "text", context),
          score,
          headingPath: parseHeadingPath(row.heading_path),
        });
      }

      // Rank by score, keep the top K, then present in reading order — the ordering the
      // results panel already relies on.
      return hits
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .sort((a, b) => a.page - b.page || b.score - a.score);
    },

    deleteDocument(contentHash) {
      return removeDocument.immediate(contentHash);
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
      wipe.immediate();
      db.exec("VACUUM");
    },

    close() {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
