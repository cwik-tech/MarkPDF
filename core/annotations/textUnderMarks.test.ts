import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readDocumentAnnotations } from "./readAnnotations.js";
import { quotesUnderMarks } from "./textUnderMarks.js";
import { buildReviewedContract, TEXT_LINES } from "./reviewedContract.test-support.js";

describe("quotesUnderMarks", () => {
  it("reads the words under each highlight from the page's own text", async () => {
    const bytes = await buildReviewedContract();
    const annotations = await readDocumentAnnotations(bytes);
    const quotes = await quotesUnderMarks(bytes, annotations);

    expect(annotations.map((annotation) => quotes.get(annotation.id))).toEqual([
      TEXT_LINES.termination,
      TEXT_LINES.payment,
      TEXT_LINES.notices,
    ]);
  });

  it("joins a mark that spans two lines, top line first", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText("The first line of the clause", { x: 72, y: 700, size: 14, font });
    page.drawText("continues on the second line", { x: 72, y: 680, size: 14, font });
    const first = { left: 72, bottom: 697, right: 72 + font.widthOfTextAtSize("The first line of the clause", 14), top: 711 };
    const second = { left: 72, bottom: 677, right: 72 + font.widthOfTextAtSize("continues on the second line", 14), top: 691 };
    const quotes = await quotesUnderMarks(await pdf.save(), [{ id: "two-lines", page: 1, marks: [first, second] }]);

    expect(quotes.get("two-lines")).toBe("The first line of the clause continues on the second line");
  });

  it("answers null for a mark over a page with no text", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const quotes = await quotesUnderMarks(await pdf.save(), [
      { id: "blank", page: 1, marks: [{ left: 72, bottom: 697, right: 300, top: 711 }] },
    ]);
    expect(quotes.get("blank")).toBeNull();
  });

  it("does not open the document when nothing marks any text", async () => {
    // A note pinned to a point has no marks. Opening pdf.js for it would cost a full parse.
    const quotes = await quotesUnderMarks(new Uint8Array([0x25, 0x50, 0x44, 0x46]), [{ id: "pin", page: 1, marks: [] }]);
    expect(quotes.get("pin")).toBeNull();
  });
});
