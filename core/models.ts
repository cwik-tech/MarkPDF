export type SemanticChunkingProfile = "precise" | "balanced" | "contextual";

export interface CuratedEmbeddingModel {
  id: string;
  name: string;
  description: string;
  dimensions: number;
  approxSizeMb: number;
  badge?: string;
  queryPrefix?: string;
}

export interface ChunkingPreset {
  id: SemanticChunkingProfile;
  name: string;
  description: string;
  chunkTokens: number;
  overlapTokens: number;
}

export interface SemanticScoreThresholdPreset {
  id: "loose" | "balanced" | "strict";
  name: string;
  description: string;
  value: number;
}

export const legacyRecommendedEmbeddingModelId = "BAAI/bge-small-en-v1.5";
export const recommendedEmbeddingModelId = "Xenova/bge-small-en-v1.5";

export const curatedEmbeddingModels: readonly CuratedEmbeddingModel[] = [
  {
    id: "Xenova/bge-small-en-v1.5",
    name: "BGE Small EN v1.5",
    description: "Recommended ONNX-ready balance for local PDF semantic search.",
    dimensions: 384,
    approxSizeMb: 133,
    badge: "Recommended",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    name: "MiniLM L6 v2",
    description: "Smaller and faster, with lighter retrieval quality.",
    dimensions: 384,
    approxSizeMb: 90,
  },
  {
    id: "Xenova/bge-base-en-v1.5",
    name: "BGE Base EN v1.5",
    description: "Higher quality, slower indexing, and larger storage.",
    dimensions: 768,
    approxSizeMb: 438,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
];

export const chunkingPresets: readonly ChunkingPreset[] = [
  { id: "precise", name: "Precise", description: "Smaller chunks, lower overlap, more targeted results.", chunkTokens: 260, overlapTokens: 40 },
  { id: "balanced", name: "Balanced", description: "Default search quality and indexing speed.", chunkTokens: 420, overlapTokens: 70 },
  { id: "contextual", name: "Contextual", description: "Larger chunks and higher overlap for broader context.", chunkTokens: 640, overlapTokens: 120 },
];

/**
 * Bumping this invalidates every stored chunk, because it is both part of the chunk id and a
 * predicate in every query — so each document silently re-indexes on next open.
 *
 * Phase 1 deliberately leaves it at 1. The chunking algorithm is unchanged by the move into
 * core, so an existing index stays valid and no user pays for a reindex they gain nothing
 * from. Phase 2 raises it to 2 when structure-aware chunking actually changes the output.
 */
export const semanticChunkingVersion = 1;

/**
 * Recorded on `documents`; diagnostic only.
 *
 * Phase 1 does not change extraction — page text still reaches the index through the same path
 * the sql.js build used — so this stays at the value legacy rows already carry. Phase 2 raises
 * it when extraction actually moves to structured Markdown.
 */
export const TEXT_EXTRACTION_VERSION = 1;

/** Recorded on `documents`; diagnostic only. Unchanged from the legacy pipeline. */
export const OCR_EXTRACTION_VERSION = 1;

export const modelVersion = "hf-transformers-js";

export const defaultSemanticScoreThreshold = 0.3;
export const defaultSemanticTopK = 12;

export const semanticScoreThresholdPresets: readonly SemanticScoreThresholdPreset[] = [
  { id: "loose", name: "Loose", description: "Shows broader, weaker related passages.", value: 0.24 },
  { id: "balanced", name: "Balanced", description: "Default cutoff for related passages.", value: defaultSemanticScoreThreshold },
  { id: "strict", name: "Strict", description: "Shows fewer, stronger matches.", value: 0.36 },
];

export function getCuratedEmbeddingModel(modelId: string): CuratedEmbeddingModel {
  const found = curatedEmbeddingModels.find((model) => model.id === modelId);
  if (found !== undefined) return found;
  const fallback = curatedEmbeddingModels[0];
  if (fallback === undefined) throw new Error("No curated embedding models are configured.");
  return fallback;
}

export function getChunkingPreset(profile: SemanticChunkingProfile): ChunkingPreset {
  const found = chunkingPresets.find((preset) => preset.id === profile);
  if (found !== undefined) return found;
  const fallback = chunkingPresets[1];
  if (fallback === undefined) throw new Error("No chunking presets are configured.");
  return fallback;
}
