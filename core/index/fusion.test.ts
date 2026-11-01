import { describe, expect, it } from "vitest";
import { capPerDocument, fuseRankings, RRF_K } from "./fusion.js";

/**
 * Fusing a ranking by meaning with a ranking by exact words.
 *
 * Expected values are written by hand from the formula `1 / (60 + rank)`, rank starting at 1:
 * 1/61 = 0.016393…, 1/62 = 0.016129…, 1/63 = 0.015873….
 */

const semantic = [
  { id: "A", documentId: 1, score: 0.9 },
  { id: "B", documentId: 1, score: 0.8 },
  { id: "C", documentId: 2, score: 0.7 },
];
const exact = [
  { id: "C", documentId: 2, rank: -5 },
  { id: "D", documentId: 3, rank: -3 },
];

describe("reciprocal rank fusion", () => {
  it("uses the constant from the literature", () => {
    expect(RRF_K).toBe(60);
  });

  it("lifts a passage both rankings found above one that only one ranking put first", () => {
    const fused = fuseRankings("hybrid", semantic, exact);

    expect(fused.map((hit) => hit.id)).toEqual(["C", "A", "B", "D"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[0]?.matchedBy).toEqual(["semantic", "exact"]);
    expect(fused[0]?.semanticScore).toBe(0.7);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 12);
  });

  it("breaks an equal fused score by the passage the ranking by meaning found, then by id", () => {
    const fused = fuseRankings("hybrid", semantic, exact);
    // B (semantic rank 2) and D (exact rank 2) both earn 1/62. B has a cosine, D has none.
    expect(fused.slice(2).map((hit) => [hit.id, hit.semanticScore])).toEqual([["B", 0.8], ["D", null]]);

    const twins = fuseRankings("hybrid", [], [
      { id: "y", documentId: 1, rank: -1 },
      { id: "x", documentId: 1, rank: -1 },
    ]);
    // Positions come from the order given; equal positions do not occur, so the id breaks only true ties.
    expect(twins.map((hit) => hit.id)).toEqual(["y", "x"]);
  });

  it("keeps the order of the ranking by meaning when no passage has the exact words", () => {
    expect(fuseRankings("hybrid", semantic, []).map((hit) => hit.id)).toEqual(["A", "B", "C"]);
  });

  it("uses the cosine alone in semantic mode", () => {
    const fused = fuseRankings("semantic", semantic, exact);
    expect(fused.map((hit) => [hit.id, hit.score, hit.matchedBy])).toEqual([
      ["A", 0.9, ["semantic"]],
      ["B", 0.8, ["semantic"]],
      ["C", 0.7, ["semantic"]],
    ]);
  });

  it("uses bm25 alone in exact mode, turned so that higher is better", () => {
    const fused = fuseRankings("exact", semantic, exact);
    expect(fused.map((hit) => [hit.id, hit.score, hit.semanticScore])).toEqual([
      ["C", 5, null],
      ["D", 3, null],
    ]);
  });
});

describe("the per-document cap", () => {
  it("keeps at most the cap from one document, in the order given", () => {
    const fused = fuseRankings("semantic", [
      { id: "a1", documentId: 1, score: 0.9 },
      { id: "a2", documentId: 1, score: 0.8 },
      { id: "b1", documentId: 2, score: 0.7 },
      { id: "a3", documentId: 1, score: 0.6 },
    ], []);

    expect(capPerDocument(fused, 2).map((hit) => hit.id)).toEqual(["a1", "a2", "b1"]);
    expect(capPerDocument(fused, null).map((hit) => hit.id)).toEqual(["a1", "a2", "b1", "a3"]);
  });
});
