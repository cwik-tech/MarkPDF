import { extractPagesFromPdf } from "../extract/pdfInspector.js";
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

/** Page text the renderer already produced by OCR, for pages the extractor cannot read. */
export interface OcrPageCandidate {
  /** 1-based, matching the page numbers the adapter reports. */
  page: number;
  text: string;
}

export interface IndexPdfDocumentInput {
  bytes: Uint8Array;
  name: string;
  filePath: string | null;
  chunkingProfile: SemanticChunkingProfile;
  /**
   * OCR text for pages the extractor reports as unreadable.
   *
   * **Phase 2 does not OCR here.** That is a scope decision, not a capability limit:
   * `@napi-rs/canvas` is a direct dependency and the native stack runs in this process. It is
   * deferred because the application's renderer has already rasterised and scanned those pages
   * for the visible text layer, so redoing the work would cost a second full pass for the same
   * result. A page reported as needing OCR with no candidate is left out of the index entirely —
   * see `toPageText`. Ruling R2 records the trade-off; Phase 3 revisits it for the CLI, which
   * has no renderer to borrow from.
   */
  ocrCandidates?: readonly OcrPageCandidate[];
  force?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
  yieldControl?: () => Promise<void>;
}

/**
 * Which pages are safe to index, and where their text comes from.
 *
 * A page the extractor flags as unreadable is *skipped* unless the caller supplied OCR text for
 * it. Indexing it from whatever fragments the native layer scraped off a scan would produce
 * chunks that look like ordinary text and cite a page nobody actually read — the same class of
 * confident wrongness as a bad page number, and harder to notice.
 *
 * An empty page contributes nothing rather than an empty chunk.
 */
function toPageText(
  pages: ReadonlyArray<{ page: number; markdown: string; needsOcr: boolean }>,
  ocrCandidates: readonly OcrPageCandidate[],
): PageText[] {
  const candidateTextByPage = new Map(ocrCandidates.map((entry) => [entry.page, entry.text]));
  // The request guard validates each candidate's shape but runs before anything knows how many
  // pages the document has. Checking here, where the count is known, stops a candidate for a
  // page that does not exist from being silently dropped.
  for (const entry of ocrCandidates) {
    if (entry.page > pages.length) {
      throw new Error(`OCR candidate names page ${entry.page}, but the document has ${pages.length} pages.`);
    }
  }
  const result: PageText[] = [];

  for (const page of pages) {
    if (page.needsOcr) {
      const ocrText = candidateTextByPage.get(page.page)?.trim() ?? "";
      if (ocrText.length > 0) result.push({ page: page.page, text: ocrText, source: "ocr" });
      continue;
    }
    const text = page.markdown.trim();
    if (text.length > 0) result.push({ page: page.page, text, source: "pdf" });
  }

  return result;
}

/**
 * Index a PDF from its bytes: extract, anchor, then store.
 *
 * This is the composition `indexDocument` deliberately does not perform. That function takes the
 * page text it is given and is agnostic about where it came from; folding extraction into it
 * would tie a proven lower-level contract to one particular source. Keeping the wrapper separate
 * is what lets a caller with text already in hand — a test, a future importer — use the same
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
  // The adapter owns the checks between its own native calls, because only it knows where they
  // are. It reports cancellation as an outcome, which passes straight through here.
  const extraction = await extractPagesFromPdf(input.bytes, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (extraction.status === "cancelled") return { status: "cancelled" };
  const extracted = extraction.document;

  // The best progress this stage can honestly offer. `@firecrawl/pdf-inspector` exposes no
  // progress callback, so nothing can report "page 3 of 12" while the parse runs — the per-page
  // granularity the renderer loop used to emit is gone and cannot be recovered without a
  // callback the package does not have. What is knowable is that the parse finished and how
  // many pages it found, so the interface gets a real total to move on to.
  const pages = toPageText(extracted.pages, input.ocrCandidates ?? []);
  const candidatesOffered = input.ocrCandidates?.length ?? 0;
  const candidatesUsed = pages.filter((page) => page.source === "ocr").length;
  const pageCountLabel = `Read ${extracted.pageCount} ${extracted.pageCount === 1 ? "page" : "pages"}`;

  // Reporting the selection is what keeps an unselected candidate an observable outcome rather
  // than a silent drop. The extractor decides which pages need OCR, so a candidate for a page it
  // read successfully is expected non-selection — but the reader is still told it happened.
  input.onProgress?.({
    status: "checking",
    current: extracted.pageCount,
    total: extracted.pageCount,
    message:
      candidatesOffered === 0
        ? pageCountLabel
        : `${pageCountLabel}, ${candidatesUsed} of ${candidatesOffered} OCR candidates used`,
  });

  // Checked again before anything is written, in case the cancel landed after the adapter's own
  // last look.
  if (cancelled()) return { status: "cancelled" };

  return indexDocument(store, embedder, {
    // Every page, including the ones that contribute no chunks. `toPageText` drops a blank page
    // and an unread scan, which is right for indexing and wrong for the cache: the cache is
    // keyed to the whole document, so a gap would make it describe a shorter one. Unread and
    // blank pages are carried as empty strings so page identity stays complete.
    markdownCache: {
      engineId: MARKDOWN_ENGINE_ID,
      markdownVersion: MARKDOWN_VERSION,
      // This function is the one place that knows the text came from PDF Inspector, so it is the
      // one place entitled to record it.
      textExtractionVersion: TEXT_EXTRACTION_VERSION,
      ocrExtractionVersion: OCR_EXTRACTION_VERSION,
      pages: extracted.pages.map((page) => ({
        page: page.page,
        markdown: pages.find((entry) => entry.page === page.page)?.text ?? "",
      })),
    },
    bytes: input.bytes,
    name: input.name,
    filePath: input.filePath,
    pages,
    pageCount: extracted.pageCount,
    chunkingProfile: input.chunkingProfile,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.yieldControl === undefined ? {} : { yieldControl: input.yieldControl }),
  });
}
