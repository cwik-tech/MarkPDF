import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MarkdownEngineId, MarkdownExportSettings } from "../global";
import type { OcrPageText } from "../types";
import { extractPageText } from "../pdf/document";

export type ResolvedMarkdownEngineId = Exclude<MarkdownEngineId, "auto">;

export interface MarkdownEngineSelectionProfile {
  sampledPages: number[];
  totalNativeChars: number;
  sparseTextPages: number;
  imagePages: number;
  ocrPages: number;
}

export interface MarkdownEngineSelection {
  engineId: ResolvedMarkdownEngineId;
  reason: string;
  profile: MarkdownEngineSelectionProfile;
}

const sparsePageCharThreshold = 100;
const weakSampleCharThreshold = 600;
const mostlyTextlessPageRatio = 0.6;
const imageHeavyPageRatio = 0.6;

const imagePaintOps = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
]);

function getSamplePages(pageCount: number) {
  const candidates = [1, 2, 3, Math.ceil(pageCount / 2), pageCount].filter(
    (pageNumber) => pageNumber >= 1 && pageNumber <= pageCount,
  );
  return Array.from(new Set(candidates));
}

async function pageHasImageOperation(page: PDFPageProxy) {
  const operatorList = await page.getOperatorList();
  return operatorList.fnArray.some((operator) => imagePaintOps.has(operator));
}

export async function profileMarkdownDocument(
  pdfDoc: PDFDocumentProxy,
  ocrPages: OcrPageText[],
) {
  const sampledPages = getSamplePages(pdfDoc.numPages);
  let totalNativeChars = 0;
  let sparseTextPages = 0;
  let imagePages = 0;

  for (const pageNumber of sampledPages) {
    const page = await pdfDoc.getPage(pageNumber);
    const text = await extractPageText(page);
    const nativeChars = text.replace(/\s/g, "").length;
    totalNativeChars += nativeChars;
    if (nativeChars < sparsePageCharThreshold) sparseTextPages += 1;
    if (await pageHasImageOperation(page)) imagePages += 1;
  }

  return {
    sampledPages,
    totalNativeChars,
    sparseTextPages,
    imagePages,
    ocrPages: ocrPages.length,
  };
}

export async function selectMarkdownEngine(
  pdfDoc: PDFDocumentProxy,
  ocrPages: OcrPageText[],
  settings: MarkdownExportSettings,
): Promise<MarkdownEngineSelection> {
  const manualEngine = settings.defaultEngine;

  if (manualEngine !== "auto") {
    return {
      engineId: manualEngine,
      reason: "Manual Markdown engine selection.",
      profile: {
        sampledPages: [],
        totalNativeChars: 0,
        sparseTextPages: 0,
        imagePages: 0,
        ocrPages: ocrPages.length,
      },
    };
  }

  const profile = await profileMarkdownDocument(pdfDoc, ocrPages);
  const sampledPageCount = Math.max(1, profile.sampledPages.length);
  const textlessRatio = profile.sparseTextPages / sampledPageCount;
  const imageRatio = profile.imagePages / sampledPageCount;
  const weakTextLayer =
    profile.totalNativeChars < weakSampleCharThreshold ||
    textlessRatio >= mostlyTextlessPageRatio;
  const imageHeavy = profile.imagePages > 0 && imageRatio >= imageHeavyPageRatio;
  const ocrAlreadyRan = profile.ocrPages > 0;

  if ((weakTextLayer && imageHeavy) || (weakTextLayer && ocrAlreadyRan)) {
    return {
      engineId: "docling-vlm-smoldocling",
      reason: "Auto selected SmolDocling because sampled pages have weak text and visual content.",
      profile,
    };
  }

  if (weakTextLayer && profile.imagePages > 0) {
    return {
      engineId: "docling-vlm-smoldocling",
      reason: "Auto selected SmolDocling because sampled pages are mostly visual.",
      profile,
    };
  }

  return {
    engineId: "docling-managed",
    reason: "Auto selected standard Docling because sampled pages have a usable text layer.",
    profile,
  };
}
