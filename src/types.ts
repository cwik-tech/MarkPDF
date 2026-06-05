import type { PDFDocumentProxy } from "pdfjs-dist";

export type ThemeMode = "light" | "dark";
export type ViewMode = "single" | "two";
export type FitMode = "actual" | "page" | "width" | "height";
export type ToolMode = "select" | "text" | "comment" | "highlight" | "signature";

export type OverlayKind = "text" | "comment" | "highlight" | "signature";

export interface OverlayItem {
  id: string;
  kind: OverlayKind;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  color?: string;
  dataUrl?: string;
  minimized?: boolean;
}

export type FormFieldKind = "text" | "checkbox" | "dropdown" | "radio" | "unknown";

export interface FormFieldState {
  name: string;
  kind: FormFieldKind;
  value: string | boolean;
  options?: string[];
}

export interface SearchMatch {
  id: string;
  page: number;
  index: number;
  snippet: string;
  source: "pdf" | "ocr";
}

export interface OutlineItem {
  id: string;
  title: string;
  page?: number;
  children: OutlineItem[];
}

export interface OcrTextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrPageText {
  page: number;
  text: string;
  lines: OcrTextLine[];
}

export type OcrStatus = "checking" | "running" | "ready" | "skipped" | "error";

export interface OcrProgress {
  status: OcrStatus;
  page?: number;
  totalPages?: number;
  progress?: number;
  message?: string;
}

export interface TabHistoryState {
  bytes: Uint8Array;
  currentPage: number;
  overlays: OverlayItem[];
  formFields: FormFieldState[];
  outline: OutlineItem[];
}

export interface PdfTab {
  id: string;
  name: string;
  path?: string;
  bytes: Uint8Array;
  pdfDoc: PDFDocumentProxy;
  pageCount: number;
  currentPage: number;
  zoom: number;
  rotation: number;
  viewMode: ViewMode;
  fitMode: FitMode;
  scrolling: boolean;
  overlays: OverlayItem[];
  formFields: FormFieldState[];
  outline: OutlineItem[];
  searchQuery: string;
  searchMatches: SearchMatch[];
  activeSearchMatch: number;
  ocrStatus?: OcrStatus;
  ocrProgress?: OcrProgress;
  ocrPages: OcrPageText[];
  ocrError?: string;
  undoStack: TabHistoryState[];
  redoStack: TabHistoryState[];
  dirty: boolean;
}
