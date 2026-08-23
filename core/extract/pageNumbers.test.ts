import { describe, expect, it } from "vitest";
import {
  classificationPageCount,
  extractPagesFromPdf,
  toExtractedDocument,
  toExtractedDocumentFromEngine,
  pageFromMarkdownResult,
  pageFromTablesList,
  pageFromColumnsList,
  pageFromOcrList,
  pageFromOcrReason,
  PdfInspectorError,
} from "./pdfInspector.js";

/**
 * The adapter's pure rules, kept apart from the fixture-driven acceptance tests on purpose.
 *
 * Those build real PDFs in `beforeAll` and call the native binding. A normalizer regression that
 * makes extraction throw would fail that hook and *skip* every test in the file, hiding which
 * rule broke behind a suite error. These run in milliseconds and answer that question directly.
 */

/** A well-formed engine result, so each malformed case below differs in exactly one way. */
function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    pages: [
      { page: 0, markdown: "one", needsOcr: false },
      { page: 1, markdown: "two", needsOcr: false },
    ],
    pagesWithTables: [],
    pagesWithColumns: [],
    pagesNeedingOcr: [],
    ocrReasonsByPage: [],
    ...overrides,
  };
}

describe("normalizing one engine page number", () => {
  const PAGE_COUNT = 3;

  it("shifts a markdown result's zero-based page onto MarkPDF's one-based page", () => {
    expect(pageFromMarkdownResult(0, PAGE_COUNT)).toBe(1);
    expect(pageFromMarkdownResult(2, PAGE_COUNT)).toBe(3);
  });

  it("leaves a one-based list's page alone", () => {
    for (const normalize of [pageFromTablesList, pageFromColumnsList, pageFromOcrList, pageFromOcrReason]) {
      expect(normalize(1, PAGE_COUNT)).toBe(1);
      expect(normalize(3, PAGE_COUNT)).toBe(3);
    }
  });

  it("refuses a markdown page beyond the document, which would cite a page nobody can open", () => {
    expect(() => pageFromMarkdownResult(3, PAGE_COUNT)).toThrow(PdfInspectorError);
    expect(() => pageFromMarkdownResult(-1, PAGE_COUNT)).toThrow(PdfInspectorError);
  });

  it("refuses a one-based page outside the document", () => {
    for (const normalize of [pageFromTablesList, pageFromColumnsList, pageFromOcrList, pageFromOcrReason]) {
      expect(() => normalize(0, PAGE_COUNT)).toThrow(PdfInspectorError);
      expect(() => normalize(4, PAGE_COUNT)).toThrow(PdfInspectorError);
    }
  });

  it("refuses anything that is not a whole number, rather than rounding it", () => {
    for (const normalize of [pageFromMarkdownResult, pageFromTablesList, pageFromColumnsList, pageFromOcrList, pageFromOcrReason]) {
      expect(() => normalize(1.5, PAGE_COUNT)).toThrow(PdfInspectorError);
      expect(() => normalize(Number.NaN, PAGE_COUNT)).toThrow(PdfInspectorError);
      expect(() => normalize("2", PAGE_COUNT)).toThrow(PdfInspectorError);
      expect(() => normalize(null, PAGE_COUNT)).toThrow(PdfInspectorError);
      expect(() => normalize(undefined, PAGE_COUNT)).toThrow(PdfInspectorError);
    }
  });

  it("names the field it rejected, so a convention change upstream is diagnosable", () => {
    expect(() => pageFromTablesList(9, PAGE_COUNT)).toThrow(/pagesWithTables/);
    expect(() => pageFromColumnsList(9, PAGE_COUNT)).toThrow(/pagesWithColumns/);
    expect(() => pageFromOcrList(9, PAGE_COUNT)).toThrow(/pagesNeedingOcr/);
    expect(() => pageFromOcrReason(9, PAGE_COUNT)).toThrow(/ocrReasonsByPage/);
    expect(() => pageFromMarkdownResult(9, PAGE_COUNT)).toThrow(/pages\[\]\.page/);
  });
});

describe("refusing a malformed engine result", () => {
  it("accepts a well-formed result", () => {
    expect(toExtractedDocument(engineResult(), 2).pages.map((page) => page.page)).toEqual([1, 2]);
  });

  it("refuses a result that is not an object", () => {
    for (const raw of [null, undefined, 42, "pages", []]) {
      expect(() => toExtractedDocument(raw, 2)).toThrow(PdfInspectorError);
    }
  });

  it("refuses a page list that skips a page, rather than indexing a document with a hole in it", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "one", needsOcr: false },
        { page: 2, markdown: "three", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 3)).toThrow(/exactly one entry/);
  });

  it("refuses a duplicated page rather than silently indexing it twice", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "one", needsOcr: false },
        { page: 0, markdown: "one again", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(PdfInspectorError);
  });

  it("refuses pages out of source order rather than sorting them into shape", () => {
    // Sorting would hide an engine that changed its ordering contract, and ordering is what
    // makes chunk positions within a document reproducible.
    const raw = engineResult({
      pages: [
        { page: 1, markdown: "two", needsOcr: false },
        { page: 0, markdown: "one", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/source order/);
  });

  it("refuses a page count that disagrees with the document", () => {
    expect(() => toExtractedDocument(engineResult(), 3)).toThrow(/exactly one entry/);
  });

  it("refuses an array where an object is required, naming the slot rather than its contents", () => {
    // An array is an object to `typeof`, so a guard that only checks `typeof === "object"` lets
    // one through and the failure then surfaces as a confusing complaint about a missing field.
    expect(() => toExtractedDocument([], 2)).toThrow(/extraction result must be an object/);
    const raw = engineResult({ pages: [[], { page: 1, markdown: "two", needsOcr: false }] });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/pages\[0\] must be an object/);
  });

  it("refuses a page whose markdown is not a string", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: 12, needsOcr: false },
        { page: 1, markdown: "two", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/markdown/);
  });

  it("refuses a needsOcr flag that is not a boolean, rather than reading it as false", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "one", needsOcr: "yes" },
        { page: 1, markdown: "two", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/needsOcr/);
  });

  it("refuses an ocrReason that is present but not a string", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "one", needsOcr: true, ocrReason: 7 },
        { page: 1, markdown: "two", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/ocrReason/);
  });

  it("refuses a page-bearing list that is not an array", () => {
    for (const field of ["pagesWithTables", "pagesWithColumns", "pagesNeedingOcr", "ocrReasonsByPage"]) {
      expect(() => toExtractedDocument(engineResult({ [field]: "2" }), 2)).toThrow(new RegExp(field));
    }
  });

  it("refuses an out-of-range entry in any page-bearing list", () => {
    for (const field of ["pagesWithTables", "pagesWithColumns", "pagesNeedingOcr"]) {
      expect(() => toExtractedDocument(engineResult({ [field]: [3] }), 2)).toThrow(new RegExp(field));
    }
    expect(() =>
      toExtractedDocument(engineResult({ ocrReasonsByPage: [{ page: 3, reasons: ["scanned"] }] }), 2),
    ).toThrow(/ocrReasonsByPage/);
  });

  it("refuses an OCR reason entry whose reasons are not strings", () => {
    expect(() =>
      toExtractedDocument(engineResult({ ocrReasonsByPage: [{ page: 1, reasons: [7] }] }), 2),
    ).toThrow(/reasons/);
  });
});

describe("reading the page count from a classification", () => {
  it("accepts a well-formed classification", () => {
    expect(classificationPageCount({ pageCount: 3 })).toBe(3);
  });

  it("refuses a classification that is not an object", () => {
    // classifyPdfAsync is third-party output like any other. Destructuring it directly would
    // let `undefined` become the page count and turn every later range check into a no-op.
    for (const raw of [null, undefined, 7, "3", [], true]) {
      expect(() => classificationPageCount(raw)).toThrow(PdfInspectorError);
    }
  });

  it("refuses a page count that is missing, fractional, zero, or negative", () => {
    for (const pageCount of [undefined, 2.5, 0, -1, Number.NaN, "3", null]) {
      expect(() => classificationPageCount({ pageCount })).toThrow(/pageCount/);
    }
  });

  it("ignores everything else the classification carries, including its own page list", () => {
    // Its `pagesNeedingOcr` is 0-based and names every page of an image-based document even
    // when one page is a scan. Nothing here may read it, so nothing here does.
    expect(classificationPageCount({ pageCount: 2, pagesNeedingOcr: [0, 1], pdfType: "ImageBased" })).toBe(2);
  });
});

describe("taking the page count from the classification rather than the extraction", () => {
  it("refuses an extraction that returned fewer pages than the document has", () => {
    // The completeness check only means something if the count comes from somewhere other than
    // the thing being counted. Reading it from the extraction would make this pass vacuously.
    expect(() => toExtractedDocumentFromEngine({ pageCount: 3 }, engineResult())).toThrow(
      /exactly one entry/,
    );
  });

  it("accepts an extraction that covers the whole document", () => {
    expect(toExtractedDocumentFromEngine({ pageCount: 2 }, engineResult()).pageCount).toBe(2);
  });

  it("refuses a malformed classification before looking at the extraction", () => {
    expect(() => toExtractedDocumentFromEngine(null, engineResult())).toThrow(PdfInspectorError);
  });
});

describe("refusing duplicated or self-contradicting metadata", () => {
  it("refuses a repeated page in any page list rather than counting it twice", () => {
    for (const field of ["pagesWithTables", "pagesWithColumns", "pagesNeedingOcr"]) {
      expect(() => toExtractedDocument(engineResult({ [field]: [1, 1] }), 2)).toThrow(
        new RegExp(`${field}.*(once|duplicate)`, "i"),
      );
    }
  });

  it("refuses a repeated page among the OCR reasons", () => {
    const raw = engineResult({
      pagesNeedingOcr: [1],
      pages: [
        { page: 0, markdown: "", needsOcr: true },
        { page: 1, markdown: "two", needsOcr: false },
      ],
      ocrReasonsByPage: [
        { page: 1, reasons: ["scanned"] },
        { page: 1, reasons: ["garbled"] },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/ocrReasonsByPage/i);
  });

  it("refuses a page flagged as needing OCR that the OCR list does not name", () => {
    // Two independent statements about the same fact. Believing one and ignoring the other is
    // how a page gets indexed as readable text that the engine said it could not read.
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "", needsOcr: true },
        { page: 1, markdown: "two", needsOcr: false },
      ],
      pagesNeedingOcr: [],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/needsOcr/);
  });

  it("refuses a page named by the OCR list that is not flagged as needing OCR", () => {
    expect(() => toExtractedDocument(engineResult({ pagesNeedingOcr: [1] }), 2)).toThrow(/needsOcr/);
  });

  it("refuses an OCR reason for a page that is not in the OCR list", () => {
    const raw = engineResult({
      pagesNeedingOcr: [],
      ocrReasonsByPage: [{ page: 1, reasons: ["scanned"] }],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/ocrReasonsByPage/);
  });

  it("refuses a reason on a page that is not flagged as needing OCR", () => {
    // A reason explains why a page could not be read. Carrying one on a page the engine says it
    // read fine is a contradiction, and the reason would then travel with text that was never
    // in doubt.
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "one", needsOcr: false, ocrReason: "scanned" },
        { page: 1, markdown: "two", needsOcr: false },
      ],
    });
    expect(() => toExtractedDocument(raw, 2)).toThrow(/ocrReason/);
  });

  it("accepts a page needing OCR that carries no reason, because the engine may not know one", () => {
    // `ocrReason` is optional in the package's own declaration. Requiring it would reject
    // perfectly ordinary output the moment the engine cannot name a cause.
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "", needsOcr: true },
        { page: 1, markdown: "two", needsOcr: false },
      ],
      pagesNeedingOcr: [1],
    });
    expect(toExtractedDocument(raw, 2).pages[0]?.ocrReason).toBeUndefined();
  });

  it("accepts metadata that agrees with itself", () => {
    const raw = engineResult({
      pages: [
        { page: 0, markdown: "", needsOcr: true, ocrReason: "scanned" },
        { page: 1, markdown: "two", needsOcr: false },
      ],
      pagesNeedingOcr: [1],
      ocrReasonsByPage: [{ page: 1, reasons: ["scanned"] }],
    });
    expect(toExtractedDocument(raw, 2).pagesNeedingOcr).toEqual([1]);
  });
});

describe("reporting a malformed value that cannot be printed", () => {
  it("still raises its own error for a BigInt, which JSON cannot serialise", () => {
    // The guard must survive describing what it rejected. A TypeError thrown while composing
    // the message would escape as an unrelated failure and lose the real diagnosis.
    expect(() => toExtractedDocument(engineResult({ pagesWithTables: 1n }), 2)).toThrow(PdfInspectorError);
  });

  it("still raises its own error for a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toExtractedDocument(engineResult({ pages: circular }), 2)).toThrow(PdfInspectorError);
  });

  it("still raises its own error for a symbol and for a function", () => {
    expect(() => toExtractedDocument(engineResult({ pagesNeedingOcr: Symbol("x") }), 2)).toThrow(PdfInspectorError);
    expect(() => toExtractedDocument(engineResult({ pagesWithColumns: () => 1 }), 2)).toThrow(PdfInspectorError);
  });
});

describe("stopping between the engine's two native calls", () => {
  /**
   * A stand-in for the two package functions, and the only place in the suite that replaces
   * them.
   *
   * `@firecrawl/pdf-inspector` offers no cancellation of any kind, so the only thing that can be
   * asserted about a cancelled extraction is which calls were *not* started. That is invisible
   * against the real binding, which is why this narrow seam exists — it replaces a
   * non-cancellable native boundary, and the package import still lives in one file.
   */
  function recordingEngine(options: { onClassify?: () => void } = {}) {
    const calls: string[] = [];
    return {
      calls,
      engine: {
        classify: async () => {
          calls.push("classify");
          options.onClassify?.();
          return { pageCount: 2 };
        },
        extractPages: async () => {
          calls.push("extractPages");
          return engineResult();
        },
      },
    };
  }

  it("extracts when nothing cancels it", async () => {
    const { calls, engine } = recordingEngine();
    const result = await extractPagesFromPdf(new Uint8Array([1, 2, 3]), { engine });

    expect(result.status).toBe("extracted");
    expect(calls).toEqual(["classify", "extractPages"]);
  });

  it("classifies nothing when it is cancelled before it starts", async () => {
    const { calls, engine } = recordingEngine();
    const controller = new AbortController();
    controller.abort();

    const result = await extractPagesFromPdf(new Uint8Array([1, 2, 3]), { engine, signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(calls).toEqual([]);
  });

  it("does not start the expensive extraction when cancelled during classification", async () => {
    // Classification is milliseconds; extraction is two orders of magnitude slower. Checking
    // only at the ends would let a cancel that arrived during the cheap call still pay for the
    // expensive one.
    const controller = new AbortController();
    const { calls, engine } = recordingEngine({ onClassify: () => controller.abort() });

    const result = await extractPagesFromPdf(new Uint8Array([1, 2, 3]), { engine, signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(calls).toEqual(["classify"]);
  });

  it("discards a completed extraction when the cancel arrived while it was running", async () => {
    const controller = new AbortController();
    const engine = {
      classify: async () => ({ pageCount: 2 }),
      extractPages: async () => {
        controller.abort();
        return engineResult();
      },
    };

    expect(await extractPagesFromPdf(new Uint8Array([1, 2, 3]), { engine, signal: controller.signal })).toEqual({
      status: "cancelled",
    });
  });

  it("still refuses a malformed engine result rather than reporting it cancelled", async () => {
    const engine = {
      classify: async () => ({ pageCount: 2 }),
      extractPages: async () => ({ pages: "not an array" }),
    };
    await expect(extractPagesFromPdf(new Uint8Array([1, 2, 3]), { engine })).rejects.toThrow(PdfInspectorError);
  });
});
