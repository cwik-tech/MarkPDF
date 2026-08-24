import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "./harness.test-support.js";
import { EXIT_CODE } from "./exit.js";
import { renderSearchResultsHuman } from "./commands/searchCommand.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
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

describe("search", () => {
  /** One result of the command line's search JSON, checked rather than assumed. */
  interface CheckedSearchResult {
    page: number;
    headingPath: string[];
    headings: Array<{ title: string; page: number | null }>;
    headingInherited: boolean;
  }

  function searchResultsOf(stdout: string): CheckedSearchResult[] {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Expected an object on standard output, got ${stdout}`);
    }
    const results = Reflect.get(parsed, "results");
    if (!Array.isArray(results)) throw new Error(`Expected a results array, got ${stdout}`);
    return results.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Result ${index} is not an object: ${JSON.stringify(entry)}`);
      }
      const page = Reflect.get(entry, "page");
      const headingPath = Reflect.get(entry, "headingPath");
      const headings = Reflect.get(entry, "headings");
      const headingInherited = Reflect.get(entry, "headingInherited");
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
        throw new Error(`Result ${index} has no usable page: ${JSON.stringify(entry)}`);
      }
      if (!Array.isArray(headingPath) || !headingPath.every((title) => typeof title === "string")) {
        throw new Error(`Result ${index} has no usable headingPath: ${JSON.stringify(entry)}`);
      }
      if (!Array.isArray(headings)) {
        throw new Error(`Result ${index} has no usable headings: ${JSON.stringify(entry)}`);
      }
      const checkedHeadings = headings.map((heading, headingIndex) => {
        if (typeof heading !== "object" || heading === null || Array.isArray(heading)) {
          throw new Error(`Result ${index} heading ${headingIndex} is not an object: ${JSON.stringify(heading)}`);
        }
        const title = Reflect.get(heading, "title");
        const headingPage = Reflect.get(heading, "page");
        if (typeof title !== "string" || title.length === 0) {
          throw new Error(`Result ${index} heading ${headingIndex} has no title: ${JSON.stringify(heading)}`);
        }
        if (headingPage !== null && (typeof headingPage !== "number" || !Number.isInteger(headingPage) || headingPage < 1)) {
          throw new Error(`Result ${index} heading ${headingIndex} has no usable page: ${JSON.stringify(heading)}`);
        }
        return { title, page: headingPage };
      });
      if (typeof headingInherited !== "boolean") {
        throw new Error(`Result ${index} has no usable headingInherited: ${JSON.stringify(entry)}`);
      }
      return { page, headingPath, headings: checkedHeadings, headingInherited };
    });
  }

  it("carries each heading's page in the JSON results", async () => {
    await run(["--allow-read", libraryDir]);
    await run(["index", fixture]);

    const result = await run(["search", "Enterprise 1204", "--path", fixture, "--min-score", "0.05", "--json"]);

    expect(result.code).toBe(EXIT_CODE.success);
    // The command line's JSON mirrors the core result shape; the MCP tool is the surface that
    // renames fields to snake_case.
    const results = searchResultsOf(result.stdout);
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((entry) => entry.page === 2);
    expect(hit?.headingPath).toContain(PAGE_TWO_HEADING);
    // The heading stands on the same page as the passage, so it says so.
    expect(hit?.headings).toContainEqual({ title: PAGE_TWO_HEADING, page: 2 });
    expect(hit?.headingInherited).toBe(false);
  }, 120_000);

  it("prefixes an inherited heading with its page in the human output", () => {
    const output = renderSearchResultsHuman([
      { page: 10, score: 0.412, snippet: "Sales 5170", headings: [{ title: "Operating Plan", page: 9 }] },
    ]);

    expect(output).toContain("p9: Operating Plan");
  });

  it("leaves a heading the passage's own page carries unprefixed", () => {
    const output = renderSearchResultsHuman([
      { page: 11, score: 0.412, snippet: "Appendix text.", headings: [{ title: "Appendix A", page: 11 }] },
    ]);

    expect(output).toContain("Appendix A");
    expect(output).not.toContain("p11: Appendix A");
  });

  it("leaves a heading with no recorded page unprefixed, because guessing one would be worse", () => {
    const output = renderSearchResultsHuman([
      { page: 4, score: 0.412, snippet: "Legacy row.", headings: [{ title: "Legacy Section", page: null }] },
    ]);

    expect(output).toContain("Legacy Section");
    expect(output).not.toContain("p0:");
    expect(output).not.toContain("pnull:");
  });

  it("uses the settings' threshold when the option is absent, and the option when it is given", async () => {
    // The settings file is the application's own; a search without --min-score runs under
    // whatever it says, and an explicit --min-score outranks it. The query is chosen so its
    // measured score (0.327 against this fixture) clears the fixed fallback of 0.3 — otherwise
    // the old behaviour would block it too and this test could not tell the two apart.
    await run(["--allow-read", libraryDir]);
    await run(["index", fixture]);
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ semanticSearch: { ...defaultSemanticSearchSettings, minSemanticScore: 0.95 } })}\n`,
      "utf8",
    );

    const blocked = await run(["search", "Enterprise 1204 1318", "--path", fixture, "--json"]);
    expect(blocked.code).toBe(EXIT_CODE.success);
    expect(searchResultsOf(blocked.stdout)).toEqual([]);

    const allowed = await run(["search", "Enterprise 1204 1318", "--path", fixture, "--min-score", "0.05", "--json"]);
    expect(allowed.code).toBe(EXIT_CODE.success);
    expect(searchResultsOf(allowed.stdout).length).toBeGreaterThan(0);
  }, 120_000);
});
