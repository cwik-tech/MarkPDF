import { readDocumentPages, type OcrPageCandidate, type ReadPage, type ResolveOcrRequest } from "../extract/readDocumentPages.js";
import { contentHash as hashBytes } from "../hash.js";
import type { SemanticChunkingProfile } from "../models.js";
import type { SemanticStore } from "../store/index.js";
import type { PageText } from "./chunking.js";
import type { Embedder } from "./embeddings.js";
import { indexDocument, type IndexDocumentResult, type IndexProgress } from "./indexDocument.js";
import { activeChunkScopeContract } from "./search.js";
import {
  MARKDOWN_ENGINE_ID,
  MARKDOWN_VERSION,
  OCR_EXTRACTION_VERSION,
  TEXT_EXTRACTION_VERSION,
  UNKNOWN_EXTRACTION_VERSION,
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
 * **The preflight comes first, and it is the whole point on a scan.** Reading a document is the
 * expensive part — rasterising, recognising, chunking — and until this existed every one of those
 * happened before anything asked whether the answer was already stored. Opening the same 628-page
 * book twice recognised it twice. So the bytes are hashed and the store is asked one exact
 * question, and only a document it cannot vouch for is read. The question covers the bytes, how
 * the text and the pictures were read, whether the cached Markdown still covers the document and
 * can say what became of each page, and whether the chunks for this precise searchable scope were
 * finished. Anything less is a miss and costs one indexed lookup.
 *
 * It runs outside `indexDocument`'s per-document lock, and that lock would not have helped anyway:
 * it serialises jobs inside one process, while the window and the `markpdf` command share one index
 * file. What makes the answer safe is that a completion claim is checked when it is made and
 * retracted by anything that could invalidate it — a batch landing in the scope, or the document's
 * text being stored again, each in the transaction that does it. So a run racing this one has
 * either finished, in which case its result is the one being reused, or has left no claim, in which
 * case this misses and the document is read.
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

  const contentHash = hashBytes(input.bytes);
  // `force` is the caller saying it does not trust what is stored, so it must not be answered from
  // what is stored — not even to skip the read.
  const reusable =
    input.force === true
      ? null
      : store.findReusableIndex({
          contentHash,
          textExtractionVersion: TEXT_EXTRACTION_VERSION,
          ocrExtractionVersion: OCR_EXTRACTION_VERSION,
          markdownEngineId: MARKDOWN_ENGINE_ID,
          markdownVersion: MARKDOWN_VERSION,
          // Read from the same place indexing and search read it, so the scope a document was
          // written under and the scope this asks about cannot drift apart. The embedder is
          // consulted for its identity and its width only; nothing here loads the weights, and an
          // already-complete index must never trigger a download to be recognised as complete.
          scope: activeChunkScopeContract(embedder, input.chunkingProfile),
        });

  // The lookup is several statements, so the signal is re-read before the one write this branch
  // performs and before the progress event that tells a tab it is ready.
  if (cancelled()) return { status: "cancelled" };

  if (reusable !== null) {
    // The only write on this path, and the same one the reuse branch inside `indexDocument` has
    // always performed: where the file was opened from, under what name, and when. The path lookup
    // that `search --path` and the MCP tools use reads exactly these columns and ranks rows by the
    // last of them, so skipping it would answer a moved or renamed file with a stale row — or with
    // a different document that happens to share its path.
    store.upsertDocument({
      contentHash,
      name: input.name,
      filePath: input.filePath,
      fileSize: input.bytes.byteLength,
      // The stored document's own account of itself. These bytes were read to produce it, and this
      // path has read nothing, so it has nothing of its own to say.
      pageCount: reusable.pageCount,
      textSource: reusable.textSource,
      // Nothing is claimed about how the text was read, because this path read nothing. The row
      // already matches these contracts — that is a condition of the hit — and how its text was
      // produced is recorded beside the cache itself, by whichever run wrote it. "Unknown" and
      // null preserve all of it.
      textExtractionVersion: UNKNOWN_EXTRACTION_VERSION,
      ocrExtractionVersion: UNKNOWN_EXTRACTION_VERSION,
      markdownEngine: null,
      markdownVersion: null,
    });

    input.onProgress?.({
      status: "ready",
      current: reusable.chunkCount,
      total: reusable.chunkCount,
      message: "Semantic index ready",
    });
    return {
      // The same word the full path would use for the same document. A stored scope with nothing
      // in it is an empty document, not a reused index, and a caller that switches on the status
      // should not be able to tell whether the answer came from the store or from a fresh read.
      status: reusable.chunkCount === 0 ? "empty" : "reused",
      contentHash,
      documentId: reusable.documentId,
      pageCount: reusable.pageCount,
      chunkCount: reusable.chunkCount,
      textSource: reusable.textSource,
      // Always empty, and not merely empty by coincidence: a snapshot recording a page nothing
      // read is not reusable, so a document that reaches here has an account of every page.
      unresolvedPages: [],
    };
  }

  input.onProgress?.({ status: "checking", message: "Reading document" });
  // The callback can abort synchronously, so the signal is re-read before the native parse
  // starts rather than only before it is used.
  if (cancelled()) return { status: "cancelled" };

  const read = await readDocumentPages({
    bytes: input.bytes,
    ...(input.resolveOcr === undefined ? {} : { resolveOcr: input.resolveOcr }),
    // Recognition, forwarded as its own phase rather than folded into the read.
    //
    // A page the extractor could not read is recognised here, inside this job, before any
    // embedding exists — and on a scanned document that is where nearly all the time goes.
    // Reporting it as `checking` told the reader their index was being examined while the machine
    // was reading their pages.
    //
    // The counters are the recognition queue's, because that is the work being waited on: a
    // 628-page book with 59 pages to read shows `42/59`, not `437/628` — a bar that would stop at
    // seven per cent and never arrive. Which document page is being read is still worth knowing,
    // and the recogniser already says so in the message, so it is carried there rather than
    // dropped.
    ...(input.onProgress === undefined
      ? {}
      : {
          onOcrProgress: (progress) =>
            input.onProgress?.({
              status: "ocr",
              current: progress.current,
              total: progress.total,
              message: progress.message,
            }),
        }),
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
