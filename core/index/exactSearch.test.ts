import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import type { Embedder } from "./embeddings.js";
import { indexDocument } from "./indexDocument.js";
import { expectIndexed } from "./indexResult.test-support.js";
import { searchDocument } from "./search.js";

/**
 * Searching one document by exact words, through the core search function.
 *
 * The document is indexed through the real pipeline with the bag-of-words test embedder. Pages 1
 * and 2 carry the same words in a different order, so only a phrase match can choose page 1.
 */

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder(384);

async function indexLease(): Promise<string> {
  const pages = [
    { page: 1, text: "Clause 4.2(b) governs the renewal of the lease", source: "pdf" as const },
    { page: 2, text: "Clause 2.4(b) governs the renewal of the lease", source: "pdf" as const },
    { page: 3, text: "Schedule of fees for parking and storage", source: "pdf" as const },
  ];
  const result = expectIndexed(
    await indexDocument(store, embedder, {
      bytes: new TextEncoder().encode("lease"),
      name: "lease.pdf",
      filePath: "/library/lease.pdf",
      pageCount: 3,
      chunkingProfile: "balanced",
      pages,
    }),
  );
  return result.contentHash;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-exact-search-"));
  store = openSemanticStore({ dataDir });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("searching one document by exact words", () => {
  it("returns only the page with the phrase", async () => {
    const contentHash = await indexLease();

    const results = await searchDocument(store, embedder, {
      contentHash, query: "clause 4.2(b)", chunkingProfile: "balanced", mode: "exact", minScore: 0,
    });

    expect(results.map((hit) => hit.page)).toEqual([1]);
    expect(results[0]?.matchedBy).toEqual(["exact"]);
    expect(results[0]?.semanticScore).toBeNull();
  });

  it("does not embed the query, so exact search never loads a model", async () => {
    const contentHash = await indexLease();
    const refusing: Embedder = {
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
      embed: async () => {
        throw new Error("exact mode embedded the query");
      },
    };

    const results = await searchDocument(store, refusing, {
      contentHash, query: "clause 4.2(b)", chunkingProfile: "balanced", mode: "exact", minScore: 0,
    });

    expect(results.map((hit) => hit.page)).toEqual([1]);
  });

  it("finds both pages by meaning, because they share their words", async () => {
    const contentHash = await indexLease();

    const results = await searchDocument(store, embedder, {
      contentHash, query: "clause 4.2(b)", chunkingProfile: "balanced", mode: "semantic", minScore: 0.5,
    });

    expect(results.map((hit) => hit.page).sort()).toEqual([1, 2]);
    expect(results.every((hit) => hit.matchedBy.length === 1 && hit.matchedBy[0] === "semantic")).toBe(true);
    expect(results.every((hit) => hit.semanticScore === hit.score)).toBe(true);
  });
});
