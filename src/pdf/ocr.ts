import type { PDFDocumentProxy } from "pdfjs-dist";
import Tesseract from "tesseract.js";
import type { OcrPageText, OcrProgress } from "../types";
import { extractPageText } from "./document";

const ocrAssetBase = `${import.meta.env.BASE_URL}tesseract/`;
const ocrCoreBase = `${import.meta.env.BASE_URL}tesseract-core/`;
const renderScale = 2;
const minimumSampleChars = 360;
const minimumPageChars = 24;
const mostlyTextlessPageRatio = 0.6;

export interface TextDensityResult {
  shouldRunOcr: boolean;
  totalChars: number;
  textlessPages: number;
  pageCount: number;
}

export async function detectOcrNeed(pdfDoc: PDFDocumentProxy): Promise<TextDensityResult> {
  const sampledPages = getTextDensitySamplePages(pdfDoc.numPages);
  let totalChars = 0;
  let textlessPages = 0;

  for (const pageNumber of sampledPages) {
    const page = await pdfDoc.getPage(pageNumber);
    const text = await extractPageText(page);
    const chars = text.replace(/\s/g, "").length;
    totalChars += chars;
    if (chars < minimumPageChars) textlessPages += 1;
  }

  return {
    shouldRunOcr:
      totalChars < Math.max(minimumSampleChars, sampledPages.length * minimumPageChars) ||
      textlessPages / sampledPages.length >= mostlyTextlessPageRatio,
    totalChars,
    textlessPages,
    pageCount: sampledPages.length
  };
}

function getTextDensitySamplePages(pageCount: number) {
  const candidates = [1, 2, 3, Math.ceil(pageCount / 2), pageCount].filter(
    (pageNumber) => pageNumber >= 1 && pageNumber <= pageCount
  );
  return Array.from(new Set(candidates));
}

export async function runDocumentOcr(
  pdfDoc: PDFDocumentProxy,
  options: {
    isCancelled: () => boolean;
    onProgress: (progress: OcrProgress) => void;
  }
): Promise<OcrPageText[]> {
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${ocrAssetBase}worker.min.js`,
    corePath: ocrCoreBase,
    logger: (message) => {
      if (message.status === "recognizing text") {
        options.onProgress({
          status: "running",
          progress: message.progress,
          message: "Recognizing text"
        });
      }
    }
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1"
    });

    const pages: OcrPageText[] = [];

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      if (options.isCancelled()) break;

      options.onProgress({
        status: "running",
        page: pageNumber,
        totalPages: pdfDoc.numPages,
        progress: 0,
        message: `OCR page ${pageNumber} of ${pdfDoc.numPages}`
      });

      const page = await pdfDoc.getPage(pageNumber);
      const canvas = document.createElement("canvas");
      const viewport = page.getViewport({ scale: renderScale });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) continue;

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: context, viewport, background: "white" }).promise;

      const result = await worker.recognize(canvas, {}, { blocks: true, text: true });
      pages.push({
        page: pageNumber,
        text: result.data.text.replace(/\s+/g, " ").trim(),
        lines: extractOcrLines(result.data.blocks, renderScale)
      });

      canvas.width = 0;
      canvas.height = 0;
    }

    return pages;
  } finally {
    await worker.terminate();
  }
}

function extractOcrLines(blocks: Tesseract.Block[] | null, scale: number) {
  if (!blocks) return [];

  return blocks
    .flatMap((block) => block.paragraphs)
    .flatMap((paragraph) => paragraph.lines)
    .map((line) => ({
      text: line.text.replace(/\s+/g, " ").trim(),
      x: line.bbox.x0 / scale,
      y: line.bbox.y0 / scale,
      width: Math.max(4, (line.bbox.x1 - line.bbox.x0) / scale),
      height: Math.max(4, (line.bbox.y1 - line.bbox.y0) / scale)
    }))
    .filter((line) => line.text.length > 0);
}
