import { describe, expect, it } from "vitest";
import {
  documentAnnotationOverlay,
  type DocumentAnnotationRecord,
  type PageBox,
} from "./documentAnnotations";

const letterPage: PageBox = { x: 0, y: 0, width: 612, height: 792 };

function makeRecord(
  overrides: Partial<DocumentAnnotationRecord> = {},
): DocumentAnnotationRecord {
  return {
    page: 3,
    index: 0,
    subtype: "Highlight",
    contents: "Limit this clause to press releases and marketing.",
    name: "fitz-A1",
    author: "Sumit Anand, Aggie Safety",
    rect: [72, 698, 200, 714],
    quadPoints: [72, 712, 200, 712, 72, 700, 200, 700],
    ...overrides,
  };
}

describe("an annotation another application wrote", () => {
  it("opens as a comment carrying the note and the name of whoever wrote it", () => {
    const overlay = documentAnnotationOverlay(makeRecord(), letterPage);

    expect(overlay).toMatchObject({
      kind: "comment",
      source: "document",
      page: 3,
      text: "Limit this clause to press releases and marketing.",
      author: "Sumit Anand, Aggie Safety",
      minimized: true,
    });
  });

  it("sits over the text it marks, measured from the top of the page", () => {
    const overlay = documentAnnotationOverlay(makeRecord(), letterPage);

    expect(overlay).toMatchObject({ x: 72, y: 80, width: 128, height: 12 });
  });

  it("keeps one fragment per marked run rather than the box around them", () => {
    const twoRuns = makeRecord({
      quadPoints: [
        72, 712, 200, 712, 72, 700, 200, 700, 72, 672, 150, 672, 72, 660, 150,
        660,
      ],
    });

    const overlay = documentAnnotationOverlay(twoRuns, letterPage);

    expect(overlay?.fragments).toEqual([
      { x: 0, y: 0, width: 128, height: 12 },
      { x: 0, y: 40, width: 78, height: 12 },
    ]);
  });

  it("reads a quadrilateral whatever order its corners arrive in", () => {
    const cornersReversed = makeRecord({
      quadPoints: [200, 700, 72, 700, 200, 712, 72, 712],
    });

    expect(documentAnnotationOverlay(cornersReversed, letterPage)).toMatchObject(
      { x: 72, y: 80, width: 128, height: 12 },
    );
  });

  it("falls back to the annotation's own rectangle when it marks no text", () => {
    const stickyNote = makeRecord({
      subtype: "Text",
      quadPoints: undefined,
      rect: [500, 730, 524, 754],
    });

    const overlay = documentAnnotationOverlay(stickyNote, letterPage);

    expect(overlay).toMatchObject({ x: 500, y: 38, width: 24, height: 24 });
    expect(overlay?.fragments).toBeUndefined();
  });

  it("measures from the page's own corner when the page does not start at the origin", () => {
    const croppedPage: PageBox = { x: 20, y: 30, width: 572, height: 742 };

    expect(documentAnnotationOverlay(makeRecord(), croppedPage)).toMatchObject({
      x: 52,
      y: 60,
    });
  });

  it("is the same annotation every time the document is opened", () => {
    const first = documentAnnotationOverlay(makeRecord(), letterPage);
    const second = documentAnnotationOverlay(makeRecord(), letterPage);

    expect(first?.id).toBe(second?.id);
    expect(first?.id).not.toBe(
      documentAnnotationOverlay(makeRecord({ name: "fitz-A2" }), letterPage)?.id,
    );
  });

  it("is dropped when it carries no note a reader could open", () => {
    expect(
      documentAnnotationOverlay(makeRecord({ contents: "   " }), letterPage),
    ).toBeNull();
  });

  it("is dropped when it is a link, a form field, or a popup window", () => {
    for (const subtype of ["Link", "Widget", "Popup"]) {
      expect(
        documentAnnotationOverlay(makeRecord({ subtype }), letterPage),
      ).toBeNull();
    }
  });

  it("is dropped when its geometry cannot be trusted", () => {
    const damaged = makeRecord({
      rect: [72, Number.NaN, 200, 714],
      quadPoints: [72, 712, 200],
    });

    expect(documentAnnotationOverlay(damaged, letterPage)).toBeNull();
  });
});
