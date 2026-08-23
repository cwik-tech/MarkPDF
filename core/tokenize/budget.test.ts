import { describe, expect, it } from "vitest";
import {
  BREADCRUMB_TOKEN_SHARE,
  breadcrumbTokenAllowance,
  embeddingTokenBudget,
  countingMode,
  distinctTokenizerHashes,
  curatedTokenizers,
  SPECIAL_TOKEN_ALLOWANCE,
} from "./budget.js";

/**
 * The recorded tokenizer measurements and the budget derived from them.
 *
 * Every number here was measured against the artifacts in `assets/tokenizers/`, not recalled
 * from a model card. The catalogue records what was measured and when; these tests are what
 * stops the two drifting apart.
 */

describe("the recorded tokenizer catalogue", () => {
  it("covers every curated embedding model", async () => {
    const { curatedEmbeddingModels } = await import("../models.js");
    expect(curatedTokenizers.map((entry) => entry.modelId).sort()).toEqual(
      curatedEmbeddingModels.map((model) => model.id).sort(),
    );
  });

  it("records a measured maximum sequence length for each", () => {
    for (const entry of curatedTokenizers) {
      expect(Number.isInteger(entry.modelMaxLength)).toBe(true);
      expect(entry.modelMaxLength).toBeGreaterThan(0);
    }
  });

  it("records a full sha256 for each model's bundled tokenizer", () => {
    for (const entry of curatedTokenizers) {
      expect(entry.tokenizerHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("choosing how tokens are counted", () => {
  it("uses worst-case measurement, because the curated tokenizers are not all the same file", () => {
    // Measured: bge-small and bge-base share one `tokenizer.json`; all-MiniLM-L6-v2 has its own.
    // Equal `model_max_length` across all three does not make them interchangeable — the same
    // string can cost a different number of tokens under a different tokenizer — so a candidate
    // chunk has to fit the worst of them.
    expect(countingMode()).toBe("worst-case");
  });

  it("measures against each distinct tokenizer once, not once per model", () => {
    // Three models, two distinct files. Counting three times would be a third more work for
    // exactly the same answer.
    expect(distinctTokenizerHashes()).toHaveLength(2);
  });
});

describe("the embedding input budget", () => {
  it("takes the smallest recorded limit when the catalogue's limits differ", () => {
    // Every model in today's catalogue reports 512, so smallest and largest coincide and the
    // rule cannot be observed against it. Stated against limits that differ, so adding a model
    // with a shorter context cannot quietly widen the budget for everything else.
    const mixed = [
      { modelId: "a", tokenizerHash: "a".repeat(64), modelMaxLength: 512 },
      { modelId: "b", tokenizerHash: "b".repeat(64), modelMaxLength: 256 },
      { modelId: "c", tokenizerHash: "c".repeat(64), modelMaxLength: 1024 },
    ];
    expect(embeddingTokenBudget(mixed)).toBe(256 - SPECIAL_TOKEN_ALLOWANCE);
  });

  it("treats a catalogue whose hashes all match as canonical", () => {
    const same = [
      { modelId: "a", tokenizerHash: "a".repeat(64), modelMaxLength: 512 },
      { modelId: "b", tokenizerHash: "a".repeat(64), modelMaxLength: 512 },
    ];
    expect(countingMode(same)).toBe("canonical");
    expect(distinctTokenizerHashes(same)).toHaveLength(1);
  });

  it("is the smallest recorded limit, less room for the tokenizer's own special tokens", () => {
    const smallest = Math.min(...curatedTokenizers.map((entry) => entry.modelMaxLength));
    expect(embeddingTokenBudget()).toBe(smallest - SPECIAL_TOKEN_ALLOWANCE);
  });

  it("leaves the breadcrumb at most a fixed share, floored to whole tokens", () => {
    expect(BREADCRUMB_TOKEN_SHARE).toBe(0.15);
    expect(breadcrumbTokenAllowance(100)).toBe(15);
    expect(breadcrumbTokenAllowance(510)).toBe(Math.floor(510 * 0.15));
  });

  it("never lets the breadcrumb take the whole budget, however small the budget is", () => {
    for (const budget of [1, 2, 10]) {
      expect(breadcrumbTokenAllowance(budget)).toBeLessThan(budget);
    }
  });
});
