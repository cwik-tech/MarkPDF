import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { LEGACY_V1_DDL } from "./legacySchema.js";
import { openSemanticStore, SchemaTooNewError, CURRENT_SCHEMA_VERSION, type ChunkScope, type SemanticStore } from "./index.js";
import { OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";
import { semanticIndexPath } from "../paths.js";

let dataDir: string;
const opened: SemanticStore[] = [];

const FIXED_CLOCK = () => new Date("2026-08-22T12:00:00.000Z");

function open() {
  const store = openSemanticStore({ dataDir, clock: FIXED_CLOCK });
  opened.push(store);
  return store;
}

/** Open the real file directly. Tests inspect and seed through this, never through a widened
 *  production interface. */
function connectDirectly() {
  const path = semanticIndexPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

function scopeFor(documentId: number): ChunkScope {
  return { documentId, chunkingProfile: "balanced", chunkingVersion: 2, modelId: "m", modelVersion: "v", dimensions: 2 };
}

function chunk(id: string, page: number, index: number, text: string) {
  return { id, page, index, text, headingPath: ["Section"], vector: Float32Array.from([1, 0]) };
}

/** A database in exactly the shape the sql.js build leaves behind: v1 DDL, user_version 0. */
function seedLegacyDatabase(options: { orphanEmbeddings?: number } = {}) {
  const db = connectDirectly();
  // Reproduce the legacy condition faithfully: sql.js never enabled foreign_keys, which is
  // precisely why orphan rows were possible. better-sqlite3 enables it by default, so the
  // fixture must turn it off to create the damage the sweep is meant to find.
  db.pragma("foreign_keys = OFF");
  db.exec(LEGACY_V1_DDL);
  db.prepare(
    `INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,
       text_extraction_version,ocr_extraction_version,created_at,last_opened_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("legacyhash", "legacy.pdf", "/tmp/legacy.pdf", 10, 2, "pdf", 1, 1, "2026-01-01", "2026-01-01");
  const row = db.prepare("SELECT id FROM documents WHERE content_hash = ?").get("legacyhash") as { id: number };
  db.prepare(
    `INSERT INTO document_chunks (id,document_id,page_number,chunk_index,text,chunking_profile,chunking_version)
     VALUES (?,?,?,?,?,?,?)`,
  ).run("legacyhash:balanced:1:1:0", row.id, 1, 0, "legacy chunk text", "balanced", 1);
  for (let i = 0; i < (options.orphanEmbeddings ?? 0); i += 1) {
    db.prepare(
      `INSERT INTO chunk_embeddings (chunk_id,model_id,model_version,dimensions,vector,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`ghost-chunk-${i}`, "m", "v", 2, Buffer.alloc(8), "2026-01-01");
  }
  db.close();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-store-"));
});
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("opening the semantic store", () => {
  it("creates a current-version database with write-ahead logging enabled", () => {
    const store = open();
    expect(store.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.diagnostics.journalMode).toBe("wal");
    expect(store.diagnostics.concurrencyDegraded).toBe(false);
  });

  it("refuses a database written by a newer MarkPDF instead of migrating it downward", () => {
    const db = connectDirectly();
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 7}`);
    db.close();
    expect(() => open()).toThrow(SchemaTooNewError);
  });

  it("closes the connection when the database cannot be opened, leaving no write-ahead log behind", () => {
    // A refused open still connected, set WAL, and created the -wal and -shm sidecars before
    // migrate threw. Without an explicit close the handle survives for the life of the process,
    // holding those sidecars open, keeping the file locked against another writer, and — on
    // Windows — making the file undeletable. SQLite removes both on the last clean close, so
    // their absence is the observable proof the handle went away.
    const db = connectDirectly();
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 7}`);
    db.close();

    expect(() => open()).toThrow(SchemaTooNewError);

    const path = semanticIndexPath(dataDir);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("closes the connection when a database claims the current schema but cannot support it", () => {
    // The gap the previous test did not reach. `migrate` returns immediately when the stamped
    // version already equals the current one, so a file stamped v2 whose tables are wrong sails
    // past migration and fails later, while the store is preparing its statements. That is
    // still initialisation — the store has not been returned and no caller can close it — so
    // the connection has to be released here or it leaks for the life of the process.
    const db = connectDirectly();
    db.pragma("journal_mode = WAL");
    // Present, so nothing treats this as a legacy or brand-new file, but missing the column
    // every lookup is keyed by. `document_chunks` is absent altogether.
    db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, unrelated TEXT);");
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.close();

    expect(() => open()).toThrow(/content_hash|document_chunks|no such/i);

    const path = semanticIndexPath(dataDir);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("stamps timestamps from the injected clock rather than the wall clock", () => {
    const store = open();
    const doc = store.upsertDocument({
      contentHash: "hc", name: "c.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });
    expect(doc.createdAt).toBe("2026-08-22T12:00:00.000Z");
  });
});

describe("migrating a database left behind by the sql.js build", () => {
  it("upgrades it in place and keeps the rows the user already had", () => {
    seedLegacyDatabase();
    const store = open();
    expect(store.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.getDocument("legacyhash")?.name).toBe("legacy.pdf");
    expect(store.info().chunkCount).toBe(1);
  });

  it("keeps a Markdown cache written before pages recorded their outcome, and admits it knows nothing about them", () => {
    // A v2 database, written out here rather than imported, so this is an independent statement of
    // the shape being migrated from. Importing production's own DDL would make the test agree with
    // the migration by construction.
    const db = connectDirectly();
    db.exec(LEGACY_V1_DDL);
    db.exec(`
      ALTER TABLE documents ADD COLUMN markdown_engine TEXT;
      ALTER TABLE documents ADD COLUMN markdown_version INTEGER;
      ALTER TABLE document_chunks ADD COLUMN heading_path TEXT;
      CREATE TABLE document_markdown (
        document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        engine_id TEXT NOT NULL,
        markdown_version INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,
         text_extraction_version,ocr_extraction_version,created_at,last_opened_at,
         markdown_engine,markdown_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("v2hash", "older.pdf", "/tmp/older.pdf", 10, 2, "pdf", 2, 1, "2026-01-01", "2026-01-01", "pdf-inspector", 1);
    const document = db.prepare("SELECT id FROM documents WHERE content_hash = ?").get("v2hash") as { id: number };
    db.prepare(
      `INSERT INTO document_markdown (document_id,engine_id,markdown_version,markdown,created_at)
       VALUES (?,?,?,?,?)`,
    ).run(
      document.id,
      "pdf-inspector",
      1,
      "<!-- markpdf:page 1 len 5 -->\nfirst<!-- markpdf:page 2 len 0 -->\n",
      "2026-01-01",
    );
    db.pragma("user_version = 2");
    db.close();

    const store = open();

    expect(store.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const cached = store.getMarkdown(document.id, "pdf-inspector", 1);
    // The text survives the upgrade untouched — nothing is re-extracted and nothing is discarded.
    expect(cached?.pages).toEqual([
      { page: 1, markdown: "first" },
      { page: 2, markdown: "" },
    ]);
    // And the row says it does not know why page 2 is empty, rather than claiming it was read. That
    // silence is what sends a later reader back for the page instead of serving it as blank.
    expect(cached?.provenance).toBeNull();
  });

  it("sweeps embedding rows orphaned while foreign keys were never enforced", () => {
    seedLegacyDatabase({ orphanEmbeddings: 3 });
    const store = open();
    expect(store.diagnostics.migration.orphanEmbeddingsRemoved).toBe(3);

    const db = connectDirectly();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

describe("the version columns a document row records", () => {
  it("records the extraction versions the pipeline actually used, not a hardcoded number", () => {
    // The store records what the caller says and hardcodes nothing. It cannot know how the text
    // was produced, so stamping a constant of its own would put a claim on the row that nothing
    // backs up — and would make a later genuine bump indistinguishable from it.
    const store = open();
    const textExtractionVersion = TEXT_EXTRACTION_VERSION + 7;
    const ocrExtractionVersion = OCR_EXTRACTION_VERSION + 7;
    store.upsertDocument({
      contentHash: "v".repeat(64), name: "v.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion, ocrExtractionVersion, markdownEngine: null, markdownVersion: null,
    });

    const db = connectDirectly();
    const row = db
      .prepare("SELECT text_extraction_version, ocr_extraction_version, markdown_engine, markdown_version FROM documents LIMIT 1")
      .get() as Record<string, unknown>;
    db.close();

    expect(row.text_extraction_version).toBe(textExtractionVersion);
    expect(row.ocr_extraction_version).toBe(ocrExtractionVersion);
    // No Markdown is cached in Phase 1, so nothing may claim a Markdown engine or version.
    expect(row.markdown_engine).toBeNull();
    expect(row.markdown_version).toBeNull();
  });
});

describe("reporting index size", () => {
  it("counts the write-ahead log alongside the database, so the figure matches disk usage", () => {
    // Under WAL, committed data lives in the -wal sidecar until a checkpoint. Reporting only
    // page_count * page_size understates what the index actually occupies, sometimes badly
    // after a large import.
    const store = open();
    for (let i = 0; i < 40; i += 1) {
      const doc = store.upsertDocument({
        contentHash: `size${String(i).padStart(60, "0")}`, name: `d${i}.pdf`, filePath: null,
        fileSize: 1, pageCount: 1, textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
      });
      store.replaceChunks(scopeFor(doc.id), [chunk(`size${i}:balanced:2:1:0`, 1, 0, "x".repeat(400))]);
    }

    const path = semanticIndexPath(dataDir);
    const onDisk = ["", "-wal", "-shm"].reduce((total, suffix) => {
      try {
        return total + statSync(`${path}${suffix}`).size;
      } catch {
        return total;
      }
    }, 0);

    expect(store.info().sizeBytes).toBe(onDisk);
  });
});

describe("deleting a document", () => {
  it("removes its chunks and embeddings too, which is what withdrawal of consent requires", () => {
    const store = open();
    const doc = store.upsertDocument({
      contentHash: "h1", name: "a.pdf", filePath: "/tmp/a.pdf", fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });
    store.replaceChunks(scopeFor(doc.id), [chunk("h1:balanced:2:1:0", 1, 0, "hello")]);
    expect(store.info().chunkCount).toBe(1);

    expect(store.deleteDocument("h1")).toBe(true);

    const info = store.info();
    expect(info.documentCount).toBe(0);
    expect(info.chunkCount).toBe(0);
    expect(info.embeddingCount).toBe(0);
  });

  it("enforces foreign keys on the store's own connection, not only on other writers", () => {
    // The cascade test below deletes through an independent connection, and foreign-key
    // enforcement is per-connection — so it proves better-sqlite3's default, not this store's
    // pragma. Assert the store's own connection separately, or `foreign_keys = ON` in
    // openSemanticStore could be changed to OFF with every other test still passing.
    //
    // What this does not prove: that removing the pragma line breaks anything. It does not,
    // because better-sqlite3 enables foreign keys by default (measured in Stage 0). The line
    // exists so the guarantee survives a driver whose default differs, and this assertion is
    // what makes flipping it to OFF visible.
    expect(open().diagnostics.foreignKeysEnforced).toBe(true);
  });

  it("cascades through both levels when a documents row is removed by another writer", () => {
    // The ON DELETE CASCADE clauses have been declared since the beginning but were inert,
    // because sql.js never enabled enforcement. Removing the parent row from an independent
    // connection proves the declaration is now real rather than decorative.
    const store = open();
    const doc = store.upsertDocument({
      contentHash: "h2", name: "b.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });
    store.replaceChunks(scopeFor(doc.id), [chunk("h2:balanced:2:1:0", 1, 0, "hi")]);

    const db = connectDirectly();
    db.exec("DELETE FROM documents WHERE content_hash = 'h2'");
    db.close();

    const info = store.info();
    expect(info.chunkCount).toBe(0);
    expect(info.embeddingCount).toBe(0);
  });
});

describe("an interrupted index", () => {
  it("leaves a partial state that counts as incomplete and can be retried without colliding", () => {
    // This is the invariant that makes beginChunkReplace/insertChunkBatch safe as a pair:
    // embedding happens between them, outside any transaction, so a crash can land a partial
    // index. Two things must hold. Completeness is derived by counting rather than stamped, so
    // a partial index is not mistaken for a finished one. And beginChunkReplace must clear the
    // scope, so the retry re-inserts the same deterministic chunk ids without a primary-key
    // collision.
    const store = open();
    const doc = store.upsertDocument({
      contentHash: "h3", name: "d.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });
    const scope = scopeFor(doc.id);
    const all = [
      chunk("h3:balanced:2:1:0", 1, 0, "one"),
      chunk("h3:balanced:2:1:1", 1, 1, "two"),
      chunk("h3:balanced:2:2:0", 2, 0, "three"),
    ];

    store.beginChunkReplace(scope);
    store.insertChunkBatch(scope, all.slice(0, 1)); // interrupted here

    expect(store.countIndexedChunks(scope)).toBeLessThan(all.length);

    // The retry uses the same ids. Without a working clear this throws UNIQUE constraint.
    store.beginChunkReplace(scope);
    store.insertChunkBatch(scope, all);

    expect(store.countIndexedChunks(scope)).toBe(all.length);
  });

  it("discards chunks left by a superseded chunking version", () => {
    const store = open();
    const doc = store.upsertDocument({
      contentHash: "h4", name: "e.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });
    const oldScope = { ...scopeFor(doc.id), chunkingVersion: 1 };
    store.replaceChunks(oldScope, [chunk("h4:balanced:1:1:0", 1, 0, "stale")]);
    expect(store.info().chunkCount).toBe(1);

    store.beginChunkReplace(scopeFor(doc.id));

    expect(store.info().chunkCount).toBe(0);
  });
});

describe("a second operating-system process", () => {
  // Note what this does and does not prove. It shows two OS processes writing to the same
  // index file through WAL without either failing. It does NOT hold an open write transaction
  // in the parent, so it does not exercise busy_timeout, and there is no retry or backoff in
  // the store to exercise. Contention behaviour under a held write lock is untested.
  it("can write to the index file while this process has it open", () => {
    const store = open();
    store.upsertDocument({
      contentHash: "parent", name: "p.pdf", filePath: null, fileSize: 1, pageCount: 1,
      textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
    });

    const path = semanticIndexPath(dataDir);
    const child = `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new Database(${JSON.stringify(path)});
      db.pragma("busy_timeout = 5000");
      db.prepare("INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,text_extraction_version,ocr_extraction_version,created_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run("child", "child.pdf", null, 1, 1, "pdf", 2, 1, "2026-01-01", "2026-01-01");
      db.close();
    `;
    execFileSync(process.execPath, ["-e", child], { encoding: "utf8" });

    expect(store.getDocument("child")).not.toBeNull();
    expect(store.getDocument("parent")).not.toBeNull();
  });
});
