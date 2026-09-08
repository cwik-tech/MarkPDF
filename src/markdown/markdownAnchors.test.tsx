import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "./MarkdownPreview";

/**
 * A document's own table of contents, rendered.
 *
 * The two ends have to meet in the markup: a heading has to carry the name, and the link has to
 * ask for it. What separates a link that stays in the document from one that leaves is also
 * visible here — the one that leaves asks for a new window, and the one that stays must not, or the
 * reader gets a second window instead of the section they clicked.
 */
const contentsDocument = [
  "# Handbook",
  "",
  "- [Getting started](#getting-started)",
  "- [What's next?](#whats-next)",
  "- [The source](https://example.invalid/handbook)",
  "",
  "## Getting started",
  "",
  "Install it first.",
  "",
  "## What's next?",
  "",
  "Read the appendix.",
  "",
].join("\n");

function render(markdown: string): string {
  return renderToStaticMarkup(<MarkdownPreview markdown={markdown} theme="dark" />);
}

describe("linking to a section of the same document", () => {
  it("names every heading in the markup a link can point at", () => {
    const markup = render(contentsDocument);

    expect(markup).toContain('<h1 id="handbook">');
    expect(markup).toContain('<h2 id="getting-started">');
    expect(markup).toContain('<h2 id="whats-next">');
  });

  it("points a contents link at the heading it names", () => {
    const markup = render(contentsDocument);

    expect(markup).toContain('<a href="#getting-started" data-markdown-anchor="getting-started">');
    expect(markup).toContain('<a href="#whats-next" data-markdown-anchor="whats-next">');
  });

  it("does not ask for a new window for a link that stays in the document", () => {
    const markup = render(contentsDocument);
    const anchorLinks = markup.match(/<a href="#[^>]*>/g) ?? [];

    expect(anchorLinks, "links to a heading of this document").toHaveLength(2);
    for (const link of anchorLinks) {
      expect(link, link).not.toContain("target=");
    }
  });

  it("still sends a link that leaves the document to a new window", () => {
    const markup = render(contentsDocument);

    expect(markup).toContain(
      '<a href="https://example.invalid/handbook" target="_blank" rel="noreferrer">',
    );
  });

  it("follows a contents row whose destination is written inside angle brackets", () => {
    // The one way to link a heading whose title has spaces in it, and the form a writer reaches for
    // when they have not memorised how the title becomes a name.
    const markup = render(
      ["# Guide", "", "- [Later](<#What's next?>)", "", "## What's next?", ""].join("\n"),
    );

    expect(markup).toContain('<a href="#whats-next" data-markdown-anchor="whats-next">');
    expect(markup).toContain('<h2 id="whats-next">');
    expect(markup, "a link that stays in the document asked for a window").not.toContain("target=");
  });

  it("gives two sections with the same title their own names", () => {
    const markup = render(["## Notes", "", "## Notes", ""].join("\n"));

    expect(markup).toContain('<h2 id="notes">');
    expect(markup).toContain('<h2 id="notes-1">');
  });

  it("leaves a heading in a document nobody links to just as reachable", () => {
    // The name does not depend on a link existing: a reader can be sent one from elsewhere, and the
    // document is the same document either way.
    expect(render("## Appendix A")).toContain('<h2 id="appendix-a">');
  });
});
