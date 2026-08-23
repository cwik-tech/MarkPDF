import { describe, expect, it } from "vitest";
import { extractDocumentPages, type PageTextReader } from "./pageText";
import type { OcrPageText, SemanticIndexProgress } from "../types";

/** A promise with its resolver exposed, so a test can hold one page read open deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * The requirement these tests encode, taken from the semantic-index behaviour that shipped
 * before extraction moved to the main process: a page is indexed from its embedded text layer
 * unless that layer is too sparse to be useful, in which case the page's OCR text stands in.
 * "Too sparse" is fewer than 100 non-space characters — the same threshold `findTextMatches`
 * applies in `src/pdf/document.ts`, so search and indexing agree on which pages are scanned.
 */

/** Ninety-nine non-space characters: one below the usable-text-layer threshold. */
const SPARSE_LAYER = "a".repeat(99);
/** Exactly one hundred non-space characters: the first length that counts as usable. */
const USABLE_LAYER = "b".repeat(100);

function makeReader(pageText: readonly string[]): PageTextReader {
  return {
    numPages: pageText.length,
    readPageText: async (pageNumber) => pageText[pageNumber - 1] ?? "",
  };
}

/** A reader that records which pages were asked for, so a test can prove one was never read. */
function makeRecordingReader(pageText: readonly string[]) {
  const requested: number[] = [];
  return {
    requested,
    reader: {
      numPages: pageText.length,
      readPageText: async (pageNumber: number) => {
        requested.push(pageNumber);
        return pageText[pageNumber - 1] ?? "";
      },
    } satisfies PageTextReader,
  };
}

/** Unwrap a successful extraction, failing loudly if the run was cancelled instead. */
function expectExtracted(result: Awaited<ReturnType<typeof extractDocumentPages>>) {
  if (result.status === "cancelled") throw new Error("Expected extraction to finish, but it was cancelled.");
  return result.pages;
}

function makeOcrPage(page: number, text: string): OcrPageText {
  return { page, text, lines: [] };
}

describe("extractDocumentPages", () => {
  it("indexes a page from its embedded text layer when the layer is usable", async () => {
    const pages = expectExtracted(
      await extractDocumentPages(makeReader([USABLE_LAYER]), [makeOcrPage(1, "scanned words")]),
    );

    expect(pages).toEqual([{ page: 1, text: USABLE_LAYER, source: "pdf" }]);
  });

  it("substitutes OCR text for a page whose text layer is too sparse to be useful", async () => {
    const pages = expectExtracted(
      await extractDocumentPages(makeReader([SPARSE_LAYER]), [makeOcrPage(1, "scanned words")]),
    );

    expect(pages).toEqual([{ page: 1, text: "scanned words", source: "ocr" }]);
  });

  it("keeps a sparse text layer when the page has no OCR text to fall back to", async () => {
    const pages = expectExtracted(await extractDocumentPages(makeReader([SPARSE_LAYER]), []));

    expect(pages).toEqual([{ page: 1, text: SPARSE_LAYER, source: "pdf" }]);
  });

  it("omits a page that has no text from either source, so a blank page never becomes a chunk", async () => {
    const pages = expectExtracted(await extractDocumentPages(makeReader(["   ", USABLE_LAYER]), []));

    expect(pages).toEqual([{ page: 2, text: USABLE_LAYER, source: "pdf" }]);
  });

  it("collapses runs of whitespace so the same page text produces the same chunks every run", async () => {
    const pages = expectExtracted(
      await extractDocumentPages(makeReader(["Revenue\n\n  by   segment"]), []),
    );

    expect(pages).toEqual([{ page: 1, text: "Revenue by segment", source: "pdf" }]);
  });

  it("matches OCR text to its own page rather than to the page being read", async () => {
    const pages = expectExtracted(
      await extractDocumentPages(makeReader([SPARSE_LAYER, SPARSE_LAYER]), [
        makeOcrPage(2, "second page scan"),
      ]),
    );

    expect(pages).toEqual([
      { page: 1, text: SPARSE_LAYER, source: "pdf" },
      { page: 2, text: "second page scan", source: "ocr" },
    ]);
  });

  it("reports progress for every page so the interface can show which page is being read", async () => {
    const reported: SemanticIndexProgress[] = [];

    await extractDocumentPages(makeReader([USABLE_LAYER, USABLE_LAYER]), [], {
      onProgress: (progress) => reported.push(progress),
    });

    expect(reported).toEqual([
      { status: "checking", current: 1, total: 2, message: "Reading page 1 of 2" },
      { status: "checking", current: 2, total: 2, message: "Reading page 2 of 2" },
    ]);
  });

  describe("stopping partway through", () => {
    it("reads no page at all when it is asked to stop before it starts", async () => {
      const { requested, reader } = makeRecordingReader([USABLE_LAYER, USABLE_LAYER]);
      const controller = new AbortController();
      controller.abort();

      const result = await extractDocumentPages(reader, [], { signal: controller.signal });

      expect(result).toEqual({ status: "cancelled" });
      expect(requested).toEqual([]);
    });

    it("reads no further pages once it is asked to stop", async () => {
      // Extraction walks every page of the document. Without a check between pages, turning
      // semantic search off during a 300-page PDF keeps reading pages the user no longer wants
      // indexed, on the thread that draws the interface. The stop is raised while page one is
      // being announced, so page one is already in flight and pages two and three must not be.
      const { requested, reader } = makeRecordingReader([USABLE_LAYER, USABLE_LAYER, USABLE_LAYER]);
      const controller = new AbortController();

      const result = await extractDocumentPages(reader, [], {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.current === 1) controller.abort();
        },
      });

      expect(result).toEqual({ status: "cancelled" });
      expect(requested).toEqual([1]);
    });

    it("stops after an awaited read that was already in flight when the stop arrived", async () => {
      // Reading a page is asynchronous, so a stop can arrive while one is pending. The stop
      // lands during the read of the *last* page deliberately: with an earlier page, the next
      // iteration's check would catch it and this check would look unnecessary. On the last
      // page there is no next iteration, so without a check after the await the run would
      // return a full, successful extraction for a job the user had already stopped.
      const controller = new AbortController();
      const releaseLastPage = deferred<string>();
      const requested: number[] = [];
      const reader: PageTextReader = {
        numPages: 2,
        readPageText: async (pageNumber) => {
          requested.push(pageNumber);
          if (pageNumber === 2) return releaseLastPage.promise;
          return USABLE_LAYER;
        },
      };

      const running = extractDocumentPages(reader, [], { signal: controller.signal });
      await Promise.resolve();
      controller.abort();
      releaseLastPage.resolve(USABLE_LAYER);

      expect(await running).toEqual({ status: "cancelled" });
      expect(requested).toEqual([1, 2]);
    });

    it("finishes normally when nothing asks it to stop", async () => {
      const controller = new AbortController();
      const pages = expectExtracted(
        await extractDocumentPages(makeReader([USABLE_LAYER]), [], { signal: controller.signal }),
      );
      expect(pages).toEqual([{ page: 1, text: USABLE_LAYER, source: "pdf" }]);
    });
  });
});
