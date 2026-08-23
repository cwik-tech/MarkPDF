import { describe, expect, it } from "vitest";
import { OCR_EXTRACTION_VERSION, curatedEmbeddingModels as coreModels, chunkingPresets as corePresets, defaultSemanticScoreThreshold as coreThreshold } from "./models.js";
import { curatedEmbeddingModels as rendererModels, chunkingPresets as rendererPresets, defaultSemanticScoreThreshold as rendererThreshold } from "../src/semanticModels";
import { OCR_CONTRACT_VERSION as coreOcrVersion, ocrProfile as coreOcrProfile } from "./ocr/ocrContract.js";
import {
  OCR_CONTRACT_VERSION as rendererOcrVersion,
  RENDERER_OCR_PROFILE,
  overlayEngineValue,
  overlayRecognitionParameters,
} from "../src/ocrContract";

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

describe("the OCR contract the renderer mirrors and the one core indexes with", () => {
  it("agrees on the contract version", () => {
    expect(rendererOcrVersion).toBe(coreOcrVersion);
    expect(coreOcrVersion).toBe(OCR_EXTRACTION_VERSION);
  });

  it("agrees on the overlay profile the window reads with", () => {
    expect(RENDERER_OCR_PROFILE).toEqual(coreOcrProfile("overlay"));
  });

  it("maps every overlay engine setting from the mirrored profile", () => {
    const installedEngine = Symbol("installed LSTM engine");
    const installedSparseMode = Symbol("installed sparse mode");

    expect(overlayEngineValue({ LSTM_ONLY: installedEngine })).toBe(installedEngine);
    expect(overlayRecognitionParameters({ SPARSE_TEXT: installedSparseMode })).toEqual({
      tessedit_pageseg_mode: installedSparseMode,
      preserve_interword_spaces: "1",
    });
  });
});
