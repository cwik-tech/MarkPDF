import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "./harness.test-support.js";
import { EXIT_CODE } from "./exit.js";
import { buildReportPdf, PAGE_TWO_HEADING } from "./journeys/fixtures.test-support.js";

/**
 * `outline` and `convert`, against the real extractor and a real PDF.
 *
 * The fixture's structure is written down in its builder: "Annual Report" heads page 1,
 * "Revenue by Segment" page 2, "Notes" page 3. **Which heading level each one gets is the
 * extractor's judgement, not this code's** — PDF Inspector infers depth from font statistics, and
 * measured against this fixture it reports the 20pt title and the 16pt section heading both as
 * level 1. So the assertions below fix the titles and pages, which the fixture controls, and
 * treat the level as a number to be carried faithfully rather than a value to be predicted.
 */

let dataDir: string;
let libraryDir: string;
let outDir: string;
let fixture: string;

const run = createRunner(() => dataDir);

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-commands-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-commands-library-")));
  outDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-commands-out-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});
afterEach(() => {
  for (const directory of [dataDir, libraryDir, outDir]) rmSync(directory, { recursive: true, force: true });
});

describe("outline", () => {
  it("lists the document's headings with the page each one sits on", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["outline", fixture, "--json"]);

    expect(result.code).toBe(EXIT_CODE.success);
    const report = JSON.parse(result.stdout) as { entries: Array<{ level: number; title: string; page: number }> };
    expect(report.entries.map((entry) => ({ title: entry.title, page: entry.page }))).toEqual([
      { title: "Annual Report", page: 1 },
      { title: PAGE_TWO_HEADING, page: 2 },
      { title: "Notes", page: 3 },
    ]);
    expect(report.entries.every((entry) => Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= 6)).toBe(true);
  }, 60_000);

  it("shows nothing deeper than the depth that was asked for", async () => {
    // The depth rule itself is proved against constructed headings in
    // `core/outline/documentOutline.test.ts`; here the claim is only that the option reaches it.
    await run(["--allow-read", libraryDir]);

    const result = await run(["outline", fixture, "--depth", "1", "--json"]);

    const report = JSON.parse(result.stdout) as { entries: Array<{ level: number }> };
    expect(report.entries.every((entry) => entry.level <= 1)).toBe(true);
  }, 60_000);

  it("refuses a document nobody granted", async () => {
    const result = await run(["outline", fixture]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
  });

  it("still answers from the index after the folder is no longer granted", async () => {
    // The same rule as search: an indexed document is answered from the index, so nothing on the
    // filesystem is touched and nothing needs permitting.
    await run(["--allow-read", libraryDir]);
    await run(["index", fixture]);
    await run(["--revoke-read", libraryDir]);

    const result = await run(["outline", fixture, "--json"]);

    expect(result.code).toBe(EXIT_CODE.success);
    const report = JSON.parse(result.stdout) as { readFromIndex: boolean; entries: unknown[] };
    expect(report.readFromIndex).toBe(true);
    expect(report.entries.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("convert", () => {
  it("writes the document's Markdown to stdout, announcing each page", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["convert", fixture]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(result.stdout).toContain("## Page 1");
    expect(result.stdout).toContain("## Page 2");
    expect(result.stdout).toContain(PAGE_TWO_HEADING);
  }, 60_000);

  it("leaves the page furniture out in clean mode", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["convert", fixture, "--mode", "clean"]);

    expect(result.stdout).not.toContain("## Page");
    expect(result.stdout).toContain(PAGE_TWO_HEADING);
  }, 60_000);

  it("converts only the pages that were asked for", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["convert", fixture, "--pages", "2", "--json"]);

    const report = JSON.parse(result.stdout) as { documents: Array<{ pages: number[]; pageCount: number }> };
    expect(report.documents[0]?.pages).toEqual([2]);
    expect(report.documents[0]?.pageCount).toBe(3);
  }, 60_000);

  it("refuses a page the document does not have, rather than quietly returning less", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["convert", fixture, "--pages", "9"]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stderr).toContain("has 3");
  }, 60_000);

  it("refuses a mistyped range before it opens anything", async () => {
    const result = await run(["convert", fixture, "--pages", "7-3"]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stderr).toContain("--pages");
  });

  it("does not treat permission to read as permission to write", async () => {
    // The asymmetry made concrete: the library is granted for reading, and writing a converted
    // copy into it is still refused.
    await run(["--allow-read", libraryDir]);

    const result = await run(["convert", fixture, "--out", join(libraryDir, "report.md")]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain("--allow-write");
    expect(existsSync(join(libraryDir, "report.md"))).toBe(false);
  }, 60_000);

  it("writes the file once writing has been granted", async () => {
    await run(["--allow-read", libraryDir, "--allow-write", outDir]);
    const out = join(outDir, "report.md");

    const result = await run(["convert", fixture, "--out", out, "--json"]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(readFileSync(out, "utf8")).toContain(PAGE_TWO_HEADING);
    const report = JSON.parse(result.stdout) as { documents: Array<{ out: string; markdown: string | null }> };
    expect(report.documents[0]?.out).toBe(out);
    // Already on disk; repeating a whole document in the report would tell the caller nothing.
    expect(report.documents[0]?.markdown).toBeNull();
  }, 60_000);
});
