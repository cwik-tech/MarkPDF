import { describe, expect, it } from "vitest";
import {
  boundItems,
  boundPages,
  boundText,
  DEFAULT_CONTENT_BUDGET,
  DEFAULT_REPLY_BUDGET,
  fitReply,
  outputBudget,
  pageRangeSummary,
  replyTextBytes,
} from "./budget.js";

/**
 * How much text a tool may return, and what it says when there is more.
 *
 * Documents are large and an agent's context is not. The rule this encodes is that output is
 * bounded *explicitly*: a caller is told how much was left out, never handed a quietly shortened
 * document that reads as a complete one.
 *
 * It lives in core because both surfaces answer to it. A budget enforced in a transport is a
 * budget the other transport does not have.
 */

const tiny = outputBudget(10);

describe("what a budget may be", () => {
  it("is a whole number of UTF-8 bytes, greater than zero", () => {
    expect(outputBudget(1)).toBe(1);
    expect(outputBudget(50_000)).toBe(50_000);
  });

  it("refuses anything that would mean no limit at all", () => {
    // The type carries the brand precisely so that "unbounded" cannot be expressed. These are the
    // runtime half of the same guarantee, for a value that arrived from outside.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => outputBudget(bad)).toThrow(/budget/i);
    }
  });

  it("has a default that is generous for a few pages and far short of a book", () => {
    expect(DEFAULT_CONTENT_BUDGET).toBeGreaterThan(5_000);
    expect(DEFAULT_CONTENT_BUDGET).toBeLessThan(100_000);
  });
});

describe("bounding a piece of text", () => {
  it("returns short text unchanged and says nothing was left out", () => {
    expect(boundText("short", tiny)).toEqual({ text: "short", truncated: false, omittedBytes: 0, totalBytes: 5 });
  });

  it("keeps text of exactly the budget whole", () => {
    expect(boundText("0123456789", tiny).truncated).toBe(false);
  });

  it("says how much it left out", () => {
    const bounded = boundText("0123456789abcde", tiny);

    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(15);
    expect(bounded.omittedBytes).toBe(15 - bounded.text.length);
    expect(bounded.text.length).toBeLessThanOrEqual(10);
  });

  it("cuts at a line ending when one is available, so the last line is a whole one", () => {
    const bounded = boundText("first\nsecond\nthird", outputBudget(14));

    expect(bounded.text).toBe("first\nsecond");
    expect(bounded.truncated).toBe(true);
  });

  it("cuts by character when no line ending fits, rather than returning nothing", () => {
    expect(boundText("a-very-long-single-line", tiny).text).toBe("a-very-lon");
  });

  it("measures the text in UTF-8 bytes, not in characters", () => {
    // Twelve characters, thirty-six bytes. A character count would call this comfortably inside a
    // twenty-byte budget and hand back nearly twice what was promised — and it would do so for
    // exactly the documents least able to afford it.
    const cjk = "第一章序論結語要旨補遺付録";
    expect(cjk.length).toBeLessThan(20);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(20);

    const bounded = boundText(cjk, outputBudget(20));

    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(20);
    expect(bounded.totalBytes).toBe(Buffer.byteLength(cjk, "utf8"));
  });

  it("never cuts inside a character, however many bytes it takes", () => {
    // A budget that lands mid-sequence must round down, or the result is not valid UTF-8 at all.
    for (const budget of [1, 2, 3, 4, 5, 6, 7]) {
      const bounded = boundText("日本語", outputBudget(budget));
      expect(Buffer.byteLength(bounded.text, "utf8") % 3).toBe(0);
      expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(budget);
    }
  });

  it("never splits a character in half", () => {
    // Cutting by UTF-16 code unit lands between the halves of a surrogate pair and emits a
    // character the document never contained.
    const astral = "𝔘𝔫𝔦𝔠𝔬𝔡𝔢";
    const bounded = boundText(astral, outputBudget(5));

    expect([...bounded.text].every((character) => astral.includes(character))).toBe(true);
    expect(bounded.text.length).toBeLessThanOrEqual(5);
  });
});

describe("bounding a document's pages", () => {
  const pages = [
    { page: 1, markdown: "aaaa" },
    { page: 2, markdown: "bbbb" },
    { page: 3, markdown: "cccc" },
  ];

  it("returns every page when they all fit", () => {
    const bounded = boundPages(pages, outputBudget(100));

    expect(bounded.pages).toEqual(pages);
    expect(bounded.truncated).toBe(false);
  });

  it("keeps whole pages while they fit and shortens the one that runs out", () => {
    const bounded = boundPages(pages, outputBudget(9));

    expect(bounded.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(bounded.pages[2]?.markdown).toBe("c");
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedBytes).toBe(3);
  });

  it("stops after the page it shortened, rather than skipping ahead to one that would fit", () => {
    // Returning page 3 but not page 2 would give a reader a document with a hole in it and no
    // indication that the hole is where the budget ran out.
    const bounded = boundPages([{ page: 1, markdown: "aaaaaa" }, { page: 2, markdown: "bbbbbb" }, { page: 3, markdown: "c" }], outputBudget(8));

    expect(bounded.pages.map((page) => page.page)).toEqual([1, 2]);
  });

  it("shortens the page that straddles the budget rather than dropping it whole", () => {
    // A page cut short is still a page a reader can cite; a page silently missing is not.
    const bounded = boundPages(pages, outputBudget(6));

    expect(bounded.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(bounded.pages[1]?.markdown).toBe("bb");
    expect(bounded.truncated).toBe(true);
  });

  it("always returns at least the first page, however small the budget", () => {
    const bounded = boundPages(pages, outputBudget(1));

    expect(bounded.pages.map((page) => page.page)).toEqual([1]);
    expect(bounded.pages[0]?.markdown).toBe("a");
  });

  it("counts every byte the document had, not only the ones it returned", () => {
    expect(boundPages(pages, outputBudget(6)).totalBytes).toBe(12);
  });

  it("counts a page's bytes rather than its characters", () => {
    // Three characters, nine bytes. Counting characters would call this comfortably inside a
    // five-byte budget and return the page whole.
    const bounded = boundPages([{ page: 1, markdown: "日本語" }], outputBudget(5));

    expect(bounded.totalBytes).toBe(9);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pages[0]?.markdown).toBe("日");
    expect(bounded.omittedBytes).toBe(6);
  });

  it("returns nothing at all for a document with no pages", () => {
    expect(boundPages([], outputBudget(10))).toEqual({ pages: [], truncated: false, omittedBytes: 0, totalBytes: 0 });
  });
});

describe("bounding a list of results", () => {
  const hits = [
    { id: "a", text: "aaaa" },
    { id: "b", text: "bbbb" },
    { id: "c", text: "cccc" },
  ];
  const textOf = (hit: { text: string }) => hit.text;

  it("returns every item when they all fit", () => {
    const bounded = boundItems(hits, outputBudget(100), textOf);

    expect(bounded.items).toEqual(hits);
    expect(bounded.truncated).toBe(false);
    expect(bounded.omittedBytes).toBe(0);
  });

  it("keeps items whole and stops, because half a heading says something else", () => {
    const bounded = boundItems(hits, outputBudget(9), textOf);

    expect(bounded.items.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedBytes).toBe(4);
    expect(bounded.totalBytes).toBe(12);
  });

  it("returns nothing rather than one item that breaks the cap", () => {
    // The case most likely to blow a caller's budget must not be the case the budget skips.
    const bounded = boundItems([{ id: "a", text: "aaaaaaaaaa" }, { id: "b", text: "b" }], outputBudget(2), textOf);

    expect(bounded.items).toEqual([]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedBytes).toBe(11);
    expect(bounded.totalBytes).toBe(11);
  });

  it("says so truthfully even when the oversized item is the only one", () => {
    // Returning it and reporting nothing omitted would be wrong twice over.
    const bounded = boundItems([{ id: "a", text: "aaaaaaaaaa" }], outputBudget(3), textOf);

    expect(bounded.items).toEqual([]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedBytes).toBe(10);
  });

  it("never returns more bytes than the budget, whatever the list looks like", () => {
    const lists = [
      [{ id: "a", text: "x".repeat(50) }],
      [{ id: "a", text: "第一章第二章第三章" }, { id: "b", text: "x" }],
      [{ id: "a", text: "" }, { id: "b", text: "x".repeat(20) }],
    ];
    for (const list of lists) {
      for (const budget of [1, 5, 12]) {
        const bounded = boundItems(list, outputBudget(budget), textOf);
        const returned = bounded.items.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
        expect(returned).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("measures bytes, not characters", () => {
    const wide = [{ id: "a", text: "第一章" }, { id: "b", text: "第二章" }];

    const bounded = boundItems(wide, outputBudget(10), textOf);

    expect(bounded.totalBytes).toBe(18);
    expect(bounded.items.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("measures every piece of document text an item carries, not only the first", () => {
    // A search hit carries a snippet and the headings above it, and both came from the document.
    const withHeadings = [
      { id: "a", snippet: "aa", headings: ["hhhh"] },
      { id: "b", snippet: "bb", headings: ["gggg"] },
    ];

    const bounded = boundItems(withHeadings, outputBudget(6), (hit) => hit.snippet + hit.headings.join(""));

    expect(bounded.items.map((hit) => hit.id)).toEqual(["a"]);
    expect(bounded.totalBytes).toBe(12);
  });

  it("returns nothing at all for an empty list", () => {
    expect(boundItems([], outputBudget(10), textOf)).toEqual({
      items: [],
      truncated: false,
      omittedBytes: 0,
      totalBytes: 0,
    });
  });
});

describe("summarising which pages a reply is about", () => {
  it("writes consecutive pages as a range, the way a caller could type it back", () => {
    expect(pageRangeSummary([1, 2, 3, 7, 10, 11, 12], DEFAULT_REPLY_BUDGET)).toBe("1-3,7,10-12");
  });

  it("puts pages in order and says each one once, whatever order they arrived in", () => {
    expect(pageRangeSummary([3, 1, 2, 2, 3], DEFAULT_REPLY_BUDGET)).toBe("1-3");
  });

  it("says nothing about no pages", () => {
    expect(pageRangeSummary([], DEFAULT_REPLY_BUDGET)).toBe("");
  });

  it("is short for a long document, which is the entire point", () => {
    const everyPage = Array.from({ length: 5_000 }, (unused, index) => index + 1);

    expect(pageRangeSummary(everyPage, DEFAULT_REPLY_BUDGET)).toBe("1-5000");
  });

  it("stays inside its budget when the pages alternate and every run is its own", () => {
    // The worst case: no two pages adjacent, so the summary is as long as the list it replaces.
    const alternating = Array.from({ length: 2_000 }, (unused, index) => index * 2 + 1);

    for (const limit of [4, 5, 8, 20, 100, 1_000]) {
      const summary = pageRangeSummary(alternating, outputBudget(limit));
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(limit);
    }
  });

  it("never ends in the middle of a page number", () => {
    const wide = [1000, 2000, 3000, 4000, 5000];

    for (const limit of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      const summary = pageRangeSummary(wide, outputBudget(limit));
      const runs = summary.replace("\u2026", "").split(",").filter((run) => run.length > 0);
      for (const run of runs) expect(wide.map(String)).toContain(run);
    }
  });

  it("says nothing rather than something over budget when even the marker will not fit", () => {
    // The marker is three bytes. A budget below that can carry no honest answer, and an answer
    // three bytes over the limit is the small overrun a bound exists to rule out.
    for (const limit of [1, 2]) {
      expect(pageRangeSummary([1, 3, 5, 7], outputBudget(limit))).toBe("");
    }
  });

  it("spends a budget of exactly the marker on the marker, which fits", () => {
    // Three bytes is enough for the marker and nothing else. Saying the summary was cut is a
    // truthful use of a budget that exactly accommodates it; saying nothing at all discards three
    // bytes of room and reads as "this document has no pages".
    expect(pageRangeSummary([1, 3, 5, 7], outputBudget(3))).toBe("\u2026");
    expect(Buffer.byteLength(pageRangeSummary([1, 3, 5, 7], outputBudget(3)), "utf8")).toBe(3);
  });
});

describe("fitting a reply to what may be handed back", () => {
  const envelope = (items: readonly string[], omitted: number) => ({ items, omitted, truncated: omitted > 0 });

  it("returns everything when everything fits", () => {
    const items = ["a", "b", "c"];
    const fitted = fitReply(items.length, DEFAULT_REPLY_BUDGET, (keep) => envelope(items.slice(0, keep), items.length - keep));

    expect(fitted.keep).toBe(3);
    expect(fitted.truncated).toBe(false);
  });

  it("counts the keys and the indentation around an item, not only the text inside it", () => {
    // A thousand one-character items are a kilobyte of text and many times that as JSON. A measure
    // that looked only at the text would call this well within budget.
    const items = Array.from({ length: 1_000 }, () => "x");
    const budget = outputBudget(2_000);

    const fitted = fitReply(items.length, budget, (keep) => envelope(items.slice(0, keep), items.length - keep));

    expect(fitted.bytes).toBeLessThanOrEqual(budget);
    expect(fitted.keep).toBeLessThan(items.length);
    expect(fitted.truncated).toBe(true);
  });

  it("counts what escaping adds, which depends on what the text contains", () => {
    // Same number of characters, different cost: a control character is one byte of text and six
    // of JSON. The reply that escapes badly must carry fewer items, not the same number.
    const plain = Array.from({ length: 200 }, () => "aaaaaaaa");
    const escaped = Array.from({ length: 200 }, () => String.fromCharCode(1).repeat(8));
    const budget = outputBudget(3_000);
    const fit = (items: readonly string[]) =>
      fitReply(items.length, budget, (keep) => envelope(items.slice(0, keep), items.length - keep));

    const plainFit = fit(plain);
    const escapedFit = fit(escaped);

    expect(escapedFit.keep).toBeLessThan(plainFit.keep);
    expect(plainFit.bytes).toBeLessThanOrEqual(budget);
    expect(escapedFit.bytes).toBeLessThanOrEqual(budget);
  });

  it("returns nothing rather than something over budget when the fixed part alone is too large", () => {
    const budget = outputBudget(20);

    const fitted = fitReply(3, budget, (keep) => ({ preamble: "x".repeat(500), kept: keep }));

    expect(fitted.keep).toBe(0);
    expect(fitted.truncated).toBe(true);
    // Reported honestly rather than pretended away: what came back does not fit, and says so.
    expect(fitted.bytes).toBeGreaterThan(budget);
  });

  it("measures the same rendering that is handed over", () => {
    const fitted = fitReply(1, DEFAULT_REPLY_BUDGET, () => ({ a: 1 }));

    expect(fitted.bytes).toBe(replyTextBytes(fitted.payload));
  });
});
