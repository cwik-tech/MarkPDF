import { defaultSemanticScoreThreshold, defaultSemanticTopK, getCuratedEmbeddingModel, modelVersion, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import type { HeadingEntry, SemanticStore } from "../store/index.js";
import type { Embedder } from "./embeddings.js";
import { createSnippet } from "./chunking.js";
import { toPlainText } from "./structuredChunking.js";

export interface SemanticSearchResult {
  id: string;
  page: number;
  snippet: string;
  score: number;
  /** Titles only — the shape every caller had before provenance existed. */
  headingPath: string[];
  /** The same breadcrumb with each heading's page, or `null` for rows that predate it. */
  headings: HeadingEntry[];
  /**
   * True when the passage's nearest heading stands on an earlier page, so a reader can tell a
   * heading the passage sits under from one it merely follows. Never true for rows whose pages
   * are unknown.
   */
  headingInherited: boolean;
}

export interface SearchInput {
  contentHash: string;
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  topK?: number;
  minScore?: number;
  /**
   * Stop, if somebody has.
   *
   * Embedding the query is not preemptible — the note in `core/index/embeddings.ts` says why — so
   * this is read before it starts and again the instant it returns. A cancel arriving during it
   * costs one wasted embedding and never a printed answer.
   */
  signal?: AbortSignal;
}

export async function searchDocument(
  store: SemanticStore,
  embedder: Embedder,
  input: SearchInput,
): Promise<SemanticSearchResult[]> {
  // Read through a call: after one direct `signal.aborted === true` check the compiler narrows
  // the property to `false` and every later check becomes provably dead code.
  const cancelled = (): boolean => input.signal?.aborted === true;
  if (cancelled()) return [];

  const query = input.query.trim();
  if (query.length === 0) return [];

  const stored = store.getDocument(input.contentHash);
  if (stored === null) return [];

  const model = getCuratedEmbeddingModel(embedder.modelId);
  const queryVector = await embedder.embed(query, "query");
  if (cancelled()) return [];

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
  return hits.map((hit) => {
    // The nearest heading decides whether the passage appears to claim one from an earlier
    // page. A heading whose page was never recorded claims nothing either way.
    const nearest = hit.headings.length > 0 ? hit.headings[hit.headings.length - 1] : undefined;
    const headingInherited = nearest !== undefined && nearest.page !== null && nearest.page !== hit.page;
    return { ...hit, snippet: createSnippet(toPlainText(hit.snippet)), headingInherited };
  });
}
