import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { indexDocument } from "../index/indexDocument.js";
import { createDeterministicEmbedder } from "../index/deterministicEmbedder.js";
import { expectIndexed } from "../index/indexResult.test-support.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";
import { resolveDocumentPages } from "./documentPages.js";

/**
 * Getting a document's pages, from the index first.
 *
 * The order is a security property rather than a performance one: a document already in the index
 * is answered from the index, so asking about it needs no filesystem permission. Callers that are
 * index-only by contract say so, and then nothing is opened at all.
 */

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder(384);
const INDEXED_PATH = "/Users/someone/Papers/report.pdf";
const PAGE_ONE = "The opening page of a report that was indexed some time ago.";

/** Records every read, so a test can assert that none happened. */
function spyFilesystem(bytes: Uint8Array) {
  const reads: string[] = [];
  return { reads, readFile: async (path: string) => (reads.push(path), bytes) };
}

async function realPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText("A page with a real text layer that the extractor can read.", {
    x: 60,
    y: 700,
    size: 12,
    font,
  });
  return await pdf.save();
}

async function indexWithText(bytes: Uint8Array, withCache: boolean): Promise<string> {
  const cache = {
    engineId: MARKDOWN_ENGINE_ID,
    markdownVersion: MARKDOWN_VERSION,
    textExtractionVersion: TEXT_EXTRACTION_VERSION,
    ocrExtractionVersion: OCR_EXTRACTION_VERSION,
    pages: [{ page: 1, markdown: PAGE_ONE }],
  };
  const result = expectIndexed(
    await indexDocument(store, embedder, {
      bytes,
      name: "report.pdf",
      filePath: INDEXED_PATH,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: PAGE_ONE, source: "pdf" }],
      ...(withCache ? { markdownCache: cache } : {}),
    }),
  );
  return result.contentHash;
}

const allowNothing = { readRoots: [], writeRoots: [] };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-pages-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Index a two-page document whose second page nothing could read, exactly as a real run would. */
async function indexWithUnresolvedPage(bytes: Uint8Array, provenanceRecorded: boolean): Promise<string> {
  const pages = [
    { page: 1, markdown: PAGE_ONE },
    { page: 2, markdown: "" },
  ];
  const result = expectIndexed(
    await indexDocument(store, embedder, {
      bytes,
      name: "report.pdf",
      filePath: INDEXED_PATH,
      pageCount: 2,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: PAGE_ONE, source: "pdf" }],
      unresolvedPages: [2],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages,
        // Omitted to stand for a cache written by a build that had no provenance to record.
        ...(provenanceRecorded
          ? {
              pageProvenance: [
                { page: 1, status: "read" as const },
                { page: 2, status: "unresolved" as const },
              ],
            }
          : {}),
      },
    }),
  );
  return result.contentHash;
}

describe("a cached page that nobody managed to read", () => {
  it("is named rather than served as an empty page", async () => {
    // The failure this closes: the cache says page 2 is an empty string, a reader takes that as
    // the page's contents, and the document is quietly one page short for as long as it stays
    // cached. An index-only caller cannot go back for it — but it can say so.
    const bytes = new TextEncoder().encode("a document");
    await indexWithUnresolvedPage(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      path: INDEXED_PATH,
      access: "index-only",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.unresolvedPages).toEqual([2]);
    // Still index-only: naming the gap costs no filesystem permission.
    expect(filesystem.reads).toEqual([]);
  });

  it("is read again by a caller that is allowed to open the file", async () => {
    const bytes = await realPdf();
    await indexWithUnresolvedPage(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, { readRoots: ["/"], writeRoots: [] }, {
      path: INDEXED_PATH,
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(false);
    expect(filesystem.reads).not.toEqual([]);
  });

  it("keeps answering from the index when the file may not be opened", async () => {
    // Withdrawing a grant must not turn a partially readable document into no document at all.
    // What the caller loses is the chance to repair the gap, not the pages that are already there.
    const bytes = new TextEncoder().encode("a document");
    await indexWithUnresolvedPage(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      path: INDEXED_PATH,
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(true);
    expect(found.unresolvedPages).toEqual([2]);
  });

  it("treats an empty page in a cache from an older build as a gap, not as a blank page", async () => {
    // The migration case. Those rows were written before anything recorded why a page was empty,
    // so their silence has to be read as "unknown" — otherwise every document indexed before this
    // change keeps its missing page for ever, and nothing ever goes back for it.
    const bytes = await realPdf();
    await indexWithUnresolvedPage(bytes, false);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, { readRoots: ["/"], writeRoots: [] }, {
      path: INDEXED_PATH,
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(false);
  });

  it("leaves a document whose pages were all read alone", async () => {
    const bytes = new TextEncoder().encode("a document");
    await indexWithText(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, { readRoots: ["/"], writeRoots: [] }, {
      path: INDEXED_PATH,
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(true);
    expect(found.unresolvedPages).toEqual([]);
    expect(filesystem.reads).toEqual([]);
  });
});

describe("a document that is already indexed", () => {
  it("comes from the index, with nothing granted and nothing opened", async () => {
    const bytes = new TextEncoder().encode("a document");
    await indexWithText(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      path: INDEXED_PATH,
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(true);
    expect(found.pages).toEqual([{ page: 1, markdown: PAGE_ONE, source: "pdf" }]);
    expect(filesystem.reads).toEqual([]);
  });

  it("is found by its content hash as readily as by its path", async () => {
    const bytes = new TextEncoder().encode("a document");
    const hash = await indexWithText(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      contentHash: hash,
      access: "index-only",
      ...filesystem,
    });

    expect(found.status).toBe("found");
    expect(filesystem.reads).toEqual([]);
  });

  it("says its text was never stored rather than opening the file to make some", async () => {
    // A document indexed before the text cache existed. An index-only caller cannot be given
    // pages, and must not have the file opened on its behalf to produce them.
    const bytes = new TextEncoder().encode("a document");
    await indexWithText(bytes, false);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      path: INDEXED_PATH,
      access: "index-only",
      ...filesystem,
    });

    expect(found.status).toBe("no-stored-text");
    expect(filesystem.reads).toEqual([]);
  });
});

describe("a document the index does not hold", () => {
  it("is reported as not indexed when the filesystem is out of bounds", async () => {
    const filesystem = spyFilesystem(new Uint8Array());

    const found = await resolveDocumentPages(store, allowNothing, {
      path: "/Users/someone/Papers/unknown.pdf",
      access: "index-only",
      ...filesystem,
    });

    expect(found.status).toBe("not-indexed");
    expect(filesystem.reads).toEqual([]);
  });

  it("is refused when the filesystem is allowed but the path was never granted", async () => {
    const filesystem = spyFilesystem(new Uint8Array());

    const found = await resolveDocumentPages(store, allowNothing, {
      path: "/Users/someone/Papers/unknown.pdf",
      access: "index-first",
      ...filesystem,
    });

    expect(found.status).toBe("denied");
    expect(filesystem.reads).toEqual([]);
  });

  it("is read and extracted when the filesystem is allowed and the path was granted", async () => {
    const bytes = await realPdf();
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: INDEXED_PATH, access: "index-first", ...filesystem },
    );

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(false);
    expect(found.document).toBeNull();
    expect(found.pages[0]?.markdown).toContain("real text layer");
  }, 60_000);

  it("opens it exactly once, although two steps need its bytes", async () => {
    // The lookup hashes the file to identify it by content, and extraction needs the same bytes.
    // Reading twice doubles the I/O on every first look at a document, which for a large PDF is
    // the most expensive thing this operation does.
    const bytes = await realPdf();
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: INDEXED_PATH, access: "index-first", ...filesystem },
    );

    expect(found.status).toBe("found");
    expect(filesystem.reads).toHaveLength(1);
  }, 60_000);
});

describe("a caller that is classed as reading the file", () => {
  it("is refused after the grant is withdrawn, even though the index still holds the text", async () => {
    // `to_markdown` is classed as a filesystem read. Serving it from a cached copy after consent
    // was withdrawn would make the withdrawal decorative — the index would become a second route
    // to the same content.
    const bytes = new TextEncoder().encode("a document");
    await indexWithText(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      path: INDEXED_PATH,
      access: "filesystem",
      ...filesystem,
    });

    expect(found.status).toBe("denied");
    expect(filesystem.reads).toEqual([]);
  });

  it("still answers from the index once the grant is in place, rather than re-reading", async () => {
    const bytes = new TextEncoder().encode("a document");
    await indexWithText(bytes, true);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: INDEXED_PATH, access: "filesystem", ...filesystem },
    );

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(true);
    expect(filesystem.reads).toEqual([]);
  });
});

describe("a document named only by its content hash", () => {
  it("is read from the path it was indexed from when the index has no text to give", async () => {
    // The case the two derivations disagreed on. Consent was proved against the stored path, then
    // extraction looked at what the caller typed — nothing — and reported a document that is
    // plainly in the index as not indexed, with a live grant in place.
    const bytes = await realPdf();
    const contentHash = await indexWithText(bytes, false);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { contentHash, access: "filesystem", ...filesystem },
    );

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.fromIndex).toBe(false);
    expect(found.pages[0]?.markdown).toContain("real text layer");
    // Read from the path the index recorded, which is the same path consent was proved against.
    expect(filesystem.reads).toEqual([INDEXED_PATH]);
  }, 60_000);

  it("is refused once that grant is withdrawn, and is not read", async () => {
    const bytes = await realPdf();
    const contentHash = await indexWithText(bytes, false);
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(store, allowNothing, {
      contentHash,
      access: "filesystem",
      ...filesystem,
    });

    expect(found.status).toBe("denied");
    if (found.status !== "denied") return;
    // Named in the refusal by the path a grant would have to be about, not by a hash nobody can
    // grant.
    expect(found.path).toBe(INDEXED_PATH);
    expect(filesystem.reads).toEqual([]);
  }, 60_000);

  it("says there is no path to check when the document was indexed from bytes alone", async () => {
    const bytes = await realPdf();
    const result = expectIndexed(
      await indexDocument(store, embedder, {
        bytes,
        name: "pasted.pdf",
        filePath: null,
        pageCount: 1,
        chunkingProfile: "balanced",
        pages: [{ page: 1, text: PAGE_ONE, source: "pdf" }],
      }),
    );
    const filesystem = spyFilesystem(bytes);

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { contentHash: result.contentHash, access: "filesystem", ...filesystem },
    );

    expect(found.status).toBe("no-recorded-path");
    expect(filesystem.reads).toEqual([]);
  }, 60_000);
});

describe("stopping", () => {
  it("reports cancellation as an outcome rather than a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const filesystem = spyFilesystem(await realPdf());

    const found = await resolveDocumentPages(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: INDEXED_PATH, access: "index-first", signal: controller.signal, ...filesystem },
    );

    expect(found.status).toBe("cancelled");
  }, 60_000);
});
