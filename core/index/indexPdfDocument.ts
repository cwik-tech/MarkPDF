import { readDocumentPages, type OcrPageCandidate, type ReadPage, type ResolveOcrRequest } from "../extract/readDocumentPages.js";
import type { SemanticChunkingProfile } from "../models.js";
import type { SemanticStore } from "../store/index.js";
import type { PageText } from "./chunking.js";
import type { Embedder } from "./embeddings.js";
import { indexDocument, type IndexDocumentResult, type IndexProgress } from "./indexDocument.js";
import {
  MARKDOWN_ENGINE_ID,
  MARKDOWN_VERSION,
  OCR_EXTRACTION_VERSION,
  TEXT_EXTRACTION_VERSION,
} from "../models.js";

export type { OcrPageCandidate };

export interface IndexPdfDocumentInput {
  bytes: Uint8Array;
  name: string;
  filePath: string | null;
  chunkingProfile: SemanticChunkingProfile;
  /**
   * Read the pages the structural extractor could not, and the qualifying pictures on pages it
   * could.
   *
   * Every surface supplies this, and it is the only way page text is produced for a scanned page
   * or a pictured figure. Anything it throws ends the run without writing: a document whose
   * scanned pages could not be recognised is incomplete, and recording it as merely short would
   * leave an index quietly missing pages that a later search would never mention.
   */
  resolveOcr?: (request: ResolveOcrRequest) => Promise<readonly OcrPageCandidate[]>;
  force?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
  yieldControl?: () => Promise<void>;
}

/**
 * Which pages carry text worth indexing.
 *
 * A page nothing could read contributes nothing rather than an empty chunk. `readDocumentPages`
 * has already decided which those are, and already refused to index a scan from the fragments the
 * native layer scraped off it.
 */
function toPageText(pages: readonly ReadPage[]): PageText[] {
  const result: PageText[] = [];
  for (const page of pages) {
    if (page.source === "none" || page.markdown.length === 0) continue;
    result.push({ page: page.page, text: page.markdown, source: page.source });
  }
  return result;
}

/**
 * Index a PDF from its bytes: read, anchor, then store.
 *
 * This is the composition `indexDocument` deliberately does not perform. That function takes the
 * page text it is given and is agnostic about where it came from; folding reading into it would
 * tie a proven lower-level contract to one particular source. Keeping the wrapper separate is
 * what lets a caller with text already in hand — a test, a future importer — use the same
 * indexing path as this one.
 *
 * **Cancellation, and its honest limit.** `@firecrawl/pdf-inspector` exposes no `AbortSignal`
 * and no cancellation of any kind: `extractPagesMarkdownAsync` runs the parse on the libuv
 * thread pool and returns a promise that cannot be abandoned. So the parse is not preemptible,
 * and pretending otherwise would be a lie in the code. What is guaranteed instead is that the
 * signal is checked before the parse starts and again the instant it returns, so a cancel
 * arriving during it costs a wasted parse and never a written row. Everything after that point
 * is `indexDocument`'s own cancellation, which is checked between embeddings.
 */
export async function indexPdfDocument(
  store: SemanticStore,
  embedder: Embedder,
  input: IndexPdfDocumentInput,
): Promise<IndexDocumentResult> {
  const cancelled = (): boolean => input.signal?.aborted === true;

  if (cancelled()) return { status: "cancelled" };

  input.onProgress?.({ status: "checking", message: "Reading document" });
  // The callback can abort synchronously, so the signal is re-read before the native parse
  // starts rather than only before it is used.
  if (cancelled()) return { status: "cancelled" };

  const read = await readDocumentPages({
    bytes: input.bytes,
    ...(input.resolveOcr === undefined ? {} : { resolveOcr: input.resolveOcr }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (read.status === "cancelled") return { status: "cancelled" };

  // The best progress this stage can honestly offer. `@firecrawl/pdf-inspector` exposes no
  // progress callback, so nothing can report "page 3 of 12" while the parse runs — the per-page
  // granularity the renderer loop used to emit is gone and cannot be recovered without a
  // callback the package does not have. What is knowable is that the parse finished, how many
  // pages it found, and what became of the ones it could not read.
  const pages = toPageText(read.pages);
  const pageCountLabel = `Read ${read.pageCount} ${read.pageCount === 1 ? "page" : "pages"}`;

  // How many pages had to be recognised is worth saying: it is the slow part of reading a document,
  // and a reader watching a scan wants to know that is what the time went on.
  input.onProgress?.({
    status: "checking",
    current: read.pageCount,
    total: read.pageCount,
    message:
      read.recognisedHere === 0
        ? pageCountLabel
        : `${pageCountLabel}, ${read.recognisedHere} read by OCR`,
  });

  // Checked again before anything is written, in case the cancel landed after the reader's own
  // last look.
  if (cancelled()) return { status: "cancelled" };

  return indexDocument(store, embedder, {
    // Every page, including the ones that contribute no chunks. A page that is blank or could not
    // be read is carried as an empty string: the cache is keyed to the whole document, so a gap
    // would make it describe a shorter one.
    markdownCache: {
      engineId: MARKDOWN_ENGINE_ID,
      markdownVersion: MARKDOWN_VERSION,
      // This function is the one place that knows the text came from PDF Inspector, so it is the
      // one place entitled to record it.
      textExtractionVersion: TEXT_EXTRACTION_VERSION,
      ocrExtractionVersion: OCR_EXTRACTION_VERSION,
      pages: read.pages.map((page) => ({ page: page.page, markdown: page.markdown })),
      // What became of each page, alongside what it said. Without this an empty page in the cache
      // is unreadable in the other sense: nothing can tell whether it is blank or a gap, so nothing
      // ever goes back for it.
      pageProvenance: read.pages.map((page) => ({ page: page.page, status: page.status })),
    },
    bytes: input.bytes,
    name: input.name,
    filePath: input.filePath,
    pages,
    pageCount: read.pageCount,
    chunkingProfile: input.chunkingProfile,
    // Carried through rather than re-derived. The reader is the only thing that knows which empty
    // pages are blank and which are gaps.
    unresolvedPages: read.unresolvedPages,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.yieldControl === undefined ? {} : { yieldControl: input.yieldControl }),
  });
}
