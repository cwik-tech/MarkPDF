import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { LEGACY_V1_DDL } from "./legacySchema.js";
import { migrateFrom } from "./schema.js";
import { openSemanticStore, StoreUpgradeBusyError, type SemanticStore } from "./index.js";
import { semanticIndexPath } from "../paths.js";
import { createDeterministicEmbedder } from "../index/deterministicEmbedder.js";
import { completeExactIndex } from "../index/exactIndexBackfill.js";
import { activeChunkScopeContract, searchDocument } from "../index/search.js";
import { semanticChunkingVersion, modelVersion } from "../models.js";
import { vectorToBlob } from "./vector.js";

/**
 * An index written before the exact-word index existed, opened by this build.
 *
 * The version 4 shape is written out here rather than imported, so this is an independent statement
 * of the file being upgraded. Its chunks are real rows with real embeddings, so the search that runs
 * afterwards is the one a person who upgraded would run.
 */

const embedder = createDeterministicEmbedder(384);
const contract = activeChunkScopeContract(embedder, "balanced");

let dataDir: string;
const opened: SemanticStore[] = [];

function open(): SemanticStore {
  const store = openSemanticStore({ dataDir });
  opened.push(store);
  return store;
}

function connectDirectly(): Database.Database {
  const path = semanticIndexPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

const V2_TO_V4 = `
  ALTER TABLE documents ADD COLUMN markdown_engine TEXT;
  ALTER TABLE documents ADD COLUMN markdown_version INTEGER;
  ALTER TABLE document_chunks ADD COLUMN heading_path TEXT;
  CREATE TABLE document_markdown (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL, markdown_version INTEGER NOT NULL, markdown TEXT NOT NULL,
    created_at TEXT NOT NULL, page_provenance TEXT
  );
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX idx_chunks_scope ON document_chunks(document_id, chunking_profile, chunking_version);
  CREATE TABLE chunk_scope_snapshots (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunking_profile TEXT NOT NULL, chunking_version INTEGER NOT NULL, model_id TEXT NOT NULL,
    model_version TEXT NOT NULL, dimensions INTEGER NOT NULL, chunks_written_at TEXT NOT NULL,
    PRIMARY KEY (document_id, chunking_profile, chunking_version, model_id, model_version, dimensions)
  );
`;

/** A version 4 file with one document per entry, each holding the given chunk texts on page 1. */
async function writeVersion4(documents: ReadonlyArray<{ hash: string; chunks: readonly string[] }>): Promise<void> {
  const db = connectDirectly();
  db.pragma("journal_mode = WAL");
  db.exec(LEGACY_V1_DDL);
  db.exec(V2_TO_V4);
  for (const document of documents) {
    const row = db
      .prepare(
        `INSERT INTO documents (content_hash,name,file_path,file_size,page_count,text_source,
           text_extraction_version,ocr_extraction_version,created_at,last_opened_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(document.hash, `${document.hash}.pdf`, `/library/${document.hash}.pdf`, 10, 1, "pdf", 2, 2, "2026-01-01", "2026-01-01");
    const documentId = Number(Reflect.get(Object(row), "id"));
    for (const [index, text] of document.chunks.entries()) {
      const id = `${document.hash}:${String(index).padStart(5, "0")}`;
      db.prepare(
        `INSERT INTO document_chunks (id,document_id,page_number,chunk_index,text,chunking_profile,chunking_version,heading_path)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, documentId, 1, index, text, contract.chunkingProfile, semanticChunkingVersion, "[]");
      db.prepare(
        `INSERT INTO chunk_embeddings (chunk_id,model_id,model_version,dimensions,vector,created_at) VALUES (?,?,?,?,?,?)`,
      ).run(id, contract.modelId, modelVersion, contract.dimensions, vectorToBlob(await embedder.embed(text, "passage")), "2026-01-01");
    }
  }
  db.pragma("user_version = 4");
  db.close();
}

function userVersion(): number {
  const db = connectDirectly();
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-upgrade-"));
});

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("opening an index written before the exact-word index", () => {
  it("finds a word that was indexed before the upgrade with an exact search", async () => {
    await writeVersion4([{ hash: "a".repeat(64), chunks: ["The tenant pays rent quarterly in advance."] }]);

    const store = open();
    const results = await searchDocument(store, embedder, {
      contentHash: "a".repeat(64), query: "quarterly", chunkingProfile: "balanced", mode: "exact", minScore: 0,
    });

    expect(results.map((hit) => hit.page)).toEqual([1]);
    expect(store.exactIndexState()).toBe("complete");
  });
});

describe("the upgrade protocol", () => {
  it("refuses to upgrade while another connection has the index open, and changes nothing", async () => {
    await writeVersion4([{ hash: "a".repeat(64), chunks: ["words"] }]);
    const other = connectDirectly();
    other.prepare("SELECT count(*) AS n FROM documents").get();

    try {
      expect(() => open()).toThrow(StoreUpgradeBusyError);
      expect(userVersion()).toBe(4);
    } finally {
      other.close();
    }

    // Once the other connection has gone, the same open upgrades.
    expect(open().exactIndexState()).toBe("backfilling");
  }, 30_000);

  it("does nothing when another process finished the upgrade after this one read the old version", async () => {
    await writeVersion4([{ hash: "a".repeat(64), chunks: ["words"] }]);
    const late = connectDirectly();
    // This connection read version 4 before the other process upgraded.
    expect(Number(late.pragma("user_version", { simple: true }))).toBe(4);
    late.close();
    open().close();

    const again = connectDirectly();
    try {
      expect(() => migrateFrom(again, 4)).not.toThrow();
      expect(Number(again.pragma("user_version", { simple: true }))).toBe(5);
    } finally {
      again.close();
    }
  }, 30_000);
});

describe("backfilling the exact-word index", () => {
  it("indexes a document larger than one batch, in bounded batches", async () => {
    const chunks = Array.from({ length: 1_203 }, (_unused, index) => `entry ${index} of the register`);
    chunks[1_100] = "entry with the rare word quincunx";
    await writeVersion4([{ hash: "b".repeat(64), chunks }]);
    const store = open();

    const batches: number[] = [];
    await completeExactIndex(store, { batchSize: 500, onProgress: (indexed) => batches.push(indexed) });

    expect(store.exactIndexState()).toBe("complete");
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.every((indexed) => indexed <= 500)).toBe(true);
    const ids = store.rankExact({ scope: contract, documentIds: [1], match: `"quincunx"`, depth: 10 }).map((hit) => hit.id);
    expect(ids).toEqual([`${"b".repeat(64)}:01100`]);
  });

  it("repairs chunks that a finished pass left behind, before it calls the index complete", async () => {
    await writeVersion4([
      { hash: "c".repeat(64), chunks: ["first document words"] },
      { hash: "d".repeat(64), chunks: ["second document words", "a stray marmoset"] },
    ]);
    const store = open();
    await completeExactIndex(store, { batchSize: 500 });

    // Simulate a gap: a chunk whose key and index rows went missing, with the cursor already past it.
    const db = connectDirectly();
    db.exec(`
      DELETE FROM chunk_text_fts WHERE rowid = (SELECT fts_rowid FROM chunk_text_keys WHERE chunk_id = '${"d".repeat(64)}:00001');
      DELETE FROM chunk_text_keys WHERE chunk_id = '${"d".repeat(64)}:00001';
      UPDATE schema_meta SET value = 'backfilling' WHERE key = 'exact_index_state';
      UPDATE schema_meta SET value = '[999,"z"]' WHERE key = 'exact_index_cursor';
    `);
    db.close();

    await completeExactIndex(store, { batchSize: 500 });

    expect(store.exactIndexState()).toBe("complete");
    expect(store.rankExact({ scope: contract, documentIds: [1, 2], match: `"marmoset"`, depth: 10 }).map((hit) => hit.id)).toEqual([
      `${"d".repeat(64)}:00001`,
    ]);
  });

  it("stops between batches when it is cancelled, and a later run finishes", async () => {
    const chunks = Array.from({ length: 1_000 }, (_unused, index) => `line ${index}`);
    await writeVersion4([{ hash: "e".repeat(64), chunks }]);
    const store = open();
    const controller = new AbortController();

    await completeExactIndex(store, {
      batchSize: 100,
      signal: controller.signal,
      yieldControl: async () => {
        controller.abort();
      },
    });
    expect(store.exactIndexState()).toBe("backfilling");

    await completeExactIndex(store, { batchSize: 100 });
    expect(store.exactIndexState()).toBe("complete");
  });

  it("has nothing left to do after the index is cleared", async () => {
    await writeVersion4([{ hash: "f".repeat(64), chunks: ["words to clear"] }]);
    const store = open();
    expect(store.exactIndexState()).toBe("backfilling");

    store.clear();

    expect(store.exactIndexState()).toBe("complete");
    await expect(completeExactIndex(store, { batchSize: 10 })).resolves.toBeUndefined();
  });
});
