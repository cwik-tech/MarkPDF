import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkPagesForIndex } from "./structuredChunking.js";
import { createTransformersEmbedder } from "./embeddings.js";
import { recommendedEmbeddingModelId } from "../models.js";
import { EXPECTED_PAGE_10_MARKDOWN } from "../ocr/recordedRecognition.test-support.js";

/**
 * Opt-in. Run with `npm run test:live`; excluded from `npm test`.
 *
 * WHY THE DEFAULT SUITE CANNOT CHECK THIS
 * ---------------------------------------
 * The default suite substitutes a deterministic bag-of-words embedder, and measured against it
 * a naturally phrased question about this table ranks the chart decoy first and the answer
 * fifth, whatever the pipeline does (that measurement is what fixed the fixture's own query to
 * carry the `Approved` disambiguator). Retrieval *quality* under natural language can therefore
 * only be checked against the real model, here.
 *
 * The question asks what was *approved*, because the document itself makes that the
 * distinction: the answer table is the approved one and the page-3 decoy is labelled
 * superseded. Measured against the real model, a shorter phrasing without that word — "Sales &
 * Marketing spend in 2028" — ranks the superseded decoy first, which is defensible of the model
 * and useless to a person asking about the approved plan. The page texts are the fixture's own
 * content — page 10 as the engine actually read it and the reconstruction actually rebuilt it —
 * so what this measures is the model's ranking of the shapes the pipeline really produces. It
 * requires network access on a cold model cache.
 */

describe("the real model ranking the pictured table for a naturally phrased question", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "markpdf-table-live-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("puts the reconstructed page-10 row above every decoy for 'what was approved for Sales & Marketing in 2028?'", async () => {
    const embedder = createTransformersEmbedder({ modelId: recommendedEmbeddingModelId, dataDir });

    // Use the same bundled token counter, profile budget, heading carry, and table windowing as
    // indexing. A character budget would create different chunks and test a pipeline we do not run.
    const chunks = await chunkPagesForIndex(
      "a".repeat(64),
      [
        {
          page: 3,
          markdown:
            "## Indicative spend (superseded)\n\n" +
            "| Line item | 2026 | 2027 | 2028 | 2029 |\n" +
            "| --- | --- | --- | --- | --- |\n" +
            "| Sales & Marketing | 4210 | 4600 | 4980 | 5700 |\n" +
            "| R&D | 2950 | 3180 | 3410 | 3660 |\n" +
            "| G&A | 1120 | 1190 | 1250 | 1320 |",
          source: "pdf",
        },
        {
          page: 4,
          markdown:
            "## Marketing\n\nMarketing owns demand generation across the plan horizon and reports " +
            "against the incentive schedule reproduced below for the current year.",
          source: "pdf",
        },
        {
          page: 5,
          markdown:
            "## Total Sales\n\nTotal Sales combines direct and channel revenue for the period across " +
            "every segment, and is reconciled to the statutory accounts each quarter.",
          source: "pdf",
        },
        {
          page: 9,
          markdown: "# Operating Plan\n\nThe approved figures for each function follow.",
          source: "pdf",
        },
        { page: 10, markdown: EXPECTED_PAGE_10_MARKDOWN, source: "ocr" },
        {
          page: 12,
          markdown:
            "Marketing spend trend\n\n" +
            "| Marketing | 2026 | 980 |\n" +
            "| --- | --- | --- |\n" +
            "| Marketing | 2027 | 1010 |\n" +
            "| Marketing | 2028 | 1140 |\n" +
            "| Marketing | 2029 | 1260 |",
          source: "ocr",
        },
      ],
      "balanced",
    );

    const dot = (a: Float32Array, b: Float32Array) => [...a].reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
    const query = await embedder.embed("what was approved for Sales & Marketing in 2028?", "query");
    const entries: Array<{ page: number; text: string; score: number }> = [];
    for (const chunk of chunks) {
      const vector = await embedder.embed(chunk.embedText, "passage");
      entries.push({ page: chunk.page, text: chunk.text, score: dot(query, vector) });
    }
    const ranked = entries.sort((a, b) => b.score - a.score);

    expect(ranked[0]?.page, "the best passage for the natural phrasing is the pictured table").toBe(10);
    expect(ranked[0]?.text).toContain("5170");
  }, 120_000);
});
