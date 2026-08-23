import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import type { ExtractionProvenance } from "./indexDocument.js";
import { semanticIndexPath } from "../paths.js";
import { indexDocument } from "./indexDocument.js";
import { searchDocument } from "./search.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { expectIndexed } from "./indexResult.test-support.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";

/**
 * Whether an index may be reused, decided through the public path.
 *
 * The scenario the old identifier could not detect: the same file, extracted twice, producing
 * different text at the *same page and the same position*. Everything the Phase 1 identifier
 * carried — the file's bytes, the page, the position — is identical across those two runs, so
 * comparing identifiers returned "already complete" and the stale text stayed.
 *
 * Extraction is not deterministic, so this is a real state, not a contrived one.
 */

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder(384);

/** Fixed bytes throughout: the content hash must not be what distinguishes the two runs. */
const BYTES = new TextEncoder().encode("one file, two extraction outcomes");

const FIRST_TEXT = "The escape velocity of Deimos is five point six metres per second at its surface.";
const REVISED_TEXT = "The escape velocity of Phobos is eleven point four metres per second at its surface.";

/** Supplied only by callers that know which engine produced the text. */
const withProvenance = (text: string) => ({
  engineId: MARKDOWN_ENGINE_ID,
  markdownVersion: MARKDOWN_VERSION,
  textExtractionVersion: TEXT_EXTRACTION_VERSION,
  ocrExtractionVersion: OCR_EXTRACTION_VERSION,
  pages: [{ page: 1, markdown: text }],
});

function indexWith(text: string, provenance?: (text: string) => ExtractionProvenance) {
  return indexDocument(store, embedder, {
    bytes: BYTES,
    name: "moons.pdf",
    filePath: null,
    pageCount: 1,
    chunkingProfile: "balanced",
    pages: [{ page: 1, text, source: "pdf" }],
    ...(provenance === undefined ? {} : { markdownCache: provenance(text) }),
  });
}

function storedTexts(): string[] {
  const db = new Database(semanticIndexPath(dataDir), { readonly: true });
  const rows = db.prepare("SELECT text FROM document_chunks").all() as Array<{ text: string }>;
  db.close();
  return rows.map((row) => row.text);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-reuse-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("re-indexing a file whose extracted text changed", () => {
  it("rebuilds rather than reusing, and the old text is gone", async () => {
    const first = expectIndexed(await indexWith(FIRST_TEXT));
    expect(first.status).toBe("ready");
    expect(storedTexts().some((text) => text.includes("Deimos"))).toBe(true);

    // Same bytes, same page, same position — different text, and no `force`.
    const second = expectIndexed(await indexWith(REVISED_TEXT));

    expect(second.status).toBe("ready");
    expect(second.status).not.toBe("reused");
    expect(second.contentHash).toBe(first.contentHash);

    const texts = storedTexts();
    expect(texts.some((text) => text.includes("Phobos"))).toBe(true);
    expect(texts.some((text) => text.includes("Deimos"))).toBe(false);

    const hits = await searchDocument(store, embedder, {
      contentHash: second.contentHash,
      query: "Phobos escape velocity",
      chunkingProfile: "balanced",
      minScore: 0,
    });
    expect(hits.some((hit) => hit.snippet.includes("Phobos"))).toBe(true);
  }, 60_000);

  it("still reuses when nothing changed, so an unchanged document costs nothing", async () => {
    // The other half of the contract. A fingerprint that changed on every run would make every
    // open a full reindex.
    await indexWith(FIRST_TEXT);
    const again = expectIndexed(await indexWith(FIRST_TEXT));
    expect(again.status).toBe("reused");
  }, 60_000);
});

describe("what a Phase 2 document records about itself", () => {
  it("stamps the extraction version, the Markdown engine and its version", async () => {
    // The columns exist so a row's provenance is answerable later. A Phase 1 row carries text
    // extraction version 1 and no engine; a Phase 2 row must be distinguishable from it.
    const indexed = expectIndexed(await indexWith(FIRST_TEXT, withProvenance));

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare(
        "SELECT text_extraction_version, ocr_extraction_version, markdown_engine, markdown_version FROM documents WHERE content_hash = ?",
      )
      .get(indexed.contentHash) as Record<string, unknown>;
    db.close();

    expect(row.text_extraction_version).toBe(TEXT_EXTRACTION_VERSION);
    expect(TEXT_EXTRACTION_VERSION).toBe(2);
    // OCR recognition is versioned with its contract: 2 marks rows read under the versioned
    // profiles, whose pages are reconstructed into tables when their geometry carries one.
    expect(row.ocr_extraction_version).toBe(OCR_EXTRACTION_VERSION);
    expect(OCR_EXTRACTION_VERSION).toBe(2);
    expect(row.markdown_engine).toBe(MARKDOWN_ENGINE_ID);
    expect(row.markdown_version).toBe(MARKDOWN_VERSION);
  }, 60_000);

  it("caches the Markdown when the caller says which engine produced it", async () => {
    const indexed = expectIndexed(await indexWith(FIRST_TEXT, withProvenance));
    expect(store.getMarkdown(indexed.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual([
      { page: 1, markdown: FIRST_TEXT },
    ]);
  }, 60_000);

  it("replaces the cached Markdown when the extraction changes", async () => {
    const first = expectIndexed(await indexWith(FIRST_TEXT, withProvenance));
    await indexWith(REVISED_TEXT, withProvenance);
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual([
      { page: 1, markdown: REVISED_TEXT },
    ]);
  }, 60_000);

  it("backfills a cache that is missing while the chunks are still complete", async () => {
    // A document indexed before caching existed: its chunks are current, so the reuse path
    // returns early. Without a backfill the cache would stay empty for every such document
    // until something forced a rebuild.
    const first = expectIndexed(await indexWith(FIRST_TEXT));
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)).toBeNull();

    const again = expectIndexed(await indexWith(FIRST_TEXT, withProvenance));
    expect(again.status).toBe("reused");
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual([
      { page: 1, markdown: FIRST_TEXT },
    ]);
  }, 60_000);

  it("backfills the page outcomes onto a cache that has the text but does not know why a page is empty", async () => {
    // The case a cache written before v3 leaves behind, and the one the earlier backfill misses:
    // the text is already there, so `getMarkdown` does not return null and nothing is rewritten.
    //
    // It matters because a page that is empty in a provenance-free cache is read as a gap — that is
    // what repairs the documents whose scanned page was never recognised. For a page that is
    // genuinely blank the same reading is wrong and permanent: the chunks never change, so every
    // run takes the reuse path, and every reader re-opens the file to look at a page that has
    // nothing on it. Backfilling here is what lets a blank page settle down as blank.
    const blankPage = (text: string): ExtractionProvenance => ({
      ...withProvenance(text),
      pages: [{ page: 1, markdown: text }, { page: 2, markdown: "" }],
      pageProvenance: [
        { page: 1, status: "read" },
        { page: 2, status: "empty" },
      ],
    });
    const indexTwoPages = (provenance: (text: string) => ExtractionProvenance) =>
      indexDocument(store, embedder, {
        bytes: BYTES,
        name: "moons.pdf",
        filePath: null,
        pageCount: 2,
        chunkingProfile: "balanced",
        pages: [{ page: 1, text: FIRST_TEXT, source: "pdf" as const }],
        markdownCache: provenance(FIRST_TEXT),
      });

    // Arrange: a cache exactly as an older build left it — complete text, no page outcomes.
    const legacy = (text: string): ExtractionProvenance => {
      const { pageProvenance: _dropped, ...withoutProvenance } = blankPage(text);
      return withoutProvenance;
    };
    const first = expectIndexed(await indexTwoPages(legacy));
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.provenance).toBeNull();

    // Act: the document has not changed, so this run reuses the chunks it already has.
    const again = expectIndexed(await indexTwoPages(blankPage));

    expect(again.status).toBe("reused");
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.provenance).toEqual([
      { page: 1, status: "read" },
      { page: 2, status: "empty" },
    ]);
  }, 60_000);

  it("leaves a cache that already knows its page outcomes alone", async () => {
    // The backfill is for a record that cannot answer, not a licence to rewrite one that can. A
    // reuse that rewrote every cache would turn the cheapest path in the pipeline into a write.
    const withPages = (text: string): ExtractionProvenance => ({
      ...withProvenance(text),
      pageProvenance: [{ page: 1, status: "read" }],
    });

    const first = expectIndexed(await indexWith(FIRST_TEXT, withPages));
    const before = store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION);
    expect(before?.provenance).toEqual([{ page: 1, status: "read" }]);

    const again = expectIndexed(await indexWith(FIRST_TEXT, withPages));

    expect(again.status).toBe("reused");
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.provenance).toEqual([
      { page: 1, status: "read" },
    ]);
  }, 60_000);
});

describe("a cancel arriving while the document is being measured", () => {
  /** Aborts once indexing has started, so the cancel lands inside the awaited chunk build. */
  function abortOnFirstProgress(controller: AbortController) {
    return () => controller.abort();
  }

  it("reports cancelled rather than reused, and backfills no cache", async () => {
    // The regression this guards: chunk building became asynchronous when it started loading a
    // real tokenizer. A cancel arriving inside it used to reach the reuse branch, which reports
    // success and writes the Markdown cache.
    const first = expectIndexed(await indexWith(FIRST_TEXT));
    expect(first.status).toBe("ready");
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)).toBeNull();

    const controller = new AbortController();
    const result = await indexDocument(store, embedder, {
      bytes: BYTES,
      name: "moons.pdf",
      filePath: null,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: FIRST_TEXT, source: "pdf" }],
      markdownCache: withProvenance(FIRST_TEXT),
      signal: controller.signal,
      onProgress: abortOnFirstProgress(controller),
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)).toBeNull();
  }, 60_000);

  it("reports cancelled rather than empty for a document with no text", async () => {
    const controller = new AbortController();
    const result = await indexDocument(store, embedder, {
      bytes: BYTES,
      name: "blank.pdf",
      filePath: null,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: "", source: "pdf" }],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: [{ page: 1, markdown: "" }],
      },
      signal: controller.signal,
      onProgress: abortOnFirstProgress(controller),
    });

    expect(result).toEqual({ status: "cancelled" });
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const cached = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    db.close();
    expect(cached.count).toBe(0);
  }, 60_000);
});

describe("a document with no text at all", () => {
  const blankCache = {
    engineId: MARKDOWN_ENGINE_ID,
    markdownVersion: MARKDOWN_VERSION,
    textExtractionVersion: TEXT_EXTRACTION_VERSION,
    ocrExtractionVersion: OCR_EXTRACTION_VERSION,
    pages: [{ page: 1, markdown: "" }],
  };

  function indexBlank(signal?: AbortSignal, onProgress?: () => void) {
    return indexDocument(store, embedder, {
      bytes: BYTES,
      name: "blank.pdf",
      filePath: null,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: "", source: "pdf" }],
      markdownCache: blankCache,
      ...(signal === undefined ? {} : { signal }),
      ...(onProgress === undefined ? {} : { onProgress }),
    });
  }

  it("still caches its page-preserving text, so a blank page is recorded as blank", async () => {
    // A document that produces no chunks still has pages, and the cache is keyed to the
    // document rather than to its chunks. Stamping the engine while writing nothing would leave
    // a row claiming a cache that does not exist — the invariant the provenance check exists for.
    const result = await indexBlank();
    expect(result.status).toBe("empty");

    const stored = store.getDocument(await import("../hash.js").then((m) => m.contentHash(BYTES)));
    expect(stored).not.toBeNull();
    if (stored === null) return;
    expect(store.getMarkdown(stored.id, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual([{ page: 1, markdown: "" }]);

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?")
      .get(stored.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBe(MARKDOWN_ENGINE_ID);
    expect(row.markdown_version).toBe(MARKDOWN_VERSION);
  }, 60_000);

  it("writes no cache when it was cancelled before reaching the empty result", async () => {
    const controller = new AbortController();
    const result = await indexBlank(controller.signal, () => controller.abort());

    expect(result).toEqual({ status: "cancelled" });
    // Nothing at all: not the cache, and not the document row either. The progress callback can
    // abort synchronously, so the very next write has to re-read the signal.
    expect(store.info().documentCount).toBe(0);
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const cached = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    db.close();
    expect(cached.count).toBe(0);
  }, 60_000);
});

describe("revisiting a document that was indexed the old way", () => {
  it("raises its recorded extraction version when a Phase 2 run replaces it", async () => {
    // The upgrade path, which inserting a fresh row cannot exercise. A document indexed before
    // Phase 2 carries text extraction version 1; re-indexing it through the new extractor has to
    // move it to 2, or the column says the document was read a way it no longer was.
    const legacy = store.upsertDocument({
      contentHash: await import("../hash.js").then((m) => m.contentHash(BYTES)),
      name: "moons.pdf",
      filePath: null,
      fileSize: BYTES.byteLength,
      pageCount: 1,
      textSource: "pdf",
      textExtractionVersion: 1,
      ocrExtractionVersion: 1,
      markdownEngine: null,
      markdownVersion: null,
    });
    expect(legacy.id).toBeGreaterThan(0);

    await indexWith(FIRST_TEXT, withProvenance);

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT text_extraction_version, markdown_engine FROM documents WHERE id = ?")
      .get(legacy.id) as Record<string, unknown>;
    db.close();
    expect(row.text_extraction_version).toBe(TEXT_EXTRACTION_VERSION);
    expect(row.markdown_engine).toBe(MARKDOWN_ENGINE_ID);
  }, 60_000);

  it("leaves an existing engine and cache alone when the caller says nothing about provenance", async () => {
    // Absence means "I do not know", not "there is none". Clearing would throw away a cache and
    // a provenance record that a caller which *did* know had written.
    const first = expectIndexed(await indexWith(FIRST_TEXT, withProvenance));
    await indexWith(REVISED_TEXT);

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT markdown_engine, markdown_version, text_extraction_version FROM documents WHERE id = ?")
      .get(first.documentId) as Record<string, unknown>;
    db.close();

    expect(row.markdown_engine).toBe(MARKDOWN_ENGINE_ID);
    expect(row.markdown_version).toBe(MARKDOWN_VERSION);
    expect(row.text_extraction_version).toBe(TEXT_EXTRACTION_VERSION);
    // And the cache row it points at is still there and still readable.
    expect(store.getMarkdown(first.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)).not.toBeNull();
  }, 60_000);
});

describe("provenance that does not describe the document", () => {
  // Typed loosely on purpose: these are the shapes a caller must not get away with, and several
  // of them are not valid `ExtractionProvenance` at all — which is the point.
  const badProvenance: Array<{ name: string; cache: unknown }> = [
    { name: "an empty engine id", cache: { engineId: "", markdownVersion: 1, textExtractionVersion: 2, ocrExtractionVersion: 1, pages: [{ page: 1, markdown: "x" }] } },
    {
      name: "a whitespace-only engine id",
      cache: { engineId: "   ", markdownVersion: 1, textExtractionVersion: 2, ocrExtractionVersion: 1, pages: [{ page: 1, markdown: "x" }] },
    },
    { name: "a zero version", cache: { engineId: "pdf-inspector", markdownVersion: 0, textExtractionVersion: 2, ocrExtractionVersion: 1, pages: [{ page: 1, markdown: "x" }] } },
    { name: "a fractional version", cache: { engineId: "pdf-inspector", markdownVersion: 1.5, textExtractionVersion: 2, ocrExtractionVersion: 1, pages: [{ page: 1, markdown: "x" }] } },
    { name: "fewer pages than the document has", cache: { engineId: "pdf-inspector", markdownVersion: 1, textExtractionVersion: 2, ocrExtractionVersion: 1, pages: [] } },
    {
      name: "more pages than the document has",
      cache: {
        engineId: "pdf-inspector",
        markdownVersion: 1,
        pages: [{ page: 1, markdown: "x" }, { page: 2, markdown: "y" }],
      },
    },
  ];

  for (const { name, cache } of badProvenance) {
    it(`refuses ${name}, and stamps nothing`, async () => {
      // Validated before the document row is written, so a refused cache cannot leave a document
      // claiming an engine that never cached anything for it.
      await expect(
        indexDocument(store, embedder, {
          bytes: BYTES,
          name: "moons.pdf",
          filePath: null,
          pageCount: 1,
          chunkingProfile: "balanced",
          pages: [{ page: 1, text: FIRST_TEXT, source: "pdf" }],
          markdownCache: cache as ExtractionProvenance,
        }),
      ).rejects.toThrow();

      const db = new Database(semanticIndexPath(dataDir), { readonly: true });
      const documents = db.prepare("SELECT markdown_engine FROM documents").all() as Array<{ markdown_engine: unknown }>;
      const cached = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
      db.close();

      expect(documents.every((row) => row.markdown_engine === null)).toBe(true);
      expect(cached.count).toBe(0);
    }, 60_000);
  }
});

describe("a caller that does not say where its text came from", () => {
  it("records the extraction as unknown rather than claiming PDF Inspector", async () => {
    // `TEXT_EXTRACTION_VERSION` describes what PDF Inspector produces. Stamping it on text this
    // function never saw produced would be the same false claim as stamping the engine id.
    const { UNKNOWN_EXTRACTION_VERSION } = await import("../models.js");
    const indexed = expectIndexed(await indexWith(FIRST_TEXT));

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT text_extraction_version FROM documents WHERE content_hash = ?")
      .get(indexed.contentHash) as Record<string, unknown>;
    db.close();
    expect(row.text_extraction_version).toBe(UNKNOWN_EXTRACTION_VERSION);
  }, 60_000);

  it("claims no engine and caches nothing", async () => {
    // `indexDocument` is agnostic about its input by design — a caller may hand it text from
    // anywhere. Stamping an engine on text it never saw produced would be a false provenance
    // claim, and a cache attributed to an extractor that did not write it is worse than none.
    const indexed = expectIndexed(await indexWith(FIRST_TEXT));

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT markdown_engine, markdown_version FROM documents WHERE content_hash = ?")
      .get(indexed.contentHash) as Record<string, unknown>;
    const cached = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    db.close();

    expect(row.markdown_engine).toBeNull();
    expect(row.markdown_version).toBeNull();
    expect(cached.count).toBe(0);
  }, 60_000);
});
