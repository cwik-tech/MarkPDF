import type { Database as Db } from "better-sqlite3";
import { LEGACY_V1_DDL } from "./legacySchema.js";
import { SchemaTooNewError, StoreUpgradeBusyError } from "./errors.js";
import { isBusyError, withExclusiveAccess } from "./exclusive.js";
import { pragmaInteger } from "./rows.js";

export const CURRENT_SCHEMA_VERSION = 5;

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

/**
 * v5 adds the exact-word index, and records how each document's path was obtained.
 *
 * The index is contentless: the text stays in `document_chunks`, and FTS5 keeps only its tokens.
 * Its rows are keyed by `chunk_text_keys`, whose `INTEGER PRIMARY KEY` survives `VACUUM`; the
 * implicit rowid of `document_chunks`, which has a text primary key, is not guaranteed to.
 *
 * Triggers keep the index equal to the table, so every write path — including ones added later —
 * maintains it without having to remember to. The key table has no foreign key on purpose: a
 * cascade could remove the key before the delete trigger reads it, and the trigger owning the key
 * row does not depend on `foreign_keys` being enforced on whichever connection did the delete.
 *
 * Chunks are immutable. An update would need a key that a row written before this version does not
 * have yet, and nothing has ever updated one.
 *
 * `path_provenance` is `resolved` only where the writer resolved the path and read the bytes from
 * it. Everything already stored is `NULL`, because nothing can now say how its path was obtained.
 */
const V5_DDL = `
  -- Created by v2, but a file can lack it, and the bookkeeping below depends on it.
  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  ALTER TABLE documents ADD COLUMN path_provenance TEXT;

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

  CREATE TRIGGER document_chunks_immutable BEFORE UPDATE OF id, text ON document_chunks BEGIN
    SELECT RAISE(ABORT, 'document_chunks id and text are immutable');
  END;

  INSERT INTO schema_meta(key, value)
    VALUES ('exact_index_state',
            CASE WHEN EXISTS (SELECT 1 FROM document_chunks) THEN 'backfilling' ELSE 'complete' END)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  INSERT INTO schema_meta(key, value) VALUES ('exact_index_cursor', '')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
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

/** The migration found a stored version that it may only upgrade with no other connection attached. */
const NEEDS_EXCLUSIVE = Symbol("needs exclusive access");

/**
 * Apply every step from the version found **under the write lock** to the current one.
 *
 * The version is read inside the transaction. Read before it, two processes that both saw an older
 * version would both apply the same steps, and the second would fail on a table the first created.
 * A process that finds the work already done does nothing.
 */
function applyMigration(db: Db, exclusive: boolean): MigrationReport | typeof NEEDS_EXCLUSIVE {
  const run = db.transaction((): MigrationReport | typeof NEEDS_EXCLUSIVE => {
    const from = detectSchemaVersion(db);
    if (from > CURRENT_SCHEMA_VERSION) throw new SchemaTooNewError(from, CURRENT_SCHEMA_VERSION);

    const report: MigrationReport = { from, to: CURRENT_SCHEMA_VERSION, orphanEmbeddingsRemoved: 0, orphanChunksRemoved: 0 };
    if (from === CURRENT_SCHEMA_VERSION) return report;
    // A file that already has a schema can be open in another process, under the old rules.
    if (from >= 1 && !exclusive) return NEEDS_EXCLUSIVE;

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
    if (from < 5) db.exec(V5_DDL);

    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    return report;
  });
  return run.immediate();
}

/**
 * Bring the database to the current schema.
 *
 * A brand-new file is created under the ordinary write lock: no other process can have it open
 * under older rules. An existing file is upgraded only with exclusive access. Measured: an older
 * MarkPDF that has the index open keeps writing after an upgrade, with its old forget — which does
 * not erase the exact-word index — so an upgrade that ran beside it would be a promise this build
 * could not keep. When another connection is attached, the upgrade refuses having changed nothing.
 */
export function migrate(db: Db): MigrationReport {
  return migrateFrom(db, detectSchemaVersion(db));
}

/**
 * `migrate`, for the version this connection observed before it took any lock.
 *
 * Separate so the rule "the observation is only a hint; the version under the lock decides" can be
 * tested with an observation that another process has since made stale.
 */
export function migrateFrom(db: Db, observed: number): MigrationReport {
  if (observed > CURRENT_SCHEMA_VERSION) throw new SchemaTooNewError(observed, CURRENT_SCHEMA_VERSION);
  if (observed === CURRENT_SCHEMA_VERSION) {
    return { from: observed, to: CURRENT_SCHEMA_VERSION, orphanEmbeddingsRemoved: 0, orphanChunksRemoved: 0 };
  }

  if (observed === 0) {
    const created = applyMigration(db, false);
    if (created !== NEEDS_EXCLUSIVE) return created;
  }

  let upgraded: MigrationReport | typeof NEEDS_EXCLUSIVE;
  try {
    upgraded = withExclusiveAccess(db, () => applyMigration(db, true));
  } catch (error) {
    if (isBusyError(error)) throw new StoreUpgradeBusyError(observed, CURRENT_SCHEMA_VERSION, { cause: error });
    throw error;
  }
  if (upgraded === NEEDS_EXCLUSIVE) throw new Error("The schema upgrade asked for exclusive access while holding it.");
  return upgraded;
}
