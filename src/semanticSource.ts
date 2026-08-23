import type { SemanticIndexRequest } from "./global";
import type { OcrPageText } from "./types";

export interface IndexableTab {
  path?: string | undefined;
  bytes: Uint8Array;
}

/**
 * Choose what the main process should hash and index.
 *
 * Always the bytes the renderer already has loaded, with the path carried only as metadata.
 *
 * Sending `{ kind: "path" }` would let the main process read the file again and hash whatever is
 * on disk now — while the page text in the same request came from the document loaded earlier.
 * If the file changed in between, the stored chunks would be keyed to a hash they did not come
 * from, which is exactly the silent mis-key the content hash exists to prevent. Phase 2 can make
 * main-process extraction from a path authoritative, because then both would come from the same
 * read.
 */
export function buildIndexSource(tab: IndexableTab): SemanticIndexRequest["source"] {
  return tab.path === undefined
    ? { kind: "bytes", bytes: tab.bytes }
    : { kind: "bytes", bytes: tab.bytes, path: tab.path };
}

/**
 * The OCR text worth sending to the main process.
 *
 * Main reads the document itself now, so this is the only page text that still crosses IPC. OCR
 * stays here as a Phase 2 scope decision rather than a capability limit — the main process has
 * `@napi-rs/canvas` and could rasterise — but this window has already scanned these pages for
 * the visible text layer, so sending the result costs nothing while redoing it would cost a
 * second full pass.
 *
 * Pages with no usable OCR text are left out rather than sent empty: an empty candidate would
 * claim a page was read when it was not. Sorted ascending because the request guard requires it.
 */
export function buildOcrCandidates(
  ocrCandidates: readonly OcrPageText[],
): NonNullable<SemanticIndexRequest["ocrCandidates"]> {
  return ocrCandidates
    .filter((page) => page.text.trim().length > 0)
    .map((page) => ({ page: page.page, text: page.text }))
    .sort((a, b) => a.page - b.page);
}
