import { describe, expect, it } from "vitest";
import { planSearch } from "./searchMode.js";

/**
 * One rule for every surface: which mode runs, with which threshold, and which queries are refused.
 *
 * The command, the MCP server and the app each pass what the caller actually said. Deciding here is
 * what stops one surface accepting a threshold the others refuse, or two surfaces reading "no words"
 * differently.
 */

const SETTINGS_MIN_SCORE = 0.3;

describe("planning a search", () => {
  it("uses the threshold the caller gave, over the setting", () => {
    expect(planSearch({ mode: "semantic", query: "rent", explicitMinScore: 0.5, settingsMinScore: SETTINGS_MIN_SCORE })).toEqual({
      ok: true,
      plan: { mode: "semantic", minScore: 0.5, exactExpression: null },
    });
  });

  it("falls back to the setting when the caller gave no threshold", () => {
    const planned = planSearch({ mode: "hybrid", query: "rent", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE });
    expect(planned).toEqual({ ok: true, plan: { mode: "hybrid", minScore: SETTINGS_MIN_SCORE, exactExpression: `"rent"` } });
  });

  it("refuses an explicit threshold in exact mode, where nothing is scored by meaning", () => {
    const planned = planSearch({ mode: "exact", query: "rent", explicitMinScore: 0.5, settingsMinScore: SETTINGS_MIN_SCORE });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.message).toMatch(/no effect in exact mode/);
  });

  it("accepts exact mode when the threshold came only from the setting", () => {
    expect(planSearch({ mode: "exact", query: "rent", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE })).toEqual({
      ok: true,
      plan: { mode: "exact", minScore: SETTINGS_MIN_SCORE, exactExpression: `"rent"` },
    });
  });

  it("refuses an exact query with no words", () => {
    const planned = planSearch({ mode: "exact", query: "() --", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.message).toBe("The query has no words to match exactly.");
  });

  it("runs a hybrid query with no words by meaning only", () => {
    expect(planSearch({ mode: "hybrid", query: "() --", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE })).toEqual({
      ok: true,
      plan: { mode: "hybrid", minScore: SETTINGS_MIN_SCORE, exactExpression: null },
    });
  });

  it("refuses a control character in every mode that matches words", () => {
    for (const mode of ["exact", "hybrid"] as const) {
      const planned = planSearch({ mode, query: "rent\u0000due", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE });
      expect(planned.ok).toBe(false);
    }
  });

  it("does not build an exact expression in semantic mode", () => {
    const planned = planSearch({ mode: "semantic", query: "clause 4.2(b)", explicitMinScore: undefined, settingsMinScore: SETTINGS_MIN_SCORE });
    expect(planned.ok && planned.plan.exactExpression).toBeNull();
  });
});
