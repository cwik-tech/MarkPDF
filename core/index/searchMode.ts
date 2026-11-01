import type { SearchMode } from "../models.js";
import { buildExactMatch } from "./exactQuery.js";

/**
 * What one search will do, decided once for every surface.
 *
 * Each adapter passes what the caller actually said — in particular whether a threshold was given or
 * only came from the settings. Both adapters used to fold the setting in before core saw it, which is
 * exactly the distinction "a threshold has no effect in exact mode" needs.
 */
export interface SearchPlan {
  mode: SearchMode;
  /** Applied to the ranking by meaning only. Exact matches are never discarded by it. */
  minScore: number;
  /** The FTS5 expression, or `null` when this search ranks by meaning only. */
  exactExpression: string | null;
}

export interface SearchPlanInput {
  mode: SearchMode;
  query: string;
  explicitMinScore: number | undefined;
  settingsMinScore: number;
}

export type SearchPlanOutcome = { ok: true; plan: SearchPlan } | { ok: false; message: string };

export const NO_EXACT_WORDS = "The query has no words to match exactly.";
export const MIN_SCORE_IN_EXACT_MODE = "A minimum score applies to meaning only, so it has no effect in exact mode.";

export function planSearch(input: SearchPlanInput): SearchPlanOutcome {
  const minScore = input.explicitMinScore ?? input.settingsMinScore;
  if (input.mode === "semantic") return { ok: true, plan: { mode: "semantic", minScore, exactExpression: null } };

  if (input.mode === "exact" && input.explicitMinScore !== undefined) {
    return { ok: false, message: MIN_SCORE_IN_EXACT_MODE };
  }

  const built = buildExactMatch(input.query);
  if (built.status === "refused") return { ok: false, message: built.message };
  if (built.status === "no-words") {
    // Hybrid still has a ranking to run, so "no words" narrows it rather than refusing it. Exact has
    // nothing else, and an empty answer would read as "no passage contains these words".
    if (input.mode === "exact") return { ok: false, message: NO_EXACT_WORDS };
    return { ok: true, plan: { mode: "hybrid", minScore, exactExpression: null } };
  }
  return { ok: true, plan: { mode: input.mode, minScore, exactExpression: built.expression } };
}
