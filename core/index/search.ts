import { defaultSemanticScoreThreshold, defaultSemanticTopK, getCuratedEmbeddingModel, modelVersion, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import type { SemanticStore } from "../store/index.js";
import type { Embedder } from "./embeddings.js";
import { createSnippet } from "./chunking.js";

export interface SemanticSearchResult {
  id: string;
  page: number;
  snippet: string;
  score: number;
  headingPath: string[];
}

export interface SearchInput {
  contentHash: string;
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  topK?: number;
  minScore?: number;
}

export async function searchDocument(
  store: SemanticStore,
  embedder: Embedder,
  input: SearchInput,
): Promise<SemanticSearchResult[]> {
  const query = input.query.trim();
  if (query.length === 0) return [];

  const stored = store.getDocument(input.contentHash);
  if (stored === null) return [];

  const model = getCuratedEmbeddingModel(embedder.modelId);
  const queryVector = await embedder.embed(query, "query");

  const hits = store.search(
    {
      documentId: stored.id,
      chunkingProfile: input.chunkingProfile,
      chunkingVersion: semanticChunkingVersion,
      modelId: model.id,
      modelVersion,
      dimensions: embedder.dimensions,
    },
    queryVector,
    input.topK ?? defaultSemanticTopK,
    input.minScore ?? defaultSemanticScoreThreshold,
  );

  return hits.map((hit) => ({ ...hit, snippet: createSnippet(hit.snippet) }));
}
