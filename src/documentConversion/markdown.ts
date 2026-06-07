import { builtinTextMarkdownEngine } from "./engines/builtinText";
import { doclingCliMarkdownEngine } from "./engines/doclingCli";
import { selectMarkdownEngine } from "./engineSelection";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownConversionResult } from "./types";

const markdownEngines: MarkdownConversionEngine[] = [builtinTextMarkdownEngine, doclingCliMarkdownEngine];

export function getMarkdownEngine(engineId: string) {
  if (engineId === "docling-vlm-smoldocling") return doclingCliMarkdownEngine;
  return markdownEngines.find((engine) => engine.id === engineId) ?? builtinTextMarkdownEngine;
}

export async function convertDocumentToMarkdown(input: MarkdownConversionInput): Promise<MarkdownConversionResult> {
  if (input.settings.defaultEngine === "auto") {
    const selection = await selectMarkdownEngine(input.pdfDoc, input.ocrPages, input.settings);
    const resolvedInput = {
      ...input,
      settings: {
        ...input.settings,
        defaultEngine: selection.engineId
      }
    };
    const engine = getMarkdownEngine(selection.engineId);
    return engine.convert(resolvedInput);
  }

  const engine = getMarkdownEngine(input.settings.defaultEngine);
  return engine.convert(input);
}
