import type { OcrPageCandidate } from "../extract/readDocumentPages.js";
import { rasterisePdfPages, RasterisationCancelled, type PageImage, type RasteriseOptions } from "./rasterisePages.js";
import { createTesseractRecogniser, type TextRecogniser } from "./tesseractEngine.js";
import { tableFromLines } from "./tableFromLines.js";
import { ocrProfile } from "./ocrContract.js";

export interface OcrRequest {
  bytes: Uint8Array;
  /** 1-based page numbers the extractor could not read. */
  pages: readonly number[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface OcrDependencies {
  /** Injected so the composition can be tested without starting a real engine. */
  createRecogniser?: () => Promise<TextRecogniser>;
  /**
   * Injected for the same reason, and for one the recogniser seam cannot reach: the window
   * between rendering finishing and the engine starting. Rendering is not preemptible once begun,
   * so that window is the only place a cancel arriving during the last page can be noticed, and
   * it cannot be aimed at from outside.
   */
  rasterise?: (bytes: Uint8Array, options: RasteriseOptions) => Promise<PageImage[]>;
  dpi?: number;
}

/**
 * Read the pages a structural extractor could not, by rendering and recognising them.
 *
 * This is the piece the application has never needed, because its renderer had already rasterised
 * and scanned those pages for the visible text layer. The command line has no renderer, so
 * without this a scanned document indexes to nothing at all — every page dropped by `toPageText`
 * for having no trustworthy text.
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

  let images: PageImage[];
  try {
    images = await (dependencies.rasterise ?? rasterisePdfPages)(request.bytes, {
      pages: request.pages,
      dpi: dependencies.dpi ?? ocrProfile("index").dpi,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    // Cancellation is an outcome here, as it is everywhere else in this pipeline. The caller reads
    // the signal the instant this returns and abandons the whole read, so an empty result cannot
    // be mistaken for a document that had nothing to recognise.
    if (error instanceof RasterisationCancelled) return [];
    throw error;
  }
  if (images.length === 0) return [];
  // Read the instant rendering returns, before anything is started. Rendering the last page is
  // not preemptible once begun, so a cancel arriving during it is only noticeable here — and
  // without this check it still bought a worker thread and a language file for a run that was
  // already over.
  if (cancelled()) return [];

  const recogniser = await (dependencies.createRecogniser ?? (() => createTesseractRecogniser()))();
  try {
    const candidates: OcrPageCandidate[] = [];
    for (const [position, image] of images.entries()) {
      // Recognition of one page is not preemptible — the engine offers no cancellation — so the
      // signal is read between pages and nothing pretends otherwise.
      if (cancelled()) break;
      request.onProgress?.(`Reading page ${image.page} with OCR (${position + 1} of ${images.length})`);
      const recognised = await recogniser.recognise(image.image);
      // Reconstruction is a pure function of the recognised lines; when it declines the page
      // (no table, or no geometry at all), the engine's own internal line breaks are preserved.
      // As before, outer whitespace is trimmed before storage.
      const text = (tableFromLines(recognised.lines) ?? recognised.text).trim();
      if (text.length > 0) candidates.push({ page: image.page, text });
    }
    return candidates;
  } finally {
    await recogniser.close();
  }
}
