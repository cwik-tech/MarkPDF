import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OcrPageText, OverlayItem } from "../types";
import type { MarkdownExportSettings } from "../global";

export interface MarkdownPage {
  page: number;
  text: string;
  source: "pdf" | "ocr";
  annotations: OverlayItem[];
}

export interface MarkdownConversionProgress {
  message: string;
  current?: number;
  total?: number;
}

export interface MarkdownConversionInput {
  name: string;
  bytes: Uint8Array;
  pdfDoc: PDFDocumentProxy;
  ocrPages: OcrPageText[];
  overlays: OverlayItem[];
  settings: MarkdownExportSettings;
  onProgress?: (progress: MarkdownConversionProgress) => void;
}

export interface MarkdownConversionResult {
  markdown: string;
  engineId: string;
  warnings: string[];
}

export interface MarkdownConversionEngine {
  id: string;
  name: string;
  convert(input: MarkdownConversionInput): Promise<MarkdownConversionResult>;
}
