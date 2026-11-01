import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { anchorQuote, textRunsFromPage, type TextRun } from "./quoteAnchor";
import { loadPdfDocument } from "./document";

/** Runs laid out the way a page lists them: one per line, top to bottom, ten units per character. */
function lines(...texts: string[]): TextRun[] {
  return texts.map((text, index) => ({ text, x: 72, y: 100 + index * 20, width: text.length * 10, height: 14 }));
}

describe("anchorQuote", () => {
  it("marks the quoted words on one line, from where they start to where they end", () => {
    const anchor = anchorQuote(lines("The fee is due within thirty days of invoice."), "due within thirty days");
    expect(anchor?.occurrences).toBe(1);
    expect(anchor?.rects).toEqual([{ x: 72 + 11 * 10, y: 100, width: 22 * 10, height: 14 }]);
  });

  it("gives one rectangle for each line a quote crosses", () => {
    const anchor = anchorQuote(lines("Termination requires thirty", "days written notice."), "thirty days written");
    expect(anchor?.rects.map((rect) => rect.y)).toEqual([100, 120]);
    expect(anchor?.rects[0]).toMatchObject({ x: 72 + 21 * 10, width: 6 * 10 });
    expect(anchor?.rects[1]).toMatchObject({ x: 72, width: 12 * 10 });
  });

  it("reads past spacing, case, soft hyphens, a hyphen that breaks a word across lines, and ligatures", () => {
    expect(anchorQuote(lines("The  NOTICE   period"), "the notice period")?.occurrences).toBe(1);
    expect(anchorQuote(lines("a ter­mination right"), "termination right")?.occurrences).toBe(1);
    expect(anchorQuote(lines("the termi-", "nation right"), "termination right")?.rects).toHaveLength(2);
    expect(anchorQuote(lines("the eﬃcient party"), "efficient party")?.occurrences).toBe(1);
  });

  it("marks the first of several occurrences and says how many there are", () => {
    const anchor = anchorQuote(lines("notice period", "another notice period"), "notice period");
    expect(anchor?.occurrences).toBe(2);
    expect(anchor?.rects.map((rect) => rect.y)).toEqual([100]);
  });

  it("finds nothing when the quote is not on the page, and nothing for an empty quote", () => {
    expect(anchorQuote(lines("Payment terms"), "termination")).toBeNull();
    expect(anchorQuote(lines("Payment terms"), "   ")).toBeNull();
  });
});

describe("textRunsFromPage", () => {
  it("places a page's text where the window draws it, measured from the top of the page", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText("Termination requires notice", { x: 72, y: 700, size: 12, font });
    const document = await loadPdfDocument(await pdf.save());
    const runs = await textRunsFromPage(await document.getPage(1));

    const run = runs.find((entry) => entry.text.includes("Termination"));
    expect(run?.x).toBeCloseTo(72, 0);
    // The baseline is 92 units from the top; the run's box ends at the baseline and rises above it.
    expect(run !== undefined && run.y < 92 && run.y + run.height > 90).toBe(true);
    // pdf.js and pdf-lib measure with their own copies of the font metrics, a unit or so apart.
    expect(Math.abs((run?.width ?? 0) - font.widthOfTextAtSize("Termination requires notice", 12))).toBeLessThan(3);
  });
});
