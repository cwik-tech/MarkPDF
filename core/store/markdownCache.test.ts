import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSemanticStore, type SemanticStore } from "./index.js";
import { semanticIndexPath } from "../paths.js";
import { renderPagePreservingMarkdown, parsePagePreservingMarkdown } from "./markdownDocument.js";

/**
 * Caching the Markdown a document was indexed from.
 *
 * The extraction is the expensive step — around 109 ms for a modest document, more for a large
 * one — and everything downstream of it is cheap. Keeping the result means a reindex after a
 * settings change, and later a `convert` that wants the same text, do not pay for it twice.
 *
 * Schema v2 created `document_markdown` and the engine/version columns. Schema v3 adds
 * `page_provenance`, because the text alone cannot say whether an empty page was blank or was one
 * nothing managed to read.
 */

let dataDir: string;
let store: SemanticStore;

const PAGES = [
  { page: 1, markdown: "# Report\n\nAdministrative preamble of the first page." },
  { page: 2, markdown: "## Revenue\n\n|Segment|2025|\n|---|---|\n|Enterprise|1204|" },
  { page: 3, markdown: "" },
];

function makeDocument(contentHash: string, owner: SemanticStore = store) {
  return owner.upsertDocument({
    contentHash,
    name: "report.pdf",
    filePath: null,
    fileSize: 10,
    pageCount: 3,
    textSource: "pdf",
    textExtractionVersion: 2, ocrExtractionVersion: 1,
    markdownEngine: null,
    markdownVersion: null,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-mdcache-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("recording why a cached page is empty", () => {
  /**
   * Two empty pages, one blank and one nobody read. The cache has to tell them apart.
   *
   * Without this the text is identical — an empty string either way — so a later reader has no way
   * to know that one of them is a gap it should go back for, and the document stays quietly short
   * for as long as it stays cached.
   */
  it("keeps each page's outcome alongside its text", () => {
    const document = makeDocument("a".repeat(64));

    store.putMarkdown(document.id, {
      engineId: "pdf-inspector",
      markdownVersion: 1,
      pages: PAGES,
      pageProvenance: [
        { page: 1, status: "read" },
        { page: 2, status: "read" },
        { page: 3, status: "unresolved" },
      ],
    });

    const cached = store.getMarkdown(document.id, "pdf-inspector", 1);
    expect(cached?.pages).toEqual(PAGES);
    expect(cached?.provenance).toEqual([
      { page: 1, status: "read" },
      { page: 2, status: "read" },
      { page: 3, status: "unresolved" },
    ]);
  });

  it("reports no provenance at all for a cache written before it was recorded", () => {
    // The migration case, and it must be distinguishable from "every page was read". A row from an
    // older build knows nothing about its empty pages, and treating that silence as a clean bill of
    // health is what would leave the documents this change exists to repair unrepaired.
    const document = makeDocument("b".repeat(64));

    store.putMarkdown(document.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    expect(store.getMarkdown(document.id, "pdf-inspector", 1)?.provenance).toBeNull();
  });

  it("refuses provenance that does not describe this document, rather than storing it", () => {
    const document = makeDocument("c".repeat(64));

    expect(() =>
      store.putMarkdown(document.id, {
        engineId: "pdf-inspector",
        markdownVersion: 1,
        pages: PAGES,
        pageProvenance: [{ page: 1, status: "read" }],
      }),
    ).toThrow(/provenance/i);
  });
});

describe("recording how the cached text was read", () => {
  /** The row's own account of itself, read from the file rather than through a reader that maps it. */
  function recordedReading(documentId: number): Record<string, unknown> {
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare(
        `SELECT text_extraction_version, ocr_extraction_version, markdown_engine, markdown_version
           FROM documents WHERE id = ?`,
      )
      .get(documentId) as Record<string, unknown>;
    db.close();
    return row;
  }

  it("stamps the extraction versions in the same write as the text they describe", () => {
    const document = makeDocument("e".repeat(64));

    store.putMarkdown(document.id, {
      engineId: "pdf-inspector",
      markdownVersion: 1,
      pages: PAGES,
      textExtractionVersion: 7,
      ocrExtractionVersion: 5,
    });

    expect(recordedReading(document.id)).toEqual({
      text_extraction_version: 7,
      ocr_extraction_version: 5,
      markdown_engine: "pdf-inspector",
      markdown_version: 1,
    });
  });

  it("leaves the recorded versions alone when the caller does not say how the text was read", () => {
    // Absence means "I do not know", not "there is none" — the same rule the document upsert
    // follows. A caller handing over text from anywhere must not erase the account written by one
    // that knew.
    const document = makeDocument("f".repeat(64));

    store.putMarkdown(document.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    expect(recordedReading(document.id).text_extraction_version).toBe(2);
    expect(recordedReading(document.id).ocr_extraction_version).toBe(1);
  });

  it("records no new version when the cache itself is refused", () => {
    // The atomicity that matters. The versions describe the text in this write, so a write that
    // does not happen must not advance them — otherwise the row claims a reading of the document
    // that nothing stored.
    const document = makeDocument("0".repeat(64));
    store.putMarkdown(document.id, {
      engineId: "pdf-inspector",
      markdownVersion: 1,
      pages: PAGES,
      textExtractionVersion: 2,
      ocrExtractionVersion: 1,
    });

    expect(() =>
      store.putMarkdown(document.id, {
        engineId: "pdf-inspector",
        markdownVersion: 1,
        // One page short of the document, so the store refuses it.
        pages: PAGES.slice(0, 2),
        textExtractionVersion: 9,
        ocrExtractionVersion: 9,
      }),
    ).toThrow();

    expect(recordedReading(document.id).text_extraction_version).toBe(2);
    expect(recordedReading(document.id).ocr_extraction_version).toBe(1);
    expect(store.getMarkdown(document.id, "pdf-inspector", 1)?.pages).toEqual(PAGES);
  });

  it("refuses a version that is not a positive whole number, and stores nothing", () => {
    const document = makeDocument("1".repeat(64));

    // Zero included: it is the sentinel this store uses internally for "the caller did not say",
    // and a caller reaching for it is naming a version that means nothing. Omission is how a
    // caller says nothing.
    for (const bad of [0, 0.5, -1, Number.NaN]) {
      expect(() =>
        store.putMarkdown(document.id, {
          engineId: "pdf-inspector",
          markdownVersion: 1,
          pages: PAGES,
          textExtractionVersion: bad,
        }),
      ).toThrow(/textExtractionVersion/);
    }

    expect(store.getMarkdown(document.id, "pdf-inspector", 1)).toBeNull();
    expect(recordedReading(document.id).markdown_engine).toBeNull();
  });
});

describe("when the snapshot was recorded", () => {
  it("says when the cached pages were written, by the clock the store runs under", () => {
    // The snapshot `read_pages` actually serves is this row; its recorded time is what a reader
    // can truthfully be told. Injected clock, so the assertion is exact rather than approximate.
    const recorded = new Date("2026-08-23T09:30:00.000Z");
    const timed = openSemanticStore({ dataDir, clock: () => recorded });
    try {
      const document = makeDocument("d".repeat(64), timed);

      timed.putMarkdown(document.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

      expect(timed.getMarkdown(document.id, "pdf-inspector", 1)?.createdAt).toBe(recorded.toISOString());
    } finally {
      timed.close();
    }
  });

  it("moves the recorded time when the cache is rewritten, not the document's own history", () => {
    // A re-index rewrites the row; the snapshot it then serves was recorded at the rewrite, and
    // the read-back must say so rather than repeating the earlier instant.
    let instant = new Date("2026-08-23T09:30:00.000Z").getTime();
    const timed = openSemanticStore({ dataDir, clock: () => new Date((instant += 60_000)) });
    try {
      const document = makeDocument("e".repeat(64), timed);

      timed.putMarkdown(document.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
      const first = timed.getMarkdown(document.id, "pdf-inspector", 1)?.createdAt;
      timed.putMarkdown(document.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
      const second = timed.getMarkdown(document.id, "pdf-inspector", 1)?.createdAt;

      expect(typeof first).toBe("string");
      expect(second).not.toBe(first);
      expect(second).toBe(new Date(instant).toISOString());
    } finally {
      timed.close();
    }
  });
});

describe("the page-preserving representation", () => {
  it("round-trips every page, including an empty one", () => {
    expect(parsePagePreservingMarkdown(renderPagePreservingMarkdown(PAGES) ?? "")).toEqual(PAGES);
  });

  it("is byte-identical for the same input, so a cache hit is decidable", () => {
    expect(renderPagePreservingMarkdown(PAGES)).toBe(renderPagePreservingMarkdown(PAGES));
  });

  it("round-trips text that contains the marker, the escaped marker, and both together", () => {
    // The governing property is that `parse(render(pages))` deep-equals `pages` for arbitrary
    // strings. An escaping scheme that maps two different inputs onto the same encoding fails it
    // silently: the document comes back subtly altered and nothing reports the change.
    const hostile = [
      {
        page: 1,
        markdown: [
          "<!-- markpdf:page 2 -->",
          "<!-- markpdf\\:page 2 -->",
          "<!-- markpdf\\\\:page 2 -->",
          "a backslash \\ alone",
        ].join("\n"),
      },
      { page: 2, markdown: "<!-- markpdf:page 1 len 3 -->" },
    ];
    expect(parsePagePreservingMarkdown(renderPagePreservingMarkdown(hostile) ?? "")).toEqual(hostile);
  });

  it("round-trips carriage returns, trailing newlines, empty pages and astral characters", () => {
    const awkward = [
      { page: 1, markdown: "line one\r\nline two\r\n" },
      { page: 2, markdown: "" },
      { page: 3, markdown: "😀 naïve café — em dash\n\n\n" },
      { page: 4, markdown: "\n" },
    ];
    expect(parsePagePreservingMarkdown(renderPagePreservingMarkdown(awkward) ?? "")).toEqual(awkward);
  });

  it("round-trips a page that is exactly the rendered form of another document", () => {
    // The nastiest case: a page whose text is itself a valid page-preserving document.
    const inner = renderPagePreservingMarkdown([{ page: 1, markdown: "inner" }]) ?? "";
    const outer = [{ page: 1, markdown: inner }];
    expect(parsePagePreservingMarkdown(renderPagePreservingMarkdown(outer) ?? "")).toEqual(outer);
  });

  it("refuses text that is not a page-preserving document", () => {
    expect(parsePagePreservingMarkdown("just some markdown")).toBeNull();
    expect(parsePagePreservingMarkdown("")).toBeNull();
  });

  it("refuses pages that are not consecutive from one", () => {
    expect(renderPagePreservingMarkdown([{ page: 2, markdown: "x" }])).toBeNull();
    expect(renderPagePreservingMarkdown([{ page: 1, markdown: "a" }, { page: 3, markdown: "c" }])).toBeNull();
  });
});

describe("storing and reading back a document's Markdown", () => {
  it("returns nothing for a document that has none", () => {
    const doc = makeDocument("h1");
    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("returns what was stored, parsed back into pages", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)?.pages).toEqual(PAGES);
  });

  it("does not serve a cache written by a different engine", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(store.getMarkdown(doc.id, "docling", 1)).toBeNull();
  });

  it("does not serve a cache written by an older version of the same engine", () => {
    // A version bump means the extraction changed. Serving the old text would index a document
    // as though the new extractor had produced it.
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(store.getMarkdown(doc.id, "pdf-inspector", 2)).toBeNull();
  });

  it("replaces the cache when the extraction changes, rather than accumulating rows", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    const revised = [{ page: 1, markdown: "# Report\n\nRevised." }, { page: 2, markdown: "x" }, { page: 3, markdown: "" }];
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: revised });

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)?.pages).toEqual(revised);
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    db.close();
    expect(rows.count).toBe(1);
  });

  it("refuses to read back a row whose stored text is not a page-preserving document", () => {
    // The row is external input like any other: a truncated write or a hand-edited file must
    // surface as a miss, not as a document with one giant page.
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    const db = new Database(semanticIndexPath(dataDir));
    db.prepare("UPDATE document_markdown SET markdown = ?").run("corrupted");
    db.close();

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("goes when its document goes", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(store.deleteDocument("h1")).toBe(true);
    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("goes when the whole index is cleared", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    store.clear();
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    db.close();
    expect(rows.count).toBe(0);
  });

  it("refuses a cache that does not cover the document, rather than storing a shorter one", () => {
    // The store checks this itself. `renderPagePreservingMarkdown` proves pages are `1..n`, but
    // only the store knows what `n` should be — and a caller reaching past `indexDocument` must
    // not be able to stamp a three-page document with a two-page cache.
    const doc = makeDocument("h1");
    expect(() =>
      store.putMarkdown(doc.id, {
        engineId: "pdf-inspector",
        markdownVersion: 1,
        pages: [{ page: 1, markdown: "a" }, { page: 2, markdown: "b" }],
      }),
    ).toThrow(/page/i);
    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("refuses a cache with a gap even when it has the right number of pages", () => {
    // The count check cannot see this: three pages numbered 1, 2 and 4 is the right *quantity*
    // and the wrong document. Raising rather than quietly declining to write is what stops a
    // document being stamped with an engine that cached nothing for it.
    const doc = makeDocument("h1");
    expect(() =>
      store.putMarkdown(doc.id, {
        engineId: "pdf-inspector",
        markdownVersion: 1,
        pages: [{ page: 1, markdown: "a" }, { page: 2, markdown: "b" }, { page: 4, markdown: "d" }],
      }),
    ).toThrow(/complete run of pages/);
    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("refuses a cache for a document that does not exist, and says so", () => {
    // Named explicitly, because reading a page count from a row that is not there would throw
    // anyway — with a message about a malformed row rather than the real problem.
    expect(() =>
      store.putMarkdown(9999, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES }),
    ).toThrow(/no such row/);
  });

  it("refuses a stored row whose pages do not cover the document, however well it parses", () => {
    // The nastiest corruption: a hand-edited or truncated row that is still a *valid* serialized
    // document, just a shorter one. Syntax alone cannot catch it — only comparing the parsed
    // page count against the document's own can — and returning it would serve two pages as
    // though they were three.
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    const twoPages = renderPagePreservingMarkdown(PAGES.slice(0, 2)) ?? "";
    const db = new Database(semanticIndexPath(dataDir));
    db.prepare("UPDATE document_markdown SET markdown = ?").run(twoPages);
    db.close();

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)).toBeNull();
  });

  it("stamps the document only when the cache row is actually written", () => {
    // The two must move together. A document claiming an engine with no cache behind it is the
    // false state the whole provenance check exists to prevent, and a refused write is exactly
    // when it would appear if the stamp had been applied first.
    const doc = makeDocument("h1");
    expect(() =>
      store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: [{ page: 1, markdown: "a" }] }),
    ).toThrow();

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db.prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBeNull();
    expect(row.markdown_version).toBeNull();
  });

  it("stamps the document as part of writing the cache", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db.prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBe("pdf-inspector");
    expect(row.markdown_version).toBe(1);
  });

  it("leaves a previous valid cache and its stamp intact when a replacement is refused", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(() =>
      store.putMarkdown(doc.id, { engineId: "other", markdownVersion: 2, pages: [{ page: 1, markdown: "x" }] }),
    ).toThrow();

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)?.pages).toEqual(PAGES);
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db.prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBe("pdf-inspector");
    expect(row.markdown_version).toBe(1);
  });

  it("refuses a blank engine id, leaving the row and the stamp untouched", () => {
    // `putMarkdown` is itself a boundary: it stamps `documents` atomically, so it cannot rely on
    // a caller having checked first. A blank engine id would be written into the provenance a
    // later read keys off, and `getMarkdown` would then never match it.
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    for (const engineId of ["", "   ", "\t\n"]) {
      expect(() => store.putMarkdown(doc.id, { engineId, markdownVersion: 1, pages: PAGES })).toThrow(
        /engine id/i,
      );
    }

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)?.pages).toEqual(PAGES);
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db.prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBe("pdf-inspector");
    expect(row.markdown_version).toBe(1);
  });

  it("refuses a version that is not a positive whole number, leaving the row and stamp untouched", () => {
    const doc = makeDocument("h1");
    store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });

    for (const markdownVersion of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        store.putMarkdown(doc.id, { engineId: "pdf-inspector", markdownVersion, pages: PAGES }),
      ).toThrow(/version/i);
    }

    expect(store.getMarkdown(doc.id, "pdf-inspector", 1)?.pages).toEqual(PAGES);
    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db.prepare("SELECT markdown_engine, markdown_version FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(row.markdown_version).toBe(1);
  });

  it("refuses a bad engine id before writing anything, even on a document with no cache yet", () => {
    const doc = makeDocument("h1");
    expect(() => store.putMarkdown(doc.id, { engineId: " ", markdownVersion: 1, pages: PAGES })).toThrow();

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const cached = db.prepare("SELECT COUNT(*) AS count FROM document_markdown").get() as { count: number };
    const row = db.prepare("SELECT markdown_engine FROM documents WHERE id = ?").get(doc.id) as Record<string, unknown>;
    db.close();
    expect(cached.count).toBe(0);
    expect(row.markdown_engine).toBeNull();
  });

  it("keeps one document's cache out of another's", () => {
    const first = makeDocument("h1");
    const second = makeDocument("h2");
    store.putMarkdown(first.id, { engineId: "pdf-inspector", markdownVersion: 1, pages: PAGES });
    expect(store.getMarkdown(second.id, "pdf-inspector", 1)).toBeNull();
  });
});
