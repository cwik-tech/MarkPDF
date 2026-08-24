/**
 * Page text handed to the indexer.
 *
 * `text` is PDF Inspector's Markdown for a page it read, and the renderer's OCR text for a page
 * it could not. The word-window chunker that used to live here was replaced in Phase 2 by
 * structure-aware chunking under a measured token budget; see `structuredChunking.ts`.
 */
export interface PageText {
  page: number;
  text: string;
  source: "pdf" | "ocr" | "mixed";
}

/** Collapse runs of whitespace so counting and snippets are stable. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A search result's snippet, bounded so a result row stays readable.
 *
 * Phase 2 stores Markdown, so the stored text may carry pipes and hashes. `searchDocument` runs
 * `toPlainText` over it before calling this, so what a reader sees — and what the highlight is
 * matched against — is the words a text layer would show. This only trims the length.
 */
export function createSnippet(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}
