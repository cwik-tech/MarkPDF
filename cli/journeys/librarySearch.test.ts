import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTextPdf } from "./fixtures.test-support.js";
import { jsonOf, runCli } from "./runCli.test-support.js";

/**
 * Searching the whole library from the command line, through the real stack.
 *
 * Two granted folders, one document in each. The document in the first folder is then changed and
 * indexed again at the same path, which leaves its old version in the index. The second folder's
 * grant is then removed. A library search must answer from the current version of the first
 * document alone, and say that one indexed document was left out.
 */

const PHRASE = "harbour dredging schedule";

let dataDir: string;
let folderA: string;
let folderB: string;

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-library-data-")));
  folderA = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-library-a-")));
  folderB = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-library-b-")));
});

afterEach(() => {
  for (const directory of [dataDir, folderA, folderB]) rmSync(directory, { recursive: true, force: true });
});

describe("searching the library", () => {
  it("answers from the current version of each granted document and counts what it left out", async () => {
    const port = join(folderA, "port.pdf");
    const annex = join(folderB, "annex.pdf");
    writeFileSync(port, await buildTextPdf([`The ${PHRASE} for spring, version alpha.`]));
    writeFileSync(annex, await buildTextPdf([`The ${PHRASE} appears in the port annex.`]));
    expect((await runCli(["--allow-read", folderA, "--allow-read", folderB], { dataDir })).code).toBe(0);
    expect((await runCli(["index", port, annex], { dataDir })).code).toBe(0);

    // The file changes on disk and is indexed again: the index keeps the old version's row too.
    writeFileSync(port, await buildTextPdf([`The ${PHRASE} for autumn, version beta.`]));
    const reindexed = jsonOf(await runCli(["index", port, "--json"], { dataDir })) as { documents: Array<{ contentHash: string }> };
    const current = reindexed.documents[0]?.contentHash;
    expect(current).toMatch(/^[0-9a-f]{64}$/);

    expect((await runCli(["--revoke-read", folderB], { dataDir })).code).toBe(0);

    const found = await runCli(["search", PHRASE, "--library", "--json"], { dataDir });
    expect(found.code).toBe(0);
    const library = jsonOf(found) as {
      scope: string;
      mode: string;
      documentsSearched: number;
      documentsNotDiscoverable: number;
      results: Array<{ contentHash: string; name: string; path: string; page: number; matchedBy: string[] }>;
    };
    expect(library.scope).toBe("library");
    expect(library.mode).toBe("hybrid");
    expect(library.documentsSearched).toBe(1);
    expect(library.documentsNotDiscoverable).toBe(1);
    expect(library.results.length).toBeGreaterThan(0);
    expect(new Set(library.results.map((hit) => hit.contentHash))).toEqual(new Set([current]));
    expect(library.results[0]).toMatchObject({ name: "port.pdf", path: port, page: 1 });
    // The remedy goes to stderr, without naming the document it left out.
    expect(found.stderr).toMatch(/1 indexed document/);
    expect(found.stderr).not.toContain("annex");

    // The old version's own words are not searchable any more.
    const old = jsonOf(await runCli(["search", "alpha", "--library", "--mode", "exact", "--json"], { dataDir })) as { results: unknown[] };
    expect(old.results).toEqual([]);
  }, 240_000);
});
