import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { agentDiscovery } from "../consent/discovery.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { indexDocument } from "./indexDocument.js";
import { expectIndexed } from "./indexResult.test-support.js";
import { searchLibrary } from "./librarySearch.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../models.js";

/**
 * Which documents a library search may discover, and how it ranks across them.
 *
 * Documents are indexed through the real pipeline. Their recorded paths need not exist: discovery is
 * decided from what the index recorded, without touching the filesystem, and a path that is not there
 * is the plainest proof of that.
 */

const embedder = createDeterministicEmbedder(384);
let dataDir: string;
let root: string;
let elsewhere: string;
let store: SemanticStore;
let now = Date.parse("2026-10-01T00:00:00.000Z");

async function index(options: {
  bytes: string;
  filePath: string | null;
  pathProvenance?: "resolved";
  pages: readonly string[];
}): Promise<string> {
  now += 60_000;
  const result = expectIndexed(
    await indexDocument(store, embedder, {
      bytes: new TextEncoder().encode(options.bytes),
      name: options.filePath === null ? "untitled.pdf" : options.filePath.split("/").pop() ?? "x.pdf",
      filePath: options.filePath,
      ...(options.pathProvenance === undefined ? {} : { pathProvenance: options.pathProvenance }),
      pageCount: options.pages.length,
      chunkingProfile: "balanced",
      pages: options.pages.map((text, position) => ({ page: position + 1, text, source: "pdf" as const })),
      // The text the chunks were built from, as real indexing stores it, so the scope is claimed complete.
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: options.pages.map((markdown, position) => ({ page: position + 1, markdown })),
      },
    }),
  );
  return result.contentHash;
}

function search(query: string, discover = agentDiscovery({ readRoots: [root], writeRoots: [] }), topK = 12) {
  return searchLibrary(store, embedder, { query, chunkingProfile: "balanced", mode: "hybrid", minScore: 0.1, topK, discover });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-library-core-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-library-root-")));
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-library-elsewhere-")));
  store = openSemanticStore({ dataDir, clock: () => new Date(now) });
});

afterEach(() => {
  store.close();
  for (const directory of [dataDir, root, elsewhere]) rmSync(directory, { recursive: true, force: true });
});

describe("what an agent's library search may discover", () => {
  it("searches the latest version recorded at a path, before it applies the grant", async () => {
    const path = join(root, "plan.pdf");
    await index({ bytes: "old", filePath: path, pathProvenance: "resolved", pages: ["Mooring fees, version alpha."] });
    const current = await index({ bytes: "new", filePath: path, pathProvenance: "resolved", pages: ["Mooring fees, version beta."] });

    const found = await search("mooring fees");

    expect(found.documentsSearched).toBe(1);
    expect(found.documentsNotDiscoverable).toBe(0);
    expect(found.hits.map((hit) => hit.contentHash)).toEqual([current]);
  });

  it("does not bring back an older version when the latest one is outside the grant", async () => {
    const path = join(root, "plan.pdf");
    await index({ bytes: "old", filePath: path, pathProvenance: "resolved", pages: ["Mooring fees, version alpha."] });
    // The same path, written again by the app: its path was never resolved, so it is not discoverable.
    await index({ bytes: "new", filePath: path, pages: ["Mooring fees, version beta."] });

    const found = await search("mooring fees");

    expect(found.hits).toEqual([]);
    expect(found.documentsNotDiscoverable).toBe(1);
  });

  it("discovers only documents whose path MarkPDF resolved when it read them", async () => {
    await index({ bytes: "resolved", filePath: join(root, "a.pdf"), pathProvenance: "resolved", pages: ["Ballast water rules."] });
    await index({ bytes: "unresolved", filePath: join(root, "b.pdf"), pages: ["Ballast water rules again."] });

    const found = await search("ballast water");

    expect(found.hits.map((hit) => hit.name)).toEqual(["a.pdf"]);
    expect(found.documentsNotDiscoverable).toBe(1);
  });

  it("never discovers a document without a recorded path", async () => {
    await index({ bytes: "pathless", filePath: null, pages: ["Ballast water rules."] });

    const found = await search("ballast water");

    expect(found.hits).toEqual([]);
    expect(found.documentsNotDiscoverable).toBe(1);
  });

  it("decides from the recorded path alone, even after a folder in it became a link elsewhere", async () => {
    // Indexed while `sub` was a real folder inside the grant. It is then replaced by a link to a folder
    // outside the grant. Resolving the path now would say "outside"; the index's copy came from inside.
    const sub = join(root, "sub");
    mkdirSync(sub);
    await index({ bytes: "linked", filePath: join(sub, "minutes.pdf"), pathProvenance: "resolved", pages: ["Pilotage minutes."] });
    rmSync(sub, { recursive: true });
    symlinkSync(elsewhere, sub);

    const found = await search("pilotage minutes");

    expect(found.hits.map((hit) => hit.name)).toEqual(["minutes.pdf"]);
  });

  it("lets the app search every indexed document, whatever the grants", async () => {
    await index({ bytes: "pathless", filePath: null, pages: ["Ballast water rules."] });

    const found = await search("ballast water", () => true);

    expect(found.hits.length).toBe(1);
    expect(found.documentsNotDiscoverable).toBe(0);
  });
});

describe("ranking across the library", () => {
  it("takes at most three passages from one document, and fills the answer from the others", async () => {
    await index({
      bytes: "long",
      filePath: join(root, "long.pdf"),
      pathProvenance: "resolved",
      pages: Array.from({ length: 8 }, (_unused, page) => `Anchorage dues schedule, section ${page + 1}.`),
    });
    await index({ bytes: "short", filePath: join(root, "short.pdf"), pathProvenance: "resolved", pages: ["Anchorage dues schedule summary."] });

    const found = await search("anchorage dues schedule", agentDiscovery({ readRoots: [root], writeRoots: [] }), 5);

    const perDocument = new Map<string, number>();
    for (const hit of found.hits) perDocument.set(hit.name, (perDocument.get(hit.name) ?? 0) + 1);
    expect(perDocument.get("long.pdf")).toBe(3);
    expect(perDocument.get("short.pdf")).toBe(1);
  });

  it("reads deeper when the cap leaves the answer short, and reaches a document below the first depth", async () => {
    // Sixty passages in one document fill the first depth of 50 for topK 2. The second document's one
    // passage is ranked below all of them, and the cap must still make room for it.
    await index({
      bytes: "dominant",
      filePath: join(root, "dominant.pdf"),
      pathProvenance: "resolved",
      pages: Array.from({ length: 60 }, (_unused, page) => `Tug assistance tariff tariff tariff ${page}.`),
    });
    await index({ bytes: "minor", filePath: join(root, "minor.pdf"), pathProvenance: "resolved", pages: ["A note mentioning tug assistance tariff once, among many unrelated words about weather and tides."] });

    const found = await search("tug assistance tariff", agentDiscovery({ readRoots: [root], writeRoots: [] }), 4);

    expect(found.hits.map((hit) => hit.name)).toContain("minor.pdf");
    expect(found.candidatesTruncated).toBe(false);
  });

  it("reports each hit's document, its scope's completion time, and the mode", async () => {
    const hash = await index({ bytes: "one", filePath: join(root, "one.pdf"), pathProvenance: "resolved", pages: ["Berth allocation rules."] });

    const found = await search("berth allocation");

    expect(found.mode).toBe("hybrid");
    expect(found.hits[0]).toMatchObject({ contentHash: hash, name: "one.pdf", path: join(root, "one.pdf"), page: 1 });
    expect(found.hits[0]?.snapshotRecordedAt).toEqual(expect.any(String));
  });
});
