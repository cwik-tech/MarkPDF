import { describe, expect, it } from "vitest";
import { outputBudget, renderReply } from "./budget.js";
import { boundSearchReply, type SearchOmission } from "./searchReply.js";

/**
 * One bound for every changed search reply: the command's JSON, MCP `search_library`, and the app's
 * library reply.
 *
 * The content bound counts the document text of each hit — snippet, headings, name and path — and
 * the reply bound is measured on the finished JSON, because escaping and per-hit keys are not a fixed
 * cost. Expected numbers are computed from the inputs written here, never from the function's output.
 */

interface Hit {
  name: string;
  snippet: string;
}

const textOf = (hit: Hit): string => hit.name + hit.snippet;

function render(kept: readonly Hit[], omission: SearchOmission): Record<string, unknown> {
  return { mode: "hybrid", ...omission, results: kept };
}

describe("bounding a search reply", () => {
  it("returns everything, and says nothing was left out, when it fits", () => {
    const hits = [{ name: "a.pdf", snippet: "one" }, { name: "b.pdf", snippet: "two" }];

    const { payload, kept } = boundSearchReply({ hits, textOf, budget: outputBudget(1_000), replyBudget: outputBudget(10_000), render });

    expect(kept).toEqual(hits);
    expect(payload).toMatchObject({ truncated: false, omittedResults: 0, omittedBytes: 0, totalBytes: 16 });
  });

  it("keeps whole hits within the content bound and counts the bytes it left out", () => {
    const hits = [{ name: "a.pdf", snippet: "x".repeat(95) }, { name: "b.pdf", snippet: "y".repeat(95) }];

    const { payload, kept } = boundSearchReply({ hits, textOf, budget: outputBudget(150), replyBudget: outputBudget(10_000), render });

    expect(kept.map((hit) => hit.name)).toEqual(["a.pdf"]);
    expect(payload).toMatchObject({ truncated: true, omittedResults: 1, omittedBytes: 100, totalBytes: 200 });
  });

  it("stays inside the reply bound when the text escapes badly", () => {
    const nasty = '"\\\n\t'.repeat(400);
    const hits = Array.from({ length: 20 }, (_unused, index) => ({ name: `n${index}.pdf`, snippet: nasty }));
    const replyBudget = outputBudget(8_000);

    const { payload, kept } = boundSearchReply({ hits, textOf, budget: outputBudget(1_000_000), replyBudget, render });

    expect(Buffer.byteLength(renderReply(payload), "utf8")).toBeLessThanOrEqual(replyBudget);
    expect(kept.length).toBeLessThan(hits.length);
    expect(payload).toMatchObject({ truncated: true, omittedResults: hits.length - kept.length });
  });

  it("counts a long document name and path as document text", () => {
    const hits = [{ name: "N".repeat(500), snippet: "s" }];

    const { payload, kept } = boundSearchReply({ hits, textOf, budget: outputBudget(100), replyBudget: outputBudget(10_000), render });

    expect(kept).toEqual([]);
    expect(payload).toMatchObject({ truncated: true, omittedResults: 1, omittedBytes: 501, totalBytes: 501 });
  });

  it("returns no hit, rather than an oversized one, when the first hit alone is over the bound", () => {
    const hits = [{ name: "big.pdf", snippet: "z".repeat(5_000) }, { name: "small.pdf", snippet: "s" }];

    const { payload, kept } = boundSearchReply({ hits, textOf, budget: outputBudget(1_000), replyBudget: outputBudget(10_000), render });

    expect(kept).toEqual([]);
    expect(payload).toMatchObject({ truncated: true, omittedResults: 2 });
  });

  it("reports an empty result as an answer", () => {
    const { payload, kept } = boundSearchReply({ hits: [], textOf, budget: outputBudget(10), replyBudget: outputBudget(1_000), render });

    expect(kept).toEqual([]);
    expect(payload).toEqual({ mode: "hybrid", truncated: false, omittedResults: 0, omittedBytes: 0, totalBytes: 0, results: [] });
  });
});
