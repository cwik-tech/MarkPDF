import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReportPdf, PAGE_TWO_HEADING } from "./fixtures.test-support.js";
import { jsonOf, runCli } from "./runCli.test-support.js";

/**
 * The command line exit criterion: grant a folder, index a report in it, notice the second run
 * reuses the index, and get back the page that actually answers a question.
 *
 * Everything below the process boundary is real — a real PDF, the real extractor, a real SQLite
 * file, a real allowlist on disk. Only the embedding model is replaced, because the default
 * suite must stay offline, and the substitution is what `--min-score` below accounts for.
 */

let dataDir: string;
let libraryDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-data-")));
  // Realpathed: an ordinary path under someone's home already is, and the index records the
  // path it actually read, so this is the spelling the lookup will be asked about.
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-library-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(libraryDir, { recursive: true, force: true });
});

describe("the command line journey", () => {
  it("grants a folder, indexes a report, reuses that index, and answers a search with the page holding the answer", async () => {
    const granted = await runCli(["--allow-read", libraryDir, "--json"], { dataDir });
    expect(granted.code).toBe(0);

    const first = await runCli(["index", fixture, "--json"], { dataDir });
    expect(first.code).toBe(0);
    const indexed = jsonOf(first) as {
      command: string;
      documents: Array<{ path: string; contentHash: string; status: string; pageCount: number; chunkCount: number }>;
      failures: unknown[];
    };
    expect(indexed.command).toBe("index");
    expect(indexed.failures).toEqual([]);
    expect(indexed.documents).toHaveLength(1);
    expect(indexed.documents[0]?.status).toBe("ready");
    expect(indexed.documents[0]?.pageCount).toBe(3);
    expect(indexed.documents[0]?.chunkCount).toBeGreaterThan(0);
    expect(indexed.documents[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Results on stdout, progress on stderr. A pipeline reading stdout must see JSON and only
    // JSON, which `jsonOf` above already proved, so the remaining claim is that progress exists
    // and went to the other stream.
    expect(first.stderr.trim().length).toBeGreaterThan(0);

    const second = await runCli(["index", fixture, "--json"], { dataDir });
    expect(second.code).toBe(0);
    const reused = jsonOf(second) as { documents: Array<{ contentHash: string; status: string }> };
    expect(reused.documents[0]?.status).toBe("reused");
    expect(reused.documents[0]?.contentHash).toBe(indexed.documents[0]?.contentHash);

    // Written down before the extractor ran: the table is on page 2 and page 3 carries a decoy
    // naming page 2 in prose. `--min-score` is set because the default 0.3 is calibrated for the
    // real model, and the offline substitute scores on shared vocabulary alone.
    const found = await runCli(["search", "Enterprise 1204 1318", "--path", fixture, "--min-score", "0.1", "--json"], {
      dataDir,
    });
    expect(found.code).toBe(0);
    const search = jsonOf(found) as {
      command: string;
      contentHash: string;
      readFromDisk: boolean;
      results: Array<{ page: number; score: number; snippet: string; headingPath: string[] }>;
    };
    expect(search.command).toBe("search");
    // Already indexed, so the answer came from the database and the file was never opened.
    expect(search.readFromDisk).toBe(false);
    expect(search.contentHash).toBe(indexed.documents[0]?.contentHash);
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]?.page).toBe(2);
    expect(search.results[0]?.headingPath).toContain(PAGE_TWO_HEADING);
    // The decoy must not outrank the page that holds the figures.
    const decoy = search.results.findIndex((hit) => hit.page === 3);
    expect(decoy === -1 || decoy > 0).toBe(true);
  }, 180_000);

  it("reports an empty result as an answer rather than a failure", async () => {
    await runCli(["--allow-read", libraryDir], { dataDir });
    await runCli(["index", fixture], { dataDir });

    const found = await runCli(["search", "xylophone quarantine bicycle", "--path", fixture, "--json"], { dataDir });

    expect(found.code).toBe(0);
    expect((jsonOf(found) as { results: unknown[] }).results).toEqual([]);
  }, 180_000);
});
