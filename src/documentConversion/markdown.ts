import { builtinTextMarkdownEngine } from "./engines/builtinText";
import { doclingCliMarkdownEngine } from "./engines/doclingCli";
import type { MarkdownConversionEngine, MarkdownConversionInput, MarkdownConversionResult } from "./types";

const markdownEngines: MarkdownConversionEngine[] = [builtinTextMarkdownEngine, doclingCliMarkdownEngine];

export function getMarkdownEngine(engineId: string) {
  return markdownEngines.find((engine) => engine.id === engineId) ?? builtinTextMarkdownEngine;
}

export async function convertDocumentToMarkdown(input: MarkdownConversionInput): Promise<MarkdownConversionResult> {
  const engine = getMarkdownEngine(input.settings.defaultEngine);
  if (engine.id === builtinTextMarkdownEngine.id) {
    return engine.convert(input);
  }

  try {
    return await engine.convert(input);
  } catch (error) {
    const fallback = await builtinTextMarkdownEngine.convert({
      ...input,
      settings: {
        ...input.settings,
        defaultEngine: "builtin-text"
      }
    });

    return {
      ...fallback,
      warnings: [
        `${engine.name} failed; used built-in text export instead. ${error instanceof Error ? error.message : "Unknown error."}`,
        ...fallback.warnings
      ]
    };
  }
}
