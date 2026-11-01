import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClausePdf } from "./fixtures.test-support.js";
import { jsonOf, runCli } from "./runCli.test-support.js";

/**
 * Exact-word search, on the command line, through the real stack.
 *
 * A real PDF, the real extractor, a real SQLite file and a real allowlist. Only the embedding model
 * is replaced, and the replacement is a bag of words, which is why the fixture puts the same words
 * on two pages: meaning alone cannot tell "4.2(b)" from "2.4(b)", and only the phrase can.
 */

let dataDir: string;
let libraryDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-exact-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-exact-library-")));
  fixture = join(libraryDir, "lease.pdf");
  writeFileSync(fixture, await buildClausePdf());
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(libraryDir, { recursive: true, force: true });
});

describe("searching one document for exact words", () => {
  it("returns the page that holds the exact clause and not the page with the same words in another order", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(0);
    expect((await runCli(["index", fixture], { dataDir })).code).toBe(0);

    const found = await runCli(["search", "clause 4.2(b)", "--path", fixture, "--mode", "exact", "--json"], { dataDir });

    expect(found.code).toBe(0);
    const search = jsonOf(found) as {
      mode: string;
      results: Array<{ page: number; matchedBy: string[]; semanticScore: number | null }>;
    };
    expect(search.mode).toBe("exact");
    expect(search.results.map((hit) => hit.page)).toEqual([1]);
    expect(search.results[0]?.matchedBy).toEqual(["exact"]);
    expect(search.results[0]?.semanticScore).toBeNull();
  }, 180_000);
});
