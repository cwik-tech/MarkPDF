import { splitIntoBlocks, type MarkdownPage } from "../index/markdownBlocks.js";

export interface OutlineEntry {
  /** Heading depth, 1–6. */
  level: number;
  title: string;
  /** The page the heading appears on, 1-based. */
  page: number;
}

/**
 * A document's heading tree, derived from the Markdown the extractor produced.
 *
 * **Native PDF bookmarks are not read.** That is a deliberate limitation, not an oversight — but
 * the reason is no longer that a PDF library is unavailable here: `core/ocr/rasterisePages.ts`
 * imports `pdfjs-dist` to render scanned pages, so ruling R1's premise is spent. The reason is
 * that the heading tree is the case that actually needs serving. A document with no bookmarks at
 * all still has headings; one whose bookmarks disagree with its headings is rare; and reading both
 * would give the same question two answers. The ADR records the alternative and what it costs.
 *
 * Order is document order, not depth order, because an outline is read top to bottom. Each entry
 * carries its page, which is what makes it something a reader can jump to rather than a list of
 * strings.
 */
export function outlineFromPages(pages: readonly MarkdownPage[], maxDepth: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const block of splitIntoBlocks(pages)) {
    if (block.kind !== "heading") continue;
    const { level, title } = block;
    // Checked rather than asserted: `level` and `title` are optional on the block type because
    // every other kind lacks them, and a heading that somehow lacked either is not one.
    if (level === undefined || title === undefined) continue;
    if (level > maxDepth) continue;
    entries.push({ level, title, page: block.page });
  }
  return entries;
}
