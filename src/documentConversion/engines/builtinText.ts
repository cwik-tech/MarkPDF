import { extractPageText } from "../../pdf/document";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownPage } from "../types";

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function markdownEscape(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function defaultTitle(name: string) {
  return name.replace(/\.[^.]+$/, "").trim() || "Untitled";
}

function annotationLabel(kind: string) {
  if (kind === "comment") return "Comment";
  if (kind === "highlight") return "Highlight";
  if (kind === "text") return "Text";
  if (kind === "signature") return "Signature";
  return "Annotation";
}

function renderAnnotations(page: MarkdownPage) {
  const annotations = page.annotations
    .filter((overlay) => overlay.text?.trim() || overlay.kind === "signature")
    .sort((a, b) => a.y - b.y || a.x - b.x);

  if (annotations.length === 0) return "";

  return [
    "### Annotations",
    "",
    ...annotations.map((overlay) => {
      const text = overlay.text?.trim() || "Signature";
      return `- **${annotationLabel(overlay.kind)}:** ${markdownEscape(text)}`;
    }),
    ""
  ].join("\n");
}

function renderPage(page: MarkdownPage, includeHeading: boolean, includeAnnotations: boolean) {
  const parts: string[] = [];

  if (includeHeading) {
    parts.push(`## Page ${page.page}`, "");
  }

  if (page.text) {
    parts.push(page.text, "");
  }

  if (includeAnnotations) {
    const annotations = renderAnnotations(page);
    if (annotations) parts.push(annotations);
  }

  return parts.join("\n").trim();
}

export const builtinTextMarkdownEngine: MarkdownConversionEngine = {
  id: "builtin-text",
  name: "Built-in text export",
  async convert(input: MarkdownConversionInput) {
    const ocrTextByPage = new Map(input.ocrPages.map((page) => [page.page, normalizeText(page.text)]));
    const warnings: string[] = [];
    const pages: MarkdownPage[] = [];

    for (let pageNumber = 1; pageNumber <= input.pdfDoc.numPages; pageNumber += 1) {
      input.onProgress?.({
        message: `Reading page ${pageNumber} of ${input.pdfDoc.numPages}`,
        current: pageNumber,
        total: input.pdfDoc.numPages
      });

      const page = await input.pdfDoc.getPage(pageNumber);
      const nativeText = normalizeText(await extractPageText(page));
      const ocrText = ocrTextByPage.get(pageNumber) ?? "";
      const useOcrText = input.settings.useOcrFallback && nativeText.replace(/\s/g, "").length < 100 && ocrText.length > 0;
      const text = useOcrText ? ocrText : nativeText;

      if (!text) {
        warnings.push(`Page ${pageNumber} had no extractable text.`);
      }

      pages.push({
        page: pageNumber,
        text,
        source: useOcrText ? "ocr" : "pdf",
        annotations: input.overlays.filter((overlay) => overlay.page === pageNumber)
      });
    }

    const includePageHeadings = input.settings.exportMode === "page-preserving" || input.settings.includePageMarkers;
    const body = pages
      .map((page) => renderPage(page, includePageHeadings, input.settings.includeAnnotations))
      .filter(Boolean)
      .join("\n\n---\n\n");

    const sourceSummary = pages.some((page) => page.source === "ocr")
      ? "PDF text with OCR fallback"
      : "PDF text";

    const markdown = [`# ${markdownEscape(defaultTitle(input.name))}`, "", `> Exported from ${sourceSummary}.`, "", body].filter(Boolean).join("\n");

    return {
      markdown: `${markdown.trim()}\n`,
      engineId: this.id,
      warnings
    };
  }
};
