import { describe, expect, it } from "vitest";
import { tableFromLines, type OcrLineBox } from "./tableFromLines.js";
import { EXPECTED_PAGE_10_MARKDOWN, RECORDED_PAGE_10_RESULT } from "./recordedRecognition.test-support.js";

/**
 * Turning recognised lines with word positions back into a table.
 *
 * Every input here is the recorded recognition of a real page — the geometry the engine actually
 * returned — or a small variation of it built to state one rule. No engine is started, and no
 * expectation is computed by the reconstruction itself.
 *
 * `null` is the contract for "this is not a table": the caller keeps the engine's own text,
 * byte for byte, so a page without a table reads exactly as it did before reconstruction
 * existed.
 */

/** The recorded lines, expressed in the shape the recogniser contract hands to reconstruction. */
function recordedLines(): OcrLineBox[] {
  const block = RECORDED_PAGE_10_RESULT.data.blocks[0];
  if (block === undefined) throw new Error("The recorded page must contain its OCR block.");
  return block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.map((line) => ({
      text: line.text,
      bbox: { ...line.bbox },
      words: line.words.map((word) => ({ text: word.text, x0: word.bbox.x0, x1: word.bbox.x1 })),
    })),
  );
}

/** A line at an arbitrary y, so tests can state geometry without repeating the recording. */
function line(text: string, y: number, words: Array<[string, number, number]>): OcrLineBox {
  return {
    text,
    bbox: {
      x0: Math.min(...words.map((word) => word[1])),
      y0: y,
      x1: Math.max(...words.map((word) => word[2])),
      y1: y + 30,
    },
    words: words.map(([wordText, x0, x1]) => ({ text: wordText, x0, x1 })),
  };
}

describe("reconstructing a table from recognised lines", () => {
  it("rebuilds the pictured financial table with its columns associated", () => {
    // The fixture drew this table at five column positions on a 1800-pixel canvas; the engine
    // read it at 200 dpi. The words are the same either way — only the association of value to
    // column is added, and only reconstruction can add it.
    expect(tableFromLines(recordedLines())).toBe(EXPECTED_PAGE_10_MARKDOWN);
  });

  it("emits the wide title as an ordinary line above the table rather than as a one-cell row", () => {
    // `Approved operating plan` starts at the label column's x but its words run across the
    // page. Treated as a row it would become `| Approved operating plan | | | | |`, which is a
    // false statement about the page; as a line it stays what it is.
    const markdown = tableFromLines(recordedLines());

    expect(markdown?.split("\n")[0]).toBe("Approved operating plan");
    expect(markdown).not.toContain("| Approved operating plan |");
  });

  it("returns null for aligned lines with only one column, because that is prose", () => {
    // Three lines sharing a left margin, with trailing words scattered the way prose scatters
    // them: nothing after the margin starts twice at the same place, so the margin is a
    // paragraph indent, not the first column of a table.
    const prose = [
      line("Ordinary sentence one", 100, [["Ordinary", 78, 160], ["sentence", 172, 270], ["one", 600, 650]]),
      line("Typical phrasing two", 140, [["Typical", 79, 155], ["phrasing", 240, 345], ["two", 410, 460]]),
      line("Regular words three", 180, [["Regular", 77, 158], ["words", 320, 375], ["three", 900, 970]]),
    ];

    expect(tableFromLines(prose)).toBeNull();
  });

  it("gives a row with a missing cell an empty cell, never a shifted row", () => {
    // The ragged row's first number column carries no word. The second words in all three labels
    // also start at nearly the same x position, but their ordinary one-space gaps do not make a
    // data column. Associating by position leaves the numeric gap where it belongs.
    const ragged = [
      line("Line item 2026 2027 2028", 100, [
        ["Line", 78, 139],
        ["item", 151, 212],
        ["2026", 605, 676],
        ["2027", 879, 952],
        ["2028", 1154, 1226],
      ]),
      line("Full row 1110 1120 1130", 140, [
        ["Full", 77, 130],
        ["row", 142, 200],
        ["1110", 605, 676],
        ["1120", 879, 952],
        ["1130", 1154, 1226],
      ]),
      line("Ragged row 1220 1230", 180, [
        ["Ragged", 79, 190],
        ["row", 202, 250],
        ["1220", 879, 952],
        ["1230", 1154, 1226],
      ]),
    ];

    const markdown = tableFromLines(ragged);

    expect(markdown).toContain("| Ragged row |  | 1220 | 1230 |");
    expect(markdown).not.toContain("| Ragged row | 1220 | 1230 |");
  });

  it("returns null when there are fewer than three lines, however aligned", () => {
    // Two lines cannot carry the majority agreement a column needs. This is the fallback that
    // keeps a stray pair of aligned lines from becoming a two-row table.
    const pair = [
      line("One line 100 200", 100, [["One", 78, 120], ["line", 132, 170], ["100", 605, 660], ["200", 879, 940]]),
      line("Two line 300 400", 140, [["Two", 77, 120], ["line", 132, 170], ["300", 605, 660], ["400", 879, 940]]),
    ];

    expect(tableFromLines(pair)).toBeNull();
  });

  it("returns null when the geometry carries no words at all", () => {
    // A recogniser that returns text without boxes is the shape every page had before geometry
    // existed. Those pages must read exactly as they always did.
    const bare = recordedLines().map((entry) => ({ ...entry, words: [] }));

    expect(tableFromLines(bare)).toBeNull();
  });
});
