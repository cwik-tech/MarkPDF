import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  openSemanticStore,
  type ChunkScope,
  type ChunkScopeContract,
  type ReusableIndexQuery,
  type SemanticStore,
} from "./index.js";
import { semanticIndexPath } from "../paths.js";
import {
  MARKDOWN_ENGINE_ID,
  MARKDOWN_VERSION,
  modelVersion,
  OCR_EXTRACTION_VERSION,
  semanticChunkingVersion,
  TEXT_EXTRACTION_VERSION,
} from "../models.js";

/**
 * Proving that a stored index can be reused, before anything expensive is done to the file.
 *
 * The question this answers is narrow on purpose: may the pipeline return the stored snapshot for
 * *these* bytes, read *this* way, chunked and embedded under *this* scope? Every clause is a way
 * for the answer to be no, and each of them is a document that would otherwise be served text or
 * results that no longer describe it.
 *
 * The completion marker is what makes the answer safe to give without a lock. It is withdrawn
 * before a replacement clears a single chunk and written only after the last batch commits, so a
 * marker present at this moment describes a scope that was finished.
 */

const CONTENT_HASH = "a".repeat(64);

const PAGES = [
  { page: 1, markdown: "# Operating plan\n\nThe opening page of the plan, in ordinary prose." },
  { page: 2, markdown: "Closing remarks recorded on the second page of the same document." },
];

/** The same two pages, read differently — what a second run's extraction can legitimately produce. */
const OTHER_PAGES = [
  { page: 1, markdown: "# Operating plan\n\nThe opening page, as a second reading of it came out." },
  { page: 2, markdown: "Closing remarks, recognised a little differently on the second pass." },
];

/** The same document with nothing on either page: what a blank or unrecognisable scan caches as. */
const BLANK_PAGES = [
  { page: 1, markdown: "" },
  { page: 2, markdown: "" },
];

const READ_THROUGHOUT = [
  { page: 1, status: "read" as const },
  { page: 2, status: "read" as const },
];

const SCOPE: ChunkScopeContract = {
  chunkingProfile: "balanced",
  chunkingVersion: semanticChunkingVersion,
  modelId: "Xenova/bge-small-en-v1.5",
  modelVersion,
  dimensions: 2,
};

/** The exact question the pipeline asks. Individual tests vary one clause of it at a time. */
const QUESTION: ReusableIndexQuery = {
  contentHash: CONTENT_HASH,
  textExtractionVersion: TEXT_EXTRACTION_VERSION,
  ocrExtractionVersion: OCR_EXTRACTION_VERSION,
  markdownEngineId: MARKDOWN_ENGINE_ID,
  markdownVersion: MARKDOWN_VERSION,
  scope: SCOPE,
};

let dataDir: string;
let store: SemanticStore;

/** Open the real file directly, to seed damage no production interface can write. */
function connectDirectly() {
  const path = semanticIndexPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

function chunk(id: string, page: number) {
  return {
    id,
    page,
    index: 0,
    text: PAGES[page - 1]?.markdown ?? "",
    headingPath: [{ title: "Operating plan", page: 1 }],
    vector: Float32Array.from([1, 0]),
  };
}

interface StoredFixture {
  documentId: number;
  scope: ChunkScope;
}

/**
 * A document exactly as a finished index leaves it: the row, a complete cache with page outcomes,
 * two embedded chunks, and the completion marker for their scope.
 */
function storeFinishedDocument(
  options: {
    textSource?: "pdf" | "ocr" | "mixed" | "none";
    provenance?: ReadonlyArray<{ page: number; status: "read" | "empty" | "unresolved" }> | undefined;
    pages?: ReadonlyArray<{ page: number; markdown: string }>;
    markComplete?: boolean;
    chunks?: boolean;
  } = {},
): StoredFixture {
  const document = store.upsertDocument({
    contentHash: CONTENT_HASH,
    name: "operating-plan.pdf",
    filePath: "/library/operating-plan.pdf",
    fileSize: 4096,
    pageCount: PAGES.length,
    textSource: options.textSource ?? "pdf",
    textExtractionVersion: TEXT_EXTRACTION_VERSION,
    ocrExtractionVersion: OCR_EXTRACTION_VERSION,
    markdownEngine: null,
    markdownVersion: null,
  });
  const provenance = options.provenance === undefined ? READ_THROUGHOUT : options.provenance;
  const cache = {
    engineId: MARKDOWN_ENGINE_ID,
    markdownVersion: MARKDOWN_VERSION,
    pages: options.pages ?? PAGES,
    ...(provenance.length === 0 ? {} : { pageProvenance: provenance }),
  };
  store.putMarkdown(document.id, cache);
  const scope: ChunkScope = { documentId: document.id, ...SCOPE };
  const chunkIds = options.chunks === false ? [] : ["c1", "c2"];
  if (options.chunks !== false) store.insertChunkBatch(scope, [chunk("c1", 1), chunk("c2", 2)]);
  // The claim carries the text, exactly as a finished run's does. A fixture that stamped without
  // it would be describing a state the store no longer produces.
  if (options.markComplete !== false) store.completeChunkScope(scope, { chunkIds, cache });
  return { documentId: document.id, scope };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-reusable-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("deciding whether a stored index may be reused", () => {
  it("answers with the stored snapshot when every contract matches", () => {
    const fixture = storeFinishedDocument({ textSource: "mixed" });

    expect(store.findReusableIndex(QUESTION)).toEqual({
      documentId: fixture.documentId,
      pageCount: 2,
      textSource: "mixed",
      chunkCount: 2,
    });
  });

  it("refuses a document whose cache records a page nothing could read", () => {
    // A gap is work still outstanding, not a state to settle into. Serving this snapshot would
    // mean the document could never be repaired: every open would answer from the same cache that
    // records the page as unread, and nothing would ever go back for it.
    storeFinishedDocument({
      provenance: [
        { page: 1, status: "unresolved" },
        { page: 2, status: "read" },
      ],
    });

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("serves a document whose pages were all read or found blank", () => {
    // The other side of the same rule: a page something looked at and found empty is accounted
    // for, and a document made of those is complete.
    const fixture = storeFinishedDocument({
      provenance: [
        { page: 1, status: "read" },
        { page: 2, status: "empty" },
      ],
    });

    expect(store.findReusableIndex(QUESTION)?.documentId).toBe(fixture.documentId);
  });

  it("refuses bytes it has never seen", () => {
    storeFinishedDocument();

    expect(store.findReusableIndex({ ...QUESTION, contentHash: "b".repeat(64) })).toBeNull();
  });

  it("refuses text read by a different extraction version", () => {
    storeFinishedDocument();

    expect(store.findReusableIndex({ ...QUESTION, textExtractionVersion: TEXT_EXTRACTION_VERSION + 1 })).toBeNull();
  });

  it("refuses pages recognised under a different OCR contract", () => {
    storeFinishedDocument();

    expect(store.findReusableIndex({ ...QUESTION, ocrExtractionVersion: OCR_EXTRACTION_VERSION + 1 })).toBeNull();
  });

  it("refuses a cache written by another Markdown engine or at another version", () => {
    storeFinishedDocument();

    expect(store.findReusableIndex({ ...QUESTION, markdownEngineId: "some-other-engine" })).toBeNull();
    expect(store.findReusableIndex({ ...QUESTION, markdownVersion: MARKDOWN_VERSION + 1 })).toBeNull();
  });

  it("refuses a document that has no cached text at all", () => {
    // A document indexed before caching existed. Its chunks may well be current, but nothing can
    // serve its pages, so the read has to happen.
    const document = store.upsertDocument({
      contentHash: CONTENT_HASH,
      name: "operating-plan.pdf",
      filePath: "/library/operating-plan.pdf",
      fileSize: 4096,
      pageCount: PAGES.length,
      textSource: "pdf",
      textExtractionVersion: TEXT_EXTRACTION_VERSION,
      ocrExtractionVersion: OCR_EXTRACTION_VERSION,
      markdownEngine: null,
      markdownVersion: null,
    });
    const scope: ChunkScope = { documentId: document.id, ...SCOPE };
    store.insertChunkBatch(scope, [chunk("c1", 1), chunk("c2", 2)]);
    store.completeChunkScope(scope, {
      chunkIds: ["c1", "c2"],
      cache: { engineId: MARKDOWN_ENGINE_ID, markdownVersion: MARKDOWN_VERSION, pages: PAGES, pageProvenance: READ_THROUGHOUT },
    });
    // And then the cache row goes, the way a database repaired by hand or damaged in place leaves
    // one: a claim standing over chunks whose text is no longer there.
    const db = connectDirectly();
    db.prepare("DELETE FROM document_markdown WHERE document_id = ?").run(document.id);
    db.close();

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a cache that cannot say what became of its pages", () => {
    // Silence about an empty page is read as a gap everywhere else in this program. Guessing that
    // it is complete here would be the one place that reads it as a fact.
    storeFinishedDocument({ provenance: [] });

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a cache whose page outcomes cannot be read back", () => {
    storeFinishedDocument();
    const db = connectDirectly();
    db.prepare("UPDATE document_markdown SET page_provenance = ?").run("{not json at all");
    db.close();

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a cache that no longer covers every page of the document", () => {
    storeFinishedDocument();
    const db = connectDirectly();
    db.prepare("UPDATE document_markdown SET markdown = ?").run("<!-- page: 1 -->\n\nOnly the first page.\n");
    db.close();

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("publishes no claim for a run that cannot say what text its chunks came from", () => {
    // A claim is a statement about a pairing, so a run with only half of it has nothing to claim.
    // Here the stored text is an earlier reading and the chunks are a new one: publishing would
    // hand the next open this document's new passages beside its old pages, and nothing afterwards
    // could tell they came from different readings.
    const fixture = storeFinishedDocument();
    store.beginChunkReplace(fixture.scope);
    store.insertChunkBatch(fixture.scope, [chunk("new-reading", 1)]);

    expect(store.completeChunkScope(fixture.scope, { chunkIds: ["new-reading"] })).toBe("unclaimed");

    expect(store.chunksWrittenAt(fixture.scope)).toBeNull();
    expect(store.findReusableIndex(QUESTION)).toBeNull();
    // The chunks are searchable, and the old text is still the only text on record — which is
    // exactly why no claim may stand over them.
    expect(store.listIndexedChunkIds(fixture.scope)).toEqual(["new-reading"]);
    expect(store.getMarkdown(fixture.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual(PAGES);
  });

  it("refuses a scope that was never marked complete", () => {
    // What an interrupted run leaves behind: chunks on disk, and no claim that they are all of
    // them. Counting them cannot tell the difference.
    storeFinishedDocument({ markComplete: false });

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a scope whose replacement has already begun", () => {
    const fixture = storeFinishedDocument();
    store.beginChunkReplace(fixture.scope);

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a completion marker with no chunks behind it when the cache holds text", () => {
    // A scope whose text should have produced chunks and has none is not a finished index, it is
    // a damaged one. Serving it would report a searchable document with nothing in it.
    storeFinishedDocument({ chunks: false });

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("serves a finished document whose pages hold no text at all", () => {
    // Nothing to embed is a legitimate finished state, and the expensive case: a scan that
    // recognises to nothing costs a full rasterisation to discover that again. The marker says the
    // scope was finished and the cache says why there is nothing in it.
    const fixture = storeFinishedDocument({ pages: BLANK_PAGES, chunks: false, textSource: "none" });

    expect(store.findReusableIndex(QUESTION)).toEqual({
      documentId: fixture.documentId,
      pageCount: 2,
      textSource: "none",
      chunkCount: 0,
    });
  });

  it("refuses every scope the index was not built under", () => {
    storeFinishedDocument();

    const elsewhere: ChunkScopeContract[] = [
      { ...SCOPE, chunkingProfile: "precise" },
      { ...SCOPE, chunkingVersion: semanticChunkingVersion + 1 },
      { ...SCOPE, modelId: "Xenova/all-MiniLM-L6-v2" },
      { ...SCOPE, modelVersion: "some-other-runtime" },
      { ...SCOPE, dimensions: SCOPE.dimensions + 1 },
    ];

    for (const scope of elsewhere) {
      expect(store.findReusableIndex({ ...QUESTION, scope }), JSON.stringify(scope)).toBeNull();
    }
  });

  it("sees only committed state, so a replacement another connection has not finished is invisible", () => {
    // The decision is four questions — the row, the cache, the completion marker, the chunk count
    // — and another process rebuilding this document commits between them in the ordinary course
    // of things. Here the rebuild is real and in flight on a second connection: the claim is
    // withdrawn and the chunks are gone, and none of it is committed. Every clause of the answer
    // must come from the database as it actually stands.
    const fixture = storeFinishedDocument();
    const other = connectDirectly();
    try {
      other.exec("BEGIN IMMEDIATE");
      other.prepare("DELETE FROM chunk_scope_snapshots WHERE document_id = ?").run(fixture.documentId);
      other.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(fixture.documentId);

      expect(store.findReusableIndex(QUESTION)?.chunkCount).toBe(2);

      other.exec("COMMIT");

      // And once it lands, the same question gets the other consistent answer, never a blend.
      expect(store.findReusableIndex(QUESTION)).toBeNull();
    } finally {
      if (other.inTransaction) other.exec("ROLLBACK");
      other.close();
    }
  });

  it("leaves no transaction open, so the index can still be compacted afterwards", () => {
    // Taking the decision under one snapshot means opening a transaction, and a read transaction
    // left open is worse than the problem it solves: it blocks the write-ahead log from being
    // truncated and makes `VACUUM` impossible, so withdrawing consent would start failing.
    storeFinishedDocument();
    expect(store.findReusableIndex(QUESTION)).not.toBeNull();

    expect(() => store.clear()).not.toThrow();
    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a scope two runs wrote into, even though one of them claimed it complete", () => {
    // Two processes, as far as SQLite is concerned. The application and the command line share one
    // index file, and the per-document queue that keeps two jobs apart lives inside a single
    // process — so this interleaving is not exotic, it is what happens when somebody runs
    // `markpdf index` on a library while the window has the same document open.
    //
    // A finishes first and claims the scope. B's last batch lands afterwards, and the scope now
    // holds a mixture of two readings that no single run ever produced. The claim must not survive
    // that, or the mixture is what the next open is served.
    const fixture = storeFinishedDocument();
    const b = openSemanticStore({ dataDir });
    try {
      store.beginChunkReplace(fixture.scope);
      b.beginChunkReplace(fixture.scope);

      b.putMarkdown(fixture.documentId, {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        pages: PAGES,
        pageProvenance: READ_THROUGHOUT,
      });

      store.insertChunkBatch(fixture.scope, [chunk("first-1", 1), chunk("first-2", 2)]);
      // A real claim, text and all — otherwise this test would pass because nothing was published
      // rather than because B's batch retracted what was.
      expect(
        store.completeChunkScope(fixture.scope, {
          chunkIds: ["first-1", "first-2"],
          cache: { engineId: MARKDOWN_ENGINE_ID, markdownVersion: MARKDOWN_VERSION, pages: PAGES, pageProvenance: READ_THROUGHOUT },
        }),
      ).toBe("claimed");
      expect(store.findReusableIndex(QUESTION)?.chunkCount).toBe(2);

      b.insertChunkBatch(fixture.scope, [chunk("second-1", 1)]);

      expect([...store.listIndexedChunkIds(fixture.scope)].sort()).toEqual(["first-1", "first-2", "second-1"]);
      expect(store.findReusableIndex(QUESTION)).toBeNull();
    } finally {
      b.close();
    }
  });

  it("refuses to claim a scope that does not hold exactly the chunks the run wrote", () => {
    // Counting cannot tell this apart: the scope holds two chunks and the run wrote two. One of
    // them is somebody else's, and the identifier is what carries the fingerprint of the text.
    const fixture = storeFinishedDocument({ markComplete: false, chunks: false });
    store.insertChunkBatch(fixture.scope, [chunk("mine-1", 1), chunk("theirs-1", 2)]);

    // A conflict, not a missing cache: the identities are checked first, so a run that lost the
    // race is told it lost rather than told it had nothing to say.
    expect(store.completeChunkScope(fixture.scope, { chunkIds: ["mine-1", "mine-2"] })).toBe("conflicted");
    expect(store.chunksWrittenAt(fixture.scope)).toBeNull();
    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("writes the completing run's text with its claim, so an earlier run's text cannot be paired with its chunks", () => {
    // The other half of the same interleaving: B stores the text it read before A finishes. If the
    // claim only covered the chunks, the next open would be served A's passages beside B's pages.
    const fixture = storeFinishedDocument({ markComplete: false, chunks: false });
    const b = openSemanticStore({ dataDir });
    try {
      b.putMarkdown(fixture.documentId, {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        pages: OTHER_PAGES,
        pageProvenance: READ_THROUGHOUT,
      });

      store.insertChunkBatch(fixture.scope, [chunk("mine-1", 1), chunk("mine-2", 2)]);
      expect(
        store.completeChunkScope(fixture.scope, {
          chunkIds: ["mine-1", "mine-2"],
          cache: {
            engineId: MARKDOWN_ENGINE_ID,
            markdownVersion: MARKDOWN_VERSION,
            pages: PAGES,
            pageProvenance: READ_THROUGHOUT,
          },
        }),
      ).toBe("claimed");
    } finally {
      b.close();
    }

    expect(store.getMarkdown(fixture.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION)?.pages).toEqual(PAGES);
    expect(store.findReusableIndex(QUESTION)?.chunkCount).toBe(2);
  });

  it("withdraws the claim when the document's text is written again", () => {
    // A claim vouches for chunks *and* for the text they were built from. Another run storing its
    // own reading afterwards breaks that pairing, and the claim has to go with it — otherwise the
    // next open is served one run's passages against another run's pages.
    const fixture = storeFinishedDocument();
    expect(store.findReusableIndex(QUESTION)).not.toBeNull();
    const b = openSemanticStore({ dataDir });
    try {
      b.putMarkdown(fixture.documentId, {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        pages: OTHER_PAGES,
        pageProvenance: READ_THROUGHOUT,
      });
    } finally {
      b.close();
    }

    expect(store.chunksWrittenAt(fixture.scope)).toBeNull();
    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });

  it("refuses a document row whose recorded text source is not one this program writes", () => {
    storeFinishedDocument();
    const db = connectDirectly();
    db.prepare("UPDATE documents SET text_source = ?").run("something-else");
    db.close();

    expect(store.findReusableIndex(QUESTION)).toBeNull();
  });
});
