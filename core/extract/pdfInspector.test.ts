import { describe, expect, it, beforeAll } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { extractPagesFromPdf, type ExtractedDocument } from "./pdfInspector.js";

/** Unwrap a successful extraction; a cancelled one here means the fixture setup is wrong. */
async function extract(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await extractPagesFromPdf(bytes);
  if (result.status === "cancelled") throw new Error("Extraction reported cancelled with no signal supplied.");
  return result.document;
}

/**
 * Phase 2's first capability: content known to be on a given page of the source PDF is reported
 * on that page, counted from one.
 *
 * Every expected value below is fixed by how the fixture is *built*, never copied from extractor
 * output. An assertion taken from the implementation proves only that the implementation is
 * deterministic, and a systematically wrong page number is the exact failure this work prevents.
 */

const PAGE_ONE_SENTINEL = "Administrative preamble concerning departmental record keeping";
const TABLE_HEADER = ["Segment", "Revenue 2025", "Revenue 2026"];
const TABLE_ROWS = [
  ["Consumer", "412", "455"],
  ["Education", "308", "331"],
  ["Government", "677", "702"],
  ["Enterprise", "1204", "1318"],
];
/** Page 3 names page 2 in its own text, so returning the right words from the wrong page fails. */
const PAGE_THREE_DECOY = "Enterprise revenue is discussed on page 2 of this report";

async function buildTableFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([612, 792]);
  first.drawText("Annual Report", { x: 60, y: 720, size: 20, font: bold });
  first.drawText(PAGE_ONE_SENTINEL, { x: 60, y: 680, size: 12, font });

  const second = pdf.addPage([612, 792]);
  second.drawText("Revenue by Segment", { x: 60, y: 720, size: 16, font: bold });
  const columnX = [60, 260, 420];
  let rowY = 680;
  TABLE_HEADER.forEach((cell, column) => {
    second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font: bold });
  });
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });
  for (const row of TABLE_ROWS) {
    rowY -= 24;
    row.forEach((cell, column) => {
      second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font });
    });
  }
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });

  const third = pdf.addPage([612, 792]);
  third.drawText("Notes", { x: 60, y: 720, size: 16, font: bold });
  third.drawText(PAGE_THREE_DECOY, { x: 60, y: 680, size: 12, font });

  return pdf.save();
}

const SCAN_MARKER = "SCANNED PAGE MARKER PHRASE";

/** Text rasterised onto a canvas and embedded as an image: a page with no text layer at all. */
function scannedPageImage(lines: readonly string[]): Buffer {
  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1224, 1584);
  context.fillStyle = "#000000";
  context.font = "36px Helvetica";
  lines.forEach((line, index) => context.fillText(line, 120, 200 + index * 60));
  return canvas.toBuffer("image/png");
}

async function buildScannedFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText("Introduction with a real text layer on the first page", { x: 60, y: 700, size: 12, font });

  const image = await pdf.embedPng(scannedPageImage([SCAN_MARKER, "Rendered as pixels, not as text."]));
  const second = pdf.addPage([612, 792]);
  second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });

  const third = pdf.addPage([612, 792]);
  third.drawText("Closing notes with a real text layer on the third page", { x: 60, y: 700, size: 12, font });

  return pdf.save();
}

function pagesContaining(document: ExtractedDocument, phrase: string): number[] {
  return document.pages.filter((page) => page.markdown.includes(phrase)).map((page) => page.page);
}

/**
 * A two-column page dense enough for the engine to recognise the layout.
 *
 * Density matters and was measured: nine short lines per column are read as ordinary prose and
 * report no columns at all. Forty-five lines are recognised, stably across gutter widths of 40
 * and 80 points and across two and three columns.
 */
const COLUMN_WORDS =
  "revenue segment growth renewal bookings services attach margin guidance variance retention churn region portfolio pricing".split(
    " ",
  );

function columnLine(index: number): string {
  return Array.from({ length: 7 }, (_unused, word) => COLUMN_WORDS[(index * 7 + word) % COLUMN_WORDS.length]).join(" ");
}

const COLUMN_PAGE_ONE_SENTINEL = "Opening page set in a single column of running prose";
const COLUMN_PAGE_THREE_SENTINEL = "Closing page set in a single column of running prose";

async function buildColumnFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText(COLUMN_PAGE_ONE_SENTINEL, { x: 60, y: 700, size: 12, font });

  const second = pdf.addPage([612, 792]);
  const gutter = 40;
  const columnWidth = (612 - 80 - gutter) / 2;
  for (const column of [0, 1]) {
    for (let line = 0; line < 45; line += 1) {
      second.drawText(columnLine(column * 45 + line), {
        x: 40 + column * (columnWidth + gutter),
        y: 750 - line * 15,
        size: 8,
        font,
        maxWidth: columnWidth,
      });
    }
  }

  const third = pdf.addPage([612, 792]);
  third.drawText(COLUMN_PAGE_THREE_SENTINEL, { x: 60, y: 700, size: 12, font });

  return pdf.save();
}

let tableDoc: ExtractedDocument;
let scannedDoc: ExtractedDocument;
let columnDoc: ExtractedDocument;

beforeAll(async () => {
  tableDoc = await extract(await buildTableFixture());
  scannedDoc = await extract(await buildScannedFixture());
  columnDoc = await extract(await buildColumnFixture());
}, 180_000);

describe("anchoring extracted content to the page it came from", () => {
  it("reports one entry per page of the document, numbered from one, in source order", () => {
    expect(tableDoc.pageCount).toBe(3);
    expect(tableDoc.pages.map((page) => page.page)).toEqual([1, 2, 3]);
  });

  it("puts the first page's text on page one", () => {
    expect(pagesContaining(tableDoc, PAGE_ONE_SENTINEL)).toEqual([1]);
  });

  it("puts the table's final row on page two, where the table was drawn", () => {
    // The final row rather than the first: a table that loses its tail still passes an
    // assertion aimed at the top of it.
    const finalRow = TABLE_ROWS.at(-1)!;
    const found = tableDoc.pages
      .filter((page) => finalRow.every((cell) => page.markdown.includes(cell)))
      .map((page) => page.page);
    expect(found).toEqual([2]);
  });

  it("puts the decoy on page three, not on the page it talks about", () => {
    expect(pagesContaining(tableDoc, "discussed on page 2")).toEqual([3]);
  });

  it("reports the table page itself as page two", () => {
    // Not merely that table text appears on page 2. `pagesWithTables` is a separate engine field
    // on a different base from `pages[].page`, so it needs its own assertion or a normalizer
    // applied to the wrong base would go unnoticed.
    expect(tableDoc.pagesWithTables).toEqual([2]);
  });

  it("reports no multi-column pages for a single-column document", () => {
    expect(tableDoc.pagesWithColumns).toEqual([]);
  });

  it("reports no page as needing OCR when every page has a text layer", () => {
    expect(tableDoc.pagesNeedingOcr).toEqual([]);
    expect(tableDoc.pages.map((page) => page.needsOcr)).toEqual([false, false, false]);
  });
});

describe("a document whose middle page is a scan", () => {
  it("flags only the scanned page as needing OCR, on the page it actually is", () => {
    expect(scannedDoc.pagesNeedingOcr).toEqual([2]);
    expect(scannedDoc.pages.map((page) => page.needsOcr)).toEqual([false, true, false]);
  });

  it("carries the engine's machine-readable reason through unchanged, keyed to the same page", () => {
    // The reason string is the engine's vocabulary, asserted verbatim on purpose: if it changes
    // upstream this test fails and somebody looks, rather than a downstream consumer silently
    // receiving a word it does not recognise.
    expect(scannedDoc.ocrReasonsByPage).toEqual([{ page: 2, reasons: ["scanned"] }]);
    expect(scannedDoc.pages[1]?.ocrReason).toBe("scanned");
  });

  it("still anchors the pages that do have text", () => {
    expect(pagesContaining(scannedDoc, "first page")).toEqual([1]);
    expect(pagesContaining(scannedDoc, "third page")).toEqual([3]);
  });

  it("leaves the scanned page's markdown empty rather than inventing content for it", () => {
    // Phase 2 does not OCR. An empty page is honest; a page with guessed text would be indexed
    // and cited as though it were read.
    expect(scannedDoc.pages[1]?.markdown).toBe("");
  });
});

describe("a document whose middle page is set in two columns", () => {
  it("reports the multi-column page as page two, where the columns were drawn", () => {
    // `pagesWithColumns` is on a different base from `pages[].page`, exactly like
    // `pagesWithTables`. Without a fixture that fills it, its normalizer would be the one
    // page-bearing field nothing measured.
    expect(columnDoc.pagesWithColumns).toEqual([2]);
  });

  it("still anchors the single-column pages either side of it", () => {
    expect(pagesContaining(columnDoc, COLUMN_PAGE_ONE_SENTINEL)).toEqual([1]);
    expect(pagesContaining(columnDoc, COLUMN_PAGE_THREE_SENTINEL)).toEqual([3]);
  });

  it("does not mistake columns for a table", () => {
    expect(columnDoc.pagesWithTables).toEqual([]);
  });
});
