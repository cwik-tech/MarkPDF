import type { SemanticStore } from "../store/index.js";

/** Chunks per backfill transaction. Bounded so no write lock is held long enough to make another process wait. */
export const EXACT_INDEX_BATCH_SIZE = 500;

export interface CompleteExactIndexOptions {
  batchSize?: number;
  /** Checked between batches. A cancelled backfill stops cleanly and the next run continues. */
  signal?: AbortSignal;
  /**
   * Awaited between batches.
   *
   * SQLite here is synchronous, so without a real yield nothing else on the event loop runs until the
   * last batch: not a cancel, not a progress message, not quit. The default is `setImmediate`, the
   * same yield the index job uses.
   */
  yieldControl?: () => Promise<void>;
  /** Chunks added by each batch. */
  onProgress?: (indexed: number) => void;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Bring the exact-word index up to date with every stored chunk.
 *
 * An index written before the exact-word index existed has chunks without index rows. New chunks are
 * indexed by triggers as they are written; this fills in the old ones, one bounded transaction at a
 * time, until the store records the index complete.
 */
export async function completeExactIndex(store: SemanticStore, options: CompleteExactIndexOptions = {}): Promise<void> {
  const batchSize = options.batchSize ?? EXACT_INDEX_BATCH_SIZE;
  const yieldControl = options.yieldControl ?? nextTurn;
  const cancelled = (): boolean => options.signal?.aborted === true;

  while (!cancelled() && store.exactIndexState() !== "complete") {
    const batch = store.backfillExactIndexBatch(batchSize);
    options.onProgress?.(batch.indexed);
    if (batch.state === "complete") return;
    await yieldControl();
  }
}
