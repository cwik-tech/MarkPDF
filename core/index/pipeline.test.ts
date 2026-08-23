import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { indexDocument } from "./indexDocument.js";
import { searchDocument } from "./search.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { expectIndexed } from "./indexResult.test-support.js";

let dataDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder();

// A three-page document whose distinctive sentence lives only on page 3. The expected page is
// a literal derived from how the fixture is built, not from what the pipeline returns.
const PAGES = [
  { page: 1, text: "Introduction and preamble about general matters of no consequence.", source: "pdf" as const },
  { page: 2, text: "Background material describing prior work and unrelated context.", source: "pdf" as const },
  { page: 3, text: "The escape velocity of Deimos is roughly five point six metres per second.", source: "pdf" as const },
];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-pipeline-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("parse to index to search, with no Electron and no browser", () => {
  it("finds the passage and reports the page it came from", async () => {
    const bytes = new TextEncoder().encode("pretend pdf bytes");
    const indexed = await indexDocument(store, embedder, {
      bytes, name: "moons.pdf", filePath: "/tmp/moons.pdf",
      pages: PAGES, pageCount: 3, chunkingProfile: "balanced",
    });
    const stored = expectIndexed(indexed);
    expect(stored.status).toBe("ready");
    expect(stored.chunkCount).toBe(3);

    const hits = await searchDocument(store, embedder, {
      contentHash: stored.contentHash,
      query: "escape velocity of Deimos",
      chunkingProfile: "balanced",
      minScore: 0,
    });

    expect(hits.length).toBeGreaterThan(0);
    // Results are returned in reading order, which is what the results panel renders
    // (preserved from the renderer implementation). The retrieval claim is about rank, so
    // assert on the best-scoring hit rather than the first one listed.
    const best = [...hits].sort((a, b) => b.score - a.score)[0];
    expect(best?.page).toBe(3);
    expect(best?.snippet).toContain("Deimos");
    expect(hits.map((hit) => hit.page)).toEqual([...hits.map((hit) => hit.page)].sort((a, b) => a - b));
  });

  it("reuses an index that is already complete instead of embedding again", async () => {
    const bytes = new TextEncoder().encode("pretend pdf bytes");
    const input = {
      bytes, name: "moons.pdf", filePath: null,
      pages: PAGES, pageCount: 3, chunkingProfile: "balanced" as const,
    };
    await indexDocument(store, embedder, input);
    const second = await indexDocument(store, embedder, input);
    expect(second.status).toBe("reused");
  });

  it("survives a restart, because the index is a file rather than process memory", async () => {
    const bytes = new TextEncoder().encode("pretend pdf bytes");
    const indexed = await indexDocument(store, embedder, {
      bytes, name: "moons.pdf", filePath: null,
      pages: PAGES, pageCount: 3, chunkingProfile: "balanced",
    });
    const stored = expectIndexed(indexed);
    store.close();

    store = openSemanticStore({ dataDir });
    const hits = await searchDocument(store, embedder, {
      contentHash: stored.contentHash, query: "escape velocity of Deimos",
      chunkingProfile: "balanced", minScore: 0,
    });
    const best = [...hits].sort((a, b) => b.score - a.score)[0];
    expect(best?.page).toBe(3);
  });
});
