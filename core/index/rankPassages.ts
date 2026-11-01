import { initialSearchCandidateDepth, searchCandidateDepthMax } from "../models.js";
import type { ChunkScopeContract, HeadingEntry, SemanticStore } from "../store/index.js";
import { capPerDocument, fuseRankings, type FusedCandidate } from "./fusion.js";
import type { SearchPlan } from "./searchMode.js";

/**
 * Rank passages across a set of documents, in the mode a plan chose.
 *
 * Shared by single-document and library search, so the two cannot rank differently. Synchronous:
 * a caller that needs one consistent view runs it inside `store.readSnapshot`, and the query
 * embedding — the one slow, asynchronous step — happens before that.
 */
export interface PassageRankRequest {
  documentIds: readonly number[];
  scope: ChunkScopeContract;
  plan: SearchPlan;
  /** Required unless the plan is exact. */
  queryVector: Float32Array | null;
  topK: number;
  /** `null` for no cap, as in a single-document search. */
  perDocumentCap: number | null;
}

export interface RankedPassage extends FusedCandidate {
  page: number;
  text: string;
  headings: HeadingEntry[];
}

export interface RankedPassages {
  passages: RankedPassage[];
  /** True when a ranking still filled the deepest read and the answer stayed short. */
  candidatesTruncated: boolean;
}

export function rankPassages(store: SemanticStore, request: PassageRankRequest): RankedPassages {
  const { plan } = request;
  const useSemantic = plan.mode !== "exact" && request.queryVector !== null;
  const useExact = plan.mode !== "semantic" && plan.exactExpression !== null;

  let depth = initialSearchCandidateDepth(request.topK);
  let chosen: FusedCandidate[] = [];
  let candidatesTruncated = false;
  for (;;) {
    const semantic = useSemantic && request.queryVector !== null
      ? store.rankSemantic({ scope: request.scope, documentIds: request.documentIds, queryVector: request.queryVector, depth, minScore: plan.minScore })
      : [];
    const exact = useExact && plan.exactExpression !== null
      ? store.rankExact({ scope: request.scope, documentIds: request.documentIds, match: plan.exactExpression, depth })
      : [];
    chosen = capPerDocument(fuseRankings(plan.mode, semantic, exact), request.perDocumentCap).slice(0, request.topK);

    const filled = semantic.length >= depth || exact.length >= depth;
    if (chosen.length >= request.topK || !filled) break;
    if (depth >= searchCandidateDepthMax) {
      candidatesTruncated = true;
      break;
    }
    depth = Math.min(searchCandidateDepthMax, depth * 2);
  }

  const passages = new Map(store.readPassages(chosen.map((candidate) => candidate.id)).map((passage) => [passage.id, passage]));
  const ranked: RankedPassage[] = [];
  for (const candidate of chosen) {
    const passage = passages.get(candidate.id);
    // Inside a snapshot this cannot happen. Outside one, a chunk replaced since it was ranked is
    // left out rather than shown with somebody else's text.
    if (passage === undefined) continue;
    ranked.push({ ...candidate, page: passage.page, text: passage.text, headings: passage.headings });
  }
  return { passages: ranked, candidatesTruncated };
}
