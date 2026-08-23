import { describe, expect, it } from "vitest";
import { renderMarkdownDocument } from "./renderMarkdown.js";

/**
 * Turning extracted pages into one Markdown document.
 *
 * `page-preserving` reproduces the convention the application already exports — an anchor, a
 * `## Page N` heading, and a rule between pages (`src/documentConversion/fidelity.ts:45-50`,
 * `engines/builtinText.ts:36-40`) — so a document converted from the command line and one
 * exported from the reader are the same shape. `clean` is the command line's own: the text with
 * none of that.
 */

const pages = [
  { page: 1, markdown: "# Annual Report\n\nOpening paragraph." },
  { page: 2, markdown: "## Revenue\n\n| Segment | 2026 |\n| --- | --- |\n| Consumer | 455 |" },
];

describe("page-preserving", () => {
  it("announces each page so a reader can still tell where they are", () => {
    const markdown = renderMarkdownDocument(pages, "page-preserving");

    expect(markdown).toContain('<a id="page-1"></a>');
    expect(markdown).toContain("## Page 2");
  });

  it("puts a rule between pages", () => {
    expect(renderMarkdownDocument(pages, "page-preserving")).toContain("\n\n---\n\n");
  });

  it("still announces a page that has no text, because the page is still there", () => {
    const markdown = renderMarkdownDocument([{ page: 1, markdown: "" }, { page: 2, markdown: "Text." }], "page-preserving");

    expect(markdown).toContain("## Page 1");
  });

  it("keeps the page's own Markdown untouched", () => {
    expect(renderMarkdownDocument(pages, "page-preserving")).toContain("| Consumer | 455 |");
  });
});

describe("clean", () => {
  it("carries none of the page furniture", () => {
    const markdown = renderMarkdownDocument(pages, "clean");

    expect(markdown).not.toContain("<a id=");
    expect(markdown).not.toContain("## Page");
    expect(markdown).not.toContain("---\n\n");
  });

  it("leaves out a page with no text rather than a blank gap", () => {
    const markdown = renderMarkdownDocument([{ page: 1, markdown: "First." }, { page: 2, markdown: "  " }, { page: 3, markdown: "Third." }], "clean");

    expect(markdown).toBe("First.\n\nThird.\n");
  });
});

describe("both modes", () => {
  it("end with exactly one newline, so the output composes with other tools", () => {
    for (const mode of ["page-preserving", "clean"] as const) {
      const markdown = renderMarkdownDocument(pages, mode);
      expect(markdown.endsWith("\n")).toBe(true);
      expect(markdown.endsWith("\n\n")).toBe(false);
    }
  });

  it("produce nothing at all for a document with no pages", () => {
    expect(renderMarkdownDocument([], "clean")).toBe("");
    expect(renderMarkdownDocument([], "page-preserving")).toBe("");
  });
});
