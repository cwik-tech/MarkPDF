import { boundText, type BoundedText, type OutputBudget } from "../output/budget.js";

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

/**
 * One Markdown document, bounded to what a caller can afford to receive.
 *
 * The bounding happens **here**, not in whatever surface asked. A transport that rendered the
 * whole document and then trimmed the string would be the only thing standing between a caller and
 * an unbounded payload, and the other transport would have its own version of that — which is
 * exactly the drift the safety constraints of this system are supposed to be immune to.
 *
 * A budget cannot be waived: `OutputBudget` is constructible only through `outputBudget`, which
 * refuses anything meaning "no limit". A caller that genuinely wants the whole document calls
 * `renderMarkdownDocument` and is visibly doing so.
 */
export function renderBoundedMarkdown(
  pages: readonly RenderablePage[],
  mode: MarkdownRenderMode,
  budget: OutputBudget,
): BoundedText {
  return boundText(renderMarkdownDocument(pages, mode), budget);
}

/**
 * The whole document, for writing to a file.
 *
 * The same rendering as `renderMarkdownDocument`, under a name that says where the result may go.
 * A file is not the wire: a caller that asked for a document on disk asked for the document, and
 * bounding it there would produce a truncated file nobody wanted. The name exists so that an
 * adapter reaching for unbounded text has to say which of the two things it is doing, and so that
 * the boundary check can tell them apart.
 */
export function renderMarkdownForFile(pages: readonly RenderablePage[], mode: MarkdownRenderMode): string {
  return renderMarkdownDocument(pages, mode);
}
