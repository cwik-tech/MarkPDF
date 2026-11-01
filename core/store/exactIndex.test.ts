import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openSemanticStore, type ChunkScope, type ChunkScopeContract, type SemanticStore } from "./index.js";
import { semanticIndexPath } from "../paths.js";

/**
 * The exact-word index stays equal to the chunk table.
 *
 * Every public write is exercised, because the index is maintained by triggers on the table and a
 * write path that bypassed them would leave words searchable that the store no longer holds — or
 * leave stored words unsearchable. The expected results are the words each test wrote.
 */

let dataDir: string;
let store: SemanticStore;

const CLAIM_CACHE = { engineId: "pdf-inspector", markdownVersion: 1, pages: [{ page: 1, markdown: "One page." }] };

const CONTRACT: ChunkScopeContract = { chunkingProfile: "balanced", chunkingVersion: 2, modelId: "m", modelVersion: "v", dimensions: 2 };

function scopeFor(documentId: number, overrides: Partial<ChunkScopeContract> = {}): ChunkScope {
  return { documentId, ...CONTRACT, ...overrides };
}

function chunk(id: string, text: string, page = 1, index = 0) {
  return { id, page, index, text, headingPath: [], vector: Float32Array.from([1, 0]) };
}

function addDocument(hash: string): number {
  return store.upsertDocument({
    contentHash: hash, name: `${hash}.pdf`, filePath: `/library/${hash}.pdf`, fileSize: 1, pageCount: 1,
    textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 1, markdownEngine: null, markdownVersion: null,
  }).id;
}

function exact(match: string, documentIds: number[], contract: ChunkScopeContract = CONTRACT): string[] {
  return store.rankExact({ scope: contract, documentIds, match, depth: 50 }).map((candidate) => candidate.id);
}

function connectDirectly(): Database.Database {
  const path = semanticIndexPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

function countOf(db: Database.Database, sql: string): number {
  return Number(Reflect.get(Object(db.prepare(sql).get()), "n"));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-exact-index-"));
  store = openSemanticStore({ dataDir });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("keeping the exact-word index equal to the chunks", () => {
  it("finds the words of a chunk as soon as it is stored", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:1", "The lessee pays quarterly rent")]);

    expect(exact(`"quarterly"`, [id])).toEqual(["a:1"]);
  });

  it("stops finding a word once a re-index has replaced the chunk that held it", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:old", "obsolete wording about tenancy")]);

    store.beginChunkReplace(scopeFor(id));
    store.insertChunkBatch(scopeFor(id), [chunk("a:new", "current wording about leasing")]);

    expect(exact(`"obsolete"`, [id])).toEqual([]);
    expect(exact(`"leasing"`, [id])).toEqual(["a:new"]);
  });

  it("does the same through replaceChunks", () => {
    const id = addDocument("a");
    store.replaceChunks(scopeFor(id), [chunk("a:old", "superseded clause text")]);
    store.replaceChunks(scopeFor(id), [chunk("a:new", "replacement clause text")]);

    expect(exact(`"superseded"`, [id])).toEqual([]);
    expect(exact(`"replacement"`, [id])).toEqual(["a:new"]);
  });

  it.each([
    ["deleteDocument", (target: SemanticStore) => target.deleteDocument("gone")],
    ["forgetDocument", (target: SemanticStore) => target.forgetDocument("gone")],
    ["clear", (target: SemanticStore) => target.clear()],
  ])("stops finding a removed document's words after %s", (_name, remove) => {
    const gone = addDocument("gone");
    const kept = addDocument("kept");
    store.insertChunkBatch(scopeFor(gone), [chunk("gone:1", "marmalade invoice")]);
    store.insertChunkBatch(scopeFor(kept), [chunk("kept:1", "marmalade receipt")]);

    remove(store);

    expect(exact(`"invoice"`, [gone, kept])).toEqual([]);
  });

  it("holds exactly one index row and one key for each chunk after every kind of write", () => {
    const a = addDocument("a");
    const b = addDocument("b");
    store.insertChunkBatch(scopeFor(a), [chunk("a:1", "one"), chunk("a:2", "two", 1, 1)]);
    store.replaceChunks(scopeFor(b), [chunk("b:1", "three")]);
    store.beginChunkReplace(scopeFor(a));
    store.insertChunkBatch(scopeFor(a), [chunk("a:3", "four")]);
    store.deleteDocument("b");

    const db = connectDirectly();
    try {
      const chunks = countOf(db, "SELECT count(*) AS n FROM document_chunks");
      expect(chunks).toBe(1);
      expect(countOf(db, "SELECT count(*) AS n FROM chunk_text_keys")).toBe(chunks);
      expect(countOf(db, "SELECT count(*) AS n FROM chunk_text_fts")).toBe(chunks);
    } finally {
      db.close();
    }
  });

  it("does not let a new chunk inherit a deleted chunk's words when its key is reused", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:old", "alpha")]);
    store.beginChunkReplace(scopeFor(id));
    store.insertChunkBatch(scopeFor(id), [chunk("a:new", "beta")]);

    expect(exact(`"alpha"`, [id])).toEqual([]);
    expect(exact(`"beta"`, [id])).toEqual(["a:new"]);
  });

  it("refuses to change the text or the identity of a stored chunk", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:1", "original words")]);

    const db = connectDirectly();
    try {
      expect(() => db.prepare("UPDATE document_chunks SET text = 'other words' WHERE id = 'a:1'").run()).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE document_chunks SET id = 'a:2' WHERE id = 'a:1'").run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
    expect(exact(`"original"`, [id])).toEqual(["a:1"]);
  });
});

describe("ranking by exact words", () => {
  it("returns only chunks of the documents it was asked about", () => {
    const a = addDocument("a");
    const b = addDocument("b");
    store.insertChunkBatch(scopeFor(a), [chunk("a:1", "shared phrase")]);
    store.insertChunkBatch(scopeFor(b), [chunk("b:1", "shared phrase")]);

    expect(exact(`"shared"`, [b])).toEqual(["b:1"]);
  });

  it("returns only chunks embedded under the active model, its version and its width", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:active", "covenant wording")]);
    store.insertChunkBatch(scopeFor(id, { modelId: "other" }), [chunk("a:other-model", "covenant wording again", 1, 1)]);
    store.insertChunkBatch(scopeFor(id, { modelVersion: "old" }), [chunk("a:old-version", "covenant wording once more", 1, 2)]);

    expect(exact(`"covenant"`, [id])).toEqual(["a:active"]);
  });

  it("returns only chunks of the active chunking profile and version", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:balanced", "indemnity wording")]);
    store.insertChunkBatch(scopeFor(id, { chunkingProfile: "precise" }), [chunk("a:precise", "indemnity wording", 1, 1)]);

    expect(exact(`"indemnity"`, [id])).toEqual(["a:balanced"]);
  });

  it("puts the chunk that uses the words more often first, and breaks a tie by chunk id", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [
      chunk("a:3", "rent is due"),
      chunk("a:1", "rent rent rent is due", 1, 1),
      chunk("a:2", "rent is due", 1, 2),
    ]);

    expect(exact(`"rent"`, [id])).toEqual(["a:1", "a:2", "a:3"]);
  });

  it("reports that the index is complete for a store that began empty", () => {
    expect(store.exactIndexState()).toBe("complete");
  });
});

// The completion claim is not part of what an exact search reads, but it must survive the
// triggers: a claim written in the same transaction as chunk writes is the existing contract.
describe("existing claims", () => {
  it("still lets a finished scope claim completion", () => {
    const id = addDocument("a");
    store.insertChunkBatch(scopeFor(id), [chunk("a:1", "words")]);
    expect(store.completeChunkScope(scopeFor(id), { chunkIds: ["a:1"], cache: CLAIM_CACHE })).toBe("claimed");
  });
});
