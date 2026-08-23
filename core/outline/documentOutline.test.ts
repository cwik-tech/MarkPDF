import { describe, expect, it } from "vitest";
import { outlineFromPages } from "./documentOutline.js";
import type { MarkdownPage } from "../index/markdownBlocks.js";

/**
 * A document's heading structure, derived from the Markdown the extractor produced.
 *
 * Native PDF bookmarks are deliberately not read; see the ADR. What this promises is the heading
 * tree of the text as extracted, with the page each heading sits on — which is what makes an
 * entry something a reader can actually jump to.
 */

const page = (number: number, markdown: string): MarkdownPage => ({ page: number, markdown, source: "pdf" });

describe("deriving an outline", () => {
  it("lists each heading with the page it appears on", () => {
    const outline = outlineFromPages([page(1, "# Annual Report\n\nText."), page(2, "## Revenue\n\nMore text.")], 6);

    expect(outline).toEqual([
      { level: 1, title: "Annual Report", page: 1 },
      { level: 2, title: "Revenue", page: 2 },
    ]);
  });

  it("keeps document order rather than grouping by level", () => {
    const outline = outlineFromPages([page(1, "# A\n\n## A1\n\n# B\n\n## B1")], 6);

    expect(outline.map((entry) => entry.title)).toEqual(["A", "A1", "B", "B1"]);
  });

  it("stops at the requested depth", () => {
    const outline = outlineFromPages([page(1, "# A\n\n## B\n\n### C\n\n#### D")], 2);

    expect(outline.map((entry) => entry.title)).toEqual(["A", "B"]);
  });

  it("returns nothing for a document with no headings, rather than inventing one", () => {
    expect(outlineFromPages([page(1, "Just a paragraph of text.")], 6)).toEqual([]);
  });

  it("ignores a pipe table that happens to contain a hash", () => {
    const outline = outlineFromPages([page(1, "| Ref | Note |\n| --- | --- |\n| #4 | fine |")], 6);

    expect(outline).toEqual([]);
  });

  it("carries a heading from a page that was read by OCR just the same", () => {
    const outline = outlineFromPages([{ page: 4, markdown: "## Appendix", source: "ocr" }], 6);

    expect(outline).toEqual([{ level: 2, title: "Appendix", page: 4 }]);
  });
});
