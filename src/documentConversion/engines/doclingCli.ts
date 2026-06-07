import type { MarkdownConversionEngine, MarkdownConversionInput } from "../types";
import { collectMarkdownPages, postProcessMarkdownWithPageContext } from "../fidelity";

export const doclingCliMarkdownEngine: MarkdownConversionEngine = {
  id: "docling-managed",
  name: "Docling",
  async convert(input: MarkdownConversionInput) {
    if (!window.pdfReader?.markdown.convertWithDocling) {
      throw new Error("Docling conversion is available only in the Electron app.");
    }

    const pageContext = await collectMarkdownPages(input);

    input.onProgress?.({
      message: "Converting document",
      current: input.pdfDoc.numPages + 1,
      total: input.pdfDoc.numPages + 1
    });
    const result = await window.pdfReader.markdown.convertWithDocling(Array.from(input.bytes), input.settings);
    const processed = postProcessMarkdownWithPageContext(result.markdown, pageContext.pages, input.settings);

    input.onProgress?.({
      message: "Conversion complete",
      current: input.pdfDoc.numPages + 1,
      total: input.pdfDoc.numPages + 1
    });

    return {
      ...result,
      markdown: processed.markdown,
      warnings: [...pageContext.warnings, ...result.warnings, ...processed.warnings]
    };
  }
};
