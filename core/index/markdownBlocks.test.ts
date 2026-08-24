import { describe, expect, it } from "vitest";
import { splitIntoBlocks, headingPathAt, type MarkdownBlock } from "./markdownBlocks.js";

/**
 * Turning a document's per-page Markdown into blocks that know where they sit.
 *
 * The heading stack is the part that has to survive a page break: a table on page 8 under a
 * heading last seen on page 7 must still cite that heading, or the breadcrumb is worse than
 * useless — it would attribute the table to whatever heading happens to open page 8.
 */

const pages = (...markdown: string[]) =>
  markdown.map((text, index) => ({ page: index + 1, markdown: text, source: "pdf" as const }));

function texts(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.map((block) => block.text);
}

describe("splitting a document's Markdown into blocks", () => {
  it("keeps a paragraph whole and drops the blank lines around it", () => {
    const blocks = splitIntoBlocks(pages("Alpha paragraph.\n\n\nBeta paragraph.\n"));
    expect(texts(blocks)).toEqual(["Alpha paragraph.", "Beta paragraph."]);
  });

  it("records which page each block came from", () => {
    const blocks = splitIntoBlocks(pages("Page one text.", "Page two text."));
    expect(blocks.map((block) => block.page)).toEqual([1, 2]);
  });

  it("marks a heading as a heading and keeps its level", () => {
    const blocks = splitIntoBlocks(pages("# Title\n\n## Section\n\nBody."));
    expect(blocks.map((block) => ({ kind: block.kind, level: block.level }))).toEqual([
      { kind: "heading", level: 1 },
      { kind: "heading", level: 2 },
      { kind: "paragraph", level: undefined },
    ]);
  });

  it("marks a GFM table as a table, header row and all", () => {
    const table = "|Segment|2025|\n|---|---|\n|Consumer|412|\n|Enterprise|1204|";
    const blocks = splitIntoBlocks(pages(`## Revenue\n\n${table}\n`));
    const tableBlock = blocks.find((block) => block.kind === "table");
    expect(tableBlock?.text).toBe(table);
  });

  it("keeps a list together rather than splitting it line by line", () => {
    const blocks = splitIntoBlocks(pages("- first item\n- second item\n- third item"));
    expect(texts(blocks)).toEqual(["- first item\n- second item\n- third item"]);
  });

  it("carries a page's trailing text as its own block rather than merging it into the next page", () => {
    // Pages are extracted separately, so a paragraph continuing across a break arrives as two
    // pieces. Merging them would make one chunk cite two pages, and a chunk has exactly one.
    const blocks = splitIntoBlocks(pages("Ends mid-sen", "tence begins."));
    expect(blocks.map((block) => block.page)).toEqual([1, 2]);
  });
});

describe("the heading stack a block sits under", () => {
  it("gives a block the headings above it, outermost first", () => {
    const blocks = splitIntoBlocks(pages("# Report\n\n## Revenue\n\n### Consumer\n\nBody text here."));
    expect(headingPathAt(blocks, blocks.length - 1)).toEqual([
      { title: "Report", page: 1 },
      { title: "Revenue", page: 1 },
      { title: "Consumer", page: 1 },
    ]);
  });

  it("carries the stack across a page break, which is the whole point", () => {
    // The heading is the last thing on page 1; the table is the first thing on page 2.
    const blocks = splitIntoBlocks(pages("# Report\n\n## Revenue by Segment", "|Segment|2025|\n|---|---|\n|Enterprise|1204|"));
    const table = blocks.findIndex((block) => block.kind === "table");
    expect(headingPathAt(blocks, table)).toEqual([
      { title: "Report", page: 1 },
      { title: "Revenue by Segment", page: 1 },
    ]);
  });

  it("pops back out when a shallower heading arrives", () => {
    const blocks = splitIntoBlocks(pages("# Report\n\n## Revenue\n\n### Consumer\n\n## Costs\n\nCost body."));
    expect(headingPathAt(blocks, blocks.length - 1)).toEqual([
      { title: "Report", page: 1 },
      { title: "Costs", page: 1 },
    ]);
  });

  it("replaces a sibling heading rather than accumulating siblings", () => {
    const blocks = splitIntoBlocks(pages("## Revenue\n\n## Costs\n\nBody."));
    expect(headingPathAt(blocks, blocks.length - 1)).toEqual([{ title: "Costs", page: 1 }]);
  });

  it("gives a block before any heading an empty path rather than inventing one", () => {
    const blocks = splitIntoBlocks(pages("Front matter with no heading above it."));
    expect(headingPathAt(blocks, 0)).toEqual([]);
  });

  it("includes a heading's own text in its own path, so a heading chunk is self-describing", () => {
    const blocks = splitIntoBlocks(pages("# Report\n\n## Revenue"));
    expect(headingPathAt(blocks, 1)).toEqual([
      { title: "Report", page: 1 },
      { title: "Revenue", page: 1 },
    ]);
  });

  it("strips the hashes from a heading's text", () => {
    const blocks = splitIntoBlocks(pages("### Revenue by Segment\n\nBody."));
    expect(headingPathAt(blocks, 1)).toEqual([{ title: "Revenue by Segment", page: 1 }]);
  });
});

describe("where each heading in a path comes from", () => {
  it("carries the page of every heading, including across the page break", () => {
    // The outer heading closes page 1, the inner one opens page 2, and the body follows it.
    // A path that cannot say where each heading came from is how a passage came to appear to
    // claim a heading from an earlier page.
    const blocks = splitIntoBlocks(pages("# Report", "## Revenue\n\nBody of the section."));
    const body = blocks.findIndex((block) => block.kind === "paragraph");
    expect(headingPathAt(blocks, body)).toEqual([
      { title: "Report", page: 1 },
      { title: "Revenue", page: 2 },
    ]);
  });

  it("names the page a heading stands on for a heading's own path", () => {
    const blocks = splitIntoBlocks(pages("Body first.", "## Costs"));
    expect(headingPathAt(blocks, 1)).toEqual([{ title: "Costs", page: 2 }]);
  });
});
