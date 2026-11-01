import { defaultSemanticTopK, libraryHitsPerDocument, type SearchMode, type SemanticChunkingProfile } from "../models.js";
import type { SemanticStore, StoredDocument } from "../store/index.js";
import type { Embedder } from "./embeddings.js";
import { completeExactIndex } from "./exactIndexBackfill.js";
import { rankPassages } from "./rankPassages.js";
import { activeChunkScopeContract, planFor, toSearchResult, type SemanticSearchResult } from "./search.js";

/**
 * Search every indexed document a caller may discover, in one ranked list.
 *
 * The query is embedded first, outside any transaction. Everything after that — which documents
 * exist, which a caller may discover, which have chunks under the active scope, both rankings, the
 * text of the hits, and when each document's scope was completed — is read in one snapshot, so the
 * answer describes one state of the index even while another process rebuilds a document.
 */
export interface LibrarySearchInput {
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  mode: SearchMode;
  /** The threshold for the ranking by meaning, already decided with `planSearch`. */
  minScore: number;
  topK?: number;
  /**
   * Which documents this caller may discover. Agents pass `agentDiscovery(allowlist)`; the app, which
   * is the person looking at their own index, passes `() => true`.
   */
  discover: (entry: StoredDocument) => boolean;
  signal?: AbortSignal;
  onExactIndexProgress?: (indexed: number) => void;
}

export interface LibrarySearchHit extends SemanticSearchResult {
  contentHash: string;
  name: string;
  path: string | null;
  /** When this document's search scope was last completed, or `null` for an incomplete one. */
  snapshotRecordedAt: string | null;
}

export interface LibrarySearchResult {
  mode: SearchMode;
  /** Documents that were discoverable and had chunks under the active scope. */
  documentsSearched: number;
  /** Documents left out because this caller may not discover them. A count, never a name. */
  documentsNotDiscoverable: number;
  /** Discoverable documents with nothing indexed under the active profile and model. */
  documentsOutsideActiveScope: number;
  /** True when the deepest candidate read still could not fill the answer. */
  candidatesTruncated: boolean;
  /** In rank order, best first. */
  hits: LibrarySearchHit[];
}

export async function searchLibrary(
  store: SemanticStore,
  embedder: Embedder,
  input: LibrarySearchInput,
): Promise<LibrarySearchResult> {
  const cancelled = (): boolean => input.signal?.aborted === true;
  const empty: LibrarySearchResult = {
    mode: input.mode,
    documentsSearched: 0,
    documentsNotDiscoverable: 0,
    documentsOutsideActiveScope: 0,
    candidatesTruncated: false,
    hits: [],
  };
  if (cancelled()) return empty;

  const query = input.query.trim();
  const plan = query.length === 0 ? null : planFor(input.mode, query, input.minScore);

  if (plan?.exactExpression != null && store.exactIndexState() !== "complete") {
    await completeExactIndex(store, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onExactIndexProgress === undefined ? {} : { onProgress: input.onExactIndexProgress }),
    });
    if (cancelled()) return empty;
  }

  const queryVector = plan === null || plan.mode === "exact" ? null : await embedder.embed(query, "query");
  if (cancelled()) return empty;

  const scope = activeChunkScopeContract(embedder, input.chunkingProfile);
  return store.readSnapshot((): LibrarySearchResult => {
    const documents = store.listLibraryDocuments();
    const discoverable = documents.filter(input.discover);
    const scoped = new Set(store.listScopedDocumentIds(scope, discoverable.map((entry) => entry.id)));
    const searched = discoverable.filter((entry) => scoped.has(entry.id));
    const counts = {
      mode: input.mode,
      documentsSearched: searched.length,
      documentsNotDiscoverable: documents.length - discoverable.length,
      documentsOutsideActiveScope: discoverable.length - searched.length,
    };
    if (plan === null || searched.length === 0) return { ...counts, candidatesTruncated: false, hits: [] };

    const ranked = rankPassages(store, {
      documentIds: searched.map((entry) => entry.id),
      scope,
      plan,
      queryVector,
      topK: input.topK ?? defaultSemanticTopK,
      perDocumentCap: libraryHitsPerDocument,
    });

    const byId = new Map(searched.map((entry) => [entry.id, entry]));
    const recordedAt = new Map<number, string | null>();
    const hits: LibrarySearchHit[] = [];
    for (const passage of ranked.passages) {
      const entry = byId.get(passage.documentId);
      if (entry === undefined) continue;
      if (!recordedAt.has(entry.id)) recordedAt.set(entry.id, store.chunksWrittenAt({ documentId: entry.id, ...scope }));
      hits.push({
        ...toSearchResult(passage),
        contentHash: entry.contentHash,
        name: entry.name,
        path: entry.filePath,
        snapshotRecordedAt: recordedAt.get(entry.id) ?? null,
      });
    }
    return { ...counts, candidatesTruncated: ranked.candidatesTruncated, hits };
  });
}
