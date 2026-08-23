import type { Embedder } from "./embeddings.js";

export interface TruncatingEmbedderOptions {
  /** Tokens (or, in tests, characters) the stand-in will accept before cutting. */
  limit: number;
  count: (text: string) => number;
  dimensions?: number;
  modelId?: string;
}

export interface TruncatingEmbedder extends Embedder {
  /** Every input that was cut, and by how much. */
  readonly truncations: ReadonlyArray<{ given: number; embedded: number }>;
}

/**
 * A deterministic embedder that truncates, reproducing what the real pipeline does silently.
 *
 * `createDeterministicEmbedder` hashes whatever string it is handed and has no limit, so it
 * returns an equally confident vector for an input the installed feature-extraction pipeline
 * would have cut in half. That makes it useless for proving anything about oversized chunks: a
 * retrieval test would pass whether or not the chunker respected the budget. This stand-in cuts,
 * so "the answer is in the final part and the search finds it" means something.
 */
export function createTruncatingEmbedder(options: TruncatingEmbedderOptions): TruncatingEmbedder {
  const dimensions = options.dimensions ?? 64;
  const truncations: Array<{ given: number; embedded: number }> = [];

  function cut(text: string): string {
    if (options.count(text) <= options.limit) return text;
    let size = text.length;
    while (size > 0 && options.count(text.slice(0, size)) > options.limit) size -= 1;
    const kept = text.slice(0, size);
    truncations.push({ given: options.count(text), embedded: options.count(kept) });
    return kept;
  }

  return {
    modelId: options.modelId ?? "Xenova/bge-small-en-v1.5",
    dimensions,
    truncations,
    async embed(text) {
      const vector = new Float32Array(dimensions);
      for (const word of cut(text).toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 0)) {
        let hash = 2166136261;
        for (let index = 0; index < word.length; index += 1) {
          hash ^= word.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        const slot = Math.abs(hash) % dimensions;
        vector[slot] = (vector[slot] ?? 0) + 1;
      }
      let magnitude = 0;
      for (const value of vector) magnitude += value * value;
      const norm = Math.sqrt(magnitude) || 1;
      for (let index = 0; index < dimensions; index += 1) vector[index] = (vector[index] ?? 0) / norm;
      return vector;
    },
  };
}
