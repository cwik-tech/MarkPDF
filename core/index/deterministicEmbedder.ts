import type { Embedder } from "./embeddings.js";

/**
 * A deterministic bag-of-words embedder for tests.
 *
 * Text sharing vocabulary lands closer together, which is enough to assert that retrieval
 * returns the right page. It proves the pipeline, not the model: it says nothing about whether
 * the real weights download, whether ONNX Runtime initialises, or whether real rankings are
 * useful. Those need the opt-in live check.
 */
export function createDeterministicEmbedder(dimensions = 64, modelId = "Xenova/bge-small-en-v1.5"): Embedder {
  return {
    modelId,
    dimensions,
    async embed(text) {
      const vector = new Float32Array(dimensions);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0)) {
        let hash = 2166136261;
        for (let i = 0; i < word.length; i += 1) {
          hash ^= word.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        const slot = Math.abs(hash) % dimensions;
        const current = vector[slot];
        if (current !== undefined) vector[slot] = current + 1;
      }
      let magnitude = 0;
      for (const value of vector) magnitude += value * value;
      magnitude = Math.sqrt(magnitude);
      if (magnitude > 0) {
        for (const [i, value] of vector.entries()) vector[i] = value / magnitude;
      }
      return vector;
    },
  };
}
