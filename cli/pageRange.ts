/**
 * The most pages `--pages` will expand to.
 *
 * Not a limit on documents — it is a limit on typing. `1-100000` on a 12-page report is a slip,
 * and materialising the list first to discover that would allocate for no reason.
 */
const MAX_SELECTED_PAGES = 10_000;

export type PageSelection = { ok: true; pages: number[] } | { ok: false; message: string };

function refuse(detail: string): PageSelection {
  return { ok: false, message: `--pages ${detail} Write a page, a range, or a list: 3, 3-7, or 1,4-6.` };
}

function parseWholePage(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Which pages `--pages` names, 1-based, ascending and without repeats.
 *
 * Syntax only. Whether the document actually has those pages is a different question, answered
 * where the document is — this cannot know, and guessing would mean either reading the file
 * before it has been permitted or accepting a page that does not exist.
 */
export function parsePageSelection(text: string): PageSelection {
  // Empty components are kept, not filtered away. `1,,2` and `1,` are a typo or a badly built
  // command line, and dropping the empty part would convert something slightly different from
  // what was asked for with nothing said about it.
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return refuse("needs a page in every position; an empty one is a typo.");
  }

  const pages = new Set<number>();
  for (const part of parts) {
    const [first, second, ...extra] = part.split("-").map((piece) => piece.trim());
    if (extra.length > 0 || first === undefined) return refuse(`could not read ${JSON.stringify(part)}.`);

    const start = parseWholePage(first);
    if (start === null) return refuse(`could not read ${JSON.stringify(part)}; pages are whole numbers counted from 1.`);
    if (second === undefined) {
      pages.add(start);
      continue;
    }

    const end = parseWholePage(second);
    if (end === null) return refuse(`could not read ${JSON.stringify(part)}; pages are whole numbers counted from 1.`);
    // Refused rather than reversed. `7-3` is far more likely to be a typo than an intention, and
    // silently converting it would convert the typo too.
    if (end < start) return refuse(`range ${JSON.stringify(part)} ends before it begins.`);
    if (end - start + 1 > MAX_SELECTED_PAGES) return refuse(`range ${JSON.stringify(part)} covers more than ${MAX_SELECTED_PAGES} pages.`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }

  if (pages.size > MAX_SELECTED_PAGES) return refuse(`names more than ${MAX_SELECTED_PAGES} pages.`);
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}
