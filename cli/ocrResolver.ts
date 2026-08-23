import { ocrPages } from "../dist-core/ocr/ocrPages.js";
import type { OcrPageCandidate } from "../dist-core/extract/readDocumentPages.js";
import type { CommandContext } from "./context.js";

/**
 * How every command in this surface reads a page the structural extractor could not.
 *
 * One resolver, shared by `index`, `outline` and `convert`, because the alternative is a document
 * whose scanned pages are readable through one command and silently blank through another.
 *
 * Nothing is caught here. A document whose scanned pages could not be recognised is incomplete,
 * and the caller is told so — an OCR engine that will not start is an installation problem worth
 * its own exit code, not a reason to record a document as short.
 */
export function createOcrResolver(
  context: CommandContext,
  label: string,
): (request: { bytes: Uint8Array; pages: readonly number[]; signal?: AbortSignal }) => Promise<readonly OcrPageCandidate[]> {
  return (request) => {
    context.report.progress(`${label}: reading ${request.pages.length} page${request.pages.length === 1 ? "" : "s"} with OCR`);
    return ocrPages(request, {});
  };
}
