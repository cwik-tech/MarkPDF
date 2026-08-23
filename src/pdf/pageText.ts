import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractPageText } from "./document";
import type { OcrPageText, SemanticIndexProgress } from "../types";

export interface ExtractedPage {
  page: number;
  text: string;
  source: "pdf" | "ocr";
}

/**
 * The narrow slice of a PDF document this module needs: how many pages there are, and the text
 * layer of one of them. Depending on the slice rather than on `PDFDocumentProxy` is what lets
 * the OCR-fallback rule below be tested against known page text with no pdf.js instance.
 */
export interface PageTextReader {
  numPages: number;
  readPageText(pageNumber: number): Promise<string>;
}

export function pdfPageTextReader(pdfDoc: PDFDocumentProxy): PageTextReader {
  return {
    numPages: pdfDoc.numPages,
    readPageText: async (pageNumber) => extractPageText(await pdfDoc.getPage(pageNumber)),
  };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface ExtractPagesOptions {
  /**
   * Stops the walk. Checked before each page and again after each awaited read, because a read
   * is asynchronous and a stop can arrive while one is in flight.
   */
  signal?: AbortSignal;
  onProgress?: (progress: SemanticIndexProgress) => void;
}

/**
 * Cancellation is a result, not an exception.
 *
 * Stopping because the reader asked to stop is an expected outcome, and callers must be forced
 * to consider it. A thrown error would be indistinguishable from a genuine extraction failure at
 * the call site, and the tab would settle into an error state for something the user chose.
 */
export type ExtractPagesResult =
  | { status: "extracted"; pages: ExtractedPage[] }
  | { status: "cancelled" };

/**
 * Page text for the semantic index, with OCR substituted where the native layer is too sparse
 * to be useful.
 *
 * This stays in the renderer for now because OCR does: rasterising a page needs a canvas, and
 * the results already feed the on-screen text layer. Core receives the finished pages. Phase 2
 * moves extraction into core, at which point this helper goes away.
 */
export async function extractDocumentPages(
  reader: PageTextReader,
  ocrPages: readonly OcrPageText[],
  options: ExtractPagesOptions = {},
): Promise<ExtractPagesResult> {
  const { signal, onProgress } = options;
  // Read through a call, never as a narrowed property: after one direct `signal.aborted === true`
  // check returns, the compiler narrows the property to `false` and the post-await check below
  // becomes provably dead code. A call is opaque to that narrowing.
  const cancelled = (): boolean => signal?.aborted === true;
  const ocrTextByPage = new Map(ocrPages.map((page) => [page.page, page.text]));
  const pages: ExtractedPage[] = [];

  for (let pageNumber = 1; pageNumber <= reader.numPages; pageNumber += 1) {
    if (cancelled()) return { status: "cancelled" };

    onProgress?.({
      status: "checking",
      current: pageNumber,
      total: reader.numPages,
      message: `Reading page ${pageNumber} of ${reader.numPages}`,
    });
    const nativeText = normalize(await reader.readPageText(pageNumber));
    // Re-checked after the await, not only at the top of the loop: reading a page is
    // asynchronous, so a stop can land while one is pending, and this page's text would
    // otherwise be kept and the walk continue.
    if (cancelled()) return { status: "cancelled" };

    const ocrText = normalize(ocrTextByPage.get(pageNumber) ?? "");
    // The same threshold `findTextMatches` applies in ./document.ts: a page with under 100
    // non-space characters is treated as having no usable text layer. Search and indexing must
    // agree on which pages are scanned, or a hit can cite text the other never saw.
    const useOcrText = nativeText.replace(/\s/g, "").length < 100 && ocrText.length > 0;
    const text = useOcrText ? ocrText : nativeText;
    if (text.length > 0) {
      pages.push({ page: pageNumber, text, source: useOcrText ? "ocr" : "pdf" });
    }
  }

  return { status: "extracted", pages };
}
