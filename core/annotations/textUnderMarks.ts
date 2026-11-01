import { openPdfDocument } from "../ocr/rasterisePages.js";
import type { PdfBox } from "./readAnnotations.js";

/**
 * The words an annotation marks, read from the page's own text.
 *
 * Applications rarely store the marked words — Acrobat keeps only the quadrilaterals — so they are
 * recovered from pdf.js's text positions. A text run counts when the mark covers at least half of
 * its height, and a run the mark covers only in part is cut at the nearest character on the
 * assumption that its characters are equally wide. That is a best effort, and every reply that
 * carries one says so: the quote is evidence of what was marked, not a transcription of it.
 *
 * A page with no native text — a scan — answers null rather than a guess.
 */

export interface MarkedArea {
  id: string;
  page: number;
  marks: readonly PdfBox[];
}

interface TextRun {
  text: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** How much of a run's height a mark must cover before the run counts as marked. */
const VERTICAL_COVERAGE = 0.5;

export async function quotesUnderMarks(
  bytes: Uint8Array,
  areas: readonly MarkedArea[],
): Promise<Map<string, string | null>> {
  const quotes = new Map<string, string | null>(areas.map((area) => [area.id, null]));
  const marked = areas.filter((area) => area.marks.length > 0);
  if (marked.length === 0) return quotes;

  const handle = await openPdfDocument(bytes);
  try {
    const runsByPage = new Map<number, TextRun[]>();
    for (const area of marked) {
      if (area.page < 1 || area.page > handle.pdf.numPages) continue;
      let runs = runsByPage.get(area.page);
      if (runs === undefined) {
        runs = await textRuns(handle.pdf, area.page);
        runsByPage.set(area.page, runs);
      }
      const words = [...area.marks]
        .sort((a, b) => b.top - a.top || a.left - b.left)
        .map((mark) => textUnder(mark, runs ?? []))
        .filter((text) => text.length > 0);
      const quote = words.join(" ").replace(/\s+/g, " ").trim();
      quotes.set(area.id, quote.length > 0 ? quote : null);
    }
  } finally {
    await handle.release();
  }
  return quotes;
}

async function textRuns(pdf: Awaited<ReturnType<typeof openPdfDocument>>["pdf"], pageNumber: number): Promise<TextRun[]> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.length === 0) continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = item.transform;
    // Rotated runs are left out rather than placed wrongly. Their boxes are not axis-aligned.
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) continue;
    const height = item.height > 0 ? item.height : Math.abs(d);
    const width = item.width > 0 ? item.width : Math.abs(a) * item.str.length * 0.5;
    if (height <= 0 || width <= 0) continue;
    runs.push({ text: item.str, left: x, right: x + width, bottom: y, top: y + height });
  }
  return runs;
}

function textUnder(mark: PdfBox, runs: readonly TextRun[]): string {
  const pieces: Array<{ left: number; text: string }> = [];
  for (const run of runs) {
    const overlapHeight = Math.min(mark.top, run.top) - Math.max(mark.bottom, run.bottom);
    if (overlapHeight < (run.top - run.bottom) * VERTICAL_COVERAGE) continue;
    const left = Math.max(mark.left, run.left);
    const right = Math.min(mark.right, run.right);
    if (right <= left) continue;

    const characters = [...run.text];
    const width = run.right - run.left;
    const start = Math.max(0, Math.round(((left - run.left) / width) * characters.length));
    const end = Math.min(characters.length, Math.round(((right - run.left) / width) * characters.length));
    if (end <= start) continue;
    pieces.push({ left, text: characters.slice(start, end).join("") });
  }
  return pieces
    .sort((a, b) => a.left - b.left)
    .map((piece) => piece.text)
    .join(" ")
    .trim();
}
