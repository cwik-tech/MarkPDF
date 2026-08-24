import { describe, expect, it } from "vitest";
import { findMarkdownMatches } from "./markdownSearch";

// The preview highlights the text a reader can actually see: prose, list
// items, table cells, link labels and code blocks. It never highlights link
// targets or image alternative text, so those must not be counted either.
const searchDocument = [
  "# Search targets",
  "",
  "Alpha appears in this paragraph.",
  "",
  "- Alpha appears in a list item",
  "",
  "```ts",
  'const alpha = "alpha";',
  "```",
  "",
  "[alpha link](https://example.com/alpha-page)",
  "",
  "![alpha logo](https://example.com/alpha-logo.png)",
  "",
  "| Column |",
  "| --- |",
  "| Alpha in a table cell |",
  "",
].join("\n");

describe("findMarkdownMatches", () => {
  it("counts every occurrence the preview shows and none that it hides", () => {
    // Counted by hand from searchDocument: paragraph 1, list item 1,
    // code block 2, link label 1, table cell 1. The link target, the image
    // alt text and the image target are not rendered as readable text.
    expect(findMarkdownMatches(searchDocument, "alpha")).toHaveLength(6);
  });

  it("numbers matches from the top of the document downwards", () => {
    const matches = findMarkdownMatches(searchDocument, "alpha");

    expect(matches.map((match) => match.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(matches[0].snippet).toContain("Alpha appears in this paragraph.");
    expect(matches[1].snippet).toContain("Alpha appears in a list item");
    expect(matches[5].snippet).toContain("Alpha in a table cell");
  });

  it("ignores case and returns nothing for a blank query", () => {
    expect(findMarkdownMatches(searchDocument, "ALPHA")).toHaveLength(6);
    expect(findMarkdownMatches(searchDocument, "   ")).toHaveLength(0);
  });
});
