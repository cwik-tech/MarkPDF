import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSemanticStore, type SemanticStore } from "./index.js";
import { semanticIndexPath } from "../paths.js";
import { indexDocument } from "../index/indexDocument.js";
import { createDeterministicEmbedder } from "../index/deterministicEmbedder.js";
import { expectIndexed } from "../index/indexResult.test-support.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";

/**
 * Forgetting a document, and meaning it.
 *
 * Deletion here is withdrawal of consent. Someone who indexed a document and changed their mind
 * is entitled to have it gone, and a row removed from a B-tree whose bytes are still sitting in a
 * freed page is not gone — anyone with the file can read it out.
 *
 * The test therefore does not ask the database what it thinks. It reads the file as bytes and
 * looks for the phrase.
 *
 * Two mechanisms protect this and they are individually redundant, which mutation testing shows
 * plainly: removing both `secure_delete` and the reclaim step fails this test, while removing
 * either one alone does not. `secure_delete` zeroes freed content at delete time, and `VACUUM`
 * rewrites the file without the freed pages at all — each is sufficient here. Both are kept
 * because they fail differently: `secure_delete` is a pragma another connection could open
 * without, and `VACUUM` is a whole-file rewrite that a crash could interrupt.
 *
 * **Neither works while another connection is attached**, which is the case the last group covers
 * with two real connections rather than a description. In write-ahead-log mode a checkpoint
 * cannot run past an open reader: it returns `{ busy: 1 }` — it does not raise — so a
 * reclaim that ignored the result would report success with the text still sitting in the log.
 */

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder(384);

/** Distinctive enough that finding it in a 5 MB file cannot be a coincidence. */
const SECRET = "Vermilion-Kestrel-Quinoa-8842-Antarctic";

async function indexSecret(): Promise<string> {
  const bytes = new TextEncoder().encode("a document to be forgotten");
  const text = `Confidential memorandum. The project code name is ${SECRET} and it is not public.`;
  const result = expectIndexed(
    await indexDocument(store, embedder, {
      bytes,
      name: "memo.pdf",
      filePath: "/Users/someone/Private/memo.pdf",
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text, source: "pdf" }],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: [{ page: 1, markdown: text }],
      },
    }),
  );
  return result.contentHash;
}

/** Every byte the index occupies on disk, database and write-ahead log alike. */
function indexBytes(): string {
  const path = semanticIndexPath(dataDir);
  const parts = [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
  return parts.map((file) => readFileSync(file).toString("latin1")).join("");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-forget-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the guarantee the store is configured with", () => {
  it("reports that overwrite-on-delete is enabled on its own connection", () => {
    // Read back, not assumed. The byte test below cannot prove this pragma on its own: reclaiming
    // space rewrites the file and would remove the text either way. Asserting the configured
    // guarantee directly is what stops it being switched off unnoticed.
    expect(store.diagnostics.secureDeleteEnabled).toBe(true);
  });
});

describe("clearing the whole index", () => {
  it("leaves none of a forgotten document's text in the file", async () => {
    // Clearing is the other way a person withdraws consent, and it reaches the same bytes. A
    // guarantee that applied only to one of the two would be a guarantee in name.
    await indexSecret();
    expect(indexBytes()).toContain(SECRET);

    store.clear();

    expect(indexBytes()).not.toContain(SECRET);
    expect(store.info().documentCount).toBe(0);
  }, 60_000);
});

describe("forgetting an indexed document", () => {
  it("leaves none of its text in the file, not merely none in its tables", async () => {
    const hash = await indexSecret();
    // The phrase really is there while the document is indexed — otherwise the absence below
    // would prove nothing at all.
    expect(indexBytes()).toContain(SECRET);

    expect(store.forgetDocument(hash)).toBe(true);

    expect(indexBytes()).not.toContain(SECRET);
  }, 60_000);

  it("reports that there was nothing to forget rather than pretending", async () => {
    expect(store.forgetDocument("a".repeat(64))).toBe(false);
  });

  it("removes the document, its chunks, its embeddings and its cached text", async () => {
    const hash = await indexSecret();
    const before = store.info();
    expect(before.documentCount).toBe(1);
    expect(before.chunkCount).toBeGreaterThan(0);

    store.forgetDocument(hash);

    const after = store.info();
    expect(after.documentCount).toBe(0);
    expect(after.chunkCount).toBe(0);
    expect(after.embeddingCount).toBe(0);
    expect(store.getDocument(hash)).toBeNull();
  }, 60_000);

  it("leaves another document untouched", async () => {
    const hash = await indexSecret();
    const other = expectIndexed(
      await indexDocument(store, embedder, {
        bytes: new TextEncoder().encode("a second document"),
        name: "other.pdf",
        filePath: null,
        pageCount: 1,
        chunkingProfile: "balanced",
        pages: [{ page: 1, text: "An entirely unrelated report about rainfall in the region.", source: "pdf" }],
      }),
    );

    store.forgetDocument(hash);

    expect(store.getDocument(other.contentHash)).not.toBeNull();
    expect(store.info().documentCount).toBe(1);
    expect(indexBytes()).toContain("rainfall");
  }, 60_000);

  it("keeps the store usable afterwards", async () => {
    // Reclaiming space rewrites the file. The handle has to survive that, or forgetting one
    // document would end the session.
    const hash = await indexSecret();
    store.forgetDocument(hash);

    const again = await indexSecret();
    expect(store.getDocument(again)).not.toBeNull();
  }, 60_000);
});

describe("forgetting while another process is using the index", () => {
  /** A second real connection, holding a read transaction open the way another process would. */
  function openReader(): { close: () => void } {
    const reader = new Database(semanticIndexPath(dataDir));
    reader.pragma("journal_mode = WAL");
    reader.pragma("busy_timeout = 500");
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS n FROM documents").get();
    return {
      close: () => {
        reader.exec("COMMIT");
        reader.close();
      },
    };
  }

  it("refuses rather than reporting a document forgotten while its text is still readable", async () => {
    // Measured, not assumed: with a reader attached, `wal_checkpoint(TRUNCATE)` returns
    // `{ busy: 1 }` and `VACUUM` succeeds anyway, so the log keeps the text. Reporting success
    // there would be the one thing this whole mechanism exists to prevent.
    const hash = await indexSecret();
    const reader = openReader();

    try {
      expect(() => store.forgetDocument(hash)).toThrow(/busy|locked/i);

      // And nothing was deleted, so the person can try again rather than being left with a
      // half-done withdrawal they were told had succeeded.
      expect(store.getDocument(hash)).not.toBeNull();
      expect(indexBytes()).toContain(SECRET);
    } finally {
      reader.close();
    }
  }, 60_000);

  it("forgets it once the other reader has finished", async () => {
    const hash = await indexSecret();
    const reader = openReader();
    reader.close();

    expect(store.forgetDocument(hash)).toBe(true);
    expect(indexBytes()).not.toContain(SECRET);
  }, 60_000);

  it("lets another connection back in after a refusal", async () => {
    // Exclusive locking mode locks every other process out of the index until it is released. A
    // release that quietly failed would leave this connection holding the database for the rest
    // of its life, which is worse than the refusal it was reporting.
    const hash = await indexSecret();
    const reader = openReader();
    expect(() => store.forgetDocument(hash)).toThrow();
    reader.close();

    expect(() => {
      const other = new Database(semanticIndexPath(dataDir));
      other.prepare("SELECT count(*) AS n FROM documents").get();
      other.close();
    }).not.toThrow();
  }, 60_000);

  it("lets another connection back in after a successful forget", async () => {
    const hash = await indexSecret();
    expect(store.forgetDocument(hash)).toBe(true);

    expect(() => {
      const other = new Database(semanticIndexPath(dataDir));
      other.prepare("SELECT count(*) AS n FROM documents").get();
      other.close();
    }).not.toThrow();
  }, 60_000);

  it("refuses to clear the whole index while another connection is attached", async () => {
    await indexSecret();
    const reader = openReader();

    try {
      expect(() => store.clear()).toThrow(/busy|locked/i);
      expect(store.info().documentCount).toBe(1);
    } finally {
      reader.close();
    }
  }, 60_000);
});
