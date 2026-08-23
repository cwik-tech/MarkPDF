import { describe, expect, it } from "vitest";
import { curatedEmbeddingModels as coreModels, chunkingPresets as corePresets, defaultSemanticScoreThreshold as coreThreshold } from "./models.js";
import { curatedEmbeddingModels as rendererModels, chunkingPresets as rendererPresets, defaultSemanticScoreThreshold as rendererThreshold } from "../src/semanticModels";

/**
 * The renderer keeps its own copy of the catalogue because it must not import core. That is a
 * duplication, and duplication of `dimensions` in particular would mislabel stored vectors.
 * This test is what makes the duplication safe: the two must agree exactly.
 */
describe("the model catalogue the renderer shows and the one core indexes with", () => {
  it("lists the same models with the same dimensions", () => {
    expect(rendererModels.map((m) => ({ id: m.id, dimensions: m.dimensions }))).toEqual(
      coreModels.map((m) => ({ id: m.id, dimensions: m.dimensions })),
    );
  });

  it("uses the same chunking presets, which decide how text is split", () => {
    expect(rendererPresets.map((p) => ({ id: p.id, chunkTokens: p.chunkTokens, overlapTokens: p.overlapTokens }))).toEqual(
      corePresets.map((p) => ({ id: p.id, chunkTokens: p.chunkTokens, overlapTokens: p.overlapTokens })),
    );
  });

  it("agrees on the default score threshold", () => {
    expect(rendererThreshold).toBe(coreThreshold);
  });
});
