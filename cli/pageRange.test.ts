import { describe, expect, it } from "vitest";
import { parsePageSelection } from "./pageRange.js";

/**
 * `--pages 3-7`, and everything somebody might type instead.
 *
 * Every rejection names `--pages`, because the message is printed next to a usage line and the
 * reader has to know which argument to correct.
 */

function pagesOf(text: string): number[] {
  const parsed = parsePageSelection(text);
  if (!parsed.ok) throw new Error(`Expected a selection, got: ${parsed.message}`);
  return parsed.pages;
}

function messageOf(text: string): string {
  const parsed = parsePageSelection(text);
  if (parsed.ok) throw new Error(`Expected a rejection, got ${parsed.pages.join(",")}`);
  return parsed.message;
}

describe("what can be selected", () => {
  it("takes a single page", () => {
    expect(pagesOf("3")).toEqual([3]);
  });

  it("takes an inclusive range", () => {
    expect(pagesOf("3-7")).toEqual([3, 4, 5, 6, 7]);
  });

  it("takes a mixture, separated by commas", () => {
    expect(pagesOf("1,4-6")).toEqual([1, 4, 5, 6]);
  });

  it("tolerates spaces around the parts", () => {
    expect(pagesOf(" 1 , 4 - 6 ")).toEqual([1, 4, 5, 6]);
  });

  it("returns each page once, in order, however it was written", () => {
    expect(pagesOf("6,2,4-6,2")).toEqual([2, 4, 5, 6]);
  });

  it("takes a range of one", () => {
    expect(pagesOf("4-4")).toEqual([4]);
  });
});

describe("what cannot", () => {
  it("refuses page zero, because pages are counted from one", () => {
    expect(messageOf("0")).toContain("--pages");
  });

  it("refuses a descending range rather than silently reversing it", () => {
    expect(messageOf("7-3")).toContain("7-3");
  });

  it("refuses something that is not a number", () => {
    expect(messageOf("three")).toContain("--pages");
  });

  it("refuses an empty selection", () => {
    expect(messageOf("")).toContain("--pages");
    expect(messageOf(",")).toContain("--pages");
  });

  it("refuses a stray comma rather than quietly ignoring it", () => {
    // `1,,2` and `1,` are almost always a typo or a badly built command line. Dropping the empty
    // part would accept them and convert something slightly different from what was asked for,
    // with nothing said about it.
    for (const malformed of ["1,,2", "1,", ",1", "1, ,2"]) {
      expect(messageOf(malformed)).toContain("--pages");
    }
  });

  it("refuses a fractional page", () => {
    expect(messageOf("2.5")).toContain("--pages");
  });

  it("refuses a range so large it could only be a mistake", () => {
    expect(messageOf("1-100000")).toContain("--pages");
  });
});
