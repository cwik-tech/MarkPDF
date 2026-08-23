import type { Database as Db } from "better-sqlite3";
import { LEGACY_V1_DDL } from "./legacySchema.js";
import { SchemaTooNewError } from "./errors.js";
import { pragmaInteger } from "./rows.js";

export const CURRENT_SCHEMA_VERSION = 2;

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

    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run.immediate();

  return report;
}
