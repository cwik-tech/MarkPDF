import type { PDFDocumentProxy } from "pdfjs-dist";

export type ThemeMode = "light" | "dark";
export type ViewMode = "single" | "two";
export type FitMode = "actual" | "page" | "width" | "height";
export type ToolMode = "select" | "text" | "comment" | "highlight" | "signature";

export type OverlayKind = "text" | "comment" | "highlight" | "signature" | "bookmark";

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

export interface MarkdownSearchMatch {
  id: string;
  index: number;
  length: number;
  snippet: string;
}

export type SemanticIndexStatus = "idle" | "checking" | "downloading" | "indexing" | "ready" | "error";

export interface SemanticIndexProgress {
  status: SemanticIndexStatus;
  current?: number;
  total?: number;
  message?: string;
}

export interface SemanticSearchResult {
  id: string;
  page: number;
  snippet: string;
  score: number;
  /** Heading breadcrumb for the chunk. Empty until Phase 2 populates it. */
  headingPath?: string[];
}

export interface SemanticHighlightTarget {
  page: number;
  text: string;
  id: string;
}

export interface OutlineItem {
  id: string;
  title: string;
  page?: number;
  children: OutlineItem[];
}

export type OutlineSource = "native" | "synthetic";

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

export interface ImagePdfSource {
  id: string;
  name: string;
  path?: string;
  bytes: Uint8Array;
  mimeType: string;
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
  outlineSource: OutlineSource | null;
}

export interface PdfTab {
  kind: "pdf";
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
  outlineSource: OutlineSource | null;
  searchQuery: string;
  searchMatches: SearchMatch[];
  activeSearchMatch: number;
  semanticResults: SemanticSearchResult[];
  /** Hash main actually indexed. Searches key off this rather than re-hashing per keystroke. */
  semanticContentHash?: string;
  semanticHighlight?: SemanticHighlightTarget | null;
  semanticIndexStatus?: SemanticIndexStatus;
  semanticIndexProgress?: SemanticIndexProgress;
  semanticIndexError?: string;
  ocrStatus?: OcrStatus;
  ocrProgress?: OcrProgress;
  ocrPages: OcrPageText[];
  ocrError?: string;
  undoStack: TabHistoryState[];
  redoStack: TabHistoryState[];
  dirty: boolean;
}

export interface MarkdownTab {
  kind: "markdown";
  id: string;
  name: string;
  path?: string;
  baseUrl?: string;
  markdown: string;
  searchQuery: string;
  searchMatches: MarkdownSearchMatch[];
  activeSearchMatch: number;
  dirty: boolean;
}

export type DocumentTab = PdfTab | MarkdownTab;
