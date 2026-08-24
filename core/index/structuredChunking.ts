import { headingPathAt, splitIntoBlocks, type HeadingRef, type MarkdownBlock, type MarkdownPage } from "./markdownBlocks.js";
import { splitTable, type RowFragment } from "./tableWindows.js";
import { breadcrumbTokenAllowance, embeddingTokenBudget } from "../tokenize/budget.js";
import { loadCuratedTokenCounter } from "../tokenize/tokenizers.js";
import { getChunkingPreset, semanticChunkingVersion, type SemanticChunkingProfile } from "../models.js";
import { chunkIdentifier } from "./chunkIdentity.js";
import type { HeadingEntry } from "../store/index.js";

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
  /** The breadcrumb's titles, in order — the shape retrieval has always shown. */
  headingPath: string[];
  /** The same breadcrumb with the page each heading stands on. */
  headings: HeadingRef[];
  /**
   * Low-signal labels from the chunk's own page, folded in as context rather than indexed as
   * chunks of their own. Empty for chunks no label preceded.
   */
  localHeadings: string[];
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

/**
 * Low-signal blocks: text that competes with content in retrieval without adding any.
 *
 * Neither kind is removed from the document — extraction, reading and conversion still show
 * every word. This is a retrieval rule: the standalone *chunk* set changes, and nothing else.
 *
 * - A **label** is a one-line paragraph, at most {@link MAX_LABEL_CHARS} plain characters,
 *   without sentence-ending punctuation, that is either wrapped in emphasis or at least 80 %
 *   capital letters and spaces — the `**T R A C T I O N**` that opens a slide. Alone it is
 *   noise a search can hit; with content after it on the same page it is context, so it is
 *   folded into that content's embedding instead of standing alone. With nothing after it, it
 *   stays a chunk: folding it into nothing would lose it.
 * - **Running text** is a paragraph of at most {@link MAX_RUNNING_TEXT_CHARS} plain characters
 *   repeated identically on `max(3, ceil(0.4 × pageCount))` or more distinct pages — the footer
 *   on every page of a report. Indexed once per page it outnumbers the content it shares pages
 *   with, so it produces no chunk on any page. It is still in every page's text.
 *
 * Both rules apply to paragraph blocks only: headings, tables and lists carry structure that is
 * signal whatever their size.
 */
const MAX_LABEL_CHARS = 48;
const MAX_RUNNING_TEXT_CHARS = 80;
/** Below this page count the floor dominates; above it, forty percent of the document. */
const RUNNING_TEXT_PAGE_SHARE = 0.4;
const RUNNING_TEXT_MINIMUM_PAGES = 3;
const CAPITAL_LABEL_SHARE = 0.8;

function emphasisWrapped(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) ||
    (trimmed.startsWith("__") && trimmed.endsWith("__") && trimmed.length > 4)
  );
}

function capitalLabel(plain: string): boolean {
  const characters = Array.from(plain);
  if (characters.length === 0) return false;
  const letters = characters.filter((character) => /^[A-Za-z]$/.test(character));
  if (letters.length === 0) return false;
  const capitalsAndSpaces = characters.filter((character) => /^[A-Z ]$/.test(character)).length;
  return capitalsAndSpaces / characters.length >= CAPITAL_LABEL_SHARE;
}

/** The label rule, applied to one block with its plain text already computed. */
function isLabel(block: MarkdownBlock, plain: string): boolean {
  if (block.kind !== "paragraph") return false;
  if (block.text.includes("\n")) return false;
  if (plain.length === 0 || plain.length > MAX_LABEL_CHARS) return false;
  if (/[.!?…]/.test(plain)) return false;
  return emphasisWrapped(block.text) || capitalLabel(plain);
}

/** The plain texts that qualify as running text for a document of this length. */
function runningTexts(blocks: readonly MarkdownBlock[], pageCount: number): Set<string> {
  const threshold = Math.max(RUNNING_TEXT_MINIMUM_PAGES, Math.ceil(RUNNING_TEXT_PAGE_SHARE * pageCount));
  const pagesCarrying = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (block.kind !== "paragraph") continue;
    const plain = toPlainText(block.text);
    if (plain.length === 0 || plain.length > MAX_RUNNING_TEXT_CHARS) continue;
    let pages = pagesCarrying.get(plain);
    if (pages === undefined) {
      pages = new Set<number>();
      pagesCarrying.set(plain, pages);
    }
    pages.add(block.page);
  }
  const running = new Set<string>();
  for (const [plain, pages] of pagesCarrying) {
    if (pages.size >= threshold) running.add(plain);
  }
  return running;
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
 * breadcrumb — and any label folded into it — is part of what the model sees. That is why the
 * prefix is computed first and the body is given whatever remains.
 *
 * Low-signal blocks do not stand alone: running text produces no chunk at all, and a label
 * folds into the next chunk of its page. A label with nothing after it keeps its chunk, because
 * folding it into nothing would lose it.
 */
export function chunkStructuredPages(pages: readonly MarkdownPage[], options: ChunkOptions): StructuredChunk[] {
  const blocks = splitIntoBlocks(pages);
  const running = runningTexts(blocks, pages.length);
  const blockInfo = blocks.map((block) => {
    const plain = toPlainText(block.text);
    const isRunning = block.kind === "paragraph" && running.has(plain);
    return { plain, isRunning, isLabel: !isRunning && isLabel(block, plain) };
  });

  const chunks: StructuredChunk[] = [];
  const perPage = new Map<number, number>();
  // Labels waiting for the chunk they fold into. Always same-page: a label is only held when a
  // later block on its own page will produce a chunk.
  let pendingLabels: string[] = [];

  for (const [position, block] of blocks.entries()) {
    const info = blockInfo[position];
    if (info === undefined) continue;
    if (info.isRunning) continue;

    if (info.isLabel) {
      // Look for a later chunk-producing block on the same page, skipping blocks that are
      // themselves dropped or folded.
      let hasFollower = false;
      for (let next = position + 1; next < blocks.length; next += 1) {
        const candidate = blocks[next];
        const candidateInfo = blockInfo[next];
        if (candidate === undefined || candidateInfo === undefined) break;
        if (candidate.page !== block.page) break;
        if (candidateInfo.isRunning || candidateInfo.isLabel) continue;
        hasFollower = true;
        break;
      }
      if (hasFollower) {
        pendingLabels.push(info.plain);
        continue;
      }
      // Nothing after it on the page: indexed as a chunk like any other block.
    }

    const headings = headingPathAt(blocks, position);
    const breadcrumb = breadcrumbFor(headings.map((heading) => heading.title), options);
    const labelPrefix = pendingLabels.map((label) => `${label}${BREADCRUMB_SEPARATOR}`).join("");
    const prefix = `${breadcrumb}${labelPrefix}`;
    const room = options.budget - options.count(prefix);
    const foldedLabels = pendingLabels;
    pendingLabels = [];
    if (room <= 0) continue;

    for (const unit of unitsForBlock(block, room, options)) {
      const index = perPage.get(block.page) ?? 0;
      perPage.set(block.page, index + 1);
      chunks.push({
        page: block.page,
        index,
        text: unit.text,
        headingPath: headings.map((heading) => heading.title),
        headings,
        localHeadings: foldedLabels,
        embedText: `${prefix}${unit.embedPrefix}${unit.text}`,
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
  /** The breadcrumb with each heading's page, as the store records it. */
  headingPath: readonly HeadingEntry[];
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
    headingPath: chunk.headings,
    embedText: chunk.embedText,
  }));
}
