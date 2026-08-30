import { contentHash as hashBytes } from "../hash.js";
import { UNKNOWN_EXTRACTION_VERSION, type SemanticChunkingProfile } from "../models.js";
import type { MarkdownCacheInput } from "../store/index.js";

/**
 * What a caller knows about how it produced the page text.
 *
 * All of it or none of it. Recording an engine without a version, or a version without the text
 * it describes, would leave the document making a claim nothing backs up.
 */
export interface ExtractionProvenance extends MarkdownCacheInput {
  /** Recorded on `documents.text_extraction_version`. */
  textExtractionVersion: number;
  /** Recorded on `documents.ocr_extraction_version`. */
  ocrExtractionVersion: number;
}
import type { ChunkInsert, ChunkScope, SemanticStore, TextSource } from "../store/index.js";
import type { PageText } from "./chunking.js";
import { chunkPagesForIndex, type IndexableChunk } from "./structuredChunking.js";
import type { Embedder } from "./embeddings.js";
import { activeChunkScopeContract } from "./search.js";
import { runExclusive } from "./serialQueue.js";

/**
 * How a run ended.
 *
 * `incomplete` is a success that must not be mistaken for `ready`. The document is stored and
 * searchable, and at least one of its pages could not be read — so a caller that treats it as
 * finished tells somebody the words are all there when they are not. It is a separate member rather
 * than a flag on `ready` because the compiler then makes every consumer decide what to do about it.
 */
export type IndexStatus = "ready" | "reused" | "empty" | "incomplete" | "cancelled";

/**
 * Another run rebuilt this document while this one was working on it.
 *
 * Thrown rather than returned, deliberately. Every member of `IndexStatus` is a description of a
 * document that was successfully indexed one way or another, and this run cannot describe one: the
 * scope holds chunks it did not write, its claim was refused, and it has no way to know whether
 * what is there is finished. Saying `ready` would be a claim about somebody else's work. The
 * document is not damaged — whichever run finishes last leaves a coherent index or none at all —
 * so the remedy is to index it again, which the next open does anyway.
 */
export class ConcurrentIndexError extends Error {
  /** The document this run was working on. Carried for diagnostics; the message stays readable. */
  readonly contentHash: string;

  constructor(contentHash: string) {
    super("Another run indexed this document at the same time, so this one could not record what it built. Open it again to finish.");
    this.name = "ConcurrentIndexError";
    this.contentHash = contentHash;
  }
}

/** Publish the scope, or say why not. `unclaimed` is not a failure; a conflict is. */
function publishScope(
  store: SemanticStore,
  scope: ChunkScope,
  contentHash: string,
  chunkIds: readonly string[],
  cache: ExtractionProvenance | undefined,
): void {
  const outcome = store.completeChunkScope(scope, { chunkIds, ...(cache === undefined ? {} : { cache }) });
  if (outcome === "conflicted") throw new ConcurrentIndexError(contentHash);
}

function hasExactChunks(store: SemanticStore, scope: ChunkScope, chunks: readonly IndexableChunk[]): boolean {
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
   *
   * `ocr` is the same argument for the other slow prerequisite: pages the extractor could not read
   * are recognised inside this job, before a single embedding is built. Folding it into `checking`
   * told the reader the index was being examined while the machine was actually reading a scan,
   * which is the longest part of preparing such a document and the one worth naming.
   */
  status: "checking" | "ocr" | "downloading" | "indexing" | "ready";
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
  /**
   * Pages that needed recognising and did not get it.
   *
   * Supplied by whoever read the document, because this function is agnostic about where its page
   * text came from and cannot work it out for itself: a page simply absent from `pages` may be
   * blank, or may be one nothing could read, and the difference is the whole point.
   */
  unresolvedPages?: readonly number[];
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
  /**
   * The extracted Markdown to cache, and which engine produced it.
   *
   * Optional, and absent by default, because this function is deliberately agnostic about where
   * its page text came from — a caller may hand it text from anywhere. Stamping an engine on a
   * document whose text this function never saw produced would be a false provenance claim, so
   * nothing is stamped and nothing is cached unless a caller supplies this.
   *
   * `pages` must cover the document completely, `1..pageCount`, with unread or blank pages
   * carried as empty strings. A gap is refused by the store rather than stored as a shorter
   * document.
   */
  markdownCache?: ExtractionProvenance;
}

export interface IndexedDocumentResult {
  status: Exclude<IndexStatus, "cancelled">;
  contentHash: string;
  documentId: number;
  pageCount: number;
  chunkCount: number;
  textSource: TextSource;
  /** Pages nothing could read, ascending. Empty exactly when `status` is not `incomplete`. */
  unresolvedPages: number[];
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

/**
 * Provenance has to describe *this* document, and the type alone cannot say so.
 *
 * `engineId` and `markdownVersion` are runtime values a caller supplies; `pages` has to cover
 * `1..pageCount` exactly. Checked here, before anything is written, because the alternative is a
 * document row claiming an engine with no cache behind it.
 */
function requireCompleteCache(cache: ExtractionProvenance, pageCount: number): void {
  if (cache.engineId.trim().length === 0) {
    throw new Error("A Markdown cache needs an engine id with something in it.");
  }
  if (!Number.isInteger(cache.markdownVersion) || cache.markdownVersion < 1) {
    throw new Error(
      `A Markdown cache needs a representation version of at least 1; received ${String(cache.markdownVersion)}.`,
    );
  }
  for (const [field, value] of [
    ["textExtractionVersion", cache.textExtractionVersion],
    ["ocrExtractionVersion", cache.ocrExtractionVersion],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Provenance needs a ${field} of at least 1; received ${String(value)}.`);
    }
  }
  if (cache.pages.length !== pageCount) {
    throw new Error(
      `A Markdown cache must cover every page: the document has ${pageCount} but ${cache.pages.length} were supplied.`,
    );
  }
  for (const [position, page] of cache.pages.entries()) {
    if (page.page !== position + 1) {
      throw new Error(`A Markdown cache must run from page 1 without gaps; entry ${position} is page ${page.page}.`);
    }
  }
}

/** Embedded, then written, in groups of this size. Never held open across an await. */
const EMBED_BATCH = 32;

/**
 * The status a run actually ended on, and the pages behind it.
 *
 * Written once and applied to every success path, because "did every page get read?" is orthogonal
 * to "was there anything to embed?" — a document can be `empty`, `reused` or `ready` and still be
 * missing a page. A branch that returned its own status directly would be a branch that could
 * forget, and the one it would forget is the one that matters.
 */
function settle(
  status: "ready" | "reused" | "empty",
  unresolvedPages: readonly number[],
): { status: Exclude<IndexStatus, "cancelled">; unresolvedPages: number[] } {
  const unresolved = [...unresolvedPages].sort((a, b) => a - b);
  return { status: unresolved.length > 0 ? "incomplete" : status, unresolvedPages: unresolved };
}

function textSourceOf(pages: readonly PageText[]): TextSource {
  if (pages.length === 0) return "none";
  // A page read by region carries both a text layer and recognition, so it counts toward each.
  const fromRecognition = pages.some((page) => page.source === "ocr" || page.source === "mixed");
  const fromTextLayer = pages.some((page) => page.source === "pdf" || page.source === "mixed");
  if (fromRecognition && fromTextLayer) return "mixed";
  return fromRecognition ? "ocr" : "pdf";
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
  // The callback can abort synchronously, so the very next write re-reads the signal. Without
  // this, a run cancelled from its own progress handler still leaves a document row behind.
  if (cancelled()) return { status: "cancelled" };

  const textSource = textSourceOf(input.pages);
  const unresolvedPages = input.unresolvedPages ?? [];
  const cache = input.markdownCache;
  // Validated before the document row is written, so a cache that cannot be stored can never
  // leave a document stamped with an engine that cached nothing for it.
  if (cache !== undefined) requireCompleteCache(cache, input.pageCount);

  const stored = store.upsertDocument({
    contentHash,
    name: input.name,
    filePath: input.filePath,
    fileSize: input.bytes.byteLength,
    pageCount: input.pageCount,
    textSource,
    // Nothing about how the text was read is stamped here — not the engine, not the Markdown
    // version, and not the extraction versions. All four describe the text `putMarkdown` writes,
    // and it writes them in the same transaction as the cache row, so a document can never
    // advertise a reading that failed to be stored. Recording an extraction version at this point
    // was exactly that failure: a run interrupted between here and the cache left a row claiming a
    // newer reading of the document than the cache underneath it. "Unknown" and null preserve
    // whatever is already recorded.
    textExtractionVersion: UNKNOWN_EXTRACTION_VERSION,
    ocrExtractionVersion: UNKNOWN_EXTRACTION_VERSION,
    markdownEngine: null,
    markdownVersion: null,
  });

  // Page text in, structure-aware chunks out. `pages[].text` is Markdown when the caller
  // extracted Markdown, and plain text otherwise; the chunker handles both.
  const chunks = await chunkPagesForIndex(
    contentHash,
    input.pages.map((page) => ({ page: page.page, markdown: page.text, source: page.source })),
    input.chunkingProfile,
  );
  // Built from the one description of a searchable scope, so what is written here, what a search
  // reads under, and what the reuse preflight asks about cannot drift apart. The embedder is the
  // authority on its own output width; the curated catalogue entry is user-facing metadata and can
  // disagree with what the model actually produces.
  const scope: ChunkScope = { documentId: stored.id, ...activeChunkScopeContract(embedder, input.chunkingProfile) };

  // Re-read the signal immediately after the awaited chunk build. Loading the token counter and
  // measuring a document are both asynchronous, so a cancel can land inside them — and every
  // branch below either reports success or writes: `empty` and `reused` are both success, and
  // the reuse path backfills the Markdown cache.
  if (cancelled()) return { status: "cancelled" };

  if (chunks.length === 0) {
    // Whether "nothing to index" is a fact about the document or only about this run.
    //
    // Every page accounted for means the document really has no text in it, and this run is the
    // current reading of it. A page nothing could read means the opposite: the run discovered
    // nothing about that page, and an index built when something *could* read it is still the best
    // account of the document there is. Throwing it away on the strength of a missing recogniser
    // would lose passages that are not wrong, only unconfirmed.
    const everyPageAccountedFor = unresolvedPages.length === 0;

    // The replacement comes first, and before the new text, for the same reason it does on the
    // rebuild path below: while the old claim stands it vouches for the old passages, and a
    // preflight arriving between the two writes would serve them against a cache that no longer
    // contains them.
    //
    // Then the text and the claim go in together. Nothing to embed is a finished scope, and saying
    // so is what stops the most expensive document in a library — a scan that recognises to
    // nothing — from being rasterised again on every open. The claim is refused if anything landed
    // in the scope meanwhile, which is exactly the answer wanted: another run is rebuilding this
    // document and its result, not this one's emptiness, is what should stand.
    if (everyPageAccountedFor) {
      store.beginChunkReplace(scope);
      publishScope(store, scope, contentHash, [], cache);
    } else if (cache !== undefined) {
      // A document that yields no chunks still has pages, and the cache is keyed to the document
      // rather than to its chunks. Returning before writing it would leave the row stamped with an
      // engine that cached nothing — exactly the false claim the provenance check exists to stop.
      // This reading could not account for every page, so it establishes nothing about the scope
      // and claims nothing; storing it does retract whatever claim stood over the old text, which
      // is right, because that text is no longer what the document says.
      store.putMarkdown(stored.id, cache);
    }
    input.onProgress?.({ status: "ready", message: "No text to index" });
    return { ...settle("empty", unresolvedPages), contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: 0, textSource };
  }

  // Completeness is an identity question, not a counting one.
  //
  // The content hash covers the file's bytes; the text extracted from those bytes is a separate
  // thing that can differ between runs. A native parser's output can shift with its version or
  // its heuristics, OCR is not deterministic at all, and which pages take which path is decided
  // per run. So the same file can yield [page1:0, page1:1] on one run and [page1:0, page2:0] on
  // the next, with an identical total. Comparing stored identifiers against expected ones catches
  // that — the identifier carries a fingerprint of the text — and comparing counts does not.
  //
  if (input.force !== true && hasExactChunks(store, scope, chunks)) {
    // Everything this run learned is recorded here, and this is where documents that the preflight
    // cannot yet vouch for come to settle. Three of them arrive on this branch:
    //
    // A document indexed before caching existed has complete chunks and no cached text at all.
    //
    // A document cached before page outcomes were recorded has the text and cannot say why any of
    // it is empty. That silence is deliberately read as a gap, which is what repairs a scanned page
    // nothing recognised — but for a page that is genuinely blank it is wrong and self-perpetuating:
    // the chunks never change, so every run returns here, and every reader re-opens the file to look
    // at a page with nothing on it. Writing the outcomes we now know is what lets a blank page
    // settle.
    //
    // And a document read by an earlier build, whose record says it was read a way this build no
    // longer reads it, though the text turned out identical.
    //
    // Everything this run learned goes in as one claim: the text, its page outcomes, the extraction
    // versions beside them, and the record that the scope is finished. Reaching here means the
    // document was read in full a moment ago, so all of it describes that reading.
    //
    // Written whether or not the stored record looks stale. It used to be written only when the
    // cache was missing or could not account for its pages, and a third case then went unnoticed:
    // after a build raises an extraction version, a document whose new reading happens to produce
    // the same chunks arrives here, and leaving the record saying it was read the old way means the
    // preflight refuses it and the whole document is read again on every open, for ever. Writing
    // every time settles that without anything having to compare versions, and it costs one row
    // rewrite on a path that has just paid for a parse. The cheap path is the preflight, which
    // never reaches this function.
    //
    // The store re-checks the chunk identities inside that transaction, which is not redundant:
    // `hasExactChunks` read them a moment ago, and another process can rebuild this document in
    // between. A refusal means one did, and this run cannot report reuse of chunks that are no
    // longer there. A caller that supplied no text publishes nothing and reports success anyway:
    // its chunks are the ones already stored, and only the claim is missing.
    publishScope(store, scope, contentHash, chunks.map((chunk) => chunk.id), cache);
    input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
    return { ...settle("reused", unresolvedPages), contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: chunks.length, textSource };
  }

  // Check before anything destructive. A job cancelled while queued behind another job for the
  // same document would otherwise clear the scope and then abandon the rebuild, deleting a
  // complete index that the earlier job had just finished writing.
  if (cancelled()) {
    return { status: "cancelled" };
  }

  // The claim is withdrawn before the new reading is stored, and the order is the whole point.
  //
  // Both writes commit, so between them the database is readable by anything else holding it open.
  // Writing the cache first left a state that is a lie: the row and its cache describe the new
  // reading of the document while the completion marker still vouches for embeddings built from
  // the old one. A preflight landing in that window is answered with the old passages as though
  // they were the new ones — and it is a window another process reaches by doing nothing unusual,
  // because the two writes are separate transactions.
  //
  // Nothing is awaited between the two, so no cancellation can land between them either. The
  // contract they carry together is unchanged: a run cancelled before the replacement begins
  // writes no cache at all, and one cancelled after it keeps the cache — the extraction is valid
  // whether or not the embedding finished, and re-reading the file would be pure waste. What the
  // ordering costs is that a crash between them leaves the document with no index and its previous
  // cache: the next open reads it again, which is what it would have done anyway.
  store.beginChunkReplace(scope);
  if (cache !== undefined) store.putMarkdown(stored.id, cache);

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
      // Embedded with its breadcrumb, stored without it: the model gets the context, the reader
      // gets what was on the page.
      prepared.push({
        id: chunk.id,
        page: chunk.page,
        index: chunk.index,
        text: chunk.text,
        headingPath: chunk.headingPath,
        vector: await embedder.embed(chunk.embedText, "passage"),
      });
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

  // The claim describes a complete searchable scope, so it is made only after the final chunk
  // batch — and it is a claim, not a statement: the store checks that the scope still holds
  // exactly the chunks this run wrote before it records anything, and writes this run's text in
  // the same transaction so the two cannot be split. It is refused when another process rebuilt
  // the same document while this one was embedding, and then the scope carries no claim at all:
  // nothing reuses it, and the next open reads the document again. That is the honest outcome —
  // this run cannot know whose chunks the scope now holds, so it raises rather than reporting a
  // readiness it cannot vouch for.
  publishScope(store, scope, contentHash, chunks.map((chunk) => chunk.id), cache);
  input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
  return { ...settle("ready", unresolvedPages), contentHash, documentId: stored.id, pageCount: input.pageCount, chunkCount: chunks.length, textSource };
}
