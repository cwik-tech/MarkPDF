import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { OverlayItem } from "../types";
import {
  exportPdfBytes,
  extractDocumentOutline,
  extractEditableOverlays,
  extractPersistedSyntheticOutline,
  loadPdfDocument,
} from "./document";

async function createSourcePdf() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([612, 792]);

  page.drawText("Bookmark target phrase", {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0, 0, 0),
  });

  return pdfDoc.save();
}

async function createHeadingPdf() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const firstPage = pdfDoc.addPage([612, 792]);
  const secondPage = pdfDoc.addPage([612, 792]);

  firstPage.drawText("Executive Summary", {
    x: 72,
    y: 700,
    size: 24,
    font: bold,
    color: rgb(0, 0, 0),
  });
  firstPage.drawText("This paragraph is normal body text and should not become an outline entry.", {
    x: 72,
    y: 660,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });
  secondPage.drawText("1. Market Opportunity", {
    x: 72,
    y: 700,
    size: 20,
    font: bold,
    color: rgb(0, 0, 0),
  });
  secondPage.drawText("Another body paragraph with enough words to look like prose rather than a heading.", {
    x: 72,
    y: 660,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  return pdfDoc.save();
}

describe("editable bookmark overlays", () => {
  it("persist through MarkPDF metadata without writing native PDF annotations", async () => {
    const sourceBytes = await createSourcePdf();
    const bookmark: OverlayItem = {
      id: "bookmark-1",
      kind: "bookmark",
      page: 1,
      x: 72,
      y: 86,
      width: 1,
      height: 1,
      text: "Bookmark target phrase",
      color: "#facc15",
    };

    const savedBytes = await exportPdfBytes(
      Uint8Array.from(sourceBytes),
      [bookmark],
      [],
      false,
      {
        bakeOverlays: false,
        persistEditable: true,
        writeStandardAnnotations: true,
      },
    );

    expect(await extractEditableOverlays(Uint8Array.from(savedBytes))).toEqual([
      bookmark,
    ]);

    const savedPdf = await PDFDocument.load(savedBytes);
    const annots = savedPdf
      .getPage(0)
      .node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    expect(annots?.size() ?? 0).toBe(0);
  });
});

describe("synthetic outlines", () => {
  it("creates an outline from heading-like PDF text when no native outline exists", async () => {
    const sourceBytes = Uint8Array.from(await createHeadingPdf());
    const pdfDoc = await loadPdfDocument(sourceBytes);

    try {
      const result = await extractDocumentOutline(pdfDoc, sourceBytes);

      expect(result.source).toBe("synthetic");
      expect(result.generated).toBe(true);
      expect(result.outline.map((item) => [item.title, item.page])).toEqual([
        ["Executive Summary", 1],
        ["1. Market Opportunity", 2],
      ]);
    } finally {
      await pdfDoc.destroy();
    }
  });

  it("persists and reloads synthetic outline metadata", async () => {
    const sourceBytes = Uint8Array.from(await createSourcePdf());
    const outline = [
      {
        id: "synthetic-outline-1",
        title: "Saved Synthetic Heading",
        page: 1,
        children: [],
      },
    ];
    const savedBytes = Uint8Array.from(
      await exportPdfBytes(sourceBytes, [], [], false, {
        bakeOverlays: false,
        persistEditable: true,
        writeStandardAnnotations: false,
        persistSyntheticOutline: true,
        syntheticOutline: outline,
      }),
    );

    expect(await extractPersistedSyntheticOutline(savedBytes)).toEqual(outline);

    const pdfDoc = await loadPdfDocument(savedBytes);
    try {
      const result = await extractDocumentOutline(pdfDoc, savedBytes);

      expect(result.source).toBe("synthetic");
      expect(result.generated).toBe(false);
      expect(result.outline).toEqual(outline);
    } finally {
      await pdfDoc.destroy();
    }
  });
});
