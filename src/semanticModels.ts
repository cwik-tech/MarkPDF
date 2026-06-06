import type { SemanticChunkingProfile } from "./global";

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

export const recommendedEmbeddingModelId = "BAAI/bge-small-en-v1.5";

export const curatedEmbeddingModels: CuratedEmbeddingModel[] = [
  {
    id: "BAAI/bge-small-en-v1.5",
    name: "BGE Small EN v1.5",
    description: "Recommended balance for local PDF semantic search.",
    dimensions: 384,
    approxSizeMb: 133,
    badge: "Recommended",
    queryPrefix: "Represent this sentence for searching relevant passages: "
  },
  {
    id: "sentence-transformers/all-MiniLM-L6-v2",
    name: "MiniLM L6 v2",
    description: "Smaller and faster, with lighter retrieval quality.",
    dimensions: 384,
    approxSizeMb: 90
  },
  {
    id: "BAAI/bge-base-en-v1.5",
    name: "BGE Base EN v1.5",
    description: "Higher quality, slower indexing, and larger storage.",
    dimensions: 768,
    approxSizeMb: 438,
    queryPrefix: "Represent this sentence for searching relevant passages: "
  }
];

export const chunkingPresets: ChunkingPreset[] = [
  {
    id: "precise",
    name: "Precise",
    description: "Smaller chunks, lower overlap, more targeted results.",
    chunkTokens: 260,
    overlapTokens: 40
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Default search quality and indexing speed.",
    chunkTokens: 420,
    overlapTokens: 70
  },
  {
    id: "contextual",
    name: "Contextual",
    description: "Larger chunks and higher overlap for broader context.",
    chunkTokens: 640,
    overlapTokens: 120
  }
];

export const semanticChunkingVersion = 1;

export function getCuratedEmbeddingModel(modelId: string) {
  return curatedEmbeddingModels.find((model) => model.id === modelId) ?? curatedEmbeddingModels[0];
}

export function getChunkingPreset(profile: SemanticChunkingProfile) {
  return chunkingPresets.find((preset) => preset.id === profile) ?? chunkingPresets[1];
}
