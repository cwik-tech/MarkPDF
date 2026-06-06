import { builtinTextMarkdownEngine } from "./engines/builtinText";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownConversionResult } from "./types";

const markdownEngines: MarkdownConversionEngine[] = [builtinTextMarkdownEngine];

export function getMarkdownEngine(engineId: string) {
  return markdownEngines.find((engine) => engine.id === engineId) ?? builtinTextMarkdownEngine;
}

export async function convertDocumentToMarkdown(input: MarkdownConversionInput): Promise<MarkdownConversionResult> {
  return getMarkdownEngine(input.settings.defaultEngine).convert(input);
}
