import { builtinTextMarkdownEngine } from "./engines/builtinText";
import { doclingCliMarkdownEngine } from "./engines/doclingCli";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownConversionResult } from "./types";

const markdownEngines: MarkdownConversionEngine[] = [builtinTextMarkdownEngine, doclingCliMarkdownEngine];

export function getMarkdownEngine(engineId: string) {
  return markdownEngines.find((engine) => engine.id === engineId) ?? builtinTextMarkdownEngine;
}

export async function convertDocumentToMarkdown(input: MarkdownConversionInput): Promise<MarkdownConversionResult> {
  const engine = getMarkdownEngine(input.settings.defaultEngine);
  return engine.convert(input);
}
