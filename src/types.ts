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
}

export type FormFieldKind = "text" | "checkbox" | "dropdown" | "radio" | "unknown";

export interface FormFieldState {
  name: string;
  kind: FormFieldKind;
  value: string | boolean;
  options?: string[];
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
  dirty: boolean;
}
