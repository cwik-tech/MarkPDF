import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts
} from "pdf-lib";
import type {
  FormFieldState,
  ImagePdfSource,
  OcrPageText,
  OutlineItem,
  OutlineSource,
  OverlayItem,
  OverlayRect,
  SearchMatch
} from "../types";
import { overlayGeometry, paintedPageRects } from "./overlayGeometry";
import { parsePersistedOverlays } from "./overlayMetadata";

const pdfAssetBase = `${import.meta.env.BASE_URL}pdfjs/`;
const pdfWorkerSrc =
  import.meta.env.MODE === "test"
    ? new URL("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href
    : pdfWorker;
const overlayMetadataPrefix = "markpdf-overlays:";
const legacyOverlayMetadataPrefix = "open-pdf-reader-overlays:";
const syntheticOutlineMetadataPrefix = "markpdf-outline:";
const standardAnnotationNamePrefix = "markpdf:";
const legacyStandardAnnotationNamePrefix = "open-pdf-reader:";
const standardAnnotationAuthor = "MarkPDF";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export interface DocumentOutline {
  outline: OutlineItem[];
  source: OutlineSource | null;
  generated: boolean;
}

interface ExtractDocumentOutlineOptions {
  preferPersistedSynthetic?: boolean;
}

interface SyntheticTextAtom {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontName: string;
}

interface SyntheticTextLine {
  text: string;
  page: number;
  pageHeight: number;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  bold: boolean;
}

export async function loadPdfDocument(bytes: Uint8Array, password?: string) {
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${pdfAssetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
    wasmUrl: `${pdfAssetBase}wasm/`,
    useSystemFonts: true
  }).promise;
}

export function isPasswordError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "PasswordException" || /password/i.test(error.message);
}

export async function extractOutline(pdfDoc: pdfjsLib.PDFDocumentProxy): Promise<OutlineItem[]> {
  const outline = await pdfDoc.getOutline();
  if (!outline) return [];

  async function normalize(items: Awaited<ReturnType<typeof pdfDoc.getOutline>>, path: string): Promise<OutlineItem[]> {
    if (!items) return [];

    return Promise.all(
      items.map(async (item, index) => {
        const id = `${path}-${index}`;
        const page = await resolveOutlinePage(pdfDoc, item.dest);
        return {
          id,
          title: item.title || "Untitled",
          page,
          children: await normalize(item.items, id)
        };
      })
    );
  }

  return normalize(outline, "outline");
}

export async function extractDocumentOutline(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  bytes?: Uint8Array,
  options: ExtractDocumentOutlineOptions = {}
): Promise<DocumentOutline> {
  const nativeOutline = await extractOutline(pdfDoc);
  if (nativeOutline.length > 0) {
    return { outline: nativeOutline, source: "native", generated: false };
  }

  if (bytes && options.preferPersistedSynthetic !== false) {
    const persistedOutline = await extractPersistedSyntheticOutline(bytes);
    if (persistedOutline.length > 0) {
      return { outline: persistedOutline, source: "synthetic", generated: false };
    }
  }

  const syntheticOutline = await extractSyntheticOutline(pdfDoc);
  return {
    outline: syntheticOutline,
    source: syntheticOutline.length > 0 ? "synthetic" : null,
    generated: syntheticOutline.length > 0
  };
}

export async function extractSyntheticOutline(pdfDoc: pdfjsLib.PDFDocumentProxy): Promise<OutlineItem[]> {
  const lines: SyntheticTextLine[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    lines.push(...groupSyntheticTextLines(textContent.items, pageNumber, viewport.height));
  }

  if (lines.length === 0) return [];

  const bodyFontSize = median(
    lines
      .map((line) => line.fontSize)
      .filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0)
  );
  const repeatedPages = getRepeatedLinePages(lines);
  const candidates = lines.filter((line) =>
    isSyntheticHeadingCandidate(line, bodyFontSize, repeatedPages.get(normalizeSyntheticHeadingText(line.text))?.size ?? 0, pdfDoc.numPages)
  );

  if (candidates.length === 0) return [];

  const fontBands = getSyntheticHeadingFontBands(candidates);
  const stack: Array<{ level: number; children: OutlineItem[] }> = [{ level: 0, children: [] }];

  candidates.slice(0, 250).forEach((line, index) => {
    const level = getSyntheticHeadingLevel(line, bodyFontSize, fontBands);
    const item: OutlineItem = {
      id: `synthetic-outline-${line.page}-${index}`,
      title: cleanSyntheticHeadingTitle(line.text),
      page: line.page,
      children: []
    };

    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    stack[stack.length - 1].children.push(item);
    stack.push({ level, children: item.children });
  });

  return stack[0].children;
}

export async function extractPersistedSyntheticOutline(bytes: Uint8Array): Promise<OutlineItem[]> {
  try {
    const pdfDoc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
    const encoded = getKeywordEntries(pdfDoc)
      .map((keyword) => readSyntheticOutlineKeyword(keyword.trim()))
      .find((value) => value !== null);

    if (!encoded) return [];
    return normalizePersistedOutlineItems(JSON.parse(decodeBase64Json(encoded)), "outline");
  } catch {
    return [];
  }
}

async function resolveOutlinePage(pdfDoc: pdfjsLib.PDFDocumentProxy, dest: unknown) {
  try {
    const resolved = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved[0]) return undefined;
    return (await pdfDoc.getPageIndex(resolved[0])) + 1;
  } catch {
    return undefined;
  }
}

function groupSyntheticTextLines(items: unknown[], page: number, pageHeight: number): SyntheticTextLine[] {
  const atoms = items
    .map(toSyntheticTextAtom)
    .filter((atom): atom is SyntheticTextAtom => atom !== null)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const grouped: SyntheticTextAtom[][] = [];

  for (const atom of atoms) {
    const current = grouped[grouped.length - 1];
    const currentFontSize = current ? median(current.map((item) => item.fontSize)) : atom.fontSize;
    const sameLineTolerance = Math.max(2, Math.max(currentFontSize, atom.fontSize) * 0.35);

    if (current && Math.abs(median(current.map((item) => item.y)) - atom.y) <= sameLineTolerance) {
      current.push(atom);
    } else {
      grouped.push([atom]);
    }
  }

  return grouped
    .map((line) => {
      const ordered = [...line].sort((a, b) => a.x - b.x);
      const text = ordered
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const left = Math.min(...ordered.map((item) => item.x));
      const right = Math.max(...ordered.map((item) => item.x + item.width));

      return {
        text,
        page,
        pageHeight,
        x: left,
        y: median(ordered.map((item) => item.y)),
        width: Math.max(0, right - left),
        fontSize: median(ordered.map((item) => item.fontSize)),
        bold: ordered.some((item) => /bold|black|heavy|semibold/i.test(item.fontName))
      };
    })
    .filter((line) => line.text.length > 0);
}

function toSyntheticTextAtom(item: unknown): SyntheticTextAtom | null {
  if (!item || typeof item !== "object" || !("str" in item)) return null;

  const text = String((item as { str?: unknown }).str ?? "").trim();
  if (!text) return null;

  const rawTransform = (item as { transform?: unknown }).transform;
  const transform = Array.isArray(rawTransform) ? rawTransform : [];
  const x = toFiniteNumber(transform[4]);
  const y = toFiniteNumber(transform[5]);
  if (x === null || y === null) return null;

  const width = toFiniteNumber((item as { width?: unknown }).width) ?? 0;
  const height = toFiniteNumber((item as { height?: unknown }).height) ?? 0;
  const transformFontSize = Math.max(
    Math.abs(toFiniteNumber(transform[0]) ?? 0),
    Math.abs(toFiniteNumber(transform[3]) ?? 0)
  );
  const fontSize = Math.max(transformFontSize, Math.abs(height), 1);

  return {
    text,
    x,
    y,
    width,
    fontSize,
    fontName: String((item as { fontName?: unknown }).fontName ?? "")
  };
}

function isSyntheticHeadingCandidate(line: SyntheticTextLine, bodyFontSize: number, repeatedPageCount: number, pageCount: number) {
  const title = cleanSyntheticHeadingTitle(line.text);
  const words = title.split(/\s+/).filter(Boolean);
  const numberedDepth = getNumberedHeadingDepth(title);
  const prominent = line.fontSize >= bodyFontSize * 1.12;
  const veryProminent = line.fontSize >= bodyFontSize * 1.28;
  const sentenceLike = words.length > 10 && /[.!?]$/.test(title);
  const repeatedAcrossPages = repeatedPageCount >= 3 && repeatedPageCount / Math.max(1, pageCount) >= 0.25;
  const nearFooter = line.y < line.pageHeight * 0.08;

  if (title.length < 3 || title.length > 140) return false;
  if (words.length > 22) return false;
  if (/^\d+$/.test(title) || /^page\s+\d+/i.test(title)) return false;
  if (/^\d{4}[.)]/.test(title) || /https?:\/\//i.test(title) || /\bwww\./i.test(title)) return false;
  if (/^[\d\s._-]+$/.test(title)) return false;
  if (repeatedAcrossPages) return false;
  if (nearFooter && !numberedDepth) return false;
  if (numberedDepth && line.fontSize < bodyFontSize * 1.08 && !line.bold) return false;

  if (numberedDepth && words.length <= 22) return true;
  if (veryProminent && words.length <= 18) return true;
  if (prominent && words.length <= 14 && !sentenceLike) return true;
  return line.bold && line.fontSize >= bodyFontSize * 1.04 && words.length <= 16 && !sentenceLike;
}

function getSyntheticHeadingLevel(line: SyntheticTextLine, bodyFontSize: number, fontBands: number[]) {
  const numberedDepth = getNumberedHeadingDepth(line.text);
  if (numberedDepth) return Math.min(3, numberedDepth);

  const fontBandIndex = fontBands.findIndex((fontSize) => Math.abs(fontSize - line.fontSize) <= 0.75);
  if (fontBandIndex >= 0) return Math.min(3, fontBandIndex + 1);
  if (line.fontSize >= bodyFontSize * 1.35) return 1;
  if (line.fontSize >= bodyFontSize * 1.18) return 2;
  return 3;
}

function getNumberedHeadingDepth(text: string) {
  const match = cleanSyntheticHeadingTitle(text).match(/^(\d+(?:\.\d+){0,4})([.)])?\s+\S/);
  if (!match) return null;
  if (!match[1].includes(".") && !match[2]) return null;
  return match[1].split(".").length;
}

function getRepeatedLinePages(lines: SyntheticTextLine[]) {
  const repeatedPages = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = normalizeSyntheticHeadingText(line.text);
    if (!key) continue;
    const pages = repeatedPages.get(key) ?? new Set<number>();
    pages.add(line.page);
    repeatedPages.set(key, pages);
  }
  return repeatedPages;
}

function getSyntheticHeadingFontBands(lines: SyntheticTextLine[]) {
  return [...lines]
    .map((line) => line.fontSize)
    .sort((a, b) => b - a)
    .reduce<number[]>((bands, fontSize) => {
      if (!bands.some((existing) => Math.abs(existing - fontSize) <= 0.75)) {
        bands.push(fontSize);
      }
      return bands;
    }, [])
    .slice(0, 3);
}

function cleanSyntheticHeadingTitle(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeSyntheticHeadingText(text: string) {
  return cleanSyntheticHeadingTitle(text).toLowerCase();
}

function toFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 1;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export async function detectFormFields(bytes: Uint8Array): Promise<FormFieldState[]> {
  try {
    const pdfDoc = await PDFDocument.load(bytes.slice());
    const form = pdfDoc.getForm();

    return form.getFields().map((field) => {
      const name = field.getName();

      if (field instanceof PDFTextField) {
        return { name, kind: "text", value: field.getText() ?? "" };
      }

      if (field instanceof PDFCheckBox) {
        return { name, kind: "checkbox", value: field.isChecked() };
      }

      if (field instanceof PDFDropdown) {
        return {
          name,
          kind: "dropdown",
          value: field.getSelected()[0] ?? "",
          options: field.getOptions()
        };
      }

      if (field instanceof PDFRadioGroup) {
        return {
          name,
          kind: "radio",
          value: field.getSelected() ?? "",
          options: field.getOptions()
        };
      }

      return { name, kind: "unknown", value: "" };
    });
  } catch {
    return [];
  }
}

export async function extractPageText(page: pdfjsLib.PDFPageProxy) {
  const textContent = await page.getTextContent();
  return textContent.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function findTextMatches(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  query: string,
  ocrPages: OcrPageText[] = []
): Promise<SearchMatch[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const matches: SearchMatch[] = [];
  const ocrTextByPage = new Map(ocrPages.map((page) => [page.page, page.text]));

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const page = await pdfDoc.getPage(pageNumber);
    const nativeText = await extractPageText(page);
    const ocrText = ocrTextByPage.get(pageNumber) ?? "";
    const useOcrText = nativeText.replace(/\s/g, "").length < 100 && ocrText.length > 0;
    const source = useOcrText ? "ocr" : "pdf";
    const pageText = useOcrText ? ocrText : nativeText;
    const lowerText = pageText.toLowerCase();
    let index = lowerText.indexOf(normalizedQuery);

    while (index >= 0) {
      const start = Math.max(0, index - 42);
      const end = Math.min(pageText.length, index + normalizedQuery.length + 42);
      matches.push({
        id: `${pageNumber}-${index}`,
        page: pageNumber,
        index,
        snippet: `${start > 0 ? "..." : ""}${pageText.slice(start, end)}${end < pageText.length ? "..." : ""}`,
        source
      });
      index = lowerText.indexOf(normalizedQuery, index + normalizedQuery.length);
    }
  }

  return matches;
}

export async function extractEditableOverlays(bytes: Uint8Array): Promise<OverlayItem[]> {
  try {
    const pdfDoc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
    const encoded = getKeywordEntries(pdfDoc)
      .map((keyword) => readEditableOverlayKeyword(keyword))
      .find((encoded) => encoded !== null);

    if (!encoded) return [];
    // Anything could have written this keyword, so it is checked field by field rather than
    // trusted for having parsed. `parsePersistedOverlays` also decides what an entry with no
    // fragments means: the single box that every version before text anchoring wrote.
    return parsePersistedOverlays(JSON.parse(decodeBase64Json(encoded)));
  } catch {
    return [];
  }
}

export async function exportPdfBytes(
  sourceBytes: Uint8Array,
  overlays: OverlayItem[],
  formFields: FormFieldState[],
  flattenForms: boolean,
  options: {
    bakeOverlays?: boolean;
    persistEditable?: boolean;
    writeStandardAnnotations?: boolean;
    persistSyntheticOutline?: boolean;
    syntheticOutline?: OutlineItem[];
  } = {}
) {
  const pdfDoc = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: true });
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const timesItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const form = pdfDoc.getForm();

  for (const field of formFields) {
    try {
      if (field.kind === "text") {
        form.getTextField(field.name).setText(String(field.value));
      } else if (field.kind === "checkbox") {
        const checkbox = form.getCheckBox(field.name);
        if (field.value) checkbox.check();
        else checkbox.uncheck();
      } else if (field.kind === "dropdown") {
        form.getDropdown(field.name).select(String(field.value));
      } else if (field.kind === "radio") {
        form.getRadioGroup(field.name).select(String(field.value));
      }
    } catch {
      // Some PDFs contain malformed or unsupported fields; keep exporting the rest.
    }
  }

  try {
    form.updateFieldAppearances(helvetica);
    if (flattenForms) {
      form.flatten();
    }
  } catch {
    // Export should not fail solely because a PDF has broken form appearances.
  }

  const pages = pdfDoc.getPages();
  const bakeOverlays = options.bakeOverlays ?? true;
  const writeStandardAnnotations = options.writeStandardAnnotations ?? true;

  if (options.persistEditable) {
    writeEditableOverlayMetadata(pdfDoc, overlays);
  } else if (bakeOverlays) {
    clearEditableOverlayMetadata(pdfDoc);
  }

  if (options.persistSyntheticOutline) {
    writeSyntheticOutlineMetadata(pdfDoc, options.syntheticOutline ?? []);
  }

  if (writeStandardAnnotations || bakeOverlays) {
    removeMarkPdfAnnotations(pdfDoc);
  }

  if (writeStandardAnnotations) {
    writeMarkPdfAnnotations(pdfDoc, overlays);
  }

  for (const overlay of overlays.filter((overlay) => bakeOverlays || overlay.kind === "text")) {
    const page = pages[overlay.page - 1];
    if (!page) continue;

    const pageHeight = page.getHeight();
    const geometry = overlayGeometry(overlay);
    const x = overlay.x;
    const y = pageHeight - overlay.y - overlay.height;
    const width = overlay.width;
    const height = overlay.height;
    const color = hexToRgb(overlay.color ?? "#111827");

    if (overlay.kind === "text") {
      page.drawText(overlay.text || "Text", {
        x,
        y: y + height - (overlay.fontSize ?? 16),
        size: overlay.fontSize ?? 16,
        font: helvetica,
        color: rgb(color.r, color.g, color.b),
        maxWidth: width
      });
    }

    if (overlay.kind === "comment") {
      if (geometry.shape === "textSelection") {
        // A comment anchored to text is drawn where the text is, one line at a time. The note it
        // carries travels as the annotation's contents; painting prose over the sentence it
        // annotates is what this fix exists to stop.
        for (const rect of paintedPageRects(geometry)) {
          page.drawRectangle({
            ...pageRectToPdfBox(pageHeight, rect),
            color: rgb(1, 0.88, 0.1),
            opacity: 0.35
          });
        }
      } else {
        page.drawRectangle({
          x,
          y,
          width,
          height,
          color: rgb(1, 0.88, 0.35),
          opacity: 0.9,
          borderColor: rgb(0.67, 0.49, 0.08),
          borderWidth: 1
        });
        page.drawText(overlay.text || "Comment", {
          x: x + 6,
          y: y + height - 16,
          size: 10,
          font: helveticaBold,
          color: rgb(0.2, 0.16, 0.05),
          maxWidth: Math.max(10, width - 12)
        });
      }
    }

    if (overlay.kind === "highlight") {
      // One rectangle for a highlight the reader placed; one per line for one they dragged across
      // text, so the blank page between two lines stays blank.
      for (const rect of paintedPageRects(geometry)) {
        page.drawRectangle({
          ...pageRectToPdfBox(pageHeight, rect),
          color: rgb(1, 0.88, 0.1),
          opacity: 0.35
        });
      }
    }

    if (overlay.kind === "signature") {
      if (overlay.dataUrl) {
        const image = await embedSignatureImage(pdfDoc, overlay.dataUrl);
        page.drawImage(image, { x, y, width, height });
      } else {
        page.drawText(overlay.text || "Signature", {
          x,
          y: y + Math.max(4, height * 0.25),
          size: overlay.fontSize ?? 28,
          font: timesItalic,
          color: rgb(0.05, 0.08, 0.12),
          maxWidth: width
        });
      }
    }
  }

  return pdfDoc.save();
}

export async function createPdfFromImages(
  images: ImagePdfSource[],
  onProgress?: (progress: { current: number; total: number; imageName: string }) => void | Promise<void>
) {
  const pdfDoc = await PDFDocument.create();

  for (const [index, image] of images.entries()) {
    await onProgress?.({ current: index + 1, total: images.length, imageName: image.name });
    const embedded = await embedPageImage(pdfDoc, image);
    const { width, height } = scaleImagePage(embedded.width, embedded.height);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded.image, { x: 0, y: 0, width, height });
  }

  return pdfDoc.save();
}

async function embedPageImage(pdfDoc: PDFDocument, source: ImagePdfSource) {
  const normalizedMime = source.mimeType.toLowerCase();

  if (normalizedMime.includes("jpeg") || normalizedMime.includes("jpg") || /\.(jpe?g)$/i.test(source.name)) {
    const image = await pdfDoc.embedJpg(source.bytes);
    return { image, width: image.width, height: image.height };
  }

  if (normalizedMime.includes("png") || /\.png$/i.test(source.name)) {
    const image = await pdfDoc.embedPng(source.bytes);
    return { image, width: image.width, height: image.height };
  }

  const converted = await convertImageToPng(source);
  const image = await pdfDoc.embedPng(converted.bytes);
  return { image, width: converted.width, height: converted.height };
}

async function convertImageToPng(source: ImagePdfSource) {
  const buffer = new ArrayBuffer(source.bytes.byteLength);
  new Uint8Array(buffer).set(source.bytes);
  const blob = new Blob([buffer], { type: source.mimeType });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadBrowserImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error(`Could not decode "${source.name}".`);
    }

    context.drawImage(image, 0, 0);
    const convertedBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error(`Could not convert "${source.name}".`));
      }, "image/png");
    });

    return {
      bytes: new Uint8Array(await convertedBlob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadBrowserImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image decode failed."));
    image.src = url;
  });
}

function scaleImagePage(width: number, height: number) {
  const maxPageEdge = 1440;
  const minPageEdge = 144;
  const longestEdge = Math.max(width, height, 1);
  const scale = longestEdge > maxPageEdge ? maxPageEdge / longestEdge : longestEdge < minPageEdge ? minPageEdge / longestEdge : 1;

  return {
    width: width * scale,
    height: height * scale
  };
}

function writeEditableOverlayMetadata(pdfDoc: PDFDocument, overlays: OverlayItem[]) {
  const existingKeywords = getKeywordsWithoutEditableOverlayMetadata(pdfDoc);
  const editableOverlays = overlays.filter(
    (overlay) =>
      overlay.kind === "highlight" ||
      overlay.kind === "comment" ||
      overlay.kind === "signature" ||
      overlay.kind === "bookmark"
  );
  const encoded = encodeBase64Json(JSON.stringify(editableOverlays));
  pdfDoc.setKeywords([...existingKeywords, `${overlayMetadataPrefix}${encoded}`]);
}

function clearEditableOverlayMetadata(pdfDoc: PDFDocument) {
  pdfDoc.setKeywords(getKeywordsWithoutEditableOverlayMetadata(pdfDoc));
}

function getKeywordsWithoutEditableOverlayMetadata(pdfDoc: PDFDocument) {
  return getKeywordEntries(pdfDoc)
    .filter(Boolean)
    .filter((keyword) => readEditableOverlayKeyword(keyword) === null);
}

function writeSyntheticOutlineMetadata(pdfDoc: PDFDocument, outline: OutlineItem[]) {
  const existingKeywords = getKeywordsWithoutSyntheticOutlineMetadata(pdfDoc);
  if (outline.length === 0) {
    pdfDoc.setKeywords(existingKeywords);
    return;
  }

  const encoded = encodeBase64Json(JSON.stringify(outline));
  pdfDoc.setKeywords([...existingKeywords, `${syntheticOutlineMetadataPrefix}${encoded}`]);
}

function getKeywordsWithoutSyntheticOutlineMetadata(pdfDoc: PDFDocument) {
  return getKeywordEntries(pdfDoc)
    .filter(Boolean)
    .filter((keyword) => readSyntheticOutlineKeyword(keyword) === null);
}

function getKeywordEntries(pdfDoc: PDFDocument) {
  return (pdfDoc.getKeywords() ?? "")
    .split(/[\s,]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

export async function insertBlankPageAfter(sourceBytes: Uint8Array, pageNumber: number) {
  const pdfDoc = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: true });
  const referencePage = pdfDoc.getPage(Math.max(0, Math.min(pdfDoc.getPageCount() - 1, pageNumber - 1)));
  pdfDoc.insertPage(Math.min(pdfDoc.getPageCount(), pageNumber), [referencePage.getWidth(), referencePage.getHeight()]);
  return pdfDoc.save();
}

export async function deletePdfPage(sourceBytes: Uint8Array, pageNumber: number) {
  const pdfDoc = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: true });
  if (pdfDoc.getPageCount() <= 1) {
    return sourceBytes.slice();
  }

  pdfDoc.removePage(Math.max(0, Math.min(pdfDoc.getPageCount() - 1, pageNumber - 1)));
  return pdfDoc.save();
}

export async function movePdfPage(sourceBytes: Uint8Array, pageNumber: number, direction: -1 | 1) {
  const pdfDoc = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();
  const fromIndex = pageNumber - 1;
  const toIndex = fromIndex + direction;

  if (fromIndex < 0 || fromIndex >= pageCount || toIndex < 0 || toIndex >= pageCount) {
    return sourceBytes.slice();
  }

  const page = pdfDoc.getPage(fromIndex);
  pdfDoc.removePage(fromIndex);
  pdfDoc.insertPage(toIndex, page);
  return pdfDoc.save();
}

export async function movePdfPageTo(sourceBytes: Uint8Array, fromPage: number, toPage: number) {
  const pdfDoc = await PDFDocument.load(sourceBytes.slice(), { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();
  const fromIndex = fromPage - 1;
  const toIndex = toPage - 1;

  if (fromIndex < 0 || fromIndex >= pageCount || toIndex < 0 || toIndex >= pageCount || fromIndex === toIndex) {
    return sourceBytes.slice();
  }

  const page = pdfDoc.getPage(fromIndex);
  pdfDoc.removePage(fromIndex);
  pdfDoc.insertPage(toIndex, page);
  return pdfDoc.save();
}

function writeMarkPdfAnnotations(pdfDoc: PDFDocument, overlays: OverlayItem[]) {
  const pages = pdfDoc.getPages();

  for (const overlay of overlays.filter((item) => item.kind === "comment" || item.kind === "highlight")) {
    const page = pages[overlay.page - 1];
    if (!page) continue;

    const pageHeight = page.getHeight();
    const geometry = overlayGeometry(overlay);
    const rect = pageRectToPdfRect(pageHeight, geometry.bounds);
    const annots = getPageAnnotations(pdfDoc, page);
    // A comment the reader dropped on the page is a note pinned to a point, and stays a Text
    // annotation. A comment they made by dragging across text is about that text, so it travels as
    // text markup: the same quadrilaterals a highlight would carry, with the note as its contents.
    const annotation =
      overlay.kind === "comment" && geometry.shape === "box"
        ? createTextNoteAnnotation(pdfDoc, overlay, rect)
        : createHighlightAnnotation(
            pdfDoc,
            overlay,
            rect,
            paintedPageRects(geometry).map((fragment) => pageRectToPdfRect(pageHeight, fragment))
          );

    annots.push(pdfDoc.context.register(annotation));
  }
}

function removeMarkPdfAnnotations(pdfDoc: PDFDocument) {
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;

    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annotation = annots.lookupMaybe(index, PDFDict);
      if (annotation && isMarkPdfAnnotation(annotation)) {
        const ref = annots.get(index);
        annots.remove(index);
        if (ref instanceof PDFRef) {
          pdfDoc.context.delete(ref);
        }
      }
    }

    if (annots.size() === 0) {
      page.node.delete(PDFName.of("Annots"));
    }
  }
}

function getPageAnnotations(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number]
) {
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray) ?? pdfDoc.context.obj([]);

  if (!page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)) {
    page.node.set(PDFName.of("Annots"), annots);
  }

  return annots;
}

function createTextNoteAnnotation(pdfDoc: PDFDocument, overlay: OverlayItem, rect: PdfRect) {
  const noteSize = 24;
  const left = rect.left;
  const top = rect.top;

  return pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [left, Math.max(rect.bottom, top - noteSize), left + noteSize, top],
    Contents: PDFString.of(overlay.text || "Comment"),
    T: PDFString.of(standardAnnotationAuthor),
    Subj: PDFString.of("Comment"),
    NM: PDFString.of(`${standardAnnotationNamePrefix}${overlay.id}`),
    M: PDFString.fromDate(new Date()),
    Name: PDFName.of("Comment"),
    C: [1, 0.88, 0.1],
    F: 4,
    Open: false
  });
}

/**
 * A text-markup annotation: one enclosing rectangle, and one quadrilateral per line it covers.
 *
 * `QuadPoints` is what every other PDF application draws from, so a selection that crossed two
 * lines has to arrive as two quadrilaterals. Sending the enclosing rectangle alone would make the
 * other reader paint the blank band between the lines, which is the same defect one layer down.
 */
function createHighlightAnnotation(
  pdfDoc: PDFDocument,
  overlay: OverlayItem,
  rect: PdfRect,
  quads: readonly PdfRect[]
) {
  const color = hexToRgb(overlay.color ?? "#facc15");
  const contents = overlay.text?.trim() || (overlay.kind === "comment" ? "Comment" : "Highlight");

  return pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [rect.left, rect.bottom, rect.right, rect.top],
    QuadPoints: quads.flatMap((quad) => [
      quad.left,
      quad.top,
      quad.right,
      quad.top,
      quad.left,
      quad.bottom,
      quad.right,
      quad.bottom
    ]),
    Contents: PDFString.of(contents),
    T: PDFString.of(standardAnnotationAuthor),
    Subj: PDFString.of(overlay.kind === "comment" ? "Comment" : "Highlight"),
    NM: PDFString.of(`${standardAnnotationNamePrefix}${overlay.id}`),
    M: PDFString.fromDate(new Date()),
    C: [color.r, color.g, color.b],
    CA: 0.35,
    F: 4
  });
}

interface PdfRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A page rectangle — measured from the top-left — as a PDF rectangle measured from the bottom. */
function pageRectToPdfRect(pageHeight: number, rect: OverlayRect): PdfRect {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = pageHeight - rect.y;
  const bottom = pageHeight - rect.y - rect.height;

  return {
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.max(top, bottom),
    bottom: Math.min(top, bottom)
  };
}

/** The same conversion in the corner-and-size form `drawRectangle` takes. */
function pageRectToPdfBox(pageHeight: number, rect: OverlayRect) {
  const pdfRect = pageRectToPdfRect(pageHeight, rect);
  return {
    x: pdfRect.left,
    y: pdfRect.bottom,
    width: pdfRect.right - pdfRect.left,
    height: pdfRect.top - pdfRect.bottom
  };
}

function isMarkPdfAnnotation(annotation: PDFDict) {
  const name = getPdfText(annotation, "NM");
  return name.startsWith(standardAnnotationNamePrefix) || name.startsWith(legacyStandardAnnotationNamePrefix);
}

function readEditableOverlayKeyword(keyword: string) {
  if (keyword.startsWith(overlayMetadataPrefix)) {
    return keyword.slice(overlayMetadataPrefix.length);
  }
  if (keyword.startsWith(legacyOverlayMetadataPrefix)) {
    return keyword.slice(legacyOverlayMetadataPrefix.length);
  }
  return null;
}

function readSyntheticOutlineKeyword(keyword: string) {
  return keyword.startsWith(syntheticOutlineMetadataPrefix)
    ? keyword.slice(syntheticOutlineMetadataPrefix.length)
    : null;
}

function normalizePersistedOutlineItems(value: unknown, path: string): OutlineItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map<OutlineItem | null>((item, index) => {
      if (!item || typeof item !== "object") return null;
      const rawTitle = (item as { title?: unknown }).title;
      if (typeof rawTitle !== "string" || !rawTitle.trim()) return null;

      const rawPage = (item as { page?: unknown }).page;
      const page = Number.isInteger(rawPage) && Number(rawPage) > 0 ? Number(rawPage) : undefined;
      const id = typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id.trim()
        ? (item as { id: string }).id
        : `${path}-${index}`;
      const outlineItem: OutlineItem = {
        id,
        title: rawTitle.trim().slice(0, 200),
        children: normalizePersistedOutlineItems((item as { children?: unknown }).children, `${path}-${index}`)
      };

      if (page) outlineItem.page = page;
      return outlineItem;
    })
    .filter((item): item is OutlineItem => item !== null);
}

function getPdfText(dict: PDFDict, key: string) {
  const value = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  return value?.decodeText() ?? "";
}

async function embedSignatureImage(pdfDoc: PDFDocument, dataUrl: string) {
  const [, mime = "", base64 = ""] = dataUrl.match(/^data:(.*?);base64,(.*)$/) ?? [];
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return pdfDoc.embedJpg(bytes);
  }

  return pdfDoc.embedPng(bytes);
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized,
    16
  );

  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}

function encodeBase64Json(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Json(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
