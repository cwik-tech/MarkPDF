/**
 * Splitting a document's per-page Markdown into blocks that know where they sit.
 *
 * Nothing here parses Markdown MarkPDF did not produce: the input is PDF Inspector's own output,
 * a narrow dialect of headings, paragraphs, lists and GFM tables. A general Markdown parser would
 * be speculative work maintained against constructs nothing emits.
 */
export interface MarkdownPage {
  page: number;
  markdown: string;
  /** `mixed`: the extractor read the page and a pictured region on it was read as well. */
  source: "pdf" | "ocr" | "mixed";
}

export type BlockKind = "heading" | "paragraph" | "table" | "list";

export interface MarkdownBlock {
  page: number;
  kind: BlockKind;
  /** Heading depth, 1–6. Absent for everything else. */
  level?: number;
  /** The block's Markdown, verbatim apart from surrounding blank lines. */
  text: string;
  /** A heading's text with its hashes removed. Absent for everything else. */
  title?: string;
  source: "pdf" | "ocr" | "mixed";
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;

function classify(line: string): BlockKind {
  if (HEADING.test(line)) return "heading";
  if (TABLE_ROW.test(line)) return "table";
  if (LIST_ITEM.test(line)) return "list";
  return "paragraph";
}

/**
 * Blocks in document order.
 *
 * A block never spans two pages, even when a sentence obviously does. The page number is what
 * makes a search hit citable, and a chunk with two pages has neither.
 */
export function splitIntoBlocks(pages: readonly MarkdownPage[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];

  for (const page of pages) {
    let pending: string[] = [];
    let pendingKind: BlockKind | null = null;

    const flush = () => {
      if (pendingKind === null || pending.length === 0) {
        pending = [];
        pendingKind = null;
        return;
      }
      const text = pending.join("\n").trim();
      if (text.length > 0) {
        // Destructured and checked rather than asserted: a regex that matched still yields
        // `string | undefined` for its groups, and production must not claim otherwise.
        const match = pendingKind === "heading" ? HEADING.exec(text) : null;
        const [, hashes, title] = match ?? [];
        const heading =
          hashes === undefined || title === undefined ? {} : { level: hashes.length, title: title.trim() };
        blocks.push({ page: page.page, kind: pendingKind, text, source: page.source, ...heading });
      }
      pending = [];
      pendingKind = null;
    };

    for (const line of page.markdown.split("\n")) {
      if (line.trim().length === 0) {
        flush();
        continue;
      }
      const kind = classify(line);
      // A heading is always its own block; everything else runs on while its kind holds.
      if (kind === "heading" || (pendingKind !== null && pendingKind !== kind)) flush();
      pendingKind = kind;
      pending.push(line);
      if (kind === "heading") flush();
    }
    flush();
  }

  return blocks;
}

/** A heading in a block's breadcrumb, with the page it stands on. */
export interface HeadingRef {
  title: string;
  page: number;
}

/**
 * The headings above a block, outermost first, each with the page it stands on.
 *
 * Computed by walking back rather than carried as state, so it is correct for any block without
 * depending on the order questions are asked. The walk crosses page boundaries for free, which
 * is the property that matters: a table opening page 8 keeps the heading that closed page 7 —
 * and now says so, because a breadcrumb that cannot name the page a heading came from is how a
 * passage comes to appear to claim a heading from an earlier page.
 *
 * A heading's own title is included in its own path, so a heading indexed as a chunk describes
 * itself rather than only its ancestors.
 */
export function headingPathAt(blocks: readonly MarkdownBlock[], index: number): HeadingRef[] {
  const path: HeadingRef[] = [];
  let deepest = Number.POSITIVE_INFINITY;

  for (let position = index; position >= 0; position -= 1) {
    const block = blocks[position];
    if (block === undefined || block.kind !== "heading" || block.level === undefined) continue;
    if (block.level < deepest) {
      path.unshift({ title: block.title ?? block.text, page: block.page });
      deepest = block.level;
      if (deepest === 1) break;
    }
  }
  return path;
}
