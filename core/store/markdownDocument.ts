/**
 * A whole document's Markdown, kept page by page in one string.
 *
 * The representation exists because page identity is what the index is built on. Concatenating
 * the pages would lose it.
 *
 * **Length-delimited, not escaped.** Each page is announced by a marker line carrying its number
 * and the exact length of its text; the reader then takes precisely that many characters. No
 * character sequence is special inside a page, so nothing needs escaping and no input can be
 * confused for a delimiter.
 *
 * An earlier draft escaped the marker prefix instead. That was not bijective: a document already
 * containing the *escaped* spelling round-tripped to the unescaped one, so the text came back
 * subtly altered with nothing reporting it. Escaping the escape would have fixed that case and
 * left the next one to be found by hand. Length delimiting has no such cases — the governing
 * property is that `parse(render(pages))` deep-equals `pages` for arbitrary strings, including
 * marker-looking lines, backslashes, CR/LF, empty pages, astral characters, and a page whose
 * text is itself a rendered document.
 *
 * Readability survives: a marker line is still plain, so the column is legible in a database
 * viewer even though it is exactly delimited.
 */
export interface MarkdownPageRecord {
  page: number;
  markdown: string;
}

/** Length is in UTF-16 code units, which is what `String.prototype.slice` counts. */
const MARKER = /^<!-- markpdf:page (\d+) len (\d+) -->$/;

/**
 * Render pages into one string, or refuse.
 *
 * Refuses anything that is not exactly pages `1..n` in order. A cache keyed to a document has to
 * describe the whole document, and a gap would be indistinguishable on read from a page whose
 * text was simply empty.
 */
export function renderPagePreservingMarkdown(pages: readonly MarkdownPageRecord[]): string | null {
  if (pages.length === 0) return null;
  for (const [position, page] of pages.entries()) {
    if (page.page !== position + 1) return null;
  }
  return pages
    .map((page) => `<!-- markpdf:page ${page.page} len ${page.markdown.length} -->\n${page.markdown}`)
    .join("");
}

/** Parse a rendered document back into pages, or report that it is not one. */
export function parsePagePreservingMarkdown(text: string): MarkdownPageRecord[] | null {
  if (text.length === 0) return null;

  const pages: MarkdownPageRecord[] = [];
  let offset = 0;

  while (offset < text.length) {
    const lineEnd = text.indexOf("\n", offset);
    if (lineEnd === -1) return null;

    const [, number, length] = MARKER.exec(text.slice(offset, lineEnd)) ?? [];
    if (number === undefined || length === undefined) return null;

    const start = lineEnd + 1;
    const end = start + Number(length);
    if (end > text.length) return null;

    pages.push({ page: Number(number), markdown: text.slice(start, end) });
    offset = end;
  }

  if (pages.length === 0) return null;
  for (const [position, page] of pages.entries()) {
    if (page.page !== position + 1) return null;
  }
  return pages;
}
