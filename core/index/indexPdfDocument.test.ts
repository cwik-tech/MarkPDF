import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { semanticIndexPath } from "../paths.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { indexPdfDocument } from "./indexPdfDocument.js";
import { expectIndexed } from "./indexResult.test-support.js";

/**
 * V5's acceptance criterion, end to end: content known to be on PDF page 1 is *stored* with
 * `page_number = 1`, and the fixture's table is stored on page 2.
 *
 * Everything below the entry point is real — a real PDF, the real PDF Inspector binding, a real
 * SQLite file on disk. Only the embedding model is replaced, because the default suite must stay
 * offline. The test calls one production function and then reads the database, so nothing here
 * composes the pipeline itself: a test that wired extraction to indexing by hand would prove the
 * test works, not the product.
 */

const PAGE_ONE_SENTINEL = "Administrative preamble concerning departmental record keeping";
const FINAL_TABLE_ROW = ["Enterprise", "1204", "1318"];
const PAGE_THREE_DECOY = "Enterprise revenue is discussed on page 2 of this report";

async function buildReportPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([612, 792]);
  first.drawText("Annual Report", { x: 60, y: 720, size: 20, font: bold });
  first.drawText(PAGE_ONE_SENTINEL, { x: 60, y: 680, size: 12, font });
  first.drawText("Filing procedures and correspondence retained for audit review.", { x: 60, y: 660, size: 12, font });

  const second = pdf.addPage([612, 792]);
  second.drawText("Revenue by Segment", { x: 60, y: 720, size: 16, font: bold });
  const columnX = [60, 260, 420];
  let rowY = 680;
  ["Segment", "Revenue 2025", "Revenue 2026"].forEach((cell, column) => {
    second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font: bold });
  });
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });
  for (const row of [["Consumer", "412", "455"], ["Education", "308", "331"], ["Government", "677", "702"], FINAL_TABLE_ROW]) {
    rowY -= 24;
    row.forEach((cell, column) => second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font }));
  }
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });

  const third = pdf.addPage([612, 792]);
  third.drawText("Notes", { x: 60, y: 720, size: 16, font: bold });
  third.drawText(PAGE_THREE_DECOY, { x: 60, y: 680, size: 12, font });

  return pdf.save();
}

const SCAN_MARKER = "SCANNED PAGE MARKER PHRASE";
const PAGE_AFTER_SCAN = "Closing remarks recorded on the page that follows the scan";
/** Exactly 60 non-space characters: comfortably under the old renderer rule's 100-character bar. */
const STAMP_TEXT = "Invoice".padEnd(60, "x").slice(0, 60);
const MIXED_PAGE_ONE = "Opening page carrying an ordinary and complete text layer of ample length";
/** 71 non-space characters: under the old rule's 100-character bar, over the chunker's minimum. */
const SPARSE_PAGE_THREE = "Appendix A lists the source records retained for the audit trail.";
const SCAN_BODY_OCR = "The escape velocity of Deimos is five point six metres per second at the surface.";

/**
 * Page 1 readable, page 2 a scan with a thin stamp, page 3 readable but sparse.
 *
 * Page 3 is the divergence case made concrete: its text layer is far under the old renderer
 * rule's 100-character bar, so that rule would have replaced it with OCR.
 */
async function buildMixedDensityPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText(MIXED_PAGE_ONE, { x: 50, y: 700, size: 11, font });
  first.drawText("Filing procedures and correspondence retained for audit review each year.", { x: 50, y: 680, size: 11, font });

  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1224, 1584);
  context.fillStyle = "#000000";
  context.font = "36px Helvetica";
  context.fillText("SCANNED BODY CONTENT", 120, 200);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  const second = pdf.addPage([612, 792]);
  second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  second.drawText(STAMP_TEXT, { x: 50, y: 760, size: 10, font });

  const third = pdf.addPage([612, 792]);
  third.drawText(SPARSE_PAGE_THREE, { x: 50, y: 700, size: 11, font });

  return pdf.save();
}

/** A scanned page carrying a short text stamp, the shape the old <100-character rule targeted. */
async function buildStampedScanPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText("First page with an ordinary and complete text layer of sufficient length.", { x: 50, y: 700, size: 11, font });

  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1224, 1584);
  context.fillStyle = "#000000";
  context.font = "36px Helvetica";
  context.fillText("SCANNED BODY CONTENT", 120, 200);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  const second = pdf.addPage([612, 792]);
  second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  second.drawText(STAMP_TEXT, { x: 50, y: 760, size: 10, font });

  return pdf.save();
}

async function buildScannedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText("Introduction with a real text layer on the first page of the document", { x: 60, y: 700, size: 12, font });

  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1224, 1584);
  context.fillStyle = "#000000";
  context.font = "36px Helvetica";
  context.fillText(SCAN_MARKER, 120, 200);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  const second = pdf.addPage([612, 792]);
  second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });

  // A third page with real text, *after* the scan. This is what makes a skipped page detectable:
  // if page numbers came from position in the surviving list rather than from the document, this
  // page would be stored as page 2.
  const third = pdf.addPage([612, 792]);
  third.drawText(PAGE_AFTER_SCAN, { x: 60, y: 700, size: 12, font });

  return pdf.save();
}

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder();

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-indexpdf-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Read what is actually on disk, rather than trusting the value the pipeline returned. */
function storedChunks(): Array<{ page: number; text: string }> {
  const db = new Database(semanticIndexPath(dataDir), { readonly: true });
  const rows = db.prepare("SELECT page_number AS page, text FROM document_chunks ORDER BY page_number, chunk_index").all();
  db.close();
  return rows.map((row) => {
    const record = row as { page: number; text: string };
    return { page: record.page, text: record.text };
  });
}

function pagesHolding(chunks: ReadonlyArray<{ page: number; text: string }>, phrase: string): number[] {
  return [...new Set(chunks.filter((chunk) => chunk.text.includes(phrase)).map((chunk) => chunk.page))];
}

describe("indexing a PDF straight from its bytes", () => {
  it("stores page one's text on page one and the table's final row on page two", async () => {
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildReportPdf(),
        name: "report.pdf",
        filePath: null,
        chunkingProfile: "balanced",
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.pageCount).toBe(3);

    const chunks = storedChunks();
    expect(pagesHolding(chunks, PAGE_ONE_SENTINEL)).toEqual([1]);

    const tableRowPages = [...new Set(
      chunks.filter((chunk) => FINAL_TABLE_ROW.every((cell) => chunk.text.includes(cell))).map((chunk) => chunk.page),
    )];
    expect(tableRowPages).toEqual([2]);

    // The decoy names page 2 in its own words. Storing it on page 2 would be the exact failure
    // this criterion exists to catch.
    expect(pagesHolding(chunks, "discussed on page 2")).toEqual([3]);
  }, 120_000);

  it("does not store a scanned page as trusted text when no OCR text was supplied", async () => {
    // Phase 2 does not OCR. A page PDF Inspector reports as unreadable must be left out rather
    // than indexed from whatever fragments the native layer scraped off it.
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildScannedPdf(),
        name: "scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
      }),
    );

    expect(result.pageCount).toBe(3);
    expect(result.textSource).toBe("pdf");

    // Page 2 is absent, and page 3 is still page 3. A skipped page must leave a gap rather than
    // pull every later page down by one.
    const chunks = storedChunks();
    expect([...new Set(chunks.map((chunk) => chunk.page))]).toEqual([1, 3]);
    expect(pagesHolding(chunks, PAGE_AFTER_SCAN)).toEqual([3]);
  }, 120_000);

  it("stores a scanned page from the text recognition produces for it", async () => {
    const ocrText = "The escape velocity of Deimos is five point six metres per second measured from its surface.";
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildScannedPdf(),
        name: "scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
        resolveOcr: async (request) => request.pages.map((page) => ({ page, text: ocrText })),
      }),
    );

    expect(result.textSource).toBe("mixed");
    const chunks = storedChunks();
    expect(pagesHolding(chunks, "escape velocity of Deimos")).toEqual([2]);
    expect(pagesHolding(chunks, PAGE_AFTER_SCAN)).toEqual([3]);
  }, 120_000);

  it("reports reading the document, then how many pages it read", async () => {
    // PDF Inspector exposes no progress callback of any kind, so nothing can report "page 3 of
    // 12" while the native parse runs. These two events are the strongest honest signal
    // available: the work has started, and it has finished with a known page count. The
    // per-page granularity the renderer loop used to emit is gone and cannot be recovered
    // without a callback the package does not have.
    const reported: Array<{ status: string; current: number | undefined; total: number | undefined }> = [];

    await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      onProgress: (progress) => reported.push({ status: progress.status, current: progress.current, total: progress.total }),
    });

    const reading = reported.filter((event) => event.status === "checking");
    // First: the parse has started and nothing is knowable about its extent yet.
    expect(reading[0]).toEqual({ status: "checking", current: undefined, total: undefined });
    // Second: the parse returned, so the page count is known and the interface has a real
    // total. Position matters — `indexDocument` emits its own "checking" after these two.
    expect(reading[1]).toEqual({ status: "checking", current: 3, total: 3 });
  }, 120_000);

  it("reports recognition as its own phase, before any indexing, while a scan is read", async () => {
    // The defect this closes: the window showed "Checking index" for the whole time the main
    // process was recognising pages, so the slowest part of preparing a scanned document was
    // reported as though nothing in particular were happening. Recognition now crosses as its own
    // status with its own counters, and it must arrive before the first embedding event.
    const reported: Array<{ status: string; current: number | undefined; total: number | undefined; message: string | undefined }> = [];

    await indexPdfDocument(store, embedder, {
      bytes: await buildScannedPdf(),
      name: "scan.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      resolveOcr: async (request) => {
        request.onProgress?.({ page: 2, current: 1, total: 1, totalPages: request.totalPages, message: "Reading page 2 with OCR" });
        return request.pages.map((page) => ({ page, text: SCAN_BODY_OCR }));
      },
      onProgress: (progress) =>
        reported.push({ status: progress.status, current: progress.current, total: progress.total, message: progress.message }),
    });

    expect(reported.filter((event) => event.status === "ocr")).toEqual([
      { status: "ocr", current: 2, total: 3, message: "Reading page 2 with OCR" },
    ]);
    expect(
      reported.findIndex((event) => event.status === "ocr"),
      "recognition is reported before embedding starts",
    ).toBeLessThan(reported.findIndex((event) => event.status === "indexing"));
  }, 120_000);

  it("invents no recognition phase for a document that never needed one", async () => {
    // A reused or ordinary text document must not show OCR work that did not happen.
    const reported: string[] = [];

    await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      resolveOcr: async (request) => request.pages.map((page) => ({ page, text: "" })),
      onProgress: (progress) => reported.push(progress.status),
    });

    expect(reported).not.toContain("ocr");
  }, 120_000);

  it("reports no page total when it was cancelled before it could read one", async () => {
    const controller = new AbortController();
    controller.abort();
    const reported: string[] = [];

    await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
      onProgress: (progress) => reported.push(progress.status),
    });

    expect(reported).toEqual([]);
  }, 120_000);

  it("uses the renderer's OCR for a scan that carries a thin text stamp", async () => {
    // Falsification of the claim that the cutover preserves OCR behaviour, for the case the old
    // renderer rule was actually written for. The old rule replaced a page's text with OCR when
    // the native layer held fewer than 100 non-space characters. Here a scanned page carries a
    // 60-character stamp — well under that threshold — so the old path would have used OCR.
    //
    // Measured against 1.17.0: PDF Inspector flags this page `needsOcr` with reason "scanned"
    // and returns *no* markdown for it at all, discarding the stamp. So the new path uses the
    // candidate too, and the two agree on this shape of document.
    const ocrText = "The escape velocity of Deimos is five point six metres per second at the surface.";
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildStampedScanPdf(),
        name: "stamped-scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
        resolveOcr: async (request) => request.pages.map((page) => ({ page, text: ocrText })),
      }),
    );

    expect(result.textSource).toBe("mixed");
    const chunks = storedChunks();
    expect(pagesHolding(chunks, "escape velocity of Deimos")).toEqual([2]);
    // The stamp itself is absent, because the extractor discarded it rather than mixing a
    // fragment of native text into an OCR'd page.
    expect(pagesHolding(chunks, STAMP_TEXT)).toEqual([]);
  }, 120_000);

  it("recognises the pages the extractor flagged and no others, however thin their text", async () => {
    // Which pages are recognised is the extractor's judgement, not a character count.
    //
    // Page 1 is ordinary prose. Page 2 is a scan carrying a 60-character stamp — under the old
    // renderer rule's 100-character bar, so that rule would have replaced it. Page 3 is a readable
    // page whose text layer is also under that bar. PDF Inspector flags only page 2, so page 2 is
    // the only page recognition is asked about, and the other two keep their native Markdown.
    const asked: number[] = [];
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildMixedDensityPdf(),
        name: "mixed.pdf",
        filePath: null,
        chunkingProfile: "balanced",
        resolveOcr: async (request) => {
          asked.push(...request.pages);
          return [{ page: 2, text: SCAN_BODY_OCR }];
        },
      }),
    );

    expect(asked).toEqual([2]);
    expect(result.textSource).toBe("mixed");
    const chunks = storedChunks();

    expect(pagesHolding(chunks, SCAN_BODY_OCR)).toEqual([2]);
    expect(pagesHolding(chunks, MIXED_PAGE_ONE)).toEqual([1]);
    expect(pagesHolding(chunks, SPARSE_PAGE_THREE)).toEqual([3]);
  }, 120_000);

  it("reports a document with a page nothing read as incomplete, not as ready", async () => {
    // The failure this exists to stop is a silent success. A scan indexed with no way to recognise
    // it produces a document that is searchable, citable, and missing a page — and every surface
    // that asked was told it was ready. Naming the pages is what lets a caller say which.
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildScannedPdf(),
        name: "scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
      }),
    );

    expect(result.status).toBe("incomplete");
    expect(result.unresolvedPages).toEqual([2]);
  }, 120_000);

  it("reports the same document as ready once recognition has answered for it", async () => {
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildScannedPdf(),
        name: "scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
        resolveOcr: async (request) => request.pages.map((page) => ({ page, text: SCAN_BODY_OCR })),
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.unresolvedPages).toEqual([]);
  }, 120_000);

  it("says how many pages it read and how many of them it had to recognise", async () => {
    const messages: string[] = [];
    await indexPdfDocument(store, embedder, {
      bytes: await buildMixedDensityPdf(),
      name: "mixed.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      resolveOcr: async (request) => request.pages.map((page) => ({ page, text: SCAN_BODY_OCR })),
      onProgress: (progress) => {
        if (progress.message !== undefined) messages.push(progress.message);
      },
    });

    // Recognition is the slow part of reading a document, so a reader watching a scan is told that
    // is where the time went.
    expect(messages).toContain("Read 3 pages, 1 read by OCR");
  }, 120_000);

  it("says only the page count when no candidates were offered", async () => {
    const messages: string[] = [];
    await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      onProgress: (progress) => {
        if (progress.message !== undefined) messages.push(progress.message);
      },
    });
    expect(messages).toContain("Read 3 pages");
  }, 120_000);

  it("caches every page of the document, keeping unread and blank pages as empty text", async () => {
    // The scanned fixture's page 2 contributes no chunk — no OCR candidate was offered — and
    // page 3 does. The cache still has to describe all three pages: it is keyed to the document,
    // so a gap would make it a record of a shorter document than the one on disk.
    const { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION } = await import("../models.js");
    const result = expectIndexed(
      await indexPdfDocument(store, embedder, {
        bytes: await buildScannedPdf(),
        name: "scan.pdf",
        filePath: null,
        chunkingProfile: "balanced",
      }),
    );

    const cached = store.getMarkdown(result.documentId, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION);
    expect(cached?.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(cached?.pages[1]?.markdown).toBe("");
    expect(cached?.pages[0]?.markdown.length).toBeGreaterThan(0);
    expect(cached?.pages[2]?.markdown).toContain(PAGE_AFTER_SCAN);
    // And why each one is what it is. Page 2 is empty because nothing read it, which is a different
    // fact from a page that was read and found blank — and the only one worth going back for.
    expect(cached?.provenance).toEqual([
      { page: 1, status: "read" },
      { page: 2, status: "unresolved" },
      { page: 3, status: "read" },
    ]);

    const db = new Database(semanticIndexPath(dataDir), { readonly: true });
    const row = db
      .prepare("SELECT markdown_engine, markdown_version FROM documents WHERE content_hash = ?")
      .get(result.contentHash) as Record<string, unknown>;
    db.close();
    expect(row.markdown_engine).toBe(MARKDOWN_ENGINE_ID);
    expect(row.markdown_version).toBe(MARKDOWN_VERSION);
  }, 120_000);

  it("writes no cache and claims no engine when it is cancelled before it indexes", async () => {
    // The cache-on-cancel contract, stated: nothing is written after cancellation is observed.
    const controller = new AbortController();
    controller.abort();

    const result = await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
  }, 120_000);

  it("stops between announcing the read and starting it", async () => {
    // The progress callback can abort synchronously. Without a check between it and the native
    // classification, a cancelled job still pays for a full parse before noticing.
    const controller = new AbortController();
    const result = await indexPdfDocument(store, embedder, {
      // Bytes that are not a PDF: if the parse were started it would throw, so returning
      // `cancelled` is the observable proof it was not.
      bytes: new TextEncoder().encode("this is not a PDF at all"),
      name: "broken.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
  }, 120_000);

  it("writes nothing when the caller cancels before extraction begins", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
    expect(storedChunks()).toEqual([]);
  }, 120_000);

  it("refuses before it parses, so a cancelled job never touches the document at all", async () => {
    // Bytes that are not a PDF. Extraction would throw on them, so returning `cancelled` instead
    // of an error is the observable proof that the signal was read before the parse was
    // attempted rather than after it came back.
    const controller = new AbortController();
    controller.abort();

    const result = await indexPdfDocument(store, embedder, {
      bytes: new TextEncoder().encode("this is not a PDF at all"),
      name: "broken.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
  }, 120_000);

  it("writes nothing when the caller cancels while the native parse is running", async () => {
    // The package exposes no AbortSignal, so the parse itself cannot be interrupted. What is
    // guaranteed is that a cancel arriving during it is honoured the moment it returns, before
    // a single row is written.
    const controller = new AbortController();
    const running = indexPdfDocument(store, embedder, {
      bytes: await buildReportPdf(),
      name: "report.pdf",
      filePath: null,
      chunkingProfile: "balanced",
      signal: controller.signal,
    });
    controller.abort();

    expect(await running).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
    expect(storedChunks()).toEqual([]);
  }, 120_000);
});
