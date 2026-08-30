import { describe, expect, it } from "vitest";
import {
  buildLeafSearchIndex,
  clipRectToLayer,
  findNthOccurrence,
  locateMatch,
  matchRangesByLeaf,
} from "./textLayerSearch";

/**
 * The parts of text-layer search that are arithmetic over strings and boxes.
 *
 * Deliberately not the DOM half. Which elements count as leaf text spans, and what the browser
 * measures for a range inside one, are layout questions that only a rendered page can answer; they
 * are covered by `tests/e2e/pdf-native-navigation.spec.ts`. What lives here is the mapping a wrong
 * answer here would corrupt in both halves: where a match starts, and which drawn run each of its
 * characters belongs to.
 */

/** A tagged page's leaves as PDF.js hands them over: one run per drawn text item. */
const CONTENTS_ROWS = ["Chapter 2 Data", "Management Frameworks", "Chapter 3 Governance"];

describe("indexing the text a page's leaf runs contain", () => {
  it("joins the runs into one string with a separator between them", () => {
    const index = buildLeafSearchIndex(CONTENTS_ROWS, true);
    expect(index.text).toBe("Chapter 2 Data Management Frameworks Chapter 3 Governance");
  });

  it("joins the runs without a separator so a word split across two runs is still found", () => {
    // PDF.js splits a word whenever the drawing operators do. `Frame` and `works` are one word on
    // the page and two runs in the text layer, and the compact index is the only one that can see it.
    const index = buildLeafSearchIndex(["Frame", "works"], false);
    expect(index.text).toBe("Frameworks");
  });

  it("collapses a run of whitespace to a single space", () => {
    const index = buildLeafSearchIndex(["Data   \n  Management"], true);
    expect(index.text).toBe("Data Management");
  });

  it("maps each character back to the run that drew it and its offset inside that run", () => {
    const index = buildLeafSearchIndex(["Data", "Stewardship"], true);
    // "Data Stewardship": index 0 is D of run 0; index 5 is S of run 1 at offset 0.
    expect(index.positions[0]).toEqual({ leaf: 0, offset: 0 });
    expect(index.positions[5]).toEqual({ leaf: 1, offset: 0 });
    expect(index.positions[6]).toEqual({ leaf: 1, offset: 1 });
  });

  it("has one position for every character, so no offset can silently address the wrong run", () => {
    const index = buildLeafSearchIndex(CONTENTS_ROWS, true);
    expect(index.positions).toHaveLength(index.text.length);
  });

  it("drops the trailing separator rather than leaving a match short by one", () => {
    const index = buildLeafSearchIndex(["Governance", ""], true);
    expect(index.text).toBe("Governance");
    expect(index.positions).toHaveLength("Governance".length);
  });
});

describe("locating the occurrence the reader asked for", () => {
  const index = buildLeafSearchIndex(["Stewardship begins", "and Stewardship ends"], true);

  it("uses the offset the page search reported when it still names the query", () => {
    const reported = index.text.indexOf("Stewardship", 1);
    expect(locateMatch(index, "stewardship", reported, 1)).toEqual({ start: reported });
  });

  it("falls back to the nth occurrence when the reported offset has moved", () => {
    // The page text and the text layer are produced by two different PDF.js calls, so an offset
    // taken from one can be a character or two out in the other. The ordinal is what still names
    // the occurrence the reader stepped to.
    const second = index.text.indexOf("Stewardship", 1);
    expect(locateMatch(index, "stewardship", 9999, 1)).toEqual({ start: second });
  });

  it("falls back to the first occurrence when the ordinal is out of range", () => {
    expect(locateMatch(index, "stewardship", 9999, 42)).toEqual({ start: 0 });
  });

  it("returns nothing when the layer does not contain the query at all", () => {
    expect(locateMatch(index, "retention", 0, 0)).toBeNull();
  });

  it("counts occurrences without overlapping them", () => {
    expect(findNthOccurrence("aaaa", "aa", 0)).toBe(0);
    expect(findNthOccurrence("aaaa", "aa", 1)).toBe(2);
    expect(findNthOccurrence("aaaa", "aa", 2)).toBe(-1);
  });
});

describe("splitting a match across the runs it crosses", () => {
  it("returns one range per run, covering only the matched characters", () => {
    const index = buildLeafSearchIndex(["Data Mana", "gement Frameworks"], false);
    const start = index.text.indexOf("Management");
    const ranges = matchRangesByLeaf(index, start, start + "Management".length);

    expect(ranges).toEqual([
      { leaf: 0, start: 5, end: 9 },
      { leaf: 1, start: 0, end: 6 },
    ]);
  });

  it("returns a single range when the match sits inside one run", () => {
    const index = buildLeafSearchIndex(["Stewardship begins here"], true);
    expect(matchRangesByLeaf(index, 12, 18)).toEqual([{ leaf: 0, start: 12, end: 18 }]);
  });

  it("ignores separator characters, which belong to no run", () => {
    const index = buildLeafSearchIndex(["Data", "Management"], true);
    // "Data Management": the space at index 4 was inserted between runs and has no run of its own.
    expect(matchRangesByLeaf(index, 0, 15)).toEqual([
      { leaf: 0, start: 0, end: 4 },
      { leaf: 1, start: 0, end: 10 },
    ]);
  });
});

describe("keeping a highlight inside the page it belongs to", () => {
  it("clips a box that runs past the page edge", () => {
    expect(clipRectToLayer({ left: 90, top: 10, width: 40, height: 12 }, 100, 200)).toEqual({
      left: 90,
      top: 10,
      width: 10,
      height: 12,
    });
  });

  it("pulls a box that starts before the page back to the edge", () => {
    expect(clipRectToLayer({ left: -20, top: -5, width: 40, height: 12 }, 100, 200)).toEqual({
      left: 0,
      top: 0,
      width: 20,
      height: 7,
    });
  });

  it("discards a box that is entirely outside the page rather than drawing a sliver on it", () => {
    expect(clipRectToLayer({ left: 140, top: 10, width: 20, height: 12 }, 100, 200)).toBeNull();
    expect(clipRectToLayer({ left: 10, top: 10, width: 0, height: 12 }, 100, 200)).toBeNull();
  });
});
