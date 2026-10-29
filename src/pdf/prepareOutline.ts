import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import type { OutlineItem } from "../types";

export type PreparedOutline = { status: "prepared"; bytes: Uint8Array } | { status: "blocked"; reason: "encryption" | "forms" | "signature" };
const outlinePrefix = "markpdf-outline:";

/** A metadata-only semantic change; serialization still rewrites the PDF. */
export async function prepareOutline(bytes: Uint8Array, outline: OutlineItem[]): Promise<PreparedOutline> {
  const pdf = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
  if (pdf.isEncrypted) return { status: "blocked", reason: "encryption" };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && (object.has(PDFName.of("ByteRange")) || object.get(PDFName.of("FT")) === PDFName.of("Sig"))) {
      return { status: "blocked", reason: "signature" };
    }
  }
  const form = pdf.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (form?.has(PDFName.of("XFA")) || (form?.lookupMaybe(PDFName.of("Fields"), PDFArray)?.size() ?? 0) > 0) return { status: "blocked", reason: "forms" };
  const keywords = (pdf.getKeywords() ?? "").replace(/markpdf-outline:[A-Za-z0-9+/=]+/g, "");
  const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(outline)), (byte) => String.fromCharCode(byte)).join(""));
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of("Keywords"), PDFHexString.fromText(`${keywords} ${outlinePrefix}${encoded}`));
  return { status: "prepared", bytes: await pdf.save({ updateFieldAppearances: false }) };
}
