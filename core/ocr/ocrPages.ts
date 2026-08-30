import type { OcrImageRegion, OcrPageCandidate, OcrPageProgress, OcrRegionBox } from "../extract/readDocumentPages.js";
import { rasterisePdfPagesStreaming, RasterisationCancelled, type PageImage, type PdfjsDocumentHandle, type RasteriseOptions } from "./rasterisePages.js";
import { createTesseractRecogniser, OcrEngineError, type TextRecogniser } from "./tesseractEngine.js";
import { tableFromLines } from "./tableFromLines.js";
import { ocrProfile } from "./ocrContract.js";

export interface OcrRequest {
  bytes: Uint8Array;
  /** 1-based page numbers the extractor could not read. */
  pages: readonly number[];
  signal?: AbortSignal;
  onProgress?: (progress: OcrPageProgress) => void;
  /**
   * Pages to read by their regions rather than whole. A page named here is rendered once and
   * the recogniser is given a crop of its qualifying regions, because recognising a whole page
   * to read one figure is the cost this annotation exists to avoid.
   */
  imageRegions?: readonly OcrImageRegion[];
  /**
   * An already-open pdf.js document over these bytes. Rendering borrows it instead of opening
   * the same PDF again; the caller keeps ownership and releases it.
   */
  document?: PdfjsDocumentHandle;
}

/**
 * How far a crop reaches past the regions it covers.
 *
 * The engine misses words that sit on the very edge of its input; the padding keeps region
 * boundaries from becoming word boundaries. Ten points is a line's worth at body size.
 */
export const REGION_CROP_PADDING_PT = 10;

export interface OcrDependencies {
  /** Injected so the composition can be tested without starting a real engine. */
  createRecogniser?: () => Promise<TextRecogniser>;
  /**
   * Compatibility seam for focused tests and specialised callers that already produce an array.
   * Production uses `rasteriseStreaming`; this form also reaches the cancellation window between
   * an array-producing rasteriser finishing and the engine starting.
   */
  rasterise?: (bytes: Uint8Array, options: RasteriseOptions) => Promise<PageImage[]>;
  /** Streaming seam used in production so recognition releases each page before rendering the next. */
  rasteriseStreaming?: (bytes: Uint8Array, options: RasteriseOptions) => AsyncIterable<PageImage>;
  dpi?: number;
}

/** One box measurement, when it is really four finite numbers with a positive extent. */
function regionBox(value: unknown): OcrRegionBox | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const x = Reflect.get(value, "x");
  const y = Reflect.get(value, "y");
  const width = Reflect.get(value, "width");
  const height = Reflect.get(value, "height");
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  if (![x, y, width, height].every((coordinate) => Number.isFinite(coordinate))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Cut the padded union of a page's regions out of its rendered image.
 *
 * The boxes arrive in page points with the origin at the bottom-left; the rendered image counts
 * pixels from the top-left. The padding is clamped at the page edge, because a crop that reached
 * outside the page would hand the engine invented margins. A page whose boxes do not validate
 * is read whole rather than not read.
 */
async function cropToRegions(image: PageImage, region: OcrImageRegion): Promise<Uint8Array> {
  const boxes = region.boxes
    .map(regionBox)
    .filter((box): box is OcrRegionBox => box !== null);
  if (boxes.length === 0) return image.image;
  const { width: pageWidth, height: pageHeight } = region.pageBox;
  if (![pageWidth, pageHeight].every((extent) => Number.isFinite(extent) && extent > 0)) {
    throw new OcrEngineError(
      `Page ${image.page} cannot be cropped: its page box was ${pageWidth} by ${pageHeight}.`,
    );
  }
  const scale = image.width / pageWidth;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  const px0 = Math.max(0, (minX - REGION_CROP_PADDING_PT) * scale);
  const px1 = Math.min(image.width, (maxX + REGION_CROP_PADDING_PT) * scale);
  const pyTop = Math.max(0, (pageHeight - maxY - REGION_CROP_PADDING_PT) * scale);
  const pyBottom = Math.min(image.height, (pageHeight - minY + REGION_CROP_PADDING_PT) * scale);
  const width = Math.max(1, Math.round(px1 - px0));
  const height = Math.max(1, Math.round(pyBottom - pyTop));

  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const decoded = await loadImage(Buffer.from(image.image));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(decoded, -px0, -pyTop);
  return canvas.toBuffer("image/png");
}

/**
 * Read the pages a structural extractor could not, by rendering and recognising them.
 *
 * This is the piece the application has never needed, because its renderer had already rasterised
 * and scanned those pages for the visible text layer. The command line has no renderer, so
 * without this a scanned document indexes to nothing at all — every page dropped by `toPageText`
 * for having no trustworthy text.
 *
 * A page named in `imageRegions` is read by its regions: it appears once in the selected-page
 * stream, and the recogniser receives only the padded union of those regions. Any other page is
 * read whole.
 *
 * A page that recognises to nothing is left out rather than returned empty: an empty candidate
 * would be indistinguishable from a page that was read and found blank.
 */
export async function ocrPages(request: OcrRequest, dependencies: OcrDependencies = {}): Promise<OcrPageCandidate[]> {
  if (request.pages.length === 0) return [];
  // Read through a call: after one direct `signal.aborted === true` check the compiler narrows
  // the property to `false` and every later check becomes provably dead code.
  const cancelled = (): boolean => request.signal?.aborted === true;
  if (cancelled()) return [];

  const regionsByPage = new Map((request.imageRegions ?? []).map((region) => [region.page, region]));
  const options: RasteriseOptions = {
    pages: request.pages,
    dpi: dependencies.dpi ?? ocrProfile("index").dpi,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.document === undefined ? {} : { document: request.document }),
  };
  const images = dependencies.rasteriseStreaming !== undefined
    ? dependencies.rasteriseStreaming(request.bytes, options)
    : dependencies.rasterise !== undefined
      ? await dependencies.rasterise(request.bytes, options)
      : rasterisePdfPagesStreaming(request.bytes, options);
  let recogniser: TextRecogniser | null = null;
  const candidates: OcrPageCandidate[] = [];
  try {
    let position = 0;
    for await (const image of images) {
      // Recognition of one page is not preemptible — the engine offers no cancellation — so the
      // signal is read between pages and nothing pretends otherwise.
      if (cancelled()) break;
      recogniser ??= await (dependencies.createRecogniser ?? (() => createTesseractRecogniser()))();
      request.onProgress?.({
        page: image.page,
        current: position + 1,
        total: request.pages.length,
        message: `Reading page ${image.page} with OCR`,
      });
      const region = regionsByPage.get(image.page);
      const target = region === undefined ? image.image : await cropToRegions(image, region);
      const recognised = await recogniser.recognise(target);
      // Reconstruction is a pure function of the recognised lines; when it declines the page
      // (no table, or no geometry at all), the engine's own internal line breaks are preserved.
      // As before, outer whitespace is trimmed before storage.
      const text = (tableFromLines(recognised.lines) ?? recognised.text).trim();
      if (text.length > 0) candidates.push({ page: image.page, text });
      position += 1;
      if (cancelled()) break;
    }
    return candidates;
  } catch (error) {
    if (error instanceof RasterisationCancelled) return candidates;
    throw error;
  } finally {
    await recogniser?.close();
  }
}
