export interface RenderablePage {
  page: number;
  markdown: string;
}

export type MarkdownRenderMode = "page-preserving" | "clean";

/**
 * The convention the reader already exports.
 *
 * An anchor so a link can reach the page, and a heading so a person reading the file knows where
 * they are. Reproduced here rather than reinvented, so a document converted from the command line
 * and one exported from the application are the same shape — see
 * `src/documentConversion/fidelity.ts:45-50`.
 */
function pagePreserving(pages: readonly RenderablePage[]): string {
  return pages
    .map((page) => [`<a id="page-${page.page}"></a>`, "", `## Page ${page.page}`, "", page.markdown.trim()].join("\n").trimEnd())
    .join("\n\n---\n\n");
}

/**
 * The text, with none of the furniture.
 *
 * An empty page is left out entirely rather than contributing a gap: in this mode there is
 * nothing to say a page was there, so a blank stretch would read as a formatting accident.
 */
function clean(pages: readonly RenderablePage[]): string {
  return pages
    .map((page) => page.markdown.trim())
    .filter((markdown) => markdown.length > 0)
    .join("\n\n");
}

/** One Markdown document from a document's pages. Empty in, empty out. */
export function renderMarkdownDocument(pages: readonly RenderablePage[], mode: MarkdownRenderMode): string {
  if (pages.length === 0) return "";
  const body = mode === "page-preserving" ? pagePreserving(pages) : clean(pages);
  return body.length === 0 ? "" : `${body}\n`;
}
