import { clipRectToLayer, type LayerRect } from "./textLayerSearch";

/**
 * The boundary between a PDF's link annotations and something a reader can click.
 *
 * Annotations are external input. They come from a file anybody can produce, PDF.js reports whatever
 * the file said in them, and a page can carry hundreds. So this module starts from `unknown` and
 * states what it admits: a `/Link` with a real rectangle and a destination inside this document.
 * Everything else — a link to the web, a rectangle with no area, an annotation that is not a link —
 * produces nothing, because an interactive element the reader cannot understand is worse than none.
 *
 * External URLs are deliberately excluded rather than merely unimplemented. Opening one needs a
 * privileged Electron boundary and a decision about which addresses are safe to hand to the
 * operating system; a link inside the document needs neither, and the two should not arrive together.
 */

/**
 * Where a link points, once it is known to point inside this document.
 *
 * Three forms because the format has three, and the installed PDF.js admits all of them: a name to
 * look up in the catalogue, an object reference to a page, and a zero-based count of pages from the
 * start of the document. Refusing the third would leave a working contents page dead — PDF.js's own
 * viewer follows it, and `_isValidExplicitDest` in the installed build accepts `Number.isInteger`
 * where a reference would otherwise be.
 */
export type InternalDestination = { kind: "named"; name: string } | ExplicitDestination;

/** A destination that already names a page, without a trip through the catalogue. */
export type ExplicitDestination =
  | { kind: "pageReference"; ref: { num: number; gen: number } }
  | { kind: "pageIndex"; index: number };

/** A link worth drawing: a box on the page, and somewhere in this document to go. */
export interface InternalLinkAnnotation {
  /** `[x0, y0, x1, y1]` in PDF points, corners in ascending order. */
  rect: readonly [number, number, number, number];
  destination: InternalDestination;
}

/**
 * What resolving a destination needs from an open document.
 *
 * A structural subset of `PDFDocumentProxy`, so the resolution rules can be exercised against a
 * document that answers in known ways rather than against a real file — and so this module never
 * has to import the renderer's PDF plumbing.
 */
export interface DestinationResolver {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

/**
 * A link's clickable box, placed in the rendered page.
 *
 * Two jobs, both needed before an element exists. The corners arrive in whatever order the viewport
 * transform produced — it flips the y axis, and on a rotated page swaps the axes too — and the box
 * is clipped to the page, because the page box does not clip its own children: a rectangle wider
 * than the page would put a clickable area over whatever is drawn beside it.
 */
export function clipLinkBox(
  corners: readonly [number, number, number, number],
  view: { width: number; height: number },
): LayerRect | null {
  const [x0, y0, x1, y1] = corners;
  return clipRectToLayer(
    {
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    },
    view.width,
    view.height,
  );
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A page reference as PDF.js serialises one: two non-negative whole numbers. */
function pageReference(value: unknown): { num: number; gen: number } | null {
  const num = readProperty(value, "num");
  const gen = readProperty(value, "gen");
  if (typeof num !== "number" || typeof gen !== "number") return null;
  if (!Number.isInteger(num) || !Number.isInteger(gen)) return null;
  if (num < 0 || gen < 0) return null;
  return { num, gen };
}

/**
 * The first entry of an explicit destination array, in either form the format allows.
 *
 * Whether the counted page exists is not decided here. It cannot be: this function does not know
 * how long the document is, and a boundary that guessed would either admit page 900 of a 4-page
 * book or refuse a legitimate one. The resolver checks the range against the open document.
 */
function explicitDestination(value: unknown): ExplicitDestination | null {
  const ref = pageReference(value);
  if (ref !== null) return { kind: "pageReference", ref };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { kind: "pageIndex", index: value };
  }
  return null;
}

/**
 * The annotation's box, with its corners put in order.
 *
 * A PDF rectangle is two opposite corners and says nothing about which is which, so both orderings
 * are valid input. A box with no area is not: PDF.js turns a `/Rect` with the wrong number of
 * entries into `[0, 0, 0, 0]` rather than dropping the annotation, and drawing that would leave an
 * invisible target in the page's corner.
 */
function annotationRect(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [a, b, c, d] = value;
  if (![a, b, c, d].every(isFiniteNumber)) return null;
  const x0 = Math.min(a, c);
  const x1 = Math.max(a, c);
  const y0 = Math.min(b, d);
  const y1 = Math.max(b, d);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return [x0, y0, x1, y1];
}

/**
 * Everything PDF.js reports about an annotation that means "do something", rather than "go here".
 *
 * A link carrying one of these does more than move the reader, and deciding which half wins is not
 * this boundary's decision to make. Listing them is deliberate: PDF.js chooses at most one of these
 * fields per annotation today, so in practice none can accompany a destination — which is exactly
 * why the guard is worth having rather than inheriting. It is a claim about a dependency's
 * behaviour, not about ours.
 */
const ACTION_FIELDS = ["url", "unsafeUrl", "action", "resetForm", "setOCGState", "attachment"] as const;

/** One annotation, when it is really an internal link. */
function parseInternalLinkAnnotation(value: unknown): InternalLinkAnnotation | null {
  if (readProperty(value, "subtype") !== "Link") return null;
  for (const field of ACTION_FIELDS) {
    if (readProperty(value, field) !== undefined) return null;
  }

  const rect = annotationRect(readProperty(value, "rect"));
  if (rect === null) return null;

  const dest = readProperty(value, "dest");
  if (typeof dest === "string") {
    return dest.length === 0 ? null : { rect, destination: { kind: "named", name: dest } };
  }
  if (Array.isArray(dest)) {
    const destination = explicitDestination(dest[0]);
    return destination === null ? null : { rect, destination };
  }
  return null;
}

/** Every internal link on a page, in the order the file lists them. */
export function parseInternalLinkAnnotations(value: unknown): InternalLinkAnnotation[] {
  if (!Array.isArray(value)) return [];
  const links: InternalLinkAnnotation[] = [];
  for (const annotation of value) {
    const link = parseInternalLinkAnnotation(annotation);
    if (link !== null) links.push(link);
  }
  return links;
}

/** What a name in the catalogue points at, when it points at a page of this document. */
async function lookUpName(
  resolver: DestinationResolver,
  name: string,
): Promise<ExplicitDestination | null> {
  const resolved = await resolver.getDestination(name);
  return Array.isArray(resolved) ? explicitDestination(resolved[0]) : null;
}

/**
 * Which one-based page of this document a destination names, or nothing.
 *
 * A name is looked up in the catalogue first, which is what a table of contents in a real book
 * relies on; the array it resolves to begins with the same page reference an explicit destination
 * carries directly. A page outside this document is refused rather than clamped: the file and the
 * open document disagreeing is not something to paper over by moving the reader somewhere plausible.
 */
export async function resolveInternalDestinationPage(
  resolver: DestinationResolver,
  destination: InternalDestination,
): Promise<number | null> {
  try {
    // A name is a level of indirection, not a different kind of destination: what the catalogue
    // gives back is an explicit destination in one of the two forms above.
    const target =
      destination.kind === "named" ? await lookUpName(resolver, destination.name) : destination;
    if (target === null) return null;

    const index =
      target.kind === "pageIndex" ? target.index : await resolver.getPageIndex(target.ref);
    if (!Number.isInteger(index)) return null;
    const page = index + 1;
    return page >= 1 && page <= resolver.numPages ? page : null;
  } catch {
    // A destination the document cannot resolve is a fact about the file, not a failure of the
    // reader's click. Nothing moves, and nothing is thrown at the page that drew the link.
    return null;
  }
}
