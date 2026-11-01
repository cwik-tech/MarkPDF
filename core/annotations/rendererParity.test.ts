import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { readDocumentAnnotations, type DocumentAnnotation } from "./readAnnotations.js";
import { exportPdfBytes, extractDocumentAnnotations, extractEditableOverlays } from "../../src/pdf/document";
import type { OverlayItem } from "../../src/types";

/**
 * The window and core read the same annotations the same way.
 *
 * Core cannot import the renderer, so it carries its own reader. That is a duplication, and this
 * test is what makes it safe: a document saved by MarkPDF's real writer — not a copy of its format
 * written by hand — reads back with the same identities, pages and geometry on both sides. The one
 * rule that differs on purpose is checked too: core keeps a highlight that has no note.
 *
 * Like `modelParity.test.ts`, this spans two module-resolution regimes and is checked by running
 * it, not by `tsconfig.test.json`.
 */

const PAGE_HEIGHT = 792;

/** A core annotation in the window's space: measured from the top-left of the page, at zoom 1. */
function asWindowGeometry(annotation: DocumentAnnotation) {
  return {
    id: annotation.id,
    page: annotation.page,
    x: annotation.bounds.left,
    y: PAGE_HEIGHT - annotation.bounds.top,
    width: annotation.bounds.right - annotation.bounds.left,
    height: annotation.bounds.top - annotation.bounds.bottom,
  };
}

function windowGeometry(overlay: OverlayItem) {
  return { id: overlay.id, page: overlay.page, x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height };
}

function rounded<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" ? Math.round(entry * 100) / 100 : entry]),
  ) as T;
}

async function annotatedSource(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, PAGE_HEIGHT]);
  page.drawText("A clause somebody else marked up", { x: 72, y: 700, size: 14, font });
  page.drawText("A clause nobody wrote a note on", { x: 72, y: 650, size: 14, font });
  const withNote = pdf.context.register(
    pdf.context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: [70, 696, 320, 716],
      QuadPoints: [72, 714, 318, 714, 72, 698, 318, 698],
      Contents: PDFHexString.fromText("Their note"),
      T: PDFHexString.fromText("Their reviewer"),
      NM: PDFString.of("theirs-1"),
    }),
  );
  const withoutNote = pdf.context.register(
    pdf.context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: [70, 646, 320, 666],
      QuadPoints: [72, 664, 318, 664, 72, 648, 318, 648],
      NM: PDFString.of("theirs-2"),
    }),
  );
  page.node.set(PDFName.of("Annots"), pdf.context.obj([withNote, withoutNote]));
  return await pdf.save();
}

const ownOverlays: OverlayItem[] = [
  {
    id: "comment-own",
    kind: "comment",
    page: 1,
    x: 72,
    y: 180,
    width: 200,
    height: 16,
    text: "My note",
    minimized: true,
    fragments: [{ x: 0, y: 0, width: 200, height: 16 }],
  },
  { id: "highlight-own", kind: "highlight", page: 1, x: 72, y: 230, width: 150, height: 16, color: "#facc15" },
];

describe("the core annotation reader and the window's readers", () => {
  it("read a document MarkPDF saved with the same identities, pages and geometry", async () => {
    const saved = await exportPdfBytes(await annotatedSource(), ownOverlays, [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });

    const windowSide = [...(await extractEditableOverlays(saved)), ...(await extractDocumentAnnotations(saved))]
      .filter((overlay) => overlay.kind === "comment" || overlay.kind === "highlight")
      .map((overlay) => rounded(windowGeometry(overlay)));
    const coreSide = (await readDocumentAnnotations(saved)).map((annotation) => rounded(asWindowGeometry(annotation)));

    // Everything the window shows, core reports — identity, page and place.
    for (const shown of windowSide) expect(coreSide).toContainEqual(shown);
    // And core reports exactly one more: the highlight with no note, which the window has nothing
    // to open for.
    expect(coreSide.map((entry) => entry.id).sort()).toEqual(
      [...windowSide.map((entry) => entry.id), "document-annotation-1-theirs-2"].sort(),
    );
  });

  it("agree on whose annotation each one is", async () => {
    const saved = await exportPdfBytes(await annotatedSource(), ownOverlays, [], false, {
      bakeOverlays: false,
      persistEditable: true,
      writeStandardAnnotations: true,
    });
    const owned = new Set((await extractEditableOverlays(saved)).map((overlay) => overlay.id));
    for (const annotation of await readDocumentAnnotations(saved)) {
      expect(annotation.origin === "person_in_markpdf").toBe(owned.has(annotation.id));
    }
  });
});
