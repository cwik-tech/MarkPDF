/**
 * The schema exactly as the sql.js build created it (src/semanticIndex.ts initializeSchema).
 *
 * Copied verbatim and frozen. It is applied as migration 0 -> 1 so that a brand-new database
 * and a user's existing legacy file converge on byte-identical structure before any v2 change
 * runs. Do not "tidy" this string: its value is that it is the same text that produced every
 * database in the wild.
 */
export const LEGACY_V1_DDL = `
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      file_path TEXT,
      file_size INTEGER NOT NULL,
      page_count INTEGER NOT NULL,
      text_source TEXT NOT NULL,
      text_extraction_version INTEGER NOT NULL,
      ocr_extraction_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      chunking_profile TEXT NOT NULL,
      chunking_version INTEGER NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(chunk_id, model_id, model_version),
      FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON chunk_embeddings(model_id, model_version);
  `;
