import { OCR_CONTRACT_VERSION } from "./ocr/ocrContract.js";

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
 * Raised to 2 by Phase 2, which replaced word-window chunking with structure-aware chunking:
 * headings carried across page boundaries, tables kept in windows rather than cut mid-row, and a
 * measured token budget instead of a word count. The output genuinely changed, so every stored
 * chunk is invalidated — and re-indexed lazily, one document at a time, on next open.
 *
 * Raised to 3 by the OCR contract phase: a recognised table now reaches chunking as a table
 * rather than as a run of paragraph lines, so a scanned page's chunks are windowed by row with
 * the header as embedding context. Chunk output changed, so stored chunks are invalidated the
 * same lazy way.
 */
export const semanticChunkingVersion = 3;

/**
 * Recorded on `documents`; diagnostic only.
 *
 * Raised to 2 by Phase 2, which genuinely changed extraction: page text now comes from PDF
 * Inspector as structured Markdown read in the main process, not from pdf.js in the renderer.
 * A row carrying 1 was extracted the old way, which is what makes the column worth having.
 */
export const TEXT_EXTRACTION_VERSION = 2;

/**
 * Recorded on `documents`; diagnostic only.
 *
 * Raised to 2 by the OCR contract phase, which made recognition versioned and geometry-carrying:
 * one contract module names the index and overlay profiles, and pages read under it are
 * reconstructed into tables when their word positions carry one. A row carrying 1 was read by
 * the unversioned configuration, which is what makes the column worth having.
 */
export const OCR_EXTRACTION_VERSION = OCR_CONTRACT_VERSION;

/**
 * Recorded when a caller did not say how the text was produced.
 *
 * Distinguishable from 1 (the legacy renderer path) and 2 (PDF Inspector), so a row that simply
 * does not know is not mistaken for a row that was read one particular way.
 */
export const UNKNOWN_EXTRACTION_VERSION = 0;

/** The engine whose Markdown the cache holds, and the shape of what it produces. */
export const MARKDOWN_ENGINE_ID = "pdf-inspector";
export const MARKDOWN_VERSION = 1;

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
