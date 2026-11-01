import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";

/**
 * The comments and highlights a saved PDF carries, read without the window.
 *
 * Two sources, as the window reads them (`src/pdf/document.ts`):
 *
 * - MarkPDF's own annotations come from its `markpdf-overlays:` keyword, which carries the exact
 *   note, the kind and — for an annotation an agent proposed and the person accepted — the origin.
 *   The standard copy MarkPDF writes beside each one for other readers is skipped, recognised by
 *   its `/NM` prefix, so nothing is reported twice.
 * - Every other application's annotations come from each page's `/Annots`.
 *
 * The renderer cannot be imported from here, so its rules are repeated and
 * `rendererParity.test.ts` holds the two readers to the same identities, pages and geometry. One
 * rule differs on purpose: a highlight with no note is kept. The window has nothing to open for
 * it, but an agent asking what was marked has every reason to see it.
 *
 * Nothing in a record is believed for having been read. An entry whose geometry cannot be trusted
 * is dropped, as the window drops it.
 */

export type AnnotationOrigin = "person_in_markpdf" | "agent_via_markpdf" | "other_application";

/** A rectangle in PDF user space: measured from the bottom-left corner of the page. */
export interface PdfBox {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

export interface DocumentAnnotation {
  /** Stable across reads: the overlay id for MarkPDF's own, page and `/NM` for the rest. */
  id: string;
  page: number;
  /** `comment` or `highlight` for MarkPDF's own; the lower-cased PDF subtype otherwise. */
  type: string;
  origin: AnnotationOrigin;
  author: string | null;
  note: string | null;
  /** The marked runs, one per line, in PDF user space. Empty for a note pinned to a point. */
  marks: PdfBox[];
  bounds: PdfBox;
  modified: string | null;
  replyTo: string | null;
}

export interface ReadAnnotationsOptions {
  /** Only these pages, 1-based. Absent means every page. */
  pages?: readonly number[];
}

const OVERLAY_KEYWORD = "markpdf-overlays:";
const LEGACY_OVERLAY_KEYWORD = "open-pdf-reader-overlays:";
const MARKPDF_NAME_PREFIXES = ["markpdf:", "open-pdf-reader:"] as const;

/** The same allow list as `src/pdf/documentAnnotations.ts`, and for the same reason. */
const MARKUP_SUBTYPES: ReadonlySet<string> = new Set([
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
  "Underline",
]);

const QUAD_LENGTH = 8;

interface PageGeometry {
  /** The crop box, which is what the window draws and positions overlays against. */
  box: { x: number; y: number; width: number; height: number };
}

export async function readDocumentAnnotations(
  bytes: Uint8Array,
  options: ReadAnnotationsOptions = {},
): Promise<DocumentAnnotation[]> {
  const pdf = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
  const wanted = options.pages === undefined ? null : new Set(options.pages);
  const pages = pdf.getPages().map((page): PageGeometry => ({ box: page.getCropBox() }));

  const owned = readKeywordOverlays(pdf, pages);
  const foreign = readForeignAnnotations(pdf, pages);
  return [...owned, ...foreign]
    .filter((entry) => wanted === null || wanted.has(entry.page))
    .sort(readingOrder);
}

/** Page, then top to bottom, then left to right: the order the comments pane lists them in. */
function readingOrder(a: DocumentAnnotation, b: DocumentAnnotation): number {
  return a.page - b.page || b.bounds.top - a.bounds.top || a.bounds.left - b.bounds.left;
}

// ---------------------------------------------------------------------------------------------
// MarkPDF's own keyword
// ---------------------------------------------------------------------------------------------

function keywordEntries(pdf: PDFDocument): string[] {
  return (pdf.getKeywords() ?? "")
    .split(/[\s,]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function readKeywordOverlays(pdf: PDFDocument, pages: readonly PageGeometry[]): DocumentAnnotation[] {
  const encoded = keywordEntries(pdf)
    .map((keyword) =>
      keyword.startsWith(OVERLAY_KEYWORD)
        ? keyword.slice(OVERLAY_KEYWORD.length)
        : keyword.startsWith(LEGACY_OVERLAY_KEYWORD)
          ? keyword.slice(LEGACY_OVERLAY_KEYWORD.length)
          : null,
    )
    .find((value) => value !== null);
  if (encoded === undefined || encoded === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const annotations: DocumentAnnotation[] = [];
  for (const entry of parsed) {
    const annotation = readKeywordOverlay(entry, pages);
    if (annotation !== null) annotations.push(annotation);
  }
  return annotations;
}

/** One persisted overlay, checked field by field as `src/pdf/overlayMetadata.ts` checks it. */
function readKeywordOverlay(value: unknown, pages: readonly PageGeometry[]): DocumentAnnotation | null {
  if (!isRecord(value)) return null;
  const { id, kind, page, x, y, width, height } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (kind !== "comment" && kind !== "highlight") return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  const geometry = pages[page - 1];
  if (geometry === undefined) return null;

  const fragments = readFragments(value.fragments);
  const marks = (fragments ?? []).map((fragment) =>
    pageRectToPdfBox({ x: x + fragment.x, y: y + fragment.y, width: fragment.width, height: fragment.height }, geometry),
  );
  const bounds = pageRectToPdfBox({ x, y, width, height }, geometry);

  const text = typeof value.text === "string" ? value.text.trim() : "";
  const origin = readOrigin(value.origin);
  return {
    id,
    page,
    type: kind,
    origin: origin === null ? "person_in_markpdf" : "agent_via_markpdf",
    author: origin?.agent ?? null,
    note: text.length > 0 ? text : null,
    // A comment the reader dropped on the page marks no text; one made from a selection does.
    marks: kind === "highlight" && marks.length === 0 ? [bounds] : marks,
    bounds,
    modified: origin?.acceptedAt ?? null,
    replyTo: null,
  };
}

function readOrigin(value: unknown): { agent: string; acceptedAt: string } | null {
  if (!isRecord(value) || value.kind !== "agent") return null;
  const { agent, acceptedAt } = value;
  if (typeof agent !== "string" || agent.trim().length === 0 || agent.length > 64) return null;
  return { agent: agent.trim(), acceptedAt: typeof acceptedAt === "string" ? acceptedAt : "" };
}

function readFragments(value: unknown): Array<{ x: number; y: number; width: number; height: number }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const fragments: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { x, y, width, height } = entry;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    fragments.push({ x, y, width, height });
  }
  return fragments;
}

/** Page space at zoom 1, measured from the top-left of the crop box, back to PDF user space. */
function pageRectToPdfBox(rect: { x: number; y: number; width: number; height: number }, page: PageGeometry): PdfBox {
  const left = page.box.x + rect.x;
  const top = page.box.y + page.box.height - rect.y;
  return { left, bottom: top - rect.height, right: left + rect.width, top };
}

// ---------------------------------------------------------------------------------------------
// Every other application's /Annots
// ---------------------------------------------------------------------------------------------

function readForeignAnnotations(pdf: PDFDocument, pages: readonly PageGeometry[]): DocumentAnnotation[] {
  const annotations: DocumentAnnotation[] = [];
  // Which identity each annotation dictionary received, so a reply can name what it answers.
  const identities = new Map<string, string>();
  const replies: Array<{ annotation: DocumentAnnotation; target: string }> = [];

  pdf.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots === undefined) return;
    const geometry = pages[pageIndex];
    if (geometry === undefined) return;

    for (let index = 0; index < annots.size(); index += 1) {
      const dict = annots.lookupMaybe(index, PDFDict);
      if (dict === undefined) continue;
      const name = textOf(dict, "NM");
      if (MARKPDF_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;

      const subtype = (dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() ?? "").replace(/^\//, "");
      if (!MARKUP_SUBTYPES.has(subtype)) continue;

      const pageNumber = pageIndex + 1;
      const id = `document-annotation-${String(pageNumber)}-${name.length > 0 ? name : `index-${String(index)}`}`;
      const reference = annots.get(index);
      if (reference instanceof PDFRef) identities.set(reference.toString(), id);

      const marks = readQuadPoints(numbersOf(dict, "QuadPoints"));
      const rect = readRect(numbersOf(dict, "Rect"));
      const bounds = marks !== null ? enclosing(marks) : rect;
      if (bounds === null) continue;

      const author = textOf(dict, "T").trim();
      const note = textOf(dict, "Contents").trim();
      const annotation: DocumentAnnotation = {
        id,
        page: pageNumber,
        type: subtype.toLowerCase(),
        origin: "other_application",
        author: author.length > 0 ? author : null,
        note: note.length > 0 ? note : null,
        marks: marks ?? [],
        bounds,
        modified: readPdfDate(textOf(dict, "M")),
        replyTo: null,
      };
      annotations.push(annotation);

      const answers = dict.get(PDFName.of("IRT"));
      if (answers instanceof PDFRef) replies.push({ annotation, target: answers.toString() });
    }
  });

  for (const { annotation, target } of replies) annotation.replyTo = identities.get(target) ?? null;
  return annotations;
}

function textOf(dict: PDFDict, key: string): string {
  const value = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  return value?.decodeText() ?? "";
}

function numbersOf(dict: PDFDict, key: string): number[] | undefined {
  const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
  if (array === undefined) return undefined;
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    values.push(array.lookupMaybe(index, PDFNumber)?.asNumber() ?? Number.NaN);
  }
  return values;
}

/**
 * The marked runs, or nothing at all: all or none, and the four corners reduced to their extremes,
 * exactly as `src/pdf/documentAnnotations.ts` reads them.
 */
function readQuadPoints(value: readonly number[] | undefined): PdfBox[] | null {
  if (value === undefined || value.length === 0 || value.length % QUAD_LENGTH !== 0) return null;
  const boxes: PdfBox[] = [];
  for (let start = 0; start < value.length; start += QUAD_LENGTH) {
    const corners = value.slice(start, start + QUAD_LENGTH);
    if (!corners.every((corner) => Number.isFinite(corner))) return null;
    const xs = corners.filter((_, index) => index % 2 === 0);
    const ys = corners.filter((_, index) => index % 2 === 1);
    const box = { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
    if (box.right <= box.left || box.top <= box.bottom) return null;
    boxes.push(box);
  }
  return boxes;
}

function readRect(value: readonly number[] | undefined): PdfBox | null {
  if (value === undefined || value.length !== 4 || !value.every((entry) => Number.isFinite(entry))) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = value;
  const box = { left: Math.min(x1, x2), bottom: Math.min(y1, y2), right: Math.max(x1, x2), top: Math.max(y1, y2) };
  return box.right > box.left && box.top > box.bottom ? box : null;
}

function enclosing(boxes: readonly PdfBox[]): PdfBox {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    bottom: Math.min(...boxes.map((box) => box.bottom)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.max(...boxes.map((box) => box.top)),
  };
}

/**
 * A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`) as an ISO timestamp, or null when it does not parse.
 *
 * Applications write every truncation the format allows, so each part after the year is optional.
 */
export function readPdfDate(value: string): string | null {
  const matched = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?$/.exec(value.trim());
  if (matched === null) return null;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", zone, zoneHours = "00", zoneMinutes = "00"] =
    matched;
  const offset = zone === "+" || zone === "-" ? `${zone}${zoneHours}:${zoneMinutes}` : "Z";
  const time = Date.parse(`${year ?? ""}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
