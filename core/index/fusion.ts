import type { SearchMode } from "../models.js";
import type { ExactCandidate, SemanticCandidate } from "../store/index.js";

/**
 * Reciprocal Rank Fusion, and the modes that use one ranking alone.
 *
 * `bm25` and cosine similarity are on unrelated scales — one is unbounded and depends on the corpus,
 * the other lies between -1 and 1 — so adding them would need a calibration nobody has. RRF uses
 * only positions: a chunk earns `1 / (k + rank)` from each ranking it appears in, rank starting at 1.
 * `k = 60` is the value from Cormack, Clarke and Büttcher (SIGIR 2009) and the common default.
 *
 * With one ranking empty, RRF keeps the other ranking's order, so a hybrid search for words that
 * occur nowhere returns exactly the semantic order.
 */
export const RRF_K = 60;

export type MatchSource = "semantic" | "exact";

export interface FusedCandidate {
  id: string;
  documentId: number;
  /** The value the list is ordered by: cosine, `-bm25`, or the RRF sum, by mode. */
  score: number;
  /** The cosine, when the ranking by meaning found this chunk. */
  semanticScore: number | null;
  matchedBy: MatchSource[];
}

function byId(a: FusedCandidate, b: FusedCandidate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function fuseRankings(
  mode: SearchMode,
  semantic: readonly SemanticCandidate[],
  exact: readonly ExactCandidate[],
): FusedCandidate[] {
  if (mode === "semantic") {
    return semantic.map((hit) => ({ id: hit.id, documentId: hit.documentId, score: hit.score, semanticScore: hit.score, matchedBy: ["semantic"] }));
  }
  if (mode === "exact") {
    return exact.map((hit) => ({ id: hit.id, documentId: hit.documentId, score: -hit.rank, semanticScore: null, matchedBy: ["exact"] }));
  }

  const fused = new Map<string, FusedCandidate>();
  for (const [position, hit] of semantic.entries()) {
    fused.set(hit.id, {
      id: hit.id,
      documentId: hit.documentId,
      score: 1 / (RRF_K + position + 1),
      semanticScore: hit.score,
      matchedBy: ["semantic"],
    });
  }
  for (const [position, hit] of exact.entries()) {
    const contribution = 1 / (RRF_K + position + 1);
    const known = fused.get(hit.id);
    if (known === undefined) {
      fused.set(hit.id, { id: hit.id, documentId: hit.documentId, score: contribution, semanticScore: null, matchedBy: ["exact"] });
    } else {
      fused.set(hit.id, { ...known, score: known.score + contribution, matchedBy: ["semantic", "exact"] });
    }
  }

  // Ties: a chunk both rankings found, then the better cosine, then the id — so the order is the
  // same on every run and does not depend on which ranking happened to be read first.
  return [...fused.values()].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const byAgreement = b.matchedBy.length - a.matchedBy.length;
    if (byAgreement !== 0) return byAgreement;
    if (a.semanticScore !== b.semanticScore) {
      if (a.semanticScore === null) return 1;
      if (b.semanticScore === null) return -1;
      return b.semanticScore - a.semanticScore;
    }
    return byId(a, b);
  });
}

/** At most `cap` passages from one document, in the order given. `null` means no cap. */
export function capPerDocument(candidates: readonly FusedCandidate[], cap: number | null): FusedCandidate[] {
  if (cap === null) return [...candidates];
  const taken = new Map<number, number>();
  const kept: FusedCandidate[] = [];
  for (const candidate of candidates) {
    const count = taken.get(candidate.documentId) ?? 0;
    if (count >= cap) continue;
    taken.set(candidate.documentId, count + 1);
    kept.push(candidate);
  }
  return kept;
}
