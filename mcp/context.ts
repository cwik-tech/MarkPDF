import { readFile, writeFile } from "node:fs/promises";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { readAllowlist } from "../dist-core/consent/allowlistFile.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { shouldUseDeterministicEmbedder } from "../dist-core/index/embedderSelection.js";
import { createTransformersEmbedder, type Embedder } from "../dist-core/index/embeddings.js";
import { getCuratedEmbeddingModel } from "../dist-core/models.js";
import { ocrPages } from "../dist-core/ocr/ocrPages.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../dist-core/output/budget.js";
import { readOpenDocuments } from "../dist-core/session/openDocuments.js";
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
 * Four rather than one: an index-only `search` should not have to wait behind a slow conversion of
 * a three-hundred-page scan, and the two do not contend for the same resource. Four rather than
 * many: embedding is synchronous native work that blocks this thread, so overlapping calls do not
 * finish sooner — they only multiply the document text held in memory at once.
 */
export const CONCURRENT_TOOL_CALLS = 4;

export interface ContextInput {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

/**
 * Everything the tools need, wired to the same core the application and the command line use.
 *
 * The consent record is read **per call**, not once at startup. A session lives as long as the
 * client does — hours — and a withdrawal made in that time has to take effect without the person
 * having to restart their editor.
 */
export function createToolContext(input: ContextInput): { context: ToolContext; close: () => void } {
  let store: SemanticStore | null = null;
  let embedder: Embedder | null = null;

  const context: ToolContext = {
    store: () => {
      // Opened on first use, so listing the tools never creates an index for somebody who has not
      // used one.
      store ??= openSemanticStore({ dataDir: input.dataDir });
      return store;
    },
    embedder: () => {
      if (embedder !== null) return embedder;
      const modelId = readSemanticSettings(input.dataDir).activeModelId;
      // The same guarded seam the other two surfaces use: unpackaged, the exact opt-in token, and
      // a test data directory. Nothing a client sends can reach it.
      embedder = shouldUseDeterministicEmbedder({ isPackaged: input.isPackaged, env: input.env })
        ? createDeterministicEmbedder(getCuratedEmbeddingModel(modelId).dimensions, modelId)
        : createTransformersEmbedder({ modelId, dataDir: input.dataDir });
      return embedder;
    },
    allowlist: () => readAllowlist(input.dataDir),
    // Per call, like the consent record above and for the same reason: a client session lasts
    // hours, and which document somebody is looking at changes by the minute.
    openDocuments: () => readOpenDocuments(input.dataDir),
    settings: readSemanticSettings(input.dataDir),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    writeFile: async (path, text) => await writeFile(path, text, "utf8"),
    // The same reading the command line does. Without it a scanned document answers with blank
    // pages, which is the one failure that looks like a correct answer.
    resolveOcr: (request) => ocrPages(request, {}),
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
