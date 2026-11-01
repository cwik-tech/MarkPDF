import { defaultSemanticScoreThreshold, defaultSemanticTopK, getCuratedEmbeddingModel, modelVersion, semanticChunkingVersion, type SearchMode, type SemanticChunkingProfile } from "../models.js";
import type { ChunkScope, ChunkScopeContract, HeadingEntry, SemanticStore } from "../store/index.js";
import type { Embedder } from "./embeddings.js";
import { createSnippet } from "./chunking.js";
import { buildExactMatch } from "./exactQuery.js";
import { completeExactIndex } from "./exactIndexBackfill.js";
import type { MatchSource } from "./fusion.js";
import { rankPassages, type RankedPassage } from "./rankPassages.js";
import type { SearchPlan } from "./searchMode.js";
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
  /** The cosine, when the ranking by meaning found this passage; `score` is the mode's own value. */
  semanticScore: number | null;
  /** Which rankings found this passage. */
  matchedBy: MatchSource[];
}

export interface SearchInput {
  contentHash: string;
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  topK?: number;
  /** The threshold for the ranking by meaning. An adapter decides it with `planSearch` first. */
  minScore?: number;
  /** `semantic` when absent, which is how every caller searched before modes existed. */
  mode?: SearchMode;
  /** Chunks added to the exact-word index, when this search had to finish its backfill first. */
  onExactIndexProgress?: (indexed: number) => void;
  /**
   * Stop, if somebody has.
   *
   * Embedding the query is not preemptible — the note in `core/index/embeddings.ts` says why — so
   * this is read before it starts and again the instant it returns. A cancel arriving during it
   * costs one wasted embedding and never a printed answer.
   */
  signal?: AbortSignal;
}

/**
 * The scope this build searches under, before a document is named.
 *
 * Separated from `searchChunkScope` because the reuse preflight has to ask about a scope while it
 * still only has the file's bytes — the document id is what the store looks up. Both callers read
 * the same five values from the same place, so a scope the index is written under cannot drift
 * from the one a search or a reuse check asks about.
 */
export function activeChunkScopeContract(
  embedder: Embedder,
  chunkingProfile: SemanticChunkingProfile,
): ChunkScopeContract {
  const model = getCuratedEmbeddingModel(embedder.modelId);
  return {
    chunkingProfile,
    chunkingVersion: semanticChunkingVersion,
    modelId: model.id,
    modelVersion,
    dimensions: embedder.dimensions,
  };
}

/** The exact persisted scope a search reads under. Shared with disclosure so the two cannot drift. */
export function searchChunkScope(
  documentId: number,
  embedder: Embedder,
  chunkingProfile: SemanticChunkingProfile,
): ChunkScope {
  return { documentId, ...activeChunkScopeContract(embedder, chunkingProfile) };
}

/**
 * The plan a search runs under, for a caller that has already validated what it was given.
 *
 * Adapters validate with `planSearch`, which knows whether a threshold was explicit. Here the
 * threshold is simply the one to use, and a query the exact ranking cannot read narrows a hybrid
 * search to meaning or makes an exact one empty.
 */
export function planFor(mode: SearchMode, query: string, minScore: number): SearchPlan | null {
  if (mode === "semantic") return { mode, minScore, exactExpression: null };
  const built = buildExactMatch(query);
  if (built.status === "ok") return { mode, minScore, exactExpression: built.expression };
  return mode === "hybrid" ? { mode, minScore, exactExpression: null } : null;
}

/**
 * A ranked passage as every surface returns it: plain-text snippet, breadcrumb, and scores.
 *
 * Plain text before trimming. The stored text is Markdown, and the snippet is matched against
 * pdf.js's reading of the page to place the highlight — where no pipe, hash or emphasis marker
 * appears. A snippet carrying them matches nothing and the highlight silently disappears.
 */
export function toSearchResult(passage: RankedPassage): SemanticSearchResult {
  // The nearest heading decides whether the passage appears to claim one from an earlier page. A
  // heading whose page was never recorded claims nothing either way.
  const nearest = passage.headings.length > 0 ? passage.headings[passage.headings.length - 1] : undefined;
  const headingInherited = nearest !== undefined && nearest.page !== null && nearest.page !== passage.page;
  return {
    id: passage.id,
    page: passage.page,
    snippet: createSnippet(toPlainText(passage.text)),
    score: passage.score,
    headingPath: passage.headings.map((heading) => heading.title),
    headings: passage.headings,
    headingInherited,
    semanticScore: passage.semanticScore,
    matchedBy: passage.matchedBy,
  };
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

  const plan = planFor(input.mode ?? "semantic", query, input.minScore ?? defaultSemanticScoreThreshold);
  if (plan === null) return [];

  // An index written before the exact-word index existed answers no exact query until its old chunks
  // are in it. A partial exact ranking would look complete, so the backfill finishes first.
  if (plan.exactExpression !== null && store.exactIndexState() !== "complete") {
    await completeExactIndex(store, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onExactIndexProgress === undefined ? {} : { onProgress: input.onExactIndexProgress }),
    });
    if (cancelled()) return [];
  }

  // Exact mode never embeds: it needs no model, and must not download one to answer a question
  // about words.
  const queryVector = plan.mode === "exact" ? null : await embedder.embed(query, "query");
  if (cancelled()) return [];

  const ranked = store.readSnapshot(() =>
    rankPassages(store, {
      documentIds: [stored.id],
      scope: activeChunkScopeContract(embedder, input.chunkingProfile),
      plan,
      queryVector,
      topK: input.topK ?? defaultSemanticTopK,
      perDocumentCap: null,
    }),
  );

  // Ranked first, then presented in reading order — the ordering the results panel relies on.
  return ranked.passages
    .map(toSearchResult)
    .sort((a, b) => a.page - b.page || b.score - a.score);
}
