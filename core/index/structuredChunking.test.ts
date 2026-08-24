import { describe, expect, it } from "vitest";
import { chunkStructuredPages, toPlainText, BREADCRUMB_SEPARATOR } from "./structuredChunking.js";
import { splitIntoBlocks } from "./markdownBlocks.js";
import { BREADCRUMB_TOKEN_SHARE } from "../tokenize/budget.js";
import { createTruncatingEmbedder } from "./truncatingEmbedder.js";
import { EXPECTED_PAGE_10_MARKDOWN } from "../ocr/recordedRecognition.test-support.js";

/**
 * Assembling blocks into chunks that fit the embedding budget.
 *
 * The invariant under test is direct and embedder-independent: no chunk's `embedText` exceeds the
 * budget, ever. A retrieval test alone could not prove it, because the deterministic embedder
 * hashes whatever it is handed and would return a confident vector for an input the real model
 * would have silently cut in half.
 */

/** Characters, so the tests can state sizes without depending on a real tokenizer. */
const count = (text: string) => text.length;

const pages = (...markdown: string[]) =>
  markdown.map((text, index) => ({ page: index + 1, markdown: text, source: "pdf" as const }));

describe("turning Markdown into chunks that fit", () => {
  it("keeps every chunk's embedding input inside the budget", () => {
    const long = Array.from({ length: 200 }, (_unused, index) => `word${index}`).join(" ");
    for (const budget of [60, 120, 400]) {
      for (const chunk of chunkStructuredPages(pages(`# Report\n\n${long}`), { budget, count })) {
        expect(count(chunk.embedText)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("prepends the breadcrumb to the embedding input only, never to the stored text", () => {
    // The stored text is what a search result shows and what a highlight matches against. A
    // breadcrumb in there would be quoted back to the reader as though it were on the page.
    const [chunk] = chunkStructuredPages(pages("# Report\n\n## Revenue\n\nBody text of the section."), {
      budget: 400,
      count,
    }).filter((entry) => entry.text.includes("Body text"));

    expect(chunk?.headingPath).toEqual(["Report", "Revenue"]);
    expect(chunk?.embedText).toBe(`Report${BREADCRUMB_SEPARATOR}Revenue${BREADCRUMB_SEPARATOR}Body text of the section.`);
    expect(chunk?.text).toBe("Body text of the section.");
  });

  it("drops outer headings when the breadcrumb would take more than its share", () => {
    // Budget 400 gives the breadcrumb 60 characters. Each heading below is 25, so two fit with
    // their separators and three do not. Outside in: the nearest heading carries the most signal
    // and is dropped last.
    const outer = "A".repeat(25);
    const middle = "B".repeat(25);
    const inner = "C".repeat(25);
    const deep = [`# ${outer}`, `## ${middle}`, `### ${inner}`].join("\n\n");
    const chunk = chunkStructuredPages(pages(`${deep}\n\nShort body.`), { budget: 400, count }).find(
      (entry) => entry.text === "Short body.",
    );

    expect(chunk).toBeDefined();
    expect(count(chunk?.embedText ?? "")).toBeLessThanOrEqual(400);
    expect(chunk?.embedText).toContain(inner);
    expect(chunk?.embedText).toContain(middle);
    expect(chunk?.embedText).not.toContain(outer);
  });

  it("drops the breadcrumb altogether rather than exceed its share for a single heading", () => {
    // The share is a ceiling, not a target. One heading longer than the whole allowance is
    // dropped like any other, because a breadcrumb that broke the budget would defeat the point.
    const huge = "H".repeat(200);
    const chunk = chunkStructuredPages(pages(`# ${huge}\n\nShort body.`), { budget: 120, count }).find(
      (entry) => entry.text === "Short body.",
    );
    expect(chunk?.embedText).toBe("Short body.");
    expect(chunk?.headingPath).toEqual([huge]);
  });

  it("always leaves the body at least the budget less the breadcrumb's share", () => {
    // The governing lower bound, asserted directly. Finding a short body and checking the total
    // fits proves nothing about reservation — a breadcrumb allowed to take everything would pass
    // that as long as the body happened to be small.
    const budget = 200;
    const allowance = Math.floor(budget * BREADCRUMB_TOKEN_SHARE);
    const deep = Array.from({ length: 20 }, (_unused, index) => `${"#".repeat((index % 6) + 1)} Heading number ${index}`).join("\n\n");
    const body = "The body that must survive.";

    for (const chunk of chunkStructuredPages(pages(`${deep}\n\n${body}`), { budget, count })) {
      const breadcrumbLength = count(chunk.embedText) - count(chunk.text);
      expect(breadcrumbLength).toBeLessThanOrEqual(allowance);
      // Whatever the breadcrumb took, the body was guaranteed at least this much room.
      expect(budget - breadcrumbLength).toBeGreaterThanOrEqual(budget - allowance);
      expect(count(chunk.embedText)).toBeLessThanOrEqual(budget);
    }

    const chunk = chunkStructuredPages(pages(`${deep}\n\n${body}`), { budget, count }).find(
      (entry) => entry.text === body,
    );
    expect(chunk?.embedText).toContain(body);
  });

  it("splits a single word longer than the allowance rather than emitting it over budget", () => {
    // The invariant would otherwise be false for exactly this input, and silently: an oversized
    // chunk embeds from its opening characters and the rest is lost with no error.
    const word = "z".repeat(500);
    const budget = 60;
    const chunks = chunkStructuredPages(pages(word), { budget, count });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(count(chunk.embedText)).toBeLessThanOrEqual(budget);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(word);
  });

  it("splits an unbroken run of astral characters without cutting one in half", () => {
    const word = "😀".repeat(120);
    const chunks = chunkStructuredPages(pages(word), { budget: 40, count });

    for (const chunk of chunks) {
      expect(count(chunk.embedText)).toBeLessThanOrEqual(40);
      expect(chunk.text).not.toContain("\uFFFD");
      // A cut through a surrogate pair leaves a lone surrogate; a whole one round-trips.
      expect([...chunk.text].every((point) => point === "😀")).toBe(true);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(word);
  });

  it("anchors every chunk to the page its text came from", () => {
    const chunks = chunkStructuredPages(pages("Page one body text here.", "Page two body text here."), {
      budget: 400,
      count,
    });
    expect(chunks.map((chunk) => chunk.page)).toEqual([1, 2]);
  });

  it("numbers chunks within a page from zero", () => {
    const chunks = chunkStructuredPages(pages("First paragraph.\n\nSecond paragraph.\n\nThird paragraph."), {
      budget: 400,
      count,
    });
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });

  it("windows an oversized table and keeps its final row retrievable", () => {
    const rows = Array.from({ length: 12 }, (_unused, index) => `|Row${index}|${index * 100}|`);
    const table = ["|Segment|Value|", "|---|---|", ...rows, "|Enterprise|1318|"].join("\n");
    const chunks = chunkStructuredPages(pages(`## Revenue\n\n${table}`), { budget: 120, count });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(count(chunk.embedText)).toBeLessThanOrEqual(120);
    expect(chunks.some((chunk) => chunk.text.includes("|Enterprise|1318|"))).toBe(true);
  });

  it("repeats the table's header on every window, which splitting it as prose would not", () => {
    // The distinguishing property. Cutting a table at word boundaries also produces chunks that
    // fit and still contain the rows — so "the final row is somewhere" cannot tell the two
    // apart. A window that says what its columns are can only come from windowing.
    const rows = Array.from({ length: 12 }, (_unused, index) => `|Row${index}|${index * 100}|`);
    const table = ["|Segment|Value|", "|---|---|", ...rows].join("\n");
    const chunks = chunkStructuredPages(pages(table), { budget: 120, count });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // The header reaches the model, so a window still says what its columns are...
      expect(chunk.embedText).toContain("|Segment|Value|\n|---|---|\n");
      // ...and not the stored text, which is what a citation quotes and a highlight matches.
      expect(chunk.text).not.toContain("|Segment|Value|");
      expect(chunk.text).not.toContain("|---|---|");
    }
  });

  it("keeps the repeated header out of the stored text of every window", () => {
    // The header belongs in `embedText` — it says what the columns are. It does not belong in
    // the stored text: `header … row` is not contiguous anywhere in the PDF's text layer, so a
    // snippet derived from it would match nothing and the highlight would vanish.
    const rows = Array.from({ length: 12 }, (_unused, index) => `|Row${index}|${index * 100}|`);
    const table = ["|Segment|Value|", "|---|---|", ...rows].join("\n");
    const chunks = chunkStructuredPages(pages(table), { budget: 120, count });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.split("\n").every((line) => /^\|Row\d+\|\d+\|$/.test(line))).toBe(true);
    }
    // Every row is somewhere, none lost to the split.
    const stored = chunks.flatMap((chunk) => chunk.text.split("\n"));
    for (const row of rows) expect(stored).toContain(row);
  });

  it("records a chunk's continuation position, so identity can tell the parts apart", () => {
    const rows = Array.from({ length: 12 }, (_unused, index) => `|Row${index}|${index * 100}|`);
    const table = ["|Segment|Value|", "|---|---|", ...rows].join("\n");
    const chunks = chunkStructuredPages(pages(table), { budget: 120, count });

    expect(chunks.every((chunk) => chunk.partIndex < chunk.partCount)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.partIndex)).size).toBeGreaterThan(1);
  });
});

describe("the snippet a reader sees", () => {
  it("strips heading hashes", () => {
    expect(toPlainText("### Revenue by Segment")).toBe("Revenue by Segment");
  });

  it("turns a table row into the words a text layer would show", () => {
    // The highlight matches the snippet against pdf.js's reading of the page. Pipes and dashes
    // appear nowhere in that reading, so a snippet carrying them matches nothing and the yellow
    // highlight silently disappears.
    expect(toPlainText("|Enterprise|1,204|1,318|")).toBe("Enterprise 1,204 1,318");
  });

  it("drops a table's divider row entirely", () => {
    expect(toPlainText("|A|B|\n|---|---|\n|1|2|")).toBe("A B 1 2");
  });

  it("strips list markers and emphasis", () => {
    expect(toPlainText("- **bold** item\n- _italic_ item")).toBe("bold item italic item");
  });

  it("collapses whitespace so a match is not defeated by layout", () => {
    expect(toPlainText("Revenue\n\n  by   segment")).toBe("Revenue by segment");
  });
});

describe("the truncating embedder, which is what makes truncation observable", () => {
  it("embeds only the first tokens of an oversized input", async () => {
    // The default deterministic embedder hashes whatever it is handed and has no limit, so it
    // would return a confident vector for an input the real model silently cut in half. This
    // stand-in reproduces the cut, which is what makes a retrieval test about it meaningful.
    const embedder = createTruncatingEmbedder({ limit: 5, count });
    const shortVector = await embedder.embed("abcde", "passage");
    const longVector = await embedder.embed("abcdefghijklmnop", "passage");
    expect([...longVector]).toEqual([...shortVector]);
  });

  it("embeds an input inside the limit in full", async () => {
    const embedder = createTruncatingEmbedder({ limit: 100, count });
    const a = await embedder.embed("alpha beta", "passage");
    const b = await embedder.embed("alpha beta gamma", "passage");
    expect([...a]).not.toEqual([...b]);
  });

  it("reports what it truncated, so a test can assert the cut happened", async () => {
    const embedder = createTruncatingEmbedder({ limit: 5, count });
    await embedder.embed("abcdefghij", "passage");
    expect(embedder.truncations).toEqual([{ given: 10, embedded: 5 }]);
  });
});

describe("a page that recognition rebuilt as a table", () => {
  it("chunks through the existing table windowing: body rows stored, header embedded, not stored", () => {
    // The reconstructed page-10 table is small enough to fit one window, so its rows share one
    // stored chunk — the windowing groups as many rows as fit, and does not split one row per
    // chunk. What matters for retrieval is where the header goes: `embedText` carries it, so the
    // model knows what the numbers are, and the stored text does not, so a snippet cannot quote
    // a header that is not contiguous with the row anywhere on the page. No new chunking code
    // is needed for this; the machinery that windows native tables windows rebuilt ones too.
    const chunks = chunkStructuredPages([{ page: 10, markdown: EXPECTED_PAGE_10_MARKDOWN, source: "ocr" }], {
      budget: 400,
      count,
    });

    const answer = chunks.find((chunk) => chunk.text.includes("5170"));
    expect(answer, "the answer row is stored").toBeDefined();
    expect(answer?.text).toContain("Sales & Marketing");
    expect(answer?.text).toContain("R&D");
    expect(answer?.text).toContain("G&A");
    expect(answer?.text, "the header is not stored with the rows").not.toContain("Approved 2026");
    expect(answer?.embedText, "the header is embedded before the rows").toContain("Approved 2026");
    expect(answer?.embedText).toContain("5170");
  });
});

describe("where a chunk's headings come from", () => {
  it("records each heading's page, so an inherited heading names the page it closed", () => {
    // The heading closes page 1; the table opens page 2 with no heading of its own. The chunk
    // must say the heading came from page 1 — the breadcrumb alone cannot.
    const chunks = chunkStructuredPages(
      pages("The plan's preamble.\n\n## Operating Plan", "|Line item|2028|\n|---|---|\n|Sales|5170|"),
      { budget: 400, count },
    );

    const tableChunk = chunks.find((chunk) => chunk.text.includes("5170"));
    expect(tableChunk?.page).toBe(2);
    expect(tableChunk?.headings).toEqual([{ title: "Operating Plan", page: 1 }]);
    expect(tableChunk?.localHeadings).toEqual([]);
    // The breadcrumb is unchanged: titles only, exactly as before.
    expect(tableChunk?.headingPath).toEqual(["Operating Plan"]);
    expect(tableChunk?.embedText.startsWith(`Operating Plan${BREADCRUMB_SEPARATOR}`)).toBe(true);
  });

  it("records a heading on the chunk's own page as coming from that page", () => {
    const chunks = chunkStructuredPages(pages("## Appendix A\n\nThe appendix body."), { budget: 400, count });
    const body = chunks.find((chunk) => chunk.text === "The appendix body.");
    expect(body?.headings).toEqual([{ title: "Appendix A", page: 1 }]);
  });
});

describe("low-signal text: retrieval context, never lost", () => {
  const FOOTER = "MarkPDF planning pack - confidential draft";

  it("a label with a following chunk stops being a chunk and becomes that chunk's context", () => {
    const chunks = chunkStructuredPages(pages("# Report\n\n**T R A C T I O N**\n\nThe body that follows the label."), {
      budget: 400,
      count,
    });

    expect(chunks.some((chunk) => chunk.text.includes("T R A C T I O N")), "no standalone label chunk").toBe(false);
    const body = chunks.find((chunk) => chunk.text === "The body that follows the label.");
    expect(body?.localHeadings).toEqual(["T R A C T I O N"]);
    expect(body?.embedText).toContain("T R A C T I O N");
    expect(body?.text).not.toContain("T R A C T I O N");
  });

  it("an all-caps label behaves like an emphasised one", () => {
    const chunks = chunkStructuredPages(pages("A P P E N D I X\n\nAppendix body text."), { budget: 400, count });

    expect(chunks.some((chunk) => chunk.text === "A P P E N D I X")).toBe(false);
    const body = chunks.find((chunk) => chunk.text === "Appendix body text.");
    expect(body?.localHeadings).toEqual(["A P P E N D I X"]);
    expect(body?.embedText).toContain("A P P E N D I X");
  });

  it("a label with nothing after it on its page is still indexed", () => {
    // The last block of the page: folding it into nothing would lose it, so it stays a chunk.
    const chunks = chunkStructuredPages(pages("Page one body.", "**S U M M A R Y**"), { budget: 400, count });

    const label = chunks.find((chunk) => chunk.page === 2);
    expect(label?.text).toContain("S U M M A R Y");
  });

  it("a short sentence is not a label, even when it would fit the size rule", () => {
    const chunks = chunkStructuredPages(pages("Results follow.\n\nThe results themselves."), { budget: 400, count });

    expect(chunks.some((chunk) => chunk.text === "Results follow.")).toBe(true);
  });

  it("text repeated across enough pages stops producing standalone chunks on any of them", () => {
    const withFooter = Array.from({ length: 6 }, (_unused, index) => `Body of page ${index + 1}.\n\n${FOOTER}`);
    const chunks = chunkStructuredPages(pages(...withFooter), { budget: 400, count });

    expect(chunks.some((chunk) => chunk.text.includes(FOOTER))).toBe(false);
    expect(chunks.some((chunk) => chunk.embedText.includes(FOOTER))).toBe(false);
    expect(chunks.filter((chunk) => chunk.text.startsWith("Body of page")).length).toBe(6);
  });

  it("repeated text below the page threshold still indexes", () => {
    // Three pages carry the line; the rule needs max(3, ceil(0.4 * 3)) = 3... so use two pages,
    // where the same line appears on fewer pages than the threshold demands.
    const chunks = chunkStructuredPages(pages(`Body one.\n\n${FOOTER}`, `Body two.\n\n${FOOTER}`), {
      budget: 400,
      count,
    });

    expect(chunks.some((chunk) => chunk.text.includes(FOOTER))).toBe(true);
  });

  it("leaves the document's blocks untouched, because only the chunk set changes", () => {
    const withFooter = Array.from({ length: 6 }, (_unused, index) => `Body of page ${index + 1}.\n\n${FOOTER}`);
    const blocks = splitIntoBlocks(pages(...withFooter));

    expect(blocks.filter((block) => block.text.includes(FOOTER)).length).toBe(6);
  });
});
