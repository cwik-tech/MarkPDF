import type { PDFDocumentProxy } from "pdfjs-dist";

export type ThemeMode = "light" | "dark";
export type ViewMode = "single" | "two";
export type FitMode = "actual" | "page" | "width" | "height";
export type ToolMode = "select" | "text" | "comment" | "highlight" | "signature";

export type OverlayKind = "text" | "comment" | "highlight" | "signature" | "bookmark";

/** A rectangle in unrotated page coordinates at zoom 1: the space overlays are stored in. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /**
   * The rectangles of the text this overlay is anchored to, as offsets from `x`/`y`.
   *
   * Present only on an overlay a reader made from a text selection, where the browser reported one
   * rectangle per line the selection crossed. Absent — as on every overlay written before this
   * field existed, and on every overlay placed by hand — means the overlay is the single box that
   * `x`, `y`, `width` and `height` describe. `overlayGeometry` in `pdf/overlayGeometry.ts` is the
   * one place that reads this distinction.
   */
  fragments?: OverlayRect[];
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
  /** Position of the match among the preview's highlights, top to bottom. */
  ordinal: number;
  snippet: string;
}

export type SemanticIndexStatus =
  | "idle"
  /** Looking at what is already stored, and reading the document's pages. */
  | "checking"
  /** Recognising the pages the extractor could not read, before any embedding exists. */
  | "ocr"
  | "downloading"
  | "indexing"
  | "ready"
  | "error";

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
  /**
   * Whether the reader has already been shown what the text-layer check decided.
   *
   * The result is worth saying once — a document with native text is not being recognised, and
   * silence used to be the only way to learn that — and worth taking away again, because a
   * permanent badge for a finished check is noise.
   */
  ocrNoticeDismissed?: boolean;
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
