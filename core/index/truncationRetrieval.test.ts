import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { indexDocument } from "./indexDocument.js";
import { searchDocument } from "./search.js";
import { createTruncatingEmbedder } from "./truncatingEmbedder.js";
import { loadCuratedTokenCounter } from "../tokenize/tokenizers.js";
import { budgetForProfile } from "./structuredChunking.js";
import { expectIndexed } from "./indexResult.test-support.js";

/**
 * The proof that windowing an oversized table actually keeps its tail findable.
 *
 * Run against an embedder that truncates, because the default deterministic one does not: it
 * hashes whatever string it is handed and would return an equally confident vector for an input
 * the real pipeline had silently cut in half. Against it, "the answer is in the last row and the
 * search finds it" passes whether or not the chunker respected the budget — which is no proof at
 * all. Against a truncating embedder it means exactly what it says.
 */

let dataDir: string;
let store: SemanticStore;

/** The answer, and it appears nowhere but the final row of a long table. */
const ANSWER_SEGMENT = "Antarctic";
const ANSWER_VALUE = "9317";

/** Long enough that no budget can hold it whole, so the tail is only reachable by windowing. */
function buildLongTable(): string {
  const rows = Array.from(
    { length: 200 },
    (_unused, index) => `|Region${index}|${index * 13}|${index * 17}|`,
  );
  return [
    "|Segment|Revenue 2025|Revenue 2026|",
    "|---|---|---|",
    ...rows,
    `|${ANSWER_SEGMENT}|${ANSWER_VALUE}|9420|`,
  ].join("\n");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-truncation-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("an oversized table's final row", () => {
  it("is embedded, not truncated away, and the search returns it", async () => {
    const counter = await loadCuratedTokenCounter();
    const count = (text: string) => counter.count(text);
    const budget = budgetForProfile("balanced");
    // The stand-in cuts at the **chunking target**, which is deliberately stricter than where the
    // installed models actually truncate (`model_max_length` less the special-token pair). The
    // target is what the chunker promises, so enforcing it here proves the promise; it is not a
    // claim about the model's own threshold.
    const embedder = createTruncatingEmbedder({ limit: budget, count, dimensions: 384 });

    const indexed = expectIndexed(
      await indexDocument(store, embedder, {
        bytes: new TextEncoder().encode("a long table"),
        name: "regions.pdf",
        filePath: null,
        pageCount: 1,
        chunkingProfile: "balanced",
        pages: [{ page: 1, text: `## Revenue by Region\n\n${buildLongTable()}`, source: "pdf" }],
      }),
    );
    expect(indexed.chunkCount).toBeGreaterThan(1);

    // Nothing was cut: every chunk the chunker produced fitted the budget it was embedded with.
    expect(embedder.truncations).toEqual([]);

    const hits = await searchDocument(store, embedder, {
      contentHash: indexed.contentHash,
      // Only the answer row carries this word. Including "revenue" would let the section
      // heading win on a term it shares, which would prove nothing about the table's tail.
      query: ANSWER_SEGMENT,
      chunkingProfile: "balanced",
      minScore: 0,
    });

    // Retrieved, not merely stored: the final row's chunk comes back through the public search
    // path with a real score. Under an atomic oversized table it would have been cut off before
    // it ever reached a vector, so nothing here could match it.
    const answer = hits.find((hit) => hit.snippet.includes(ANSWER_SEGMENT));
    expect(answer).toBeDefined();
    expect(answer?.score).toBeGreaterThan(0);
    expect(answer?.snippet).toContain(ANSWER_VALUE);
    expect(answer?.page).toBe(1);
  }, 120_000);

  it("returns that row as plain text a highlight can match against the page", async () => {
    // The snippet is matched against pdf.js's reading of the page. Pipes, dividers and the
    // repeated header appear nowhere in that reading, so a snippet carrying any of them matches
    // nothing and the yellow highlight silently disappears.
    const counter = await loadCuratedTokenCounter();
    const count = (text: string) => counter.count(text);
    const embedder = createTruncatingEmbedder({ limit: budgetForProfile("balanced"), count, dimensions: 384 });

    const indexed = expectIndexed(
      await indexDocument(store, embedder, {
        bytes: new TextEncoder().encode("a long table"),
        name: "regions.pdf",
        filePath: null,
        pageCount: 1,
        chunkingProfile: "balanced",
        pages: [{ page: 1, text: `## Revenue by Region\n\n${buildLongTable()}`, source: "pdf" }],
      }),
    );

    const hits = await searchDocument(store, embedder, {
      contentHash: indexed.contentHash,
      query: ANSWER_SEGMENT,
      chunkingProfile: "balanced",
      minScore: 0,
    });
    const answer = hits.find((hit) => hit.snippet.includes(ANSWER_SEGMENT));

    expect(answer?.snippet).not.toContain("|");
    expect(answer?.snippet).not.toContain("---");
    expect(answer?.snippet).not.toContain("Segment Revenue 2025 Revenue 2026");
    // Contiguous: the row reads as the words a text layer would show, in order.
    expect(answer?.snippet).toContain(`${ANSWER_SEGMENT} ${ANSWER_VALUE} 9420`);
  }, 120_000);
});
