import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
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

/**
 * What a document keeps about an annotation a reader made by dragging across text.
 *
 * Two readers have to be satisfied. Another PDF application only ever sees the standard
 * annotation, so the shape of a text-markup annotation — an enclosing rectangle plus one
 * quadrilateral per line — is the whole contract there. MarkPDF itself reopens its own metadata,
 * where the contract is that a document saved by any version still opens with its annotations
 * where the reader put them.
 */

/** The two lines a reader selected, and the enclosing box they produce, on a 792-point page. */
const SELECTED_LINES = {
  bounds: { x: 72, y: 80, width: 150, height: 78 },
  fragments: [
    { x: 0, y: 0, width: 150, height: 18 },
    { x: 0, y: 60, width: 130, height: 18 },
  ],
  /** The same two lines from the page's bottom-left corner, which is where a PDF measures. */
  firstQuad: [72, 712, 222, 712, 72, 694, 222, 694],
  secondQuad: [72, 652, 202, 652, 72, 634, 202, 634],
  enclosingRect: [72, 634, 222, 712],
  /** A point in the blank band between the two lines. Nothing may be painted here. */
  band: { x: 100, y: 673 },
};

function makeSelectionOverlay(overrides: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: "selection-1",
    kind: "highlight",
    page: 1,
    ...SELECTED_LINES.bounds,
    fragments: SELECTED_LINES.fragments.map((fragment) => ({ ...fragment })),
    color: "#facc15",
    ...overrides,
  };
}

async function annotationsOf(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes);
  const annots = pdfDoc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const found: Array<{ subtype: string; contents: string; rect: number[]; quadPoints: number[] }> = [];

  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const annotation = annots?.lookupMaybe(index, PDFDict);
    if (!annotation) continue;
    found.push({
      // `asString` keeps the PDF's leading slash; the subtype a reader would name does not.
      subtype: (annotation.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() ?? "").replace(/^\//, ""),
      contents: annotation.lookupMaybe(PDFName.of("Contents"), PDFString)?.decodeText() ?? "",
      rect: numbersOf(annotation.lookupMaybe(PDFName.of("Rect"), PDFArray)),
      quadPoints: numbersOf(annotation.lookupMaybe(PDFName.of("QuadPoints"), PDFArray)),
    });
  }

  return found;
}

function numbersOf(array: PDFArray | undefined): number[] {
  if (!array) return [];
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const value = array.lookupMaybe(index, PDFNumber);
    if (value) values.push(value.asNumber());
  }
  return values;
}

/**
 * The rectangles a flattened page fills, read back from what it will actually draw.
 *
 * pdf-lib writes a filled rectangle as a translation followed by a four-sided path, so this reads
 * the page the way a viewer would rather than trusting the call that produced it.
 */
async function filledRectangles(bytes: Uint8Array) {
  const pdfDoc = await PDFDocument.load(bytes);
  const contents = pdfDoc.context.lookup(pdfDoc.getPage(0).node.get(PDFName.of("Contents")));
  const streams: PDFRawStream[] = [];

  if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = pdfDoc.context.lookup(contents.get(index));
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }

  const text = streams
    .map((stream) => {
      const raw = Buffer.from(stream.contents);
      return (stream.dict.get(PDFName.of("Filter")) ? inflateSync(raw) : raw).toString("latin1");
    })
    .join("\n");

  const pattern =
    /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm[\s\S]*?0 0 m\s+0 (-?[\d.]+) l\s+(-?[\d.]+) -?[\d.]+ l/g;
  const rectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const match of text.matchAll(pattern)) {
    rectangles.push({
      x: Number(match[1]),
      y: Number(match[2]),
      height: Number(match[3]),
      width: Number(match[4]),
    });
  }
  return rectangles;
}

describe("standard annotations for a selection that crosses two lines", () => {
  it("writes one quadrilateral per selected line inside one enclosing rectangle", async () => {
    const sourceBytes = await createSourcePdf();

    const savedBytes = await exportPdfBytes(
      Uint8Array.from(sourceBytes),
      [makeSelectionOverlay()],
      [],
      false,
      { bakeOverlays: false, persistEditable: true, writeStandardAnnotations: true },
    );

    const annotations = await annotationsOf(Uint8Array.from(savedBytes));
    expect(annotations).toHaveLength(1);
    expect(annotations[0].subtype).toBe("Highlight");
    expect(annotations[0].rect).toEqual(SELECTED_LINES.enclosingRect);
    expect(annotations[0].quadPoints).toEqual([
      ...SELECTED_LINES.firstQuad,
      ...SELECTED_LINES.secondQuad,
    ]);
  });

  it("keeps a highlight the reader placed by hand as a single quadrilateral", async () => {
    const sourceBytes = await createSourcePdf();
    const placed: OverlayItem = {
      id: "placed-1",
      kind: "highlight",
      page: 1,
      x: 72,
      y: 80,
      width: 180,
      height: 28,
      color: "#facc15",
    };

    const savedBytes = await exportPdfBytes(Uint8Array.from(sourceBytes), [placed], [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });

    const annotations = await annotationsOf(Uint8Array.from(savedBytes));
    expect(annotations[0].quadPoints).toEqual([72, 712, 252, 712, 72, 684, 252, 684]);
  });

  it("exports a comment made on a selection as text markup that carries the comment", async () => {
    const sourceBytes = await createSourcePdf();
    const comment = makeSelectionOverlay({
      id: "comment-1",
      kind: "comment",
      text: "Check this against the plan",
      minimized: true,
    });

    const savedBytes = await exportPdfBytes(Uint8Array.from(sourceBytes), [comment], [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });

    const annotations = await annotationsOf(Uint8Array.from(savedBytes));
    expect(annotations[0].subtype).toBe("Highlight");
    expect(annotations[0].contents).toBe("Check this against the plan");
    expect(annotations[0].quadPoints).toEqual([
      ...SELECTED_LINES.firstQuad,
      ...SELECTED_LINES.secondQuad,
    ]);
  });

  it("exports a comment the reader placed on the page as a text note", async () => {
    const sourceBytes = await createSourcePdf();
    const placed: OverlayItem = {
      id: "comment-2",
      kind: "comment",
      page: 1,
      x: 72,
      y: 80,
      width: 180,
      height: 92,
      text: "A note about this page",
    };

    const savedBytes = await exportPdfBytes(Uint8Array.from(sourceBytes), [placed], [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });

    const annotations = await annotationsOf(Uint8Array.from(savedBytes));
    expect(annotations[0].subtype).toBe("Text");
    expect(annotations[0].contents).toBe("A note about this page");
    expect(annotations[0].quadPoints).toEqual([]);
  });
});

describe("flattening a selection that crosses two lines", () => {
  it("draws each selected line and leaves the band between them unpainted", async () => {
    const sourceBytes = await createSourcePdf();

    const savedBytes = await exportPdfBytes(
      Uint8Array.from(sourceBytes),
      [makeSelectionOverlay()],
      [],
      false,
      { bakeOverlays: true, writeStandardAnnotations: false },
    );

    const rectangles = await filledRectangles(Uint8Array.from(savedBytes));
    expect(rectangles).toEqual([
      { x: 72, y: 694, width: 150, height: 18 },
      { x: 72, y: 634, width: 130, height: 18 },
    ]);
    expect(
      rectangles.some(
        (rect) =>
          SELECTED_LINES.band.y >= rect.y &&
          SELECTED_LINES.band.y <= rect.y + rect.height &&
          SELECTED_LINES.band.x >= rect.x &&
          SELECTED_LINES.band.x <= rect.x + rect.width,
      ),
    ).toBe(false);
  });
});

describe("reopening a saved document's annotations", () => {
  it("keeps every selected line through a save and reopen", async () => {
    const sourceBytes = await createSourcePdf();
    const overlay = makeSelectionOverlay();

    const savedBytes = await exportPdfBytes(Uint8Array.from(sourceBytes), [overlay], [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });

    expect(await extractEditableOverlays(Uint8Array.from(savedBytes))).toEqual([overlay]);
  });

  it("reopens an annotation saved before text anchoring existed as the one box it was", async () => {
    // Written by hand in the older shape rather than produced by today's exporter, so this reads a
    // document that genuinely predates fragments rather than one that merely omitted them.
    const legacy = {
      id: "highlight-legacy",
      kind: "highlight",
      page: 1,
      x: 72,
      y: 80,
      width: 150,
      height: 78,
      color: "#facc15",
    };
    const pdfDoc = await PDFDocument.load(await createSourcePdf());
    pdfDoc.setKeywords([
      `markpdf-overlays:${Buffer.from(JSON.stringify([legacy]), "utf8").toString("base64")}`,
    ]);

    expect(await extractEditableOverlays(Uint8Array.from(await pdfDoc.save()))).toEqual([legacy]);
  });
});
