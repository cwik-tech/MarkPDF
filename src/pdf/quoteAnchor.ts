/**
 * Where a quoted passage sits on a page, from the page's own text.
 *
 * One matcher for everything an agent points at: the passage `reveal` marks for a few seconds and
 * the text a suggested highlight or comment is anchored to. It works on positioned text runs —
 * pdf.js's text content, or the lines OCR recognised on a scan — so a page does not have to be
 * drawn before a quote can be found on it.
 *
 * The quote an agent sends is its own reading of the page, so the comparison forgives what a
 * reading changes and a reader does not see: case, runs of spaces, soft hyphens, a hyphen that
 * breaks a word across two lines, and ligatures (NFKC turns "ﬃ" into "ffi"). It does not forgive a
 * different word. The first occurrence is marked, and the count of all of them is reported, so an
 * agent whose quote is ambiguous can make it longer.
 *
 * Geometry inside one run assumes equally wide characters. The window draws runs that way too, so
 * the error is a fraction of a character at either end of the mark.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import type { OverlayRect } from "../types";

/** One run of text, in page space at zoom 1, measured from the top-left of the page. */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuoteAnchor {
  /** One rectangle per line the passage crosses, top line first. */
  rects: OverlayRect[];
  /** How many times the passage occurs on the page. The first is the one in `rects`. */
  occurrences: number;
}

const SOFT_HYPHEN = "­";
/** A position in the normalized text that came from no character of a run: a joining space. */
const SEPARATOR = -1;

interface Position {
  run: number;
  char: number;
}

function normalizedCharacters(character: string): string {
  return character.normalize("NFKC").toLowerCase();
}

function normalizeQuote(quote: string): string {
  return [...quote]
    .filter((character) => character !== SOFT_HYPHEN)
    .map(normalizedCharacters)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's text as one normalized string, with the run and character each position came from. */
function flatten(runs: readonly TextRun[]): { text: string; positions: Position[] } {
  let text = "";
  const positions: Position[] = [];
  const pushSpace = (run: number): void => {
    if (text.length === 0 || text.endsWith(" ")) return;
    text += " ";
    positions.push({ run, char: SEPARATOR });
  };

  runs.forEach((run, runIndex) => {
    if (runIndex > 0) {
      const previous = runs[runIndex - 1];
      const newLine = previous !== undefined && Math.abs(previous.y - run.y) > Math.min(previous.height, run.height) / 2;
      // A hyphen that ends a line and is followed by more of the word joins the two halves.
      if (newLine && text.endsWith("-") && /^\p{L}/u.test(run.text.trimStart())) {
        text = text.slice(0, -1);
        positions.pop();
      } else {
        pushSpace(runIndex);
      }
    }
    [...run.text].forEach((character, charIndex) => {
      if (character === SOFT_HYPHEN) return;
      if (/\s/.test(character)) {
        pushSpace(runIndex);
        return;
      }
      for (const piece of normalizedCharacters(character)) {
        text += piece;
        positions.push({ run: runIndex, char: charIndex });
      }
    });
  });
  return { text, positions };
}

function occurrencesOf(text: string, quote: string): number[] {
  const starts: number[] = [];
  for (let from = text.indexOf(quote); from !== -1; from = text.indexOf(quote, from + 1)) starts.push(from);
  return starts;
}

export function anchorQuote(runs: readonly TextRun[], quote: string): QuoteAnchor | null {
  const wanted = normalizeQuote(quote);
  if (wanted.length === 0) return null;
  const { text, positions } = flatten(runs);
  const starts = occurrencesOf(text, wanted);
  const first = starts[0];
  if (first === undefined) return null;

  // The characters of each run the passage covers.
  const covered = new Map<number, { first: number; last: number }>();
  for (const position of positions.slice(first, first + wanted.length)) {
    if (position.char === SEPARATOR) continue;
    const span = covered.get(position.run);
    covered.set(position.run, {
      first: Math.min(span?.first ?? position.char, position.char),
      last: Math.max(span?.last ?? position.char, position.char),
    });
  }

  const pieces: OverlayRect[] = [];
  for (const [runIndex, span] of [...covered.entries()].sort((a, b) => a[0] - b[0])) {
    const run = runs[runIndex];
    if (run === undefined) continue;
    const length = [...run.text].length;
    if (length === 0) continue;
    const unit = run.width / length;
    pieces.push({ x: run.x + span.first * unit, y: run.y, width: (span.last + 1 - span.first) * unit, height: run.height });
  }

  // Runs on one line become one rectangle, so a line is marked once rather than word by word.
  const rects: OverlayRect[] = [];
  for (const piece of pieces) {
    const line = rects.find((rect) => Math.abs(rect.y - piece.y) <= Math.min(rect.height, piece.height) / 2);
    if (line === undefined) {
      rects.push({ ...piece });
      continue;
    }
    const left = Math.min(line.x, piece.x);
    const right = Math.max(line.x + line.width, piece.x + piece.width);
    const top = Math.min(line.y, piece.y);
    const bottom = Math.max(line.y + line.height, piece.y + piece.height);
    Object.assign(line, { x: left, y: top, width: right - left, height: bottom - top });
  }
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  return { rects, occurrences: starts.length };
}

/** How far above its baseline a run's box starts, as a share of its font size. */
const ASCENT = 0.8;

/**
 * A page's text runs in the space overlays use: unrotated, at zoom 1, from the top-left.
 *
 * Rotation 0 on purpose. Overlays are stored unrotated and turned with the page when drawn, and
 * the window asks pdf.js for the same unrotated space when it draws the page at no rotation.
 */
export async function textRunsFromPage(page: PDFPageProxy): Promise<TextRun[]> {
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.length === 0) continue;
    const [, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform as number[];
    // Rotated runs have no axis-aligned box to mark. They are left out rather than placed wrongly.
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) continue;
    const size = item.height > 0 ? item.height : Math.abs(d);
    if (size <= 0 || item.width <= 0) continue;
    const [x, baseline] = viewport.convertToViewportPoint(e, f);
    runs.push({ text: item.str, x, y: baseline - size * ASCENT, width: item.width, height: size });
  }
  return runs;
}
