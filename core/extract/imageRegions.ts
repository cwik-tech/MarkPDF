import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdfDocument, RasterisationCancelled, type PdfjsDocumentHandle } from "../ocr/rasterisePages.js";

/**
 * Which pages carry a picture worth reading on a page the extractor already read.
 *
 * The structural extractor decides a page is a scan by the balance of text to picture, so an
 * ordinary text page carrying one figure is never flagged, and everything inside the figure is
 * unreachable. Finding those figures is not an extraction question — the text layer is complete
 * — it is a question about the page's drawing instructions, which this answers by walking the
 * operator list rather than rendering: the walk costs a measured 2.8 ms per page where a render
 * costs hundreds.
 *
 * A region qualifies on two rules, both measured against the probe document:
 *
 * - total image coverage of at least {@link MIN_IMAGE_COVERAGE} of the page — the measured logo
 *   covers 0.7 %, the measured figure 10.6 %, so 5 % separates them with room on both sides; and
 * - at least one single image of at least {@link MIN_SINGLE_IMAGE_AREA_PT2} device square
 *   points — the logo is 3 200 pt², the figure 51 200 pt², so the floor keeps a page of many
 *   small marks away from the recogniser even when the marks together clear the coverage rule.
 *
 * Boxes are stated in PDF user space: points, origin at the bottom-left corner of the page box,
 * y rising. Pages turned sideways decline to qualify: the crop arithmetic is stated for upright
 * pages, and declining is the honest answer where it would otherwise be a guess.
 */

/** The four image-paint operators pdf.js reports. `paintJpegXObject` is named for older builds; the installed pdfjs-dist 5.4 no longer defines it, so it is included only when present. */
const IMAGE_PAINT_OPS = ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintJpegXObject"];

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Device-space area in square points: |det CTM| for the unit square an image paints into. */
  areaPt2: number;
}

export interface PageImageRegions {
  page: number;
  regions: readonly ImageRegion[];
  /** Fraction of the page area covered by images, clamped to 1. */
  coverage: number;
  qualifies: boolean;
  /** The page box the boxes above are measured in. */
  pageBox: { width: number; height: number };
}

export interface FindImageRegionsInput {
  /** 1-based pages to inspect. Anything outside the document is ignored. Defaults to all. */
  pages?: readonly number[];
  signal?: AbortSignal;
  /** An already-open pdf.js document, so the 35 ms open is paid once. The caller keeps ownership. */
  document?: PdfjsDocumentHandle;
}

export const MIN_IMAGE_COVERAGE = 0.05;
export const MIN_SINGLE_IMAGE_AREA_PT2 = 10_000;

/** An affine transform in pdf.js's row form: [a, b, c, d, e, f]. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Concatenate a transform onto the current one, the way PDF's `cm` does: the new transform is
 * applied first, the current one after.
 */
function compose(m: Matrix, ctm: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = ctm;
  return [
    a * A + b * C,
    a * B + b * D,
    c * A + d * C,
    c * B + d * D,
    e * A + f * C + E,
    e * B + f * D + F,
  ];
}

/**
 * The arguments of a transform or form-xobject operator, when they really are six numbers.
 *
 * pdf.js passes plain arrays and Float32Arrays; read them by index rather than by type, because
 * either shape answers to `length` and a numeric index and nothing else needs to be true.
 */
function matrixFrom(args: unknown): Matrix | null {
  if (typeof args !== "object" || args === null) return null;
  if (Reflect.get(args, "length") !== 6) return null;
  const numbers: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const value = Reflect.get(args, String(index));
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    numbers.push(value);
  }
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0, numbers[4] ?? 0, numbers[5] ?? 0];
}

/** The rectangle an image occupies on the page: the unit square it paints into, under the CTM. */
function regionFrom(ctm: Matrix): ImageRegion {
  const [a, b, c, d, e, f] = ctm;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return { x, y, width, height, areaPt2: Math.abs(a * d - b * c) };
}

/**
 * Walk one page's operator list and collect every image paint with its position.
 *
 * The list is flat — form xobjects are inlined by pdf.js — but their matrices arrive as
 * arguments of `paintFormXObjectBegin` rather than as transforms, so the walk carries a CTM
 * stack and applies them itself, exactly as the renderer does: begin saves and transforms,
 * end restores.
 */
async function regionsOnPage(pdfjs: { OPS: Record<string, number> }, page: PDFPageProxy): Promise<ImageRegion[]> {
  const ops = pdfjs.OPS;
  const paintOps = new Set(IMAGE_PAINT_OPS.map((name) => ops[name]).filter((value): value is number => typeof value === "number"));
  const saveOp = ops["save"];
  const restoreOp = ops["restore"];
  const transformOp = ops["transform"];
  const formBeginOp = ops["paintFormXObjectBegin"];
  const formEndOp = ops["paintFormXObjectEnd"];

  const list = await page.getOperatorList();
  const regions: ImageRegion[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  for (const [position, fn] of list.fnArray.entries()) {
    if (fn === saveOp) {
      stack.push(ctm);
    } else if (fn === restoreOp) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === transformOp) {
      const m = matrixFrom(list.argsArray[position]);
      if (m !== null) ctm = compose(m, ctm);
    } else if (fn === formBeginOp) {
      stack.push(ctm);
      // The first argument carries the form's own matrix, or null for the identity.
      const args = list.argsArray[position];
      const m = Array.isArray(args) ? matrixFrom(args[0]) : null;
      if (m !== null) ctm = compose(m, ctm);
    } else if (fn === formEndOp) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (paintOps.has(fn)) {
      regions.push(regionFrom(ctm));
    }
  }
  return regions;
}

/**
 * Inspect the named pages of a document for image regions.
 *
 * Shares an already-open pdf.js handle when one is supplied and otherwise opens and releases its
 * own; the document is the expensive part, and a caller holding one open pays for it once. Each
 * page gives its operator-list resources back the moment the walk is done.
 */
export async function findImageRegions(bytes: Uint8Array, input: FindImageRegionsInput): Promise<PageImageRegions[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const handle = input.document ?? (await openPdfDocument(bytes));
  try {
    const wanted = input.pages ?? Array.from({ length: handle.pdf.numPages }, (_unused, index) => index + 1);
    const results: PageImageRegions[] = [];

    for (const pageNumber of [...wanted].sort((a, b) => a - b)) {
      if (input.signal?.aborted === true) throw new RasterisationCancelled();
      if (pageNumber < 1 || pageNumber > handle.pdf.numPages) continue;

      const page = await handle.pdf.getPage(pageNumber);
      try {
        // The view is the library's to produce; read it as unknown until it checks out. A page
        // without a usable box reports no regions rather than guessing at its geometry.
        const [viewX0, viewY0, viewX1, viewY1] = page.view;
        let originX = 0;
        let originY = 0;
        let pageWidth = 0;
        let pageHeight = 0;
        if (
          typeof viewX0 === "number" && typeof viewY0 === "number" && typeof viewX1 === "number" && typeof viewY1 === "number" &&
          [viewX0, viewY0, viewX1, viewY1].every(Number.isFinite) && viewX1 > viewX0 && viewY1 > viewY0
        ) {
          originX = viewX0;
          originY = viewY0;
          pageWidth = viewX1 - viewX0;
          pageHeight = viewY1 - viewY0;
        }
        const pageArea = pageWidth * pageHeight;
        const rotation = typeof page.rotate === "number" && Number.isFinite(page.rotate) ? page.rotate : 0;

        const raw = pageArea > 0 ? await regionsOnPage(pdfjs, page) : [];
        const regions = raw.map((region) => ({
          ...region,
          x: region.x - originX,
          y: region.y - originY,
        }));
        const coverage = pageArea > 0 ? Math.min(1, regions.reduce((sum, region) => sum + region.areaPt2, 0) / pageArea) : 0;
        const qualifies =
          rotation === 0 &&
          coverage >= MIN_IMAGE_COVERAGE &&
          regions.some((region) => region.areaPt2 >= MIN_SINGLE_IMAGE_AREA_PT2);

        results.push({ page: pageNumber, regions, coverage, qualifies, pageBox: { width: pageWidth, height: pageHeight } });
      } finally {
        // The operator list is the page's most expensive by-product; give it back before moving
        // on — walked or not, a page with no usable box included.
        page.cleanup();
      }
    }

    return results;
  } finally {
    // A supplied handle belongs to its caller; only what this function opened does it close.
    if (input.document === undefined) await handle.release();
  }
}
