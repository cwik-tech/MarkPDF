import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "./MarkdownPreview";
import { findMarkdownMatches } from "./markdownSearch";

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
  "| Column |",
  "| --- |",
  "| Alpha in a table cell |",
  "",
].join("\n");

function renderHighlightTags(activeMatchIndex: number) {
  const markup = renderToStaticMarkup(
    <MarkdownPreview
      markdown={searchDocument}
      theme="dark"
      searchQuery="alpha"
      activeMatchIndex={activeMatchIndex}
    />,
  );
  return markup.match(/<mark[^>]*>/g) ?? [];
}

describe("markdown search highlighting", () => {
  it("draws one highlight for every reported match", () => {
    const matches = findMarkdownMatches(searchDocument, "alpha");

    expect(renderHighlightTags(0)).toHaveLength(matches.length);
  });

  it("marks the highlight that sits at the position the match reports", () => {
    const matches = findMarkdownMatches(searchDocument, "alpha");

    for (const match of matches) {
      const tags = renderHighlightTags(match.ordinal);
      const activePosition = tags.findIndex((tag) =>
        tag.includes('data-active-search-match="true"'),
      );

      expect(activePosition).toBe(match.ordinal);
    }
  });
});
