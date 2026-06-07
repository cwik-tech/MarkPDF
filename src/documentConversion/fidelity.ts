import { extractPageText } from "../pdf/document";
import type { OverlayItem } from "../types";
import type { MarkdownExportSettings } from "../global";
import type { MarkdownConversionInput, MarkdownPage } from "./types";

const sparseTextThreshold = 100;

export function normalizeMarkdownText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function markdownEscape(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

export function defaultMarkdownTitle(name: string) {
  return name.replace(/\.[^.]+$/, "").trim() || "Untitled";
}

function annotationLabel(kind: string) {
  if (kind === "comment") return "Comment";
  if (kind === "highlight") return "Highlight";
  if (kind === "text") return "Text";
  if (kind === "signature") return "Signature";
  return "Annotation";
}

export function renderAnnotationBlock(annotations: OverlayItem[]) {
  const sortedAnnotations = annotations
    .filter((overlay) => overlay.text?.trim() || overlay.kind === "signature")
    .sort((a, b) => a.y - b.y || a.x - b.x);

  if (sortedAnnotations.length === 0) return "";

  return [
    "### Annotations",
    "",
    ...sortedAnnotations.map((overlay) => {
      const text = overlay.text?.trim() || "Signature";
      return `- **${annotationLabel(overlay.kind)}:** ${markdownEscape(text)}`;
    })
  ].join("\n");
}

export function renderPageAnchor(pageNumber: number, includeHeading: boolean) {
  const anchor = `<a id="page-${pageNumber}"></a>`;
  if (!includeHeading) return anchor;
  return `${anchor}\n\n## Page ${pageNumber}`;
}

export async function collectMarkdownPages(input: MarkdownConversionInput) {
  const ocrTextByPage = new Map(input.ocrPages.map((page) => [page.page, normalizeMarkdownText(page.text)]));
  const pages: MarkdownPage[] = [];
  const warnings: string[] = [];

  for (let pageNumber = 1; pageNumber <= input.pdfDoc.numPages; pageNumber += 1) {
    input.onProgress?.({
      message: `Reading page ${pageNumber} of ${input.pdfDoc.numPages}`,
      current: pageNumber,
      total: input.pdfDoc.numPages
    });

    const page = await input.pdfDoc.getPage(pageNumber);
    const nativeText = normalizeMarkdownText(await extractPageText(page));
    const ocrText = ocrTextByPage.get(pageNumber) ?? "";
    const nativeTextLength = nativeText.replace(/\s/g, "").length;
    const useOcrText = input.settings.useOcrFallback && nativeTextLength < sparseTextThreshold && ocrText.length > 0;
    const text = useOcrText ? ocrText : nativeText;

    if (!text) {
      warnings.push(`Page ${pageNumber} had no extractable text.`);
    } else if (nativeTextLength < sparseTextThreshold && !ocrText) {
      warnings.push(`Page ${pageNumber} appears scanned or low-confidence; no OCR fallback text was available.`);
    }

    pages.push({
      page: pageNumber,
      text,
      source: useOcrText ? "ocr" : "pdf",
      annotations: input.overlays.filter((overlay) => overlay.page === pageNumber),
      nativeTextLength
    });
  }

  return { pages, warnings };
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MatchToken {
  value: string;
  index: number;
}

interface MarkdownTokenIndex {
  tokens: MatchToken[];
  byValue: Map<string, number[]>;
}

function normalizeMatchToken(token: string) {
  return token
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
}

function tokenizeForMatching(text: string): MatchToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: normalizeMatchToken(match[0]),
    index: match.index ?? 0
  }));
}

function indexMarkdownTokens(tokens: MatchToken[]): MarkdownTokenIndex {
  const byValue = new Map<string, number[]>();
  tokens.forEach((token, index) => {
    const tokenIndexes = byValue.get(token.value) ?? [];
    tokenIndexes.push(index);
    byValue.set(token.value, tokenIndexes);
  });

  return { tokens, byValue };
}

function firstCandidateAtOrAfter(tokens: MatchToken[], tokenIndexes: number[], fromIndex: number) {
  let low = 0;
  let high = tokenIndexes.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[tokenIndexes[middle]].index < fromIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function findTokenSequence(markdownIndex: MarkdownTokenIndex, sequence: string[], fromIndex: number) {
  const tokenIndexes = markdownIndex.byValue.get(sequence[0]);
  if (!tokenIndexes) return -1;

  for (let candidateIndex = firstCandidateAtOrAfter(markdownIndex.tokens, tokenIndexes, fromIndex); candidateIndex < tokenIndexes.length; candidateIndex += 1) {
    const tokenIndex = tokenIndexes[candidateIndex];
    if (tokenIndex > markdownIndex.tokens.length - sequence.length) break;
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (markdownIndex.tokens[tokenIndex + offset].value !== sequence[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) return markdownIndex.tokens[tokenIndex].index;
  }

  return -1;
}

function candidateTokenWindows(tokens: string[], size: number) {
  const windows: string[][] = [];
  const step = Math.max(1, Math.floor(size / 2));

  for (let start = 0; start <= tokens.length - size; start += step) {
    const window = tokens.slice(start, start + size);
    if (new Set(window).size >= Math.ceil(size * 0.65)) {
      windows.push(window);
    }
  }

  return windows;
}

function findPageInsertionPoint(markdownIndex: MarkdownTokenIndex, page: MarkdownPage, fromIndex: number) {
  const pageTokens = tokenizeForMatching(page.text).map((token) => token.value);
  if (pageTokens.length < 6) return -1;

  for (const size of [14, 12, 10, 8, 6]) {
    let bestPosition = Number.POSITIVE_INFINITY;
    for (const window of candidateTokenWindows(pageTokens, size)) {
      const position = findTokenSequence(markdownIndex, window, fromIndex);
      if (position >= 0) {
        bestPosition = Math.min(bestPosition, position);
      }
    }

    if (Number.isFinite(bestPosition)) return bestPosition;
  }

  return -1;
}

function hasPageMarker(markdown: string, pageNumber: number) {
  const escapedPage = escapeRegExp(String(pageNumber));
  return new RegExp(`<a\\s+id=["']page-${escapedPage}["']\\s*></a>|^#{1,6}\\s+Page\\s+${escapedPage}\\b`, "im").test(markdown);
}

function insertBlocks(markdown: string, inserts: Array<{ position: number; block: string }>) {
  let nextMarkdown = markdown;
  for (const insert of [...inserts].sort((a, b) => b.position - a.position)) {
    const before = nextMarkdown.slice(0, insert.position).trimEnd();
    const after = nextMarkdown.slice(insert.position).trimStart();
    nextMarkdown = `${before}\n\n${insert.block.trim()}\n\n${after}`.trim();
  }
  return nextMarkdown;
}

export function postProcessMarkdownWithPageContext(
  markdown: string,
  pages: MarkdownPage[],
  settings: MarkdownExportSettings
) {
  const includeHeadings = settings.exportMode === "page-preserving" || settings.includePageMarkers;
  const includeAnchors = includeHeadings || settings.includeAnnotations;
  const inserts: Array<{ position: number; block: string }> = [];
  const unmatchedBlocks: string[] = [];
  const warnings: string[] = [];
  const markdownIndex = indexMarkdownTokens(tokenizeForMatching(markdown));
  let cursor = 0;

  if (!includeAnchors && !settings.includeAnnotations) {
    return { markdown: `${markdown.trim()}\n`, warnings };
  }

  for (const page of pages) {
    const blockParts: string[] = [];
    if (includeAnchors && !hasPageMarker(markdown, page.page)) {
      blockParts.push(renderPageAnchor(page.page, includeHeadings));
    }
    if (settings.includeAnnotations) {
      const annotations = renderAnnotationBlock(page.annotations);
      if (annotations) blockParts.push(annotations);
    }

    if (blockParts.length === 0) continue;

    const position = findPageInsertionPoint(markdownIndex, page, cursor);
    const block = blockParts.join("\n\n");
    if (position >= 0) {
      inserts.push({ position, block });
      cursor = position + 1;
    } else if (block) {
      unmatchedBlocks.push(block);
      warnings.push(`Page ${page.page} could not be matched to a stable Markdown location and was appended.`);
    }
  }

  const withInsertedBlocks = insertBlocks(markdown, inserts);
  const withUnmatchedBlocks = unmatchedBlocks.length
    ? `${withInsertedBlocks.trim()}\n\n---\n\n## Unmatched Page Markers\n\n${unmatchedBlocks.join("\n\n")}`
    : withInsertedBlocks;

  return {
    markdown: `${withUnmatchedBlocks.trim()}\n`,
    warnings
  };
}
