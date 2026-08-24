import type { Database as Db } from "better-sqlite3";
import { LEGACY_V1_DDL } from "./legacySchema.js";
import { SchemaTooNewError } from "./errors.js";
import { pragmaInteger } from "./rows.js";

export const CURRENT_SCHEMA_VERSION = 4;

export interface MigrationReport {
  from: number;
  to: number;
  orphanEmbeddingsRemoved: number;
  orphanChunksRemoved: number;
}

/** v2 adds heading provenance, the Markdown cache, and an index matching the hot predicate. */
const V2_DDL = `
  ALTER TABLE documents ADD COLUMN markdown_engine TEXT;
  ALTER TABLE documents ADD COLUMN markdown_version INTEGER;
  ALTER TABLE document_chunks ADD COLUMN heading_path TEXT;

  CREATE TABLE IF NOT EXISTS document_markdown (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL,
    markdown_version INTEGER NOT NULL,
    markdown TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE INDEX IF NOT EXISTS idx_chunks_scope
    ON document_chunks(document_id, chunking_profile, chunking_version);
`;

/**
 * v3 records what became of each cached page, not only what its text was.
 *
 * Additive and nullable on purpose. `NULL` is the honest answer for every row written before this
 * column existed: those rows genuinely do not know whether an empty page was blank or unread, and a
 * default that claimed either would be a fact nobody established.
 */
const V3_DDL = `
  ALTER TABLE document_markdown ADD COLUMN page_provenance TEXT;
`;

/** v4 records completion per searchable chunk scope, rather than ambiguously per document. */
const V4_DDL = `
  CREATE TABLE chunk_scope_snapshots (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunking_profile TEXT NOT NULL,
    chunking_version INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    chunks_written_at TEXT NOT NULL,
    PRIMARY KEY (
      document_id, chunking_profile, chunking_version,
      model_id, model_version, dimensions
    )
  );
`;

function hasDocumentsTable(db: Db): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get();
  return row !== undefined;
}

/**
 * `user_version` is authoritative: it is readable before any table exists and it updates
 * atomically inside the migration transaction. The sql.js build never set it, so a legacy file
 * reads 0 — the `documents` table is what distinguishes "legacy" from "brand new".
 */
export function detectSchemaVersion(db: Db): number {
  const stamped = pragmaInteger(db.pragma("user_version", { simple: true }), "user_version");
  if (stamped > 0) return stamped;
  return hasDocumentsTable(db) ? 1 : 0;
}

export function migrate(db: Db): MigrationReport {
  const from = detectSchemaVersion(db);
  if (from > CURRENT_SCHEMA_VERSION) throw new SchemaTooNewError(from, CURRENT_SCHEMA_VERSION);

  const report: MigrationReport = { from, to: CURRENT_SCHEMA_VERSION, orphanEmbeddingsRemoved: 0, orphanChunksRemoved: 0 };
  if (from === CURRENT_SCHEMA_VERSION) return report;

  const run = db.transaction(() => {
    if (from < 1) db.exec(LEGACY_V1_DDL);

    if (from < 2) {
      db.exec(V2_DDL);
      // Foreign keys were never enabled under sql.js, so the declared cascades never fired.
      // Measured against a real index this had produced no orphans, because the delete path
      // removed embeddings explicitly — but the guarantee was never enforced, so sweep once
      // before turning enforcement on and report what was found rather than swallowing it.
      report.orphanEmbeddingsRemoved = db
        .prepare("DELETE FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM document_chunks)")
        .run().changes;
      report.orphanChunksRemoved = db
        .prepare("DELETE FROM document_chunks WHERE document_id NOT IN (SELECT id FROM documents)")
        .run().changes;
    }

    if (from < 3) db.exec(V3_DDL);
    if (from < 4) db.exec(V4_DDL);

    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run.immediate();

  return report;
}
