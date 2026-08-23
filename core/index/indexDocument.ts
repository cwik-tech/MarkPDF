import { contentHash as hashBytes } from "../hash.js";
import { getCuratedEmbeddingModel, modelVersion, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import type { ChunkInsert, ChunkScope, SemanticStore, TextSource } from "../store/index.js";
import { chunkPages, type PageText, type TextChunk } from "./chunking.js";
import type { Embedder } from "./embeddings.js";
import { runExclusive } from "./serialQueue.js";

export type IndexStatus = "ready" | "reused" | "empty" | "cancelled";

function hasExactChunks(store: SemanticStore, scope: ChunkScope, chunks: readonly TextChunk[]): boolean {
  const stored = store.listIndexedChunkIds(scope);
  if (stored.length !== chunks.length) return false;
  const expected = new Set(chunks.map((chunk) => chunk.id));
  return stored.every((id) => expected.has(id));
}

export interface IndexProgress {
  /**
   * `downloading` covers the model fetch a job triggers when the weights are not yet on disk.
   * It belongs on the index job's own progress rather than a separate channel, because from the
   * reader's point of view the tab is busy indexing — the download is why, not a separate task.
   */
  status: "checking" | "downloading" | "indexing" | "ready";
  current?: number;
  total?: number;
  message?: string;
}

export interface IndexDocumentInput {
  bytes: Uint8Array;
  name: string;
  filePath: string | null;
  /** Page text, already extracted. Phase 2 moves extraction into core. */
  pages: readonly PageText[];
  pageCount: number;
  chunkingProfile: SemanticChunkingProfile;
  force?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  /**
   * Stops the run. Checked before anything destructive, between embedding batches, between
   * individual embeddings, and again immediately before each commit — inference itself cannot be
   * interrupted, so a single embedding is the finest granularity available.
   */
  signal?: AbortSignal;
  /** Awaited once after each batch's progress event, so the interface can render it. */
  yieldControl?: () => Promise<void>;
}

export interface IndexedDocumentResult {
  status: Exclude<IndexStatus, "cancelled">;
  contentHash: string;
  documentId: number;
  pageCount: number;
  chunkCount: number;
  textSource: TextSource;
}

/**
 * A cancelled run carries a status and nothing else.
 *
 * It has no content hash and no document id because it never produced one. An earlier shape
 * declared those fields on every result and filled them with `""` and `0` when cancelled, which
 * a caller trusting the declared type would store as a real document keyed to the hash of
 * nothing. Making cancellation a separate member of the union means the compiler stops that
 * caller instead of the runtime discovering it later.
 */
export type IndexDocumentResult = IndexedDocumentResult | { status: "cancelled" };

/** Embedded, then written, in groups of this size. Never held open across an await. */
const EMBED_BATCH = 32;

function textSourceOf(pages: readonly PageText[]): TextSource {
  if (pages.length === 0) return "none";
  const ocr = pages.filter((page) => page.source === "ocr").length;
  if (ocr === 0) return "pdf";
  return ocr === pages.length ? "ocr" : "mixed";
}

/**
 * Extract → chunk → embed → store.
 *
 * The transaction discipline is the point: embedding is slow and asynchronous, so it happens
 * strictly between `beginChunkReplace` and the `insertChunkBatch` calls, never inside one. A
 * crash mid-run therefore leaves fewer rows than expected, which `countIndexedChunks` reports
 * as incomplete and the next open repairs. Completeness is derived, not stamped.
 */
export async function indexDocument(
  store: SemanticStore,
  embedder: Embedder,
  input: IndexDocumentInput,
): Promise<IndexDocumentResult> {
  const contentHash = hashBytes(input.bytes);
  // Serialised per document, not per caller: the clear-then-insert protocol below cannot be
  // interleaved with another job for the same hash. Enforced here rather than at the call site
  // so no caller can forget.
  return runExclusive(contentHash, () => indexDocumentExclusive(store, embedder, input, contentHash));
}

async function indexDocumentExclusive(
  store: SemanticStore,
  embedder: Embedder,
  input: IndexDocumentInput,
  contentHash: string,
): Promise<IndexDocumentResult> {
  // Read through a call, never as a narrowed property. `signal.aborted` changes underneath us,
  // but the compiler cannot see that: after one direct `signal.aborted === true` check returns,
  // it narrows the property to `false` and every later check becomes provably dead code. A
  // function call is opaque to that narrowing, which is what keeps the later checks live.
  const cancelled = (): boolean => input.signal?.aborted === true;

  // Before anything at all. A job queued behind another for the same document waits here, and by
  // the time it is admitted the reason for running it may be gone. Every step below has a side
  // effect the caller would have to undo: `onProgress` moves the tab's badge, `upsertDocument`
  // writes a row, and the reuse return reports a complete index — which would tell the caller
  // the document is searchable off the back of a job the user stopped.
  if (cancelled()) return { status: "cancelled" };

  input.onProgress?.({ status: "checking", message: "Checking semantic index" });

  const model = getCuratedEmbeddingModel(embedder.modelId);
  const textSource = textSourceOf(input.pages);

  const stored = store.upsertDocument({
    contentHash,
    name: input.name,
    filePath: input.filePath,
    fileSize: input.bytes.byteLength,
    pageCount: input.pageCount,
    textSource,
    // Phase 1 caches no Markdown, so nothing may claim an engine or a Markdown version.
    // Stamping one here would make a Phase 2 document indistinguishable from a Phase 1 one.
    markdownEngine: null,
    markdownVersion: null,
  });

  const chunks = chunkPages(contentHash, input.pages, input.chunkingProfile);
  const scope: ChunkScope = {
    documentId: stored.id,
    chunkingProfile: input.chunkingProfile,
    chunkingVersion: semanticChunkingVersion,
    modelId: model.id,
    modelVersion,
    // The embedder is the authority on its own output width; the curated catalogue entry
    // is user-facing metadata and can disagree with what the model actually produces.
    dimensions: embedder.dimensions,
  };

  if (chunks.length === 0) {
    input.onProgress?.({ status: "ready", message: "No text to index" });
    return { status: "empty", contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: 0, textSource };
  }

  // Completeness is an identity question, not a counting one.
  //
  // Chunk identifiers embed page and per-page position, so the same total can describe a
  // different set: one extraction run can yield [page1:0, page1:1] and the next [page1:0,
  // page2:0] for the same file, because the content hash covers the file's bytes while the
  // extracted text comes from the renderer and OCR output is not deterministic. Comparing the
  // stored identifiers against the expected ones catches that; comparing counts does not.
  //
  // Remaining limitation, deliberately not claimed away: identical identifiers can still carry
  // stale text, because an identifier does not cover its chunk's content and OCR output is not
  // deterministic. Phase 2 does not remove this by itself — the app's OCR stays in the renderer
  // — so Phase 2 must extend chunk identity or invalidation to cover changed extracted text.
  // Until then a forced rebuild is the only way to refresh such a document.
  if (input.force !== true && hasExactChunks(store, scope, chunks)) {
    input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
    return { status: "reused", contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: chunks.length, textSource };
  }

  // Check before anything destructive. A job cancelled while queued behind another job for the
  // same document would otherwise clear the scope and then abandon the rebuild, deleting a
  // complete index that the earlier job had just finished writing.
  if (cancelled()) {
    return { status: "cancelled" };
  }

  store.beginChunkReplace(scope);

  let written = 0;
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
    if (cancelled()) {
      return { status: "cancelled" };
    }

    const batch = chunks.slice(offset, offset + EMBED_BATCH);
    const prepared: ChunkInsert[] = [];
    for (const chunk of batch) {
      // Between each embedding, not just between batches: one batch is up to 32 embeddings, so
      // a batch-boundary check can leave a cancelled job running for a long time. Inference
      // itself cannot be interrupted (see createTransformersEmbedder), so the granularity of a
      // single embedding is the finest available.
      if (cancelled()) {
        // Discard whatever was prepared. Committing it would be a write after the caller
        // stopped us — and if the reason for stopping was a clear, that write repopulates a
        // database the user just emptied or fails a foreign key because the document row is
        // already gone.
        return { status: "cancelled" };
      }
      // Awaits happen here, with no transaction open.
      prepared.push({ ...chunk, vector: await embedder.embed(chunk.text, "passage") });
    }

    // Re-check immediately before committing: the await above yields, so cancellation can
    // arrive between the last embedding and this write.
    if (cancelled()) {
      return { status: "cancelled" };
    }
    store.insertChunkBatch(scope, prepared);
    written += prepared.length;

    input.onProgress?.({
      status: "indexing",
      current: written,
      total: chunks.length,
      message: `Indexing ${written} of ${chunks.length}`,
    });
    // One bounded yield per batch: the progress message reaches the channel before the next
    // batch monopolises this process again. It does not guarantee the interface paints that
    // state — the renderer may coalesce it with a later update — but it stops a long index
    // starving the channel. Injected rather than assumed: the shell supplies a real event-loop
    // yield, tests supply a deterministic one.
    await input.yieldControl?.();
  }

  input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
  return { status: "ready", contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: chunks.length, textSource };
}
