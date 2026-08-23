import { describe, expect, it } from "vitest";
import { splitTable, reassembleTable, reassembleRows, parseTable } from "./tableWindows.js";

/**
 * Splitting a table that does not fit, without losing any of it.
 *
 * Two invariants cannot both hold — "never split a row" and "never exceed the budget" — because a
 * single row can be larger than the whole budget. The rule below resolves that in one direction
 * only: rows stay whole while they fit, and a row that cannot fit at all becomes continuation
 * parts split at cell boundaries. Nothing is ever dropped, which is the property the tests state.
 */

const HEADER = "|Segment|Revenue 2025|Revenue 2026|";
const DIVIDER = "|---|---|---|";
const ROWS = [
  "|Consumer|412|455|",
  "|Education|308|331|",
  "|Government|677|702|",
  "|Enterprise|1204|1318|",
];
const TABLE = [HEADER, DIVIDER, ...ROWS].join("\n");

/** Counts characters, so the tests can state sizes without depending on a real tokenizer. */
const charCount = (text: string) => text.length;

describe("reading a GFM table", () => {
  it("separates the header, the divider and the body rows", () => {
    const parsed = parseTable(TABLE);
    expect(parsed?.header).toBe(HEADER);
    expect(parsed?.divider).toBe(DIVIDER);
    expect(parsed?.rows).toEqual(ROWS);
  });

  it("reports anything that is not a table as not a table", () => {
    expect(parseTable("Just a paragraph.")).toBeNull();
    expect(parseTable("|only|a|header|")).toBeNull();
  });
});

describe("splitting an oversized table into row windows", () => {
  it("returns the table unchanged when it already fits", () => {
    expect(splitTable(TABLE, { budget: 10_000, count: charCount }).map((w) => w.markdown)).toEqual([TABLE]);
  });

  it("repeats the header on every window, so each one still says what its columns are", () => {
    const windows = splitTable(TABLE, { budget: 90, count: charCount });
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(window.markdown.startsWith(`${HEADER}\n${DIVIDER}\n`)).toBe(true);
    }
  });

  it("keeps every window within the budget", () => {
    for (const budget of [80, 90, 120, 200]) {
      for (const window of splitTable(TABLE, { budget, count: charCount })) {
        expect(charCount(window.markdown)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("overlaps windows by one row when the budget has room for two", () => {
    // At budget 125 the header costs 50 and each row about 23, so three rows fit and four do
    // not — enough room for the carried row plus a new one. Overlap is what keeps a comparison
    // between adjacent rows intact in at least one window.
    const windows = splitTable(TABLE, { budget: 125, count: charCount });
    expect(windows.length).toBeGreaterThan(1);
    const bodies = windows.map((window) => window.markdown.split("\n").slice(2));
    for (let index = 1; index < bodies.length; index += 1) {
      expect(bodies[index]![0]).toBe(bodies[index - 1]!.at(-1));
    }
  });

  it("drops the overlap rather than the budget when there is room for only one row", () => {
    // Overlap is a courtesy; the budget is a contract. When a carried row will not fit beside
    // the next one, the window carries one row and reassembly still returns the original — the
    // property that matters either way.
    for (const budget of [72, 80, 90]) {
      const windows = splitTable(TABLE, { budget, count: charCount });
      for (const window of windows) expect(charCount(window.markdown)).toBeLessThanOrEqual(budget);
      expect(reassembleTable(windows)).toBe(TABLE);
    }
  });

  it("loses no row: every window together reproduces the table exactly", () => {
    for (const budget of [80, 90, 120, 200, 10_000]) {
      expect(reassembleTable(splitTable(TABLE, { budget, count: charCount }))).toBe(TABLE);
      expect(reassembleRows(splitTable(TABLE, { budget, count: charCount }))).toEqual(ROWS);
    }
  });

  it("keeps the final row, which is the one a truncating embedder would have lost", () => {
    const windows = splitTable(TABLE, { budget: 90, count: charCount });
    expect(windows.at(-1)?.markdown.includes("|Enterprise|1204|1318|")).toBe(true);
  });
});

describe("a single row larger than the whole budget", () => {
  const wideRow = `|Enterprise|${"a".repeat(300)}|${"b".repeat(300)}|`;
  const wideTable = [HEADER, DIVIDER, ROWS[0] ?? "", wideRow].join("\n");

  it("splits that row at cell boundaries rather than refusing or truncating it", () => {
    const windows = splitTable(wideTable, { budget: 400, count: charCount });
    expect(windows.length).toBeGreaterThan(1);
    const joined = windows.map((w) => w.markdown).join("\n");
    expect(joined).toContain("a".repeat(300));
    expect(joined).toContain("b".repeat(300));
  });

  it("reconstructs the row exactly, character for character from its structured parts", () => {
    expect(reassembleRows(splitTable(wideTable, { budget: 400, count: charCount }))).toEqual([
      ROWS[0],
      wideRow,
    ]);
    expect(reassembleTable(splitTable(wideTable, { budget: 400, count: charCount }))).toBe(wideTable);
  });

  it("splits inside a cell when one cell alone exceeds the budget, still losslessly", () => {
    // The case text-only reassembly could not undo: the pieces of one cell are indistinguishable
    // from separate cells in the rendered Markdown. Carrying the fragments as data removes the
    // ambiguity rather than narrowing the contract to avoid it.
    const hugeCell = `|Notes|${"lorem ipsum ".repeat(60).trim()}|x|`;
    const table = [HEADER, DIVIDER, hugeCell].join("\n");
    const windows = splitTable(table, { budget: 120, count: charCount });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.some((window) => window.parts.some((part) => part.withinCell))).toBe(true);
    expect(reassembleRows(windows)).toEqual([hugeCell]);
    for (const window of windows) expect(charCount(window.markdown)).toBeLessThanOrEqual(120);
  });

  it("splits a single word longer than the allowance by characters rather than losing it", () => {
    // The smallest deterministic fallback. There is no boundary left to respect, and refusing or
    // truncating would drop text the reader can see in the document.
    const unbroken = `|Notes|${"z".repeat(600)}|x|`;
    const table = [HEADER, DIVIDER, unbroken].join("\n");
    const windows = splitTable(table, { budget: 120, count: charCount });

    expect(reassembleRows(windows)).toEqual([unbroken]);
    for (const window of windows) expect(charCount(window.markdown)).toBeLessThanOrEqual(120);
  });

  it("prefers cell boundaries, so a row that can be cut between cells is never cut inside one", () => {
    // Correctness alone would not catch this: reassembly is byte-exact wherever the cut falls.
    // The preference is about meaning — a fragment ending mid-cell embeds half a value.
    const row = `|Enterprise|${"a".repeat(120)}|${"b".repeat(120)}|`;
    const windows = splitTable([HEADER, DIVIDER, row].join("\n"), { budget: 200, count: charCount });
    const parts = windows.flatMap((window) => window.parts);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => !part.withinCell)).toBe(true);
    for (const part of parts) {
      // Each fragment starts and ends on a pipe, which is what a cell boundary means here.
      expect(part.fragment.startsWith("|") || part.partIndex > 0).toBe(true);
    }
    expect(reassembleRows(windows)).toEqual([row]);
  });

  it("numbers a row's parts consecutively from zero, and agrees on how many there are", () => {
    const hugeCell = `|Notes|${"lorem ipsum ".repeat(60).trim()}|x|`;
    const windows = splitTable([HEADER, DIVIDER, hugeCell].join("\n"), { budget: 120, count: charCount });
    const parts = windows.flatMap((window) => window.parts).filter((part) => part.row === 0);

    expect(parts.map((part) => part.partIndex)).toEqual(parts.map((_unused, index) => index));
    expect(new Set(parts.map((part) => part.partCount)).size).toBe(1);
    expect(parts[0]?.partCount).toBe(parts.length);
  });

  it("reports which column an oversized middle cell's fragments came from, in order", () => {
    // Provenance, not a boolean. A reader asking "where did this come from" needs the column and
    // the ordering, and `withinCell` alone answers neither.
    const middle = "lorem ipsum ".repeat(60).trim();
    const row = `|Enterprise|${middle}|1318|`;
    const windows = splitTable([HEADER, DIVIDER, row].join("\n"), { budget: 120, count: charCount });
    const parts = windows.flatMap((window) => window.parts).filter((part) => part.row === 0);

    // Ordered, contiguous, and exactly covering the row.
    expect(parts.map((part) => part.partIndex)).toEqual(parts.map((_unused, index) => index));
    let expectedOffset = 0;
    for (const part of parts) {
      expect(part.offset).toBe(expectedOffset);
      expectedOffset += part.fragment.length;
    }
    expect(expectedOffset).toBe(row.length);

    // The long middle cell is column 1, and several consecutive fragments report it.
    const middleParts = parts.filter((part) => part.firstColumn === 1 && part.lastColumn === 1);
    expect(middleParts.length).toBeGreaterThan(1);
    expect(middleParts.map((part) => part.fragment).join("")).toContain("lorem ipsum");

    // The last fragment reaches the final column, so nothing after the split cell was lost.
    expect(parts.at(-1)?.lastColumn).toBe(2);
    expect(reassembleRows(windows)).toEqual([row]);
  });

  it("reports that it cannot window a table whose header alone fills the budget", () => {
    // Refusing the whole document is not an option: an oversized header cell is unusual, not
    // invalid. Reporting "no windows" lets the chunker fall back to lossless prose splitting,
    // which keeps every character at the cost of the repeated header nobody could have fitted.
    const wideHeader = `|${"H".repeat(400)}|Value|`;
    const table = [wideHeader, "|---|---|", "|Row0|1|"].join("\n");
    expect(splitTable(table, { budget: 120, count: charCount })).toEqual([]);
    expect(splitTable(TABLE, { budget: 10, count: charCount })).toEqual([]);
  });

  it("splits an unbroken astral run inside a cell without cutting a surrogate pair", () => {
    // The table equivalent of the prose regression. Decrementing UTF-16 code units lands between
    // the halves of a surrogate pair and produces a lone surrogate — a character the document
    // never contained.
    const row = `|Notes|${"😀".repeat(200)}|x|`;
    const table = [HEADER, DIVIDER, row].join("\n");
    const windows = splitTable(table, { budget: 120, count: charCount });

    for (const tableWindow of windows) {
      expect(charCount(tableWindow.markdown)).toBeLessThanOrEqual(120);
      expect(tableWindow.markdown).not.toContain("\uFFFD");
      for (const part of tableWindow.parts) {
        // A cut through a pair leaves a lone surrogate; a whole one round-trips through an array.
        expect([...part.fragment].join("")).toBe(part.fragment);
      }
    }
    expect(reassembleRows(windows)).toEqual([row]);
  });

  it("does not treat an escaped pipe as a cell boundary or a new column", () => {
    // `\|` is one character of cell content in GFM, not a separator. Counting it would report
    // the wrong column and would let a cut land inside what is really one cell.
    const row = "|A \\| B|C|";
    const table = [HEADER, DIVIDER, row].join("\n");
    const windows = splitTable(table, { budget: 10_000, count: charCount });
    const parts = windows.flatMap((tableWindow) => tableWindow.parts);

    expect(parts).toHaveLength(1);
    // Two real cells, so the last column is 1 — not 2, which counting the escaped pipe gives.
    expect(parts[0]?.firstColumn).toBe(0);
    expect(parts[0]?.lastColumn).toBe(1);
    expect(reassembleRows(windows)).toEqual([row]);
  });

  it("keeps an escaped pipe inside its cell when the row has to be split", () => {
    const row = `|A \\| B|${"z".repeat(200)}|`;
    const table = [HEADER, DIVIDER, row].join("\n");
    const windows = splitTable(table, { budget: 120, count: charCount });

    expect(reassembleRows(windows)).toEqual([row]);
    // The first fragment covers the whole first cell, escaped pipe and all.
    const first = windows[0]?.parts[0];
    expect(first?.fragment).toContain("A \\| B");
  });

  it("reports no windows when the budget leaves less room than one rendered character", () => {
    // `prefixCost < budget` is not sufficient: a fragment is rendered with synthetic pipes, so
    // the smallest emittable piece costs three characters here. Below that, windowing is
    // impossible and the caller falls back to prose rather than emitting over budget.
    const headerCost = HEADER.length + DIVIDER.length + 2;
    expect(splitTable(TABLE, { budget: headerCost + 2, count: charCount })).toEqual([]);
  });
});
