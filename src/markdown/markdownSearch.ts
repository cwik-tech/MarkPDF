import type { MarkdownSearchMatch } from "../types";
import { collectHighlightableText, parseMarkdown } from "./markdownDocument";

const SNIPPET_PADDING = 56;

function buildSnippet(segment: string, index: number, length: number) {
  const start = Math.max(0, index - SNIPPET_PADDING);
  const end = Math.min(segment.length, index + length + SNIPPET_PADDING);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < segment.length ? "..." : "";
  const body = segment.slice(start, end).replace(/\s+/g, " ").trim();
  return `${prefix}${body}${suffix}`;
}

/**
 * Finds the query in the text the preview renders, in reading order. The
 * position of a match in this list is the position of its highlight in the
 * preview, which is what lets next and previous jump to the right place.
 */
export function findMarkdownMatches(
  markdown: string,
  query: string,
): MarkdownSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const matches: MarkdownSearchMatch[] = [];

  for (const segment of collectHighlightableText(parseMarkdown(markdown))) {
    const lowerSegment = segment.toLocaleLowerCase();
    let cursor = 0;

    for (;;) {
      const index = lowerSegment.indexOf(lowerQuery, cursor);
      if (index === -1) break;
      const ordinal = matches.length;
      matches.push({
        id: `markdown-match-${ordinal}`,
        ordinal,
        snippet: buildSnippet(segment, index, normalizedQuery.length),
      });
      cursor = index + normalizedQuery.length;
    }
  }

  return matches;
}
