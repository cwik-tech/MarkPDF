import { getCuratedEmbeddingModel } from "../models.js";
import { modelCacheDir } from "../paths.js";
import { toEmbeddingVector } from "./embeddingTensor.js";
import { withRequestBound, type FetchLike } from "./boundedFetch.js";

export interface EmbedProgress {
  loaded: number;
  total: number;
}

/**
 * The boundary between this pipeline and the model runtime.
 *
 * Injected so the default test suite runs offline and deterministically. Substituting it does
 * not prove that the real model loads, that ONNX Runtime initialises, that q8 quantisation
 * works, or that rankings are useful — those need the opt-in live check.
 */
export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(text: string, mode: "query" | "passage"): Promise<Float32Array>;
  /** Optional eager load, for a UI that wants to download before indexing. */
  warm?(): Promise<void>;
}

export interface TransformersEmbedderOptions {
  modelId: string;
  dataDir: string;
  onProgress?: (progress: EmbedProgress) => void;
}

/**
 * Install the download bound exactly once per process.
 *
 * `env` is a module-level singleton shared by every caller, so re-assigning `env.fetch` per job
 * would let concurrent jobs clobber each other. Installing once, with a fixed policy, is the
 * only race-free arrangement available.
 */
let fetchBoundInstalled = false;

function installBoundedFetch(env: { fetch: FetchLike }): void {
  if (fetchBoundInstalled) return;
  fetchBoundInstalled = true;
  env.fetch = withRequestBound(env.fetch);
}

/**
 * Transformers.js against onnxruntime-node, caching weights on the filesystem.
 *
 * Construction is cheap: the model identity and width come from the catalogue, and the weights
 * load on the first `embed` call. That laziness matters — an already-complete index must not
 * trigger a download just to be recognised as complete, and a document's row should be
 * recorded even when the model is unavailable.
 *
 * KNOWN LIMITATION — inference cannot be cancelled. `FeatureExtractionPipeline._call` accepts
 * only pooling, normalize, quantize and precision; Transformers calls `session.run(feed)`
 * without ever populating ONNX RunOptions; and onnxruntime-node exposes no abort at all, its
 * `RunOptions.terminate` being documented as WebAssembly-only. The native call is synchronous
 * inside a `setImmediate`, so it blocks the event loop and cannot be preempted in-process.
 * Cancelling mid-embedding would require a worker thread or a separate process. Indexing
 * therefore checks for cancellation between batches, never inside one.
 */
export function createTransformersEmbedder(options: TransformersEmbedderOptions): Embedder {
  const model = getCuratedEmbeddingModel(options.modelId);
  type Extractor = Awaited<ReturnType<typeof loadPipeline>>;
  let extractor: Promise<Extractor> | null = null;

  async function loadPipeline() {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    env.useFSCache = true;
    env.cacheDir = modelCacheDir(options.dataDir);
    installBoundedFetch(env);

    // The task literal drives a mapped return type, so this is already a
    // FeatureExtractionPipeline. No cast.
    return pipeline("feature-extraction", model.id, {
      dtype: "q8",
      progress_callback: (event) => {
        if (event.status !== "progress") return;
        const { loaded, total } = event;
        if (typeof loaded === "number" && typeof total === "number") {
          options.onProgress?.({ loaded, total });
        }
      },
    });
  }

  function load(): Promise<Extractor> {
    if (extractor !== null) return extractor;
    extractor = loadPipeline().catch((error: unknown) => {
      extractor = null; // a failed or timed-out download must not poison every later attempt
      throw error;
    });
    return extractor;
  }

  return {
    modelId: model.id,
    dimensions: model.dimensions,
    async warm() {
      await load();
    },
    async embed(text, mode) {
      const run = await load();
      const input = mode === "query" && model.queryPrefix !== undefined ? `${model.queryPrefix}${text}` : text;
      const output = await run(input, { pooling: "mean", normalize: true });
      return toEmbeddingVector(output, model.dimensions);
    },
  };
}
