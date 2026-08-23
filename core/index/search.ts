import { defaultSemanticScoreThreshold, defaultSemanticTopK, getCuratedEmbeddingModel, modelVersion, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import type { SemanticStore } from "../store/index.js";
import type { Embedder } from "./embeddings.js";
import { createSnippet } from "./chunking.js";
import { toPlainText } from "./structuredChunking.js";

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

  // Plain text before trimming. The stored text is Markdown, and the snippet is matched against
  // pdf.js's reading of the page to place the highlight — where no pipe, hash or emphasis marker
  // appears. A snippet carrying them matches nothing and the highlight silently disappears.
  return hits.map((hit) => ({ ...hit, snippet: createSnippet(toPlainText(hit.snippet)) }));
}
