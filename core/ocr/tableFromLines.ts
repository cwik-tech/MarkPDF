/**
 * Deterministic table reconstruction from recognised lines.
 *
 * The engine returns a row-per-line reading of a tabled page: every word, with the x extent it
 * occupies. Words alone carry the values but not the association between them — `4620` is just
 * a number until its column says which year it belongs to. This module recovers that
 * association from word positions, with no runtime tuning knobs: the same lines always produce
 * the same page.
 *
 * The rules, so they can be argued with rather than tuned:
 *
 * - A **column** is a cluster of word start positions. A cluster is a column when at least
 *   `COLUMN_SUPPORT` of the candidate lines have a word starting within one space width of its
 *   centre and, after the first column, the word follows a visible gutter. Majority agreement
 *   keeps one line's ragged text from inventing a column; the gutter keeps aligned words inside
 *   multiword labels from becoming columns.
 * - A **row** is a candidate line that populates at least two columns. A line that populates
 *   only one — a title running across the top of a table, a stray caption — is emitted as the
 *   ordinary line it is, above the table.
 * - Cells are associated **by position, never by order**: a word starts the cell of the column
 *   it begins at, and a word that starts at no column continues the cell to its left. A missing
 *   cell stays an empty cell; nothing shifts into the gap.
 * - Fewer than `MINIMUM_TABLE_LINES` lines, fewer than two columns, or no word geometry at
 *   all, and this is not a table: the caller keeps the engine's own text unchanged.
 */

/** A table is a majority agreement; two lines cannot carry one. */
export const MINIMUM_TABLE_LINES = 3;

/** The fraction of candidate lines that must start a word at a cluster for it to be a column. */
export const COLUMN_SUPPORT = 0.6;

/** A data column starts after more than an ordinary interword space. */
const COLUMN_GUTTER_SPACES = 2;

/** The x extent a recognised word occupies, which is all column association needs. */
export interface OcrWordBox {
  text: string;
  x0: number;
  x1: number;
}

/** One recognised line: its text, its box, and its words. */
export interface OcrLineBox {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  words: OcrWordBox[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The width of a space on this page, which is the tolerance a start position must sit inside to
 * belong to a column.
 *
 * The lower quartile of adjacent-word gaps, not the median of all of them: on a tabled page most
 * gaps are the gutter between columns — a body row of four numbers carries three gutter gaps and
 * no intra-cell space at all — so the plain median measures the gutter and merges the columns it
 * should separate. The small half of the gaps is where the spaces live, and its median is a
 * space width that survives both a wide gutter and one noisy split word.
 */
function spaceWidthTolerance(lines: readonly OcrLineBox[]): number {
  const gaps: number[] = [];
  for (const line of lines) {
    for (let index = 1; index < line.words.length; index += 1) {
      const gap = (line.words[index]?.x0 ?? 0) - (line.words[index - 1]?.x1 ?? 0);
      if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
    }
  }
  if (gaps.length === 0) return 0;
  const sorted = gaps.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 4)] ?? 0;
}

/** A markdown table row from cells, with any pipe inside a cell escaped so it cannot split it. */
function renderRow(cells: readonly string[]): string {
  const escaped = cells.map((cell) => cell.replace(/\|/g, "\\|"));
  return `| ${escaped.join(" | ")} |`;
}

/**
 * The page's markdown when a table was found, or `null` when it was not.
 *
 * Non-row lines keep their place, so a title above a table stays a title.
 */
export function tableFromLines(lines: readonly OcrLineBox[]): string | null {
  // A line that cannot carry a majority position — one word, or nothing — is not a candidate.
  const candidates = lines.filter((line) => line.text.trim().length > 0 && line.words.length >= 2);
  if (candidates.length < MINIMUM_TABLE_LINES) return null;

  const tolerance = spaceWidthTolerance(candidates);
  if (tolerance <= 0) return null;

  // Cluster start positions: positions within one space width of each other are one cluster.
  const starts = candidates
    .flatMap((line) => line.words.map((word) => word.x0))
    .sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const start of starts) {
    const current = clusters.at(-1);
    const lastOfCurrent = current?.at(-1);
    if (lastOfCurrent !== undefined && start - lastOfCurrent <= tolerance) current?.push(start);
    else clusters.push([start]);
  }

  const clusterCentres = clusters
    .map((members) => median(members))
    .sort((a, b) => a - b);
  const columns = clusterCentres.filter((centre, clusterIndex) => {
    const supported = candidates.filter((line) => {
      const wordIndex = line.words.findIndex((word) => Math.abs(word.x0 - centre) <= tolerance);
      if (wordIndex < 0) return false;
      if (clusterIndex === 0 || wordIndex === 0) return true;
      const word = line.words[wordIndex];
      const previous = line.words[wordIndex - 1];
      if (word === undefined || previous === undefined) return false;
      return word.x0 - previous.x1 > tolerance * COLUMN_GUTTER_SPACES;
    }).length;
    return supported / candidates.length >= COLUMN_SUPPORT;
  });
  if (columns.length < 2) return null;

  const columnOf = (x0: number): number => columns.findIndex((centre) => Math.abs(x0 - centre) <= tolerance);

  // Classify every line, keeping the original order so non-row lines keep their place.
  const rows = new Map<number, string[]>();
  for (const [index, line] of lines.entries()) {
    if (!candidates.includes(line)) continue;
    const cells: string[] = Array.from({ length: columns.length }, () => "");
    let started: number | null = null;
    for (const word of line.words) {
      const column = columnOf(word.x0);
      const target = column >= 0 ? column : started;
      if (column >= 0) started = column;
      if (target === null || target < 0 || target >= cells.length) {
        // A word before any column, matching no column: this line is not a row of this table,
        // and pretending otherwise would place its words somewhere they were not.
        started = -2;
        break;
      }
      const cell = cells[target] ?? "";
      cells[target] = cell.length === 0 ? word.text : `${cell} ${word.text}`;
    }
    const populated = cells.filter((cell) => cell.length > 0).length;
    if (populated >= 2) rows.set(index, cells);
  }
  if (rows.size < MINIMUM_TABLE_LINES) return null;

  // Contiguous runs of rows are one table; the first row of a run is its header.
  const segments: string[] = [];
  let table: string[] | null = null;
  for (const [index, line] of lines.entries()) {
    const cells = rows.get(index);
    if (cells === undefined) {
      if (table !== null) {
        segments.push(...table);
        table = null;
      }
      segments.push(line.text);
      continue;
    }
    if (table === null) {
      table = [renderRow(cells), renderRow(Array.from({ length: columns.length }, () => "---"))];
      continue;
    }
    table.push(renderRow(cells));
  }
  if (table !== null) segments.push(...table);

  return segments.join("\n");
}
