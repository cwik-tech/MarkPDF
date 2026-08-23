import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { findIndexedDocument } from "./documentLookup.js";
import { contentHash } from "../hash.js";

/**
 * Finding an already-indexed document by the path a person typed.
 *
 * The property under test is what the lookup does *not* do. A document that is already in the
 * index is found by a database query alone — no `stat`, no `open`, no `realpath` — so searching a
 * library you have already indexed needs no filesystem permission at all. That is what makes the
 * highest-traffic command usable without granting anything, and it is only true if the code path
 * genuinely avoids the filesystem.
 */

let dataDir: string;
let store: SemanticStore;
const BYTES = new TextEncoder().encode("a document");
const INDEXED_PATH = "/Users/someone/Papers/report.pdf";

/** Records every filesystem touch, so a test can assert none happened. */
function spyFilesystem(bytes: Uint8Array = BYTES) {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string) => {
      reads.push(path);
      return bytes;
    },
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-lookup-"));
  store = openSemanticStore({ dataDir });
  store.upsertDocument({
    contentHash: contentHash(BYTES),
    name: "report.pdf",
    filePath: INDEXED_PATH,
    fileSize: BYTES.byteLength,
    pageCount: 1,
    textSource: "pdf",
    textExtractionVersion: 2,
    ocrExtractionVersion: 1,
    markdownEngine: null,
    markdownVersion: null,
  });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const allowNothing = { readRoots: [], writeRoots: [] };

describe("looking up a document by path", () => {
  it("finds an indexed document without touching the filesystem", async () => {
    const filesystem = spyFilesystem();
    const found = await findIndexedDocument(store, allowNothing, { path: INDEXED_PATH, ...filesystem });

    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.document.contentHash).toBe(contentHash(BYTES));
    expect(found.usedFilesystem).toBe(false);
    expect(filesystem.reads).toEqual([]);
  });

  it("finds it even when nothing at all has been granted", async () => {
    // The acceptance criterion. A path already in the index is answered from the index, so the
    // allowlist never comes into it.
    const found = await findIndexedDocument(store, allowNothing, { path: INDEXED_PATH, ...spyFilesystem() });
    expect(found.status).toBe("found");
  });

  it("finds it through a differently punctuated spelling, still without reading anything", async () => {
    // `./` and `../` segments, and a relative path, are arithmetic on strings — no `stat`, no
    // `realpath` — so normalising them keeps the common case on the branch that needs no
    // permission. What is deliberately *not* done here is resolving links, because that would
    // be a filesystem call and this branch exists to avoid one.
    const filesystem = spyFilesystem();

    const found = await findIndexedDocument(store, allowNothing, {
      path: "/Users/someone/Papers/2026/../report.pdf",
      readFile: filesystem.readFile,
    });

    expect(found.status).toBe("found");
    expect(filesystem.reads).toEqual([]);
  });

  it("still reaches for the file when only a link would make the two spellings the same", async () => {
    // Resolving links is what needs permission, so a spelling that differs only by one is
    // correctly refused rather than quietly matched.
    const filesystem = spyFilesystem();

    const found = await findIndexedDocument(store, allowNothing, {
      path: "/Users/someone/PapersLink/report.pdf",
      readFile: filesystem.readFile,
    });

    expect(found.status).toBe("denied");
    expect(filesystem.reads).toEqual([]);
  });

  it("never reaches for the file when the caller says the index is the only source", async () => {
    // Some callers are index-only by contract — the MCP `read_pages` tool is one — and for them a
    // fallback that quietly opened the file would turn a tool that needs no permission into one
    // that does.
    const filesystem = spyFilesystem();

    const found = await findIndexedDocument(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: "/Users/someone/Papers/moved.pdf", filesystemFallback: false, ...filesystem },
    );

    expect(found.status).toBe("not-indexed");
    expect(filesystem.reads).toEqual([]);
  });

  it("reads and hashes only when the path is not in the index", async () => {
    const filesystem = spyFilesystem();
    const elsewhere = "/Users/someone/Papers/moved.pdf";
    const found = await findIndexedDocument(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: elsewhere, ...filesystem },
    );

    // The same bytes, so hashing finds the document the path did not.
    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.usedFilesystem).toBe(true);
    expect(filesystem.reads).toEqual([elsewhere]);
  });

  it("refuses to read an unknown path that was never granted", async () => {
    // Falling back to the filesystem is where permission starts to matter, and this is the only
    // branch that needs it.
    const filesystem = spyFilesystem();
    const found = await findIndexedDocument(store, allowNothing, {
      path: "/Users/someone/Private/secret.pdf",
      ...filesystem,
    });

    expect(found.status).toBe("denied");
    expect(filesystem.reads).toEqual([]);
  });

  it("reports a granted but unindexed document as not indexed", async () => {
    const filesystem = spyFilesystem(new TextEncoder().encode("a different document"));
    const found = await findIndexedDocument(
      store,
      { readRoots: ["/Users/someone/Papers"], writeRoots: [] },
      { path: "/Users/someone/Papers/new.pdf", ...filesystem },
    );
    expect(found.status).toBe("not-indexed");
  });
});

describe("one path with more than one indexed version", () => {
  it("returns the most recently opened version, not an arbitrary one", async () => {
    // `documents.file_path` is not unique and the upsert conflicts on `content_hash`, so
    // re-indexing a file whose bytes changed leaves two rows sharing one path. An unordered
    // query would answer with whichever the planner happened to reach.
    const older = contentHash(BYTES);
    const newer = contentHash(new TextEncoder().encode("the same file, edited"));

    store.upsertDocument({
      contentHash: newer,
      name: "report.pdf",
      filePath: INDEXED_PATH,
      fileSize: 20,
      pageCount: 1,
      textSource: "pdf",
      textExtractionVersion: 2,
      ocrExtractionVersion: 1,
      markdownEngine: null,
      markdownVersion: null,
    });

    // Both rows are present; only the ordering distinguishes them.
    expect(store.getDocument(older)).not.toBeNull();
    expect(store.getDocument(newer)).not.toBeNull();

    const found = await findIndexedDocument(store, allowNothing, { path: INDEXED_PATH, ...spyFilesystem() });
    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    expect(found.document.contentHash).toBe(newer);
  });

  it("orders by when it was last opened, not by which row was written last", async () => {
    // The test above cannot tell the two halves of the ordering apart: both rows are written in
    // the same millisecond, so `id DESC` alone would satisfy it. Here the row written *first*
    // carries the later timestamp, so ordering by id would answer with the wrong one.
    const separate = mkdtempSync(join(tmpdir(), "markpdf-lookup-order-"));
    const times = ["2026-08-23T10:00:00.000Z", "2026-08-23T09:00:00.000Z"];
    let tick = 0;
    const clocked = openSemanticStore({
      dataDir: separate,
      clock: () => new Date(times[Math.min(tick++, times.length - 1)] ?? times[0]!),
    });

    try {
      const openedLater = contentHash(new TextEncoder().encode("opened at ten"));
      const writtenLater = contentHash(new TextEncoder().encode("written second, opened at nine"));
      for (const hash of [openedLater, writtenLater]) {
        clocked.upsertDocument({
          contentHash: hash,
          name: "report.pdf",
          filePath: INDEXED_PATH,
          fileSize: 20,
          pageCount: 1,
          textSource: "pdf",
          textExtractionVersion: 2,
          ocrExtractionVersion: 1,
          markdownEngine: null,
          markdownVersion: null,
        });
      }

      const found = await findIndexedDocument(clocked, allowNothing, { path: INDEXED_PATH, ...spyFilesystem() });

      expect(found.status).toBe("found");
      if (found.status !== "found") return;
      expect(found.document.contentHash).toBe(openedLater);
    } finally {
      clocked.close();
      rmSync(separate, { recursive: true, force: true });
    }
  });
});

describe("looking up a document by content hash", () => {
  it("finds it without touching the filesystem or the allowlist", async () => {
    const filesystem = spyFilesystem();
    const found = await findIndexedDocument(store, allowNothing, {
      contentHash: contentHash(BYTES),
      ...filesystem,
    });

    expect(found.status).toBe("found");
    expect(filesystem.reads).toEqual([]);
  });

  it("reports an unknown hash as not indexed rather than reaching for a file", async () => {
    const filesystem = spyFilesystem();
    const found = await findIndexedDocument(store, allowNothing, { contentHash: "b".repeat(64), ...filesystem });

    expect(found.status).toBe("not-indexed");
    expect(filesystem.reads).toEqual([]);
  });
});
