import { headingPathAt, splitIntoBlocks, type MarkdownBlock, type MarkdownPage } from "./markdownBlocks.js";
import { splitTable, type RowFragment } from "./tableWindows.js";
import { breadcrumbTokenAllowance, embeddingTokenBudget } from "../tokenize/budget.js";
import { loadCuratedTokenCounter } from "../tokenize/tokenizers.js";
import { getChunkingPreset, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import { chunkIdentifier } from "./chunkIdentity.js";

/** What separates breadcrumb elements, and the breadcrumb from the body. */
export const BREADCRUMB_SEPARATOR = " › ";

export interface StructuredChunk {
  page: number;
  /** Position within its page, from zero. */
  index: number;
  /**
   * Stored text: the exact source this chunk covers, with no breadcrumb and, for a table window,
   * no repeated header. It is what a citation quotes and what a highlight is matched against.
   */
  text: string;
  headingPath: string[];
  /** What is embedded: breadcrumb, separator, body — measured to fit the budget. */
  embedText: string;
  /** Position within its source unit's continuation sequence, for chunk identity. */
  partIndex: number;
  partCount: number;
}

export interface ChunkOptions {
  budget: number;
  count: (text: string) => number;
}

/**
 * Markdown reduced to the words a PDF text layer would show.
 *
 * The snippet is matched against pdf.js's reading of the page to place the highlight. Pipes,
 * hashes and emphasis markers appear nowhere in that reading, so a snippet carrying them matches
 * nothing and the highlight silently disappears.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*([-*+]|\d+\.)\s+/, "")
        .replace(/\|/g, " ")
        .replace(/(\*\*|__|\*|_|`)/g, ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A table's header and divider, for prefixing to a window's embedding input. */
function tableHeaderOf(table: string): string {
  const lines = table.split("\n").filter((line) => line.trim().length > 0);
  const [header, divider] = lines;
  if (header === undefined || divider === undefined) return "";
  return `${header}\n${divider}\n`;
}

/** The breadcrumb, trimmed outside-in until it fits its allowance. */
function breadcrumbFor(headingPath: readonly string[], options: ChunkOptions): string {
  const allowance = breadcrumbTokenAllowance(options.budget);
  let path = [...headingPath];
  while (path.length > 0 && options.count(path.join(BREADCRUMB_SEPARATOR) + BREADCRUMB_SEPARATOR) > allowance) {
    // Outside in: the nearest heading carries the most signal and is dropped last.
    path = path.slice(1);
  }
  return path.length === 0 ? "" : path.join(BREADCRUMB_SEPARATOR) + BREADCRUMB_SEPARATOR;
}

/**
 * Split running text into pieces that each fit, partitioning it exactly.
 *
 * Word boundaries where they exist, and code-point boundaries where they do not — a single word
 * longer than the allowance still has to be indexed, and refusing or truncating it would lose
 * text the reader can see. Splitting by code point rather than by UTF-16 unit keeps a surrogate
 * pair whole, so an emoji or an astral character is never cut in half.
 *
 * The partition is exact: concatenating the pieces reproduces the input, which is what makes
 * the budget guarantee compatible with losing nothing.
 */
function splitProse(text: string, room: number, count: (value: string) => number): string[] {
  if (count(text) <= room) return [text];

  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (count(remaining) <= room) {
      pieces.push(remaining);
      break;
    }

    // The last whitespace boundary that still fits.
    let taken = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      if (!/\s/.test(remaining[index - 1] ?? "")) continue;
      if (count(remaining.slice(0, index)) <= room) taken = index;
    }

    if (taken === 0) {
      // One word longer than the allowance. Cut by code point, the smallest deterministic unit
      // that cannot corrupt a character.
      const points = Array.from(remaining);
      let size = 0;
      let width = 0;
      for (const point of points) {
        if (count(remaining.slice(0, width + point.length)) > room) break;
        width += point.length;
        size += 1;
      }
      taken = size === 0 ? (points[0]?.length ?? 1) : width;
    }

    pieces.push(remaining.slice(0, taken));
    remaining = remaining.slice(taken);
  }

  const rejoined = pieces.join("");
  if (rejoined !== text) {
    throw new Error(`Prose splitting lost text: ${rejoined.length} characters of ${text.length}.`);
  }
  return pieces;
}

interface Unit {
  /**
   * What is stored: the exact source text this chunk covers.
   *
   * For a table window that is the body fragments alone. The repeated header belongs in
   * `embedText`, where it tells the model what the columns are, but not in the stored text: the
   * header is not contiguous with a later row anywhere on the page, so a snippet derived from
   * text carrying it would match nothing and the highlight would silently vanish.
   */
  text: string;
  /** Prefixed to `text` for embedding only. Empty for everything except a table window. */
  embedPrefix: string;
  partIndex: number;
  partCount: number;
}

function unitsForBlock(block: MarkdownBlock, room: number, options: ChunkOptions): Unit[] {
  if (block.kind === "table") {
    const windows = splitTable(block.text, { budget: room, count: options.count });
    if (windows.length > 0) {
      const header = tableHeaderOf(block.text);
      return windows.map((tableWindow, partIndex) => ({
        text: tableWindow.parts.map((part) => part.fragment).join("\n"),
        embedPrefix: header,
        partIndex,
        partCount: windows.length,
      }));
    }
  }
  const pieces = splitProse(block.text, room, options.count);
  return pieces.map((text, partIndex) => ({
    text,
    embedPrefix: "",
    partIndex,
    partCount: pieces.length,
  }));
}

/**
 * Blocks in, chunks out, none of them over budget.
 *
 * The budget is enforced on the assembled `embedText`, not on the body alone, because the
 * breadcrumb is part of what the model sees. That is why the breadcrumb is computed first and
 * the body is given whatever remains.
 */
export function chunkStructuredPages(pages: readonly MarkdownPage[], options: ChunkOptions): StructuredChunk[] {
  const blocks = splitIntoBlocks(pages);
  const chunks: StructuredChunk[] = [];
  const perPage = new Map<number, number>();

  for (const [position, block] of blocks.entries()) {
    const headingPath = headingPathAt(blocks, position);
    const breadcrumb = breadcrumbFor(headingPath, options);
    const room = options.budget - options.count(breadcrumb);
    if (room <= 0) continue;

    for (const unit of unitsForBlock(block, room, options)) {
      const index = perPage.get(block.page) ?? 0;
      perPage.set(block.page, index + 1);
      chunks.push({
        page: block.page,
        index,
        text: unit.text,
        headingPath,
        embedText: `${breadcrumb}${unit.embedPrefix}${unit.text}`,
        partIndex: unit.partIndex,
        partCount: unit.partCount,
      });
    }
  }

  return chunks;
}

export type { RowFragment };

/** A chunk ready to store: identified, anchored, and with the text the model will see. */
export interface IndexableChunk {
  id: string;
  page: number;
  index: number;
  text: string;
  headingPath: string[];
  /** What the embedder is given. Never stored; never shown to a reader. */
  embedText: string;
}

/**
 * The budget a profile actually gets.
 *
 * The presets keep their meaning as *targets* — a user's precise/balanced/contextual choice still
 * changes chunk size — but none of them may exceed what the catalogue's smallest tokenizer can
 * accept. `contextual` at 640 is therefore capped at the model budget rather than honoured and
 * silently truncated, which is what the old word-count presets did.
 */
export function budgetForProfile(profile: SemanticChunkingProfile): number {
  return Math.min(embeddingTokenBudget(), getChunkingPreset(profile).chunkTokens);
}

/**
 * Page Markdown in, storable chunks out.
 *
 * The one place chunk identity is minted, so the text fingerprint cannot be forgotten at a call
 * site. Loading the token counter is what makes the budget real rather than estimated; it is
 * cached per process and reads only bundled files, so it costs nothing after the first document.
 */
export async function chunkPagesForIndex(
  contentHash: string,
  pages: readonly MarkdownPage[],
  profile: SemanticChunkingProfile,
): Promise<IndexableChunk[]> {
  const counter = await loadCuratedTokenCounter();
  const budget = budgetForProfile(profile);
  const chunks = chunkStructuredPages(pages, { budget, count: (text) => counter.count(text) });

  return chunks.map((chunk) => ({
    id: chunkIdentifier({
      contentHash,
      chunkingProfile: profile,
      chunkingVersion: semanticChunkingVersion,
      page: chunk.page,
      index: chunk.index,
      partIndex: chunk.partIndex,
      text: chunk.text,
    }),
    page: chunk.page,
    index: chunk.index,
    text: chunk.text,
    headingPath: chunk.headingPath,
    embedText: chunk.embedText,
  }));
}
