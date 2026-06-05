import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import {
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts
} from "pdf-lib";
import type { FormFieldState, OutlineItem, OverlayItem, SearchMatch } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const pdfAssetBase = `${import.meta.env.BASE_URL}pdfjs/`;
const overlayMetadataPrefix = "open-pdf-reader-overlays:";

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

async function resolveOutlinePage(pdfDoc: pdfjsLib.PDFDocumentProxy, dest: unknown) {
  try {
    const resolved = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved[0]) return undefined;
    return (await pdfDoc.getPageIndex(resolved[0])) + 1;
  } catch {
    return undefined;
  }
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

export async function findTextMatches(pdfDoc: pdfjsLib.PDFDocumentProxy, query: string): Promise<SearchMatch[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const matches: SearchMatch[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const page = await pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const lowerText = pageText.toLowerCase();
    let index = lowerText.indexOf(normalizedQuery);

    while (index >= 0) {
      const start = Math.max(0, index - 42);
      const end = Math.min(pageText.length, index + normalizedQuery.length + 42);
      matches.push({
        id: `${pageNumber}-${index}`,
        page: pageNumber,
        index,
        snippet: `${start > 0 ? "..." : ""}${pageText.slice(start, end)}${end < pageText.length ? "..." : ""}`
      });
      index = lowerText.indexOf(normalizedQuery, index + normalizedQuery.length);
    }
  }

  return matches;
}

export async function extractEditableOverlays(bytes: Uint8Array): Promise<OverlayItem[]> {
  try {
    const pdfDoc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
    const keywords = pdfDoc.getKeywords() ?? "";
    const encoded = keywords
      .split(/,\s*/)
      .find((keyword) => keyword.startsWith(overlayMetadataPrefix))
      ?.slice(overlayMetadataPrefix.length);

    if (!encoded) return [];
    const parsed = JSON.parse(decodeBase64Json(encoded)) as OverlayItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((overlay) => typeof overlay.id === "string" && typeof overlay.page === "number");
  } catch {
    return [];
  }
}

export async function exportPdfBytes(
  sourceBytes: Uint8Array,
  overlays: OverlayItem[],
  formFields: FormFieldState[],
  flattenForms: boolean,
  options: { bakeOverlays?: boolean; persistEditable?: boolean } = {}
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

  if (options.persistEditable) {
    writeEditableOverlayMetadata(pdfDoc, overlays);
  }

  for (const overlay of overlays.filter(
    (overlay) => bakeOverlays || overlay.kind === "text" || overlay.kind === "signature"
  )) {
    const page = pages[overlay.page - 1];
    if (!page) continue;

    const pageHeight = page.getHeight();
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
      addTextNoteAnnotation(pdfDoc, page, overlay, x, y);
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

    if (overlay.kind === "highlight") {
      page.drawRectangle({
        x,
        y,
        width,
        height,
        color: rgb(1, 0.88, 0.1),
        opacity: 0.35
      });
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

function writeEditableOverlayMetadata(pdfDoc: PDFDocument, overlays: OverlayItem[]) {
  const existingKeywords = (pdfDoc.getKeywords() ?? "")
    .split(/,\s*/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .filter((keyword) => !keyword.startsWith(overlayMetadataPrefix));
  const editableOverlays = overlays.filter((overlay) => overlay.kind === "highlight" || overlay.kind === "comment");
  const encoded = encodeBase64Json(JSON.stringify(editableOverlays));
  pdfDoc.setKeywords([...existingKeywords, `${overlayMetadataPrefix}${encoded}`]);
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

function addTextNoteAnnotation(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  overlay: OverlayItem,
  x: number,
  y: number
) {
  const annots =
    page.node.lookupMaybe(PDFName.of("Annots"), PDFArray) ?? pdfDoc.context.obj([]);

  if (!page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)) {
    page.node.set(PDFName.of("Annots"), annots);
  }

  const noteSize = 24;
  const annotation = pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [x, y + Math.max(0, overlay.height - noteSize), x + noteSize, y + overlay.height],
    Contents: PDFString.of(overlay.text || "Comment"),
    Name: PDFName.of("Comment"),
    C: [1, 0.88, 0.1],
    Open: false
  });

  annots.push(pdfDoc.context.register(annotation));
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
