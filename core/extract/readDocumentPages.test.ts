import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pageNeedsRecognition, readDocumentPages, type ReadDocument } from "./readDocumentPages.js";
import { outlineFromPages } from "../outline/documentOutline.js";

/**
 * Reading a document once, for every command that needs it.
 *
 * The fixture is deliberately mixed: page 1 has a real text layer, page 2 is nothing but pixels.
 * That is the case where the three commands used to disagree — indexing recognised the scan while
 * outlining and converting quietly returned a blank page — and it is the case these fix.
 *
 * The recogniser is replaced here. Whether real OCR reads real pixels is proved end to end, with
 * the network blocked, by `cli/journeys/scannedDocument.test.ts`.
 */

describe("deciding whether a page still needs reading", () => {
  /**
   * The rule on its own, away from any extractor.
   *
   * It has to be testable without one. The state that matters most here — a page the extractor
   * says it read, which came back with nothing on it — is a state the installed extractor does not
   * produce on demand, so driving this through a real document would mean either finding a file
   * that happens to trigger it or faking the engine. Neither is a test of the rule.
   */
  it("asks for the page the extractor flagged", () => {
    expect(pageNeedsRecognition({ needsOcr: true, markdown: "" })).toBe(true);
  });

  it("leaves a page the extractor read alone", () => {
    expect(pageNeedsRecognition({ needsOcr: false, markdown: "Ordinary prose." })).toBe(false);
  });

  it("asks for a page the extractor claims to have read but returned nothing for", () => {
    // The claim and the result contradict each other, and believing the claim is what stores a
    // page as blank when nobody read it. Whitespace counts as nothing: a page carrying a newline
    // is not a page with words on it.
    expect(pageNeedsRecognition({ needsOcr: false, markdown: "" })).toBe(true);
    expect(pageNeedsRecognition({ needsOcr: false, markdown: "   \n  " })).toBe(true);
  });
});

const TEXT_PAGE = "Opening page carrying an ordinary and complete text layer of ample length.";

async function buildMixedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const first = pdf.addPage([612, 792]);
  first.drawText(TEXT_PAGE, { x: 50, y: 700, size: 11, font });

  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "40px Helvetica";
  context.fillText("Scanned page with no text layer at all.", 90, 300);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });

  return await pdf.save();
}

function expectRead(result: Awaited<ReturnType<typeof readDocumentPages>>): ReadDocument {
  if (result.status === "cancelled") throw new Error("Expected the document to be read, but it reported cancelled.");
  return result;
}

describe("a page the extractor can read", () => {
  it("carries its text and says it came from the document's own structure", async () => {
    const read = expectRead(await readDocumentPages({ bytes: await buildMixedPdf() }));

    expect(read.pages[0]?.source).toBe("pdf");
    expect(read.pages[0]?.markdown).toContain("Opening page");
    expect(read.pages[0]?.needsOcr).toBe(false);
  }, 60_000);
});

describe("a page nothing has read", () => {
  it("is empty and says so, rather than carrying whatever was scraped off the scan", async () => {
    // The fragments a native extractor gets from a scan look like ordinary text and would cite a
    // page nobody actually read.
    const read = expectRead(await readDocumentPages({ bytes: await buildMixedPdf() }));

    expect(read.pages[1]?.needsOcr).toBe(true);
    expect(read.pages[1]?.source).toBe("none");
    expect(read.pages[1]?.markdown).toBe("");
  }, 60_000);
});

describe("a page read by recognition", () => {
  it("carries the recognised text and is marked as recognised", async () => {
    const read = expectRead(
      await readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async () => [{ page: 2, text: "## Appendix\n\nRecognised body text." }],
      }),
    );

    expect(read.pages[1]?.source).toBe("ocr");
    expect(read.pages[1]?.markdown).toContain("Recognised body text.");
    expect(read.recognisedHere).toBe(1);
  }, 60_000);

  it("is asked about only the pages the extractor could not read", async () => {
    let asked: readonly number[] = [];
    await readDocumentPages({
      bytes: await buildMixedPdf(),
      resolveOcr: async (request) => {
        asked = request.pages;
        return [];
      },
    });

    expect(asked).toEqual([2]);
  }, 60_000);

  it("is not asked about pages the caller has already said it will not use", async () => {
    // `convert --pages 1` on a 400-page scanned book must not rasterise and recognise 400 pages
    // to then discard 399. The selection is a bound on the work, not a filter applied afterwards.
    let asked: readonly number[] | null = null;
    await readDocumentPages({
      bytes: await buildMixedPdf(),
      ocrOnlyPages: [1],
      resolveOcr: async (request) => {
        asked = request.pages;
        return [];
      },
    });

    expect(asked).toBeNull();
  }, 60_000);

  it("is still asked about a selected page that needs it", async () => {
    let asked: readonly number[] = [];
    await readDocumentPages({
      bytes: await buildMixedPdf(),
      ocrOnlyPages: [2],
      resolveOcr: async (request) => {
        asked = request.pages;
        return [];
      },
    });

    expect(asked).toEqual([2]);
  }, 60_000);

  it("still returns every page, so a selection beyond the document is still detectable", async () => {
    // The page *count* is what tells a caller that `--pages 9` names a page that is not there.
    // Narrowing the OCR must not narrow the document.
    const read = expectRead(await readDocumentPages({ bytes: await buildMixedPdf(), ocrOnlyPages: [1] }));

    expect(read.pages).toHaveLength(2);
    expect(read.pageCount).toBe(2);
  }, 60_000);

  it("asks about every page the extractor could not read, with no way for a caller to answer first", async () => {
    // A caller used to be able to supply text for a page and have recognition skipped for it. That
    // is gone: the application supplied it from the reading its window had done for its own
    // display, so a page the window never looked at was a page nothing looked at, and a page it did
    // look at entered the index shaped by a different engine from every other surface. Recognition
    // now has one producer, and this is the shape that keeps it that way.
    const asked: number[] = [];
    const read = expectRead(
      await readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async (request) => {
          asked.push(...request.pages);
          return request.pages.map((page) => ({ page, text: "Recognised here." }));
        },
      }),
    );

    expect(asked).toEqual([2]);
    expect(read.pages[1]?.markdown).toBe("Recognised here.");
    expect(read.pages[1]?.source).toBe("ocr");
    expect(read.recognisedHere).toBe(1);
  }, 60_000);

  it("says of every page whether it was read, found empty, or never resolved", async () => {
    // Three outcomes, and the third is the one that has to be distinguishable. A page nothing read
    // and a page read and found blank both end up with no text, and storing them the same way is
    // how a scanned page came to be indistinguishable from an empty one — so nothing could ever
    // repair the first without re-reading every document that contained the second.
    const recognised = expectRead(
      await readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async (request) => request.pages.map((page) => ({ page, text: "Recognised here." })),
      }),
    );
    expect(recognised.pages.map((page) => page.status)).toEqual(["read", "read"]);

    const foundBlank = expectRead(
      await readDocumentPages({ bytes: await buildMixedPdf(), resolveOcr: async () => [] }),
    );
    // Asked, answered with nothing. The page really is blank, and saying so stops it being read
    // again on every future open.
    expect(foundBlank.pages.map((page) => page.status)).toEqual(["read", "empty"]);

    const neverAsked = expectRead(await readDocumentPages({ bytes: await buildMixedPdf() }));
    expect(neverAsked.pages.map((page) => page.status)).toEqual(["read", "unresolved"]);
  }, 60_000);

  it("counts a page it could not resolve, so a caller cannot report the document as complete", async () => {
    const read = expectRead(await readDocumentPages({ bytes: await buildMixedPdf() }));

    expect(read.unresolvedPages).toEqual([2]);
  }, 60_000);

  it("leaves nothing unresolved once recognition has answered", async () => {
    const read = expectRead(
      await readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async (request) => request.pages.map((page) => ({ page, text: "Recognised here." })),
      }),
    );

    expect(read.unresolvedPages).toEqual([]);
  }, 60_000);

  it("ends the read when recognition fails, rather than returning a document with a page missing", async () => {
    // A document whose scanned pages could not be read is incomplete. Returning it as merely
    // short would let it be indexed, converted or outlined as though nothing were wrong.
    await expect(
      readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async () => {
          throw new Error("the recognition engine is not installed");
        },
      }),
    ).rejects.toThrow("not installed");
  }, 60_000);

});

describe("cancelling", () => {
  it("stops after recognition returns, rather than writing what it managed to read", async () => {
    // Recognition is long and not preemptible. What is guaranteed is that a cancel arriving
    // during it is noticed the instant it returns, so the pages never reach a caller that would
    // store them.
    const controller = new AbortController();

    const result = await readDocumentPages({
      bytes: await buildMixedPdf(),
      signal: controller.signal,
      resolveOcr: async () => {
        controller.abort();
        return [{ page: 2, text: "read just as the cancel arrived" }];
      },
    });

    expect(result.status).toBe("cancelled");
  }, 60_000);

  it("reports cancellation as an outcome rather than an error", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await readDocumentPages({ bytes: await buildMixedPdf(), signal: controller.signal });

    expect(result.status).toBe("cancelled");
  }, 60_000);
});

describe("what the outline is derived from", () => {
  it("includes a heading that only recognition could have found", async () => {
    // The merge is what makes `outline` agree with `index` about a scanned document. Before it,
    // a heading on a scanned page existed in the index and not in the outline.
    const read = expectRead(
      await readDocumentPages({
        bytes: await buildMixedPdf(),
        resolveOcr: async () => [{ page: 2, text: "## Appendix C\n\nRecorded during the survey." }],
      }),
    );

    const outline = outlineFromPages(
      read.pages.map((page) => ({ page: page.page, markdown: page.markdown, source: page.source === "ocr" ? "ocr" : "pdf" })),
      6,
    );

    expect(outline).toContainEqual({ level: 2, title: "Appendix C", page: 2 });
  }, 60_000);
});
