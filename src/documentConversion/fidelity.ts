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

function snippetRegex(text: string) {
  const words = normalizeMarkdownText(text)
    .split(" ")
    .filter((word) => /[A-Za-z0-9]/.test(word))
    .slice(0, 14);

  if (words.length < 6) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "i");
}

function findPageInsertionPoint(markdown: string, page: MarkdownPage, fromIndex: number) {
  const regex = snippetRegex(page.text);
  if (!regex) return -1;
  const match = markdown.slice(fromIndex).match(regex);
  return typeof match?.index === "number" ? fromIndex + match.index : -1;
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

    const position = findPageInsertionPoint(markdown, page, cursor);
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
