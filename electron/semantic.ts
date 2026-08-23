import { app } from "electron";
import { readFile } from "node:fs/promises";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { resolveDataDir } from "../dist-core/paths.js";
import type { IndexProgress, IndexDocumentResult } from "../dist-core/index/indexDocument.js";
import { indexPdfDocument } from "../dist-core/index/indexPdfDocument.js";
import { searchDocument, type SemanticSearchResult } from "../dist-core/index/search.js";
import { createTransformersEmbedder, type Embedder } from "../dist-core/index/embeddings.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { shouldUseDeterministicEmbedder } from "../dist-core/index/embedderSelection.js";
import { curatedEmbeddingModels, type CuratedEmbeddingModel } from "../dist-core/models.js";
import { JobRegistry } from "../dist-core/index/jobRegistry.js";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { scheduleIndexJob } from "../dist-core/index/scheduleIndexJob.js";
import { ModelProgressHub } from "../dist-core/index/modelProgress.js";
import { filterCachedModels, isModelCached } from "../dist-core/index/modelCache.js";
import { clearSemanticIndex } from "../dist-core/index/clearIndex.js";
import type { PageText } from "../dist-core/index/chunking.js";
import {
  parseSemanticSettings,
  type SemanticSearchSettings,
} from "../dist-core/ipc/settings.js";
import {
  parseContentHash,
  parseDownloadRequest,
  parseIndexRequest,
  parseSearchRequest,
  SemanticRequestError,
  type ParsedIndexRequest,
  type ParsedSearchRequest,
} from "../dist-core/ipc/requests.js";

export {
  parseContentHash,
  parseDownloadRequest,
  parseIndexRequest,
  parseSearchRequest,
  SemanticRequestError,
};

export type { SemanticChunkingProfile, SemanticSearchSettings } from "../dist-core/ipc/settings.js";
export {
  defaultSemanticSearchSettings,
  parseCuratedModelId,
  parseSemanticSettings,
  parseSemanticSettingsPatch,
} from "../dist-core/ipc/settings.js";

export interface SemanticStoreSchema {
  semanticSearch: SemanticSearchSettings;
}

export interface SemanticDatabaseInfo {
  sizeBytes: number;
  documentCount: number;
  chunkCount: number;
  schemaVersion: number;
  concurrencyDegraded: boolean;
}

/* ------------------------------------------------- *
 * Store handle, embedder cache and the job registry. *
 * ------------------------------------------------- */

let storeHandle: SemanticStore | null = null;

export function getSemanticStore(): SemanticStore {
  if (storeHandle === null) {
    storeHandle = openSemanticStore({ dataDir: resolveDataDir(app.getPath("userData")) });
  }
  return storeHandle;
}

export function closeSemanticStore(): void {
  storeHandle?.close();
  storeHandle = null;
}

const embedders = new Map<string, Embedder>();

/**
 * Download progress for every model, one producer to many consumers.
 *
 * An embedder is built once per model and lives for the process, so a progress callback baked
 * in at construction would belong forever to whichever caller happened to be first. Later
 * callers would watch a bar that never moves. The embedder publishes here instead, and each
 * operation subscribes for its own duration.
 */
const modelProgress = new ModelProgressHub();

export function subscribeToModelProgress(
  modelId: string,
  listener: (loaded: number, total: number) => void,
): () => void {
  return modelProgress.subscribe(modelId, (progress) => listener(progress.loaded, progress.total));
}

/**
 * Cheap: the real model's weights load on first use, not here.
 *
 * The deterministic stand-in is selectable only through the environment, and only in an
 * unpackaged build pointed at a test user-data directory (see `shouldUseDeterministicEmbedder`).
 * No IPC channel and no persisted setting reaches this decision, so a running application
 * cannot be talked into it by the renderer.
 */
export function getEmbedder(modelId: string): Embedder {
  const existing = embedders.get(modelId);
  if (existing !== undefined) return existing;

  const created = shouldUseDeterministicEmbedder({ isPackaged: app.isPackaged, env: process.env })
    ? createDeterministicEmbedder(384, modelId)
    : createTransformersEmbedder({
        modelId,
        dataDir: resolveDataDir(app.getPath("userData")),
        onProgress: (progress) => modelProgress.publish(modelId, progress),
      });

  embedders.set(modelId, created);
  return created;
}

/** Whether a model claimed as downloaded is genuinely on disk. */
export function isSemanticModelCached(modelId: string): boolean {
  return isModelCached(resolveDataDir(app.getPath("userData")), modelId);
}

/** The claimed models that are genuinely on disk, so a stale claim corrects itself on read. */
export function cachedSemanticModels(modelIds: readonly string[]): string[] {
  return filterCachedModels(resolveDataDir(app.getPath("userData")), modelIds);
}

const jobs = new JobRegistry();

/**
 * One index job at a time in this process.
 *
 * `runExclusive` inside `indexDocument` serialises jobs for the *same* document; it says nothing
 * about different ones, and opening ten tabs schedules ten distinct content hashes. Embedding is
 * synchronous native work that blocks this thread, so overlapping those jobs buys no throughput
 * — it only multiplies peak memory and lengthens the stalls in the process that also draws the
 * interface. One is therefore the evidenced value, not a placeholder.
 */
const indexScheduler = new BoundedScheduler(1);

export function activeJobCount(): number {
  return jobs.size;
}

export function cancelSemanticJob(jobId: unknown): boolean {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new SemanticRequestError("jobId must be a non-empty string.");
  }
  return jobs.cancel(jobId);
}

export function listCuratedModels(): CuratedEmbeddingModel[] {
  return [...curatedEmbeddingModels];
}

export async function runIndexJob(
  request: ParsedIndexRequest,
  settings: SemanticSearchSettings,
  onProgress: (progress: IndexProgress) => void,
): Promise<IndexDocumentResult> {
  const modelId = settings.activeModelId;

  // Subscribed for this job only. A job that finds the weights missing triggers the download
  // itself, deep inside the first embed call; without this the tab would sit on "Checking" for
  // the length of a 133 MB fetch with nothing to show for it.
  const unsubscribe = subscribeToModelProgress(modelId, (loaded, total) => {
    onProgress({ status: "downloading", current: loaded, total, message: "Downloading embedding model" });
  });

  try {
    return await scheduleIndexJob({ registry: jobs, scheduler: indexScheduler, jobId: request.jobId }, async (token) => {
      // Reading the file can fail — a deleted or unreadable path — and it happens here, after
      // the permit and the cancellation re-check, so a queued job that was cancelled never
      // touches the filesystem at all.
      let bytes = request.bytes;
      if (bytes === null) {
        // parseIndexRequest guarantees one of the two, but the parsed shape does not say so.
        // Say it here rather than reading path "" and reporting a confusing ENOENT.
        if (request.filePath === null) {
          throw new SemanticRequestError("index request must carry bytes or a file path.");
        }
        bytes = new Uint8Array(await readFile(request.filePath));
      }
      return indexPdfDocument(getSemanticStore(), getEmbedder(modelId), {
        bytes,
        name: request.name,
        filePath: request.filePath,
        ocrCandidates: request.ocrCandidates,
        chunkingProfile: request.chunkingProfile,
        force: request.force,
        onProgress,
        signal: token.signal,
        // A real event-loop yield: the progress message is queued to the renderer before the
        // next batch begins, so the interface can paint it.
        yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
      });
    });
  } finally {
    unsubscribe();
  }
}

export async function runSearch(
  request: ParsedSearchRequest,
  settings: SemanticSearchSettings,
): Promise<SemanticSearchResult[]> {
  const embedder = getEmbedder(settings.activeModelId);
  return searchDocument(getSemanticStore(), embedder, {
    contentHash: request.contentHash,
    query: request.query,
    chunkingProfile: request.chunkingProfile,
    ...(request.topK !== undefined ? { topK: request.topK } : {}),
    minScore: request.minScore ?? settings.minSemanticScore,
  });
}

/**
 * Warm the pipeline so the weights land in the shared filesystem cache.
 *
 * Subscribed for the duration of this call rather than at embedder construction, so a second
 * caller arriving later still receives byte progress. Returns whether the model is on disk
 * afterwards, which is the only honest basis for recording it as downloaded.
 */
export async function downloadSemanticModel(
  modelId: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<boolean> {
  const unsubscribe =
    onProgress === undefined ? () => undefined : subscribeToModelProgress(modelId, onProgress);
  try {
    await getEmbedder(modelId).warm?.();
  } finally {
    unsubscribe();
  }
  return isSemanticModelCached(modelId);
}

export function getSemanticDatabaseInfo(): SemanticDatabaseInfo {
  const store = getSemanticStore();
  const info = store.info();
  return {
    sizeBytes: info.sizeBytes,
    documentCount: info.documentCount,
    chunkCount: info.chunkCount,
    schemaVersion: info.schemaVersion,
    concurrencyDegraded: store.diagnostics.concurrencyDegraded,
  };
}

/**
 * Empty the index, stopping every writer first and waiting for them to actually stop.
 *
 * The composition lives in core (`clearSemanticIndex`) so it can be mutation-proved; this is
 * the main-process wiring. It does not depend on the renderer sending cancels first, which it
 * could not do in time anyway: the settings action awaits this call before resetting its tabs.
 */
export async function clearSemanticDatabase(): Promise<SemanticDatabaseInfo> {
  await clearSemanticIndex(getSemanticStore(), jobs);
  return getSemanticDatabaseInfo();
}

/**
 * Remove a document at the reader's request, and mean it.
 *
 * `forgetDocument`, not `deleteDocument`: this is the user-facing surface, so it has to reclaim
 * the space rather than leave the text recoverable from the file until something else happens to.
 */
export function deleteSemanticDocument(contentHash: unknown): boolean {
  return getSemanticStore().forgetDocument(parseContentHash(contentHash));
}

export function getSemanticDocument(contentHash: unknown) {
  return getSemanticStore().getDocument(parseContentHash(contentHash));
}
