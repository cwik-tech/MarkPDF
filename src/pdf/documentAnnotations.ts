/**
 * Reading the annotations another application left inside the document.
 *
 * MarkPDF keeps its own annotations in a keyword of its own, which is why a document commented on
 * in Acrobat, Preview or a PyMuPDF script used to open here with nothing to click: the comments
 * were in the file's `/Annots`, and nothing read them. The page still looked right, because PDF.js
 * paints each annotation's appearance stream onto the canvas — so the reader saw the highlight and
 * had no way to reach the note attached to it.
 *
 * What comes out of here is an overlay MarkPDF shows but does not own. It is read from the file
 * every time the document is opened and left out of everything MarkPDF writes, because the
 * document already carries it: rewriting it would put this application's name where its author's
 * name is and leave the same comment in the file twice.
 *
 * Nothing in a record is believed for having been read. An annotation whose geometry cannot be
 * trusted is dropped rather than opened somewhere the reader would have to guess about.
 */

import type { OverlayItem, OverlayRect } from "../types";
import { enclosingRect } from "./overlayGeometry";

/** A page's own box in PDF units: where its corner sits, and how large it is. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One annotation as the document records it.
 *
 * Deliberately the PDF's own vocabulary rather than MarkPDF's. `rect` and `quadPoints` arrive in
 * PDF user space — measured from the bottom of the page — and in the order the writing application
 * chose, which is not the same order in every application.
 */
export interface DocumentAnnotationRecord {
  page: number;
  /** Position among the page's annotations: the identity used when the annotation has no name. */
  index: number;
  subtype: string;
  contents: string;
  /** The annotation's `/NM`, when it has one. */
  name?: string;
  author?: string;
  color?: string;
  /** `[x1, y1, x2, y2]`, the annotation's enclosing rectangle. */
  rect?: readonly number[];
  /** Four corners per marked run, flat: `[x1, y1, x2, y2, x3, y3, x4, y4, ...]`. */
  quadPoints?: readonly number[];
}

/**
 * The annotation types that carry a note a reader can open.
 *
 * An allow list rather than a deny list. A link, a form field and a popup window are all
 * annotations too, and each of them would arrive as a comment pinned to a piece of page furniture
 * if this list were written the other way round.
 */
const markupSubtypes: ReadonlySet<string> = new Set([
  "Caret",
  "Circle",
  "FileAttachment",
  "FreeText",
  "Highlight",
  "Ink",
  "Line",
  "Polygon",
  "PolyLine",
  "Square",
  "Squiggly",
  "Stamp",
  "StrikeOut",
  "Text",
  "Underline"
]);

/** Corners per quadrilateral in `QuadPoints`, as pairs of numbers. */
const quadLength = 8;

/**
 * One annotation, as an overlay — or nothing, when it is not a note or cannot be placed.
 *
 * The identity is derived rather than generated. The same annotation has to be the same overlay
 * every time the document is opened, or the comment the reader had open would close under them
 * after a save, and a second reading would add a second copy of every note.
 */
export function documentAnnotationOverlay(
  record: DocumentAnnotationRecord,
  page: PageBox
): OverlayItem | null {
  if (!markupSubtypes.has(record.subtype)) return null;

  const text = record.contents.trim();
  if (!text) return null;

  const fragments = readQuadPoints(record.quadPoints, page);
  const bounds = fragments !== null ? enclosingRect(fragments) : readRect(record.rect, page);
  if (bounds === null) return null;

  const overlay: OverlayItem = {
    id: `document-annotation-${String(record.page)}-${record.name ?? `index-${String(record.index)}`}`,
    kind: "comment",
    source: "document",
    page: record.page,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    text,
    // A pin beside the line rather than a note box over it. The page already shows the
    // annotation's own appearance, and a second shape on top of it would be MarkPDF's, not the
    // document's.
    minimized: true
  };

  if (record.author !== undefined && record.author.trim() !== "") {
    overlay.author = record.author.trim();
  }
  if (record.color !== undefined) overlay.color = record.color;
  if (fragments !== null) {
    overlay.fragments = fragments.map((fragment) => ({
      x: fragment.x - bounds.x,
      y: fragment.y - bounds.y,
      width: fragment.width,
      height: fragment.height
    }));
  }

  return overlay;
}

/**
 * The marked runs, or nothing at all.
 *
 * All or none, for the same reason `overlayMetadata` reads a stored fragment list that way: a
 * partly read selection puts the comment somewhere its author never put it. The four corners are
 * reduced to their extremes rather than read positionally, because the specification's corner
 * order and the order applications actually write are not reliably the same.
 */
function readQuadPoints(
  value: readonly number[] | undefined,
  page: PageBox
): OverlayRect[] | null {
  if (value === undefined || value.length === 0) return null;
  if (value.length % quadLength !== 0) return null;

  const fragments: OverlayRect[] = [];
  for (let start = 0; start < value.length; start += quadLength) {
    const corners = value.slice(start, start + quadLength);
    if (!corners.every((corner) => Number.isFinite(corner))) return null;

    const xs = corners.filter((_, index) => index % 2 === 0);
    const ys = corners.filter((_, index) => index % 2 === 1);
    const rect = pdfRectToPageRect(
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
      page
    );
    if (rect.width <= 0 || rect.height <= 0) return null;
    fragments.push(rect);
  }

  return fragments.length > 0 ? fragments : null;
}

/** The annotation's enclosing rectangle, for an annotation that marks no text. */
function readRect(value: readonly number[] | undefined, page: PageBox): OverlayRect | null {
  if (value === undefined || value.length !== 4) return null;
  if (!value.every((coordinate) => Number.isFinite(coordinate))) return null;

  const [x1, y1, x2, y2] = value;
  const rect = pdfRectToPageRect(
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
    page
  );
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/**
 * A PDF rectangle as the space overlays are stored in.
 *
 * PDF measures from the bottom-left corner of the page's own box; an overlay is measured from the
 * top-left of the page as it is drawn, at zoom 1. The page's corner is subtracted rather than
 * assumed to be the origin, because a cropped page's box does not start there.
 */
function pdfRectToPageRect(
  left: number,
  bottom: number,
  right: number,
  top: number,
  page: PageBox
): OverlayRect {
  return {
    x: left - page.x,
    y: page.y + page.height - top,
    width: right - left,
    height: top - bottom
  };
}
