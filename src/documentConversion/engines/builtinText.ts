import {
  collectMarkdownPages,
  defaultMarkdownTitle,
  markdownEscape,
  renderAnnotationBlock,
  renderPageAnchor
} from "../fidelity";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownPage } from "../types";

function renderPage(page: MarkdownPage, includeHeading: boolean, includeAnnotations: boolean) {
  const parts: string[] = [];

  if (includeHeading) {
    parts.push(renderPageAnchor(page.page, true), "");
  }

  if (page.text) {
    parts.push(page.text, "");
  }

  if (includeAnnotations) {
    const annotations = renderAnnotationBlock(page.annotations);
    if (annotations) parts.push(annotations);
  }

  return parts.join("\n").trim();
}

export const builtinTextMarkdownEngine: MarkdownConversionEngine = {
  id: "builtin-text",
  name: "Built-in text export",
  async convert(input: MarkdownConversionInput) {
    const { pages, warnings } = await collectMarkdownPages(input);

    const includePageHeadings = input.settings.exportMode === "page-preserving" || input.settings.includePageMarkers;
    const body = pages
      .map((page) => renderPage(page, includePageHeadings, input.settings.includeAnnotations))
      .filter(Boolean)
      .join("\n\n---\n\n");

    const sourceSummary = pages.some((page) => page.source === "ocr")
      ? "PDF text with OCR fallback"
      : "PDF text";

    const markdown = [`# ${markdownEscape(defaultMarkdownTitle(input.name))}`, "", `> Exported from ${sourceSummary}.`, "", body].filter(Boolean).join("\n");

    return {
      markdown: `${markdown.trim()}\n`,
      engineId: this.id,
      warnings
    };
  }
};
