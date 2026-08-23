import { getChunkingPreset, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";

export interface PageText {
  page: number;
  text: string;
  source: "pdf" | "ocr";
}

export interface TextChunk {
  id: string;
  page: number;
  index: number;
  text: string;
  headingPath: string[];
}

/** Collapse runs of whitespace so word counting and snippets are stable. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const MINIMUM_CHUNK_CHARACTERS = 20;

/**
 * Split page text into overlapping fixed-size windows.
 *
 * Ported unchanged from the renderer implementation, deliberately. Phase 1 moves where this
 * runs, not what it produces, so an existing index stays valid and no user pays for a reindex.
 * Phase 2 replaces this with structure-aware chunking and raises `semanticChunkingVersion`.
 *
 * The invariant that matters and must survive that replacement: a chunk never spans two pages,
 * because the page number is what makes a search hit citable.
 */
export function chunkPages(
  contentHash: string,
  pages: readonly PageText[],
  profile: SemanticChunkingProfile,
): TextChunk[] {
  const preset = getChunkingPreset(profile);
  const stride = Math.max(1, preset.chunkTokens - preset.overlapTokens);
  const chunks: TextChunk[] = [];

  for (const page of pages) {
    const words = normalizeText(page.text).split(" ").filter((word) => word.length > 0);
    if (words.length === 0) continue;

    let index = 0;
    for (let start = 0; start < words.length; start += stride) {
      const text = words.slice(start, start + preset.chunkTokens).join(" ");
      if (text.length >= MINIMUM_CHUNK_CHARACTERS) {
        chunks.push({
          id: `${contentHash}:${profile}:${semanticChunkingVersion}:${page.page}:${index}`,
          page: page.page,
          index,
          text,
          headingPath: [],
        });
        index += 1;
      }
      if (start + preset.chunkTokens >= words.length) break;
    }
  }

  return chunks;
}

/** Bound a stored chunk to something a result list can show. */
export function createSnippet(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}
