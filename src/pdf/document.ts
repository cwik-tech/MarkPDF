import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  StandardFonts
} from "pdf-lib";
import type { FormFieldState, OverlayItem } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export async function loadPdfDocument(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
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

export async function exportPdfBytes(
  sourceBytes: Uint8Array,
  overlays: OverlayItem[],
  formFields: FormFieldState[],
  flattenForms: boolean
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

  for (const overlay of overlays) {
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
