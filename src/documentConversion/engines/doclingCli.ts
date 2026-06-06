import type { MarkdownConversionEngine, MarkdownConversionInput } from "../types";

export const doclingCliMarkdownEngine: MarkdownConversionEngine = {
  id: "docling-managed",
  name: "Docling",
  async convert(input: MarkdownConversionInput) {
    if (!window.pdfReader?.markdown.convertWithDocling) {
      throw new Error("Docling conversion is available only in the Electron app.");
    }

    input.onProgress?.({
      message: "Converting document",
      current: 1,
      total: 2
    });

    const result = await window.pdfReader.markdown.convertWithDocling(Array.from(input.bytes), input.settings);

    input.onProgress?.({
      message: "Conversion complete",
      current: 2,
      total: 2
    });

    return result;
  }
};
