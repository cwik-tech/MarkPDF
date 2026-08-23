/**
 * Windowing a table that does not fit the embedding budget, without losing any of it.
 *
 * Two invariants cannot both hold — "never split a row" and "never exceed the budget" — because
 * one row, or even one cell, can be larger than the whole budget. The resolution is a structured
 * result rather than a text one: each emitted window carries plain-data metadata identifying the
 * source row, the fragment's exact text, and its position in the row's sequence of parts.
 *
 * That structure is what makes losslessness provable. An earlier draft tried to infer
 * reconstruction from the emitted Markdown alone, which is ambiguous once a cell is split: the
 * pieces are indistinguishable from separate cells. Carrying the fragments explicitly removes
 * the ambiguity instead of narrowing the contract to avoid it.
 */
export interface ParsedTable {
  header: string;
  divider: string;
  rows: string[];
}

/**
 * One piece of one source row.
 *
 * The metadata is enough to place the piece exactly: which row, which columns it touches, where
 * it starts in that row, and where it sits in the row's sequence of parts. `offset` and
 * `fragment` together are the authority — concatenating a row's fragments in `partIndex` order
 * reproduces the row exactly, character for character, and `offset` says so independently.
 */
export interface RowFragment {
  /** The source row's position in the table body, 0-based. */
  row: number;
  /** Which piece of that row this is, 0-based. */
  partIndex: number;
  /** How many pieces the row was split into. `1` means the row was not split. */
  partCount: number;
  /** Character offset of this piece within the source row. */
  offset: number;
  /** 0-based index of the first column this piece touches. */
  firstColumn: number;
  /** 0-based index of the last column this piece touches. */
  lastColumn: number;
  /** The exact source text of this piece. Never normalized, never re-rendered. */
  fragment: string;
  /** True when the piece begins or ends part-way through a cell. */
  withinCell: boolean;
}

export interface TableWindow {
  /** Header, divider and this window's fragments, rendered for embedding and display. */
  markdown: string;
  /** What this window carries, in order. */
  parts: RowFragment[];
  /** True when the first part repeats the previous window's last, as deliberate overlap. */
  overlapsPrevious: boolean;
}

export interface WindowOptions {
  /** Tokens (or, in tests, characters) one window's rendered Markdown may occupy. */
  budget: number;
  count: (text: string) => number;
}

const DIVIDER_ROW = /^\s*\|[\s:|-]+\|\s*$/;

/** A GFM table is a header, a divider, and at least one body row. Anything else is not one. */
export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 3) return null;
  const [header, divider, ...rows] = lines;
  if (header === undefined || divider === undefined) return null;
  if (!DIVIDER_ROW.test(divider)) return null;
  return { header, divider, rows };
}

/**
 * Is the pipe at this position a cell boundary?
 *
 * In GFM a pipe escaped with a backslash is cell *content*, not a separator — and a backslash can
 * itself be escaped, so the question is whether an even number of backslashes precedes the pipe.
 * Counting every pipe would report the wrong column and let a cut land inside a single cell.
 */
function isCellBoundary(row: string, index: number): boolean {
  if (row[index] !== "|") return false;
  let backslashes = 0;
  for (let scan = index - 1; scan >= 0 && row[scan] === "\\"; scan -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Which column a character position falls in.
 *
 * A row is `|c0|c1|c2|`, so the column of a position is the number of cell boundaries strictly
 * before it, less the leading one. Clamped at zero for the leading pipe itself.
 */
function columnAt(row: string, position: number): number {
  let pipes = 0;
  for (let index = 0; index < position && index < row.length; index += 1) {
    if (isCellBoundary(row, index)) pipes += 1;
  }
  return Math.max(0, pipes - 1);
}

/** Render one fragment as something that still reads as a table row. */
function renderFragment(fragment: string): string {
  const inner = fragment.replace(/^\|/, "").replace(/\|$/, "");
  return `|${inner}|`;
}

function renderWindow(table: ParsedTable, parts: readonly RowFragment[]): string {
  return [table.header, table.divider, ...parts.map((part) => renderFragment(part.fragment))].join("\n");
}

/**
 * Every place a row may be cut, in preference order.
 *
 * Cell boundaries first, because a cell is the smallest unit that still means something. Word
 * boundaries inside a cell next. A single word longer than the allowance is cut by **code
 * point** — the smallest deterministic fallback that cannot split a character in half, chosen
 * because refusing or truncating would lose text.
 */
function cutPoints(row: string, preferCells: boolean): number[] {
  const points: number[] = [];
  for (let index = 1; index < row.length; index += 1) {
    const boundary = isCellBoundary(row, index - 1);
    if (preferCells ? boundary : boundary || row[index - 1] === " ") points.push(index);
  }
  return points;
}

/** Split a row into fragments that each render within `room`, partitioning it exactly. */
function fragmentsFor(rowIndex: number, row: string, room: number, count: (text: string) => number): RowFragment[] {
  if (count(renderFragment(row)) <= room) {
    return [
      {
        row: rowIndex,
        partIndex: 0,
        partCount: 1,
        offset: 0,
        firstColumn: 0,
        lastColumn: columnAt(row, row.length - 1),
        fragment: row,
        withinCell: false,
      },
    ];
  }

  const pieces: Array<{ text: string; withinCell: boolean }> = [];
  let remaining = row;
  let consumed = 0;

  while (remaining.length > 0) {
    // Whatever is left, once it fits, is taken whole. Its far end is the end of the row, which
    // is a cell boundary by construction — so this is not a cut inside a cell, and the character
    // fallback below must not claim it is.
    if (count(renderFragment(remaining)) <= room) {
      pieces.push({ text: remaining, withinCell: false });
      consumed += remaining.length;
      break;
    }

    // Cell boundaries, then word boundaries, then characters. Each list is a strict superset of
    // the safety of the last, so the loop always terminates with a piece that fits.
    let taken = 0;
    let withinCell = false;
    for (const preferCells of [true, false]) {
      const candidates = cutPoints(remaining, preferCells).filter(
        (point) => count(renderFragment(remaining.slice(0, point))) <= room,
      );
      const best = candidates.at(-1);
      if (best !== undefined) {
        taken = best;
        withinCell = !preferCells;
        break;
      }
    }
    if (taken === 0) {
      // No boundary of any kind fits: one word longer than the allowance. Cut by **code point**,
      // never by UTF-16 code unit — decrementing units lands between the halves of a surrogate
      // pair and emits a lone surrogate, a character the document never contained.
      let width = 0;
      for (const point of remaining) {
        if (count(renderFragment(remaining.slice(0, width + point.length))) > room) break;
        width += point.length;
      }
      taken = width === 0 ? ([...remaining][0]?.length ?? 1) : width;
      withinCell = true;
    }
    pieces.push({ text: remaining.slice(0, taken), withinCell });
    consumed += taken;
    remaining = remaining.slice(taken);
  }

  // The partition must be exact; anything else is silent loss.
  if (consumed !== row.length) {
    throw new Error(`Row fragmentation consumed ${consumed} of ${row.length} characters.`);
  }

  let offset = 0;
  return pieces.map((piece, partIndex) => {
    const start = offset;
    offset += piece.text.length;
    const startsMidCell = start > 0 && row[start - 1] !== "|";
    const endsMidCell = offset < row.length && row[offset - 1] !== "|";
    return {
      row: rowIndex,
      partIndex,
      partCount: pieces.length,
      offset: start,
      firstColumn: columnAt(row, start),
      lastColumn: columnAt(row, offset - 1),
      fragment: piece.text,
      withinCell: startsMidCell || endsMidCell,
    };
  });
}

/**
 * A table as one or more windows, each rendering within the budget.
 *
 * Every window repeats the header and divider, so it still says what its columns are. Whole rows
 * overlap by one where the budget allows, so a comparison spanning a boundary survives intact in
 * one tableWindow. Fragments of a split row never overlap: repeating one would make its position in
 * the row's sequence ambiguous.
 */
export function splitTable(text: string, options: WindowOptions): TableWindow[] {
  const parsed = parseTable(text);
  if (parsed === null) return [];

  const { budget, count } = options;
  // No windows rather than an exception when the header cannot be repeated.
  //
  // An oversized header cell is unusual, not invalid, and refusing would abort indexing the whole
  // document over it. Reporting that this table cannot be windowed lets the caller fall back to
  // lossless prose splitting: the repeated header is lost — nobody could have fitted it — and
  // every character of the table is still indexed.
  //
  // `prefixCost < budget` alone is not enough either. A fragment renders with synthetic pipes, so
  // the smallest emittable piece costs more than one character; below that the code-point
  // fallback would emit a window over budget.
  const prefixCost = count(`${parsed.header}\n${parsed.divider}\n`);
  const room = budget - prefixCost;
  if (prefixCost >= budget || room < count(renderFragment("x"))) return [];
  const allParts = parsed.rows.flatMap((row, index) => fragmentsFor(index, row, room, count));

  const windows: TableWindow[] = [];
  let current: RowFragment[] = [];
  let overlapsPrevious = false;

  const flush = () => {
    if (current.length > 0) {
      windows.push({ markdown: renderWindow(parsed, current), parts: [...current], overlapsPrevious });
    }
  };

  for (const part of allParts) {
    const next = [...current, part];
    if (current.length > 0 && count(renderWindow(parsed, next)) > budget) {
      const carry = current.at(-1);
      flush();
      const canOverlap =
        carry !== undefined &&
        carry.partCount === 1 &&
        part.partCount === 1 &&
        count(renderWindow(parsed, [carry, part])) <= budget;
      current = canOverlap && carry !== undefined ? [carry, part] : [part];
      overlapsPrevious = canOverlap;
      continue;
    }
    current = next;
  }
  flush();
  return windows;
}

/**
 * Reconstruct the table's body rows from the structured parts, exactly, character for character.
 *
 * The executable statement of losslessness. It works from `RowFragment`, never from the rendered
 * Markdown, which is the whole reason the result is structured: rendering is for reading, and
 * fragments are for proving nothing was lost.
 */
export function reassembleRows(windows: readonly TableWindow[]): string[] {
  const byRow = new Map<number, Map<number, string>>();

  for (const tableWindow of windows) {
    for (const part of tableWindow.parts) {
      let row = byRow.get(part.row);
      if (row === undefined) {
        row = new Map<number, string>();
        byRow.set(part.row, row);
      }
      // Overlap repeats a part verbatim; recording it twice is the same as once.
      row.set(part.partIndex, part.fragment);
    }
  }

  return [...byRow.keys()]
    .sort((a, b) => a - b)
    .map((rowIndex) => {
      const parts = byRow.get(rowIndex);
      if (parts === undefined) return "";
      return [...parts.keys()]
        .sort((a, b) => a - b)
        .map((partIndex) => parts.get(partIndex) ?? "")
        .join("");
    });
}

/** The whole table, header included, rebuilt from its windows. */
export function reassembleTable(windows: readonly TableWindow[]): string {
  const first = windows[0];
  if (first === undefined) return "";
  const parsed = parseTable(first.markdown);
  if (parsed === null) return "";
  return [parsed.header, parsed.divider, ...reassembleRows(windows)].join("\n");
}
