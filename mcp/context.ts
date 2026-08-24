import { readFile, writeFile } from "node:fs/promises";
import { BoundedScheduler, SchedulerCancelled } from "../dist-core/index/boundedScheduler.js";
import { readAllowlist } from "../dist-core/consent/allowlistFile.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { shouldUseDeterministicEmbedder } from "../dist-core/index/embedderSelection.js";
import { createTransformersEmbedder, type Embedder } from "../dist-core/index/embeddings.js";
import { ModelProgressHub } from "../dist-core/index/modelProgress.js";
import { getCuratedEmbeddingModel } from "../dist-core/models.js";
import { ocrPages } from "../dist-core/ocr/ocrPages.js";
import { recordingRasteriser, shouldRecordRasterisation } from "../dist-core/ocr/rasterisationRecord.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../dist-core/output/budget.js";
import { readOpenDocuments } from "../dist-core/session/openDocuments.js";
import { readOpenDocumentContent } from "../dist-core/session/openDocumentContent.js";
import { readSemanticSettings } from "../dist-core/settings/appSettings.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import type { ToolContext } from "./operations.js";

/**
 * How many tool calls this server does work for at once.
 *
 * It has to be a number, and it has to be finite. The SDK's protocol layer starts each request
 * handler the moment its frame arrives and never waits for an earlier one, so left alone a client
 * that sends twenty calls gets twenty concurrent document extractions sharing one SQLite
 * connection and one embedding session — and peak memory then depends on how many calls somebody
 * chose to make rather than on anything this program decided.
 *
 * Four keeps cheap index-only work responsive while a long conversion runs. Expensive OCR has its
 * own one-per-process scheduler below, so accepting several tool calls never means holding several
 * rasterised pages and recognition engines at once.
 */
export const CONCURRENT_TOOL_CALLS = 4;
export const CONCURRENT_OCR_CALLS = 1;

export interface ContextInput {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

export interface ContextDependencies {
  createEmbedder?: (modelId: string, onProgress: (progress: { loaded: number; total: number }) => void) => Embedder;
  ocr?: typeof ocrPages;
}

/**
 * How many embedding models this server keeps alive at once.
 *
 * One per model id, capped: a session that works under one model and then another holds both —
 * enough for a change of model in the application to take effect on the very next call — and a
 * third evicts the one used least recently, so the number cannot grow with the session's
 * history. Eviction drops the reference; the runtime itself is the embedding library's to
 * reclaim, exactly as the application handles its own per-model map.
 */
export const EMBEDDER_CACHE_SIZE = 2;

/**
 * Everything the tools need, wired to the same core the application and the command line use.
 *
 * The consent record, the open-document record and the settings are read **per call**, not once
 * at startup. A session lives as long as the client does — hours — and a withdrawal, an opened
 * tab or a changed setting in that time has to take effect without the person having to restart
 * their editor.
 */
export function createToolContext(
  input: ContextInput,
  dependencies: ContextDependencies = {},
): { context: ToolContext; close: () => void } {
  let store: SemanticStore | null = null;
  // Most recently used last; the first entry is the next to go once the cache is full.
  const embedders = new Map<string, Embedder>();
  const modelProgress = new ModelProgressHub();
  const ocrScheduler = new BoundedScheduler(CONCURRENT_OCR_CALLS);

  const watchedEmbedder = (
    embedder: Embedder,
    listener: (progress: { loaded: number; total: number }) => void,
  ): Embedder => {
    const warm = embedder.warm;
    const watched = async <T>(work: () => Promise<T>): Promise<T> => {
      const unsubscribe = modelProgress.subscribe(embedder.modelId, listener);
      try {
        return await work();
      } finally {
        unsubscribe();
      }
    };
    return {
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
      embed: async (text, mode) => await watched(async () => await embedder.embed(text, mode)),
      ...(warm === undefined
        ? {}
        : { warm: async () => await watched(async () => await warm()) }),
    };
  };

  const context: ToolContext = {
    store: () => {
      // Opened on first use, so listing the tools never creates an index for somebody who has not
      // used one.
      store ??= openSemanticStore({ dataDir: input.dataDir });
      return store;
    },
    embedder: (modelId, onProgress) => {
      const cached = embedders.get(modelId);
      if (cached !== undefined) {
        // Touched: move to the most-recent end so the eviction takes the true least recent.
        embedders.delete(modelId);
        embedders.set(modelId, cached);
        return onProgress === undefined ? cached : watchedEmbedder(cached, onProgress);
      }
      // The same guarded seam the other two surfaces use: unpackaged, the exact opt-in token, and
      // a test data directory. Nothing a client sends can reach it.
      const publish = (progress: { loaded: number; total: number }): void => modelProgress.publish(modelId, progress);
      const created = dependencies.createEmbedder !== undefined
        ? dependencies.createEmbedder(modelId, publish)
        : shouldUseDeterministicEmbedder({ isPackaged: input.isPackaged, env: input.env })
          ? createDeterministicEmbedder(getCuratedEmbeddingModel(modelId).dimensions, modelId)
          : createTransformersEmbedder({ modelId, dataDir: input.dataDir, onProgress: publish });
      embedders.set(modelId, created);
      while (embedders.size > EMBEDDER_CACHE_SIZE) {
        const oldest = embedders.keys().next();
        if (oldest.done === true) break;
        embedders.delete(oldest.value);
      }
      return onProgress === undefined ? created : watchedEmbedder(created, onProgress);
    },
    allowlist: () => readAllowlist(input.dataDir),
    // Per call, like the consent record above and for the same reason: a client session lasts
    // hours, and which document somebody is looking at changes by the minute.
    openDocuments: () => readOpenDocuments(input.dataDir),
    readOpenDocumentContent: (entry) =>
      readOpenDocumentContent(input.dataDir, entry.process, entry.window, entry.tabId),
    // Per call, for the same reason again — and read inside the call rather than at startup, so
    // a settings file that cannot be opened refuses one call instead of refusing to start.
    settings: () => readSemanticSettings(input.dataDir),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    writeFile: async (path, text) => await writeFile(path, text, "utf8"),
    // The same reading the command line does. Without it a scanned document answers with blank
    // pages, which is the one failure that looks like a correct answer.
    resolveOcr: async (request) => {
      try {
        return await ocrScheduler.run(
          async () => await (dependencies.ocr ?? ocrPages)(
            request,
            shouldRecordRasterisation({ isPackaged: input.isPackaged, env: input.env })
              ? { rasterise: recordingRasteriser(input.dataDir) }
              : {},
          ),
          request.signal,
        );
      } catch (error) {
        if (error instanceof SchedulerCancelled) return [];
        throw error;
      }
    },
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    scheduler: new BoundedScheduler(CONCURRENT_TOOL_CALLS),
  };

  return {
    context,
    close: () => {
      store?.close();
      store = null;
    },
  };
}
