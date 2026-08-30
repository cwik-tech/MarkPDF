import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ocrPages } from "./ocrPages.js";
import { openPdfDocument, type PageImage, type RasteriseOptions } from "./rasterisePages.js";
import { pageFromRecognitionResult, type TextRecogniser } from "./tesseractEngine.js";
import {
  EXPECTED_PAGE_10_MARKDOWN,
  RECORDED_PAGE_10_RESULT,
} from "./recordedRecognition.test-support.js";

/**
 * Reading a *region* of a page that reads perfectly well as text.
 *
 * The whole-page path is covered beside the engine in `ocr.test.ts`; this covers what is
 * different here: the rasteriser is asked for the page once, and the recogniser is given a crop
 * of the qualifying regions rather than the whole page — because recognising a whole page to
 * read one figure is the cost this path exists to avoid.
 */

async function buildTextPagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("A text-bearing page.", { x: 60, y: 720, size: 11, font });
  return await pdf.save();
}

/**
 * A stand-in rasteriser that returns one white PNG per requested page, sized as though rendered
 * at 72 dpi — one point per pixel, which lets the crop arithmetic be stated in plain numbers.
 */
function blankRasteriser(calls: Array<{ pages: readonly number[]; dpi: number | undefined }>) {
  return async (_bytes: Uint8Array, options: RasteriseOptions): Promise<PageImage[]> => {
    calls.push({ pages: [...options.pages], dpi: options.dpi });
    return options.pages.map((page) => {
      const canvas = createCanvas(612, 792);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return { page, image: canvas.toBuffer("image/png"), width: 612, height: 792 };
    });
  };
}

/** The image the recogniser was handed at a position, named when it is missing. */
function seenImage(seen: readonly Uint8Array[], index: number): Uint8Array {
  const image = seen[index];
  if (image === undefined) throw new Error(`The recogniser was handed ${seen.length} image(s); expected one at ${index}.`);
  return image;
}

/** What size of image the recogniser was actually handed, decoded from the PNG bytes. */
async function imageSize(png: Uint8Array): Promise<{ width: number; height: number }> {
  const image = await loadImage(Buffer.from(png));
  return { width: image.width, height: image.height };
}

function recogniserRecording(seen: Uint8Array[], answer: () => { text: string; lines: [] }): TextRecogniser {
  return {
    async recognise(image) {
      seen.push(image);
      return answer();
    },
    async close() {},
  };
}

/** One region on page 1, stated in the page's own points. */
const regionRequest = (boxes: readonly { x: number; y: number; width: number; height: number }[]) => [
  { page: 1, boxes, pageBox: { width: 612, height: 792 } },
];

describe("reading a qualifying region instead of the whole page", () => {
  it("asks the rasteriser for the page once and hands the recogniser a crop of the region", async () => {
    const calls: Array<{ pages: readonly number[]; dpi: number | undefined }> = [];
    const seen: Uint8Array[] = [];

    await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1],
        totalPages: 1,
        imageRegions: regionRequest([{ x: 100, y: 200, width: 300, height: 150 }]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser(calls),
        createRecogniser: async () => recogniserRecording(seen, () => ({ text: "region words", lines: [] })),
      },
    );

    expect(calls).toEqual([{ pages: [1], dpi: 72 }]);
    expect(seen).toHaveLength(1);
    // The region occupies x 100..400 and, top-down, y 442..592 of a 72-dpi render; the crop
    // carries ten points of padding on every side.
    expect(await imageSize(seenImage(seen, 0))).toEqual({ width: 320, height: 170 });
  }, 60_000);

  it("crops the padded union when a page qualifies with several regions", async () => {
    const seen: Uint8Array[] = [];

    await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1],
        totalPages: 1,
        imageRegions: regionRequest([
          { x: 50, y: 50, width: 100, height: 100 },
          { x: 300, y: 400, width: 100, height: 100 },
        ]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser([]),
        createRecogniser: async () => recogniserRecording(seen, () => ({ text: "region words", lines: [] })),
      },
    );

    // Union x 50..400, y 50..500, padded ten points out on every side.
    expect(await imageSize(seenImage(seen, 0))).toEqual({ width: 370, height: 470 });
  }, 60_000);

  it("clamps the padding at the page edge rather than cropping outside it", async () => {
    const seen: Uint8Array[] = [];

    await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1],
        totalPages: 1,
        imageRegions: regionRequest([{ x: 0, y: 0, width: 100, height: 100 }]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser([]),
        createRecogniser: async () => recogniserRecording(seen, () => ({ text: "region words", lines: [] })),
      },
    );

    // The box sits in the bottom-left corner: no room to pad below or to the left.
    expect(await imageSize(seenImage(seen, 0))).toEqual({ width: 110, height: 110 });
  }, 60_000);

  it("reconstructs a table found inside a region, the same as a whole page", async () => {
    const candidates = await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1],
        totalPages: 1,
        imageRegions: regionRequest([{ x: 60, y: 300, width: 320, height: 160 }]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser([]),
        createRecogniser: async () => ({
          async recognise() {
            // The same recorded engine result the whole-page tests use, parsed by the same
            // production parser, so the region path proves it reconstructs exactly as the
            // whole-page path does.
            return pageFromRecognitionResult(RECORDED_PAGE_10_RESULT);
          },
          async close() {},
        }),
      },
    );

    expect(candidates).toEqual([{ page: 1, text: EXPECTED_PAGE_10_MARKDOWN }]);
  }, 60_000);

  it("returns no candidate when a region recognises to nothing", async () => {
    const candidates = await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1],
        totalPages: 1,
        imageRegions: regionRequest([{ x: 60, y: 300, width: 320, height: 160 }]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser([]),
        createRecogniser: async () => ({
          async recognise() {
            return { text: "   \n  ", lines: [] };
          },
          async close() {},
        }),
      },
    );

    expect(candidates).toEqual([]);
  }, 60_000);

  it("still reads whole pages alongside region pages in one render pass", async () => {
    const calls: Array<{ pages: readonly number[]; dpi: number | undefined }> = [];
    const seen: Uint8Array[] = [];

    const candidates = await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [1, 2],
        totalPages: 2,
        imageRegions: regionRequest([{ x: 100, y: 200, width: 300, height: 150 }]),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser(calls),
        createRecogniser: async () => recogniserRecording(seen, () => ({ text: "region words", lines: [] })),
      },
    );

    // One render pass for both pages; the region page is cropped, the flagged page is not.
    expect(calls).toEqual([{ pages: [1, 2], dpi: 72 }]);
    expect(seen).toHaveLength(2);
    expect(await imageSize(seenImage(seen, 0))).toEqual({ width: 320, height: 170 });
    expect(await imageSize(seenImage(seen, 1))).toEqual({ width: 612, height: 792 });
    expect(candidates.map((candidate) => candidate.page)).toEqual([1, 2]);
  }, 60_000);
});

describe("an already-open document", () => {
  it("renders from a supplied handle instead of opening the bytes a second time", async () => {
    // The bytes passed in are unreadable on purpose: if the renderer opens them instead of the
    // supplied handle, this call fails. Reading from the handle is the only way through.
    const handle = await openPdfDocument(await buildTextPagePdf());
    try {
      const candidates = await ocrPages(
        { bytes: Uint8Array.from([1, 2, 3]), pages: [1], totalPages: 1, document: handle },
        { dpi: 72, createRecogniser: async () => recogniserRecording([], () => ({ text: "whole words", lines: [] })) },
      );

      expect(candidates).toEqual([{ page: 1, text: "whole words" }]);
      // The caller owns the handle: reading through it must not have destroyed it.
      expect(handle.pdf.loadingTask.destroyed).toBe(false);
      expect((await handle.pdf.getPage(1)).pageNumber).toBe(1);
    } finally {
      await handle.release();
    }
  }, 60_000);
});

describe("saying which page is being recognised", () => {
  it("reports every page it reads against the full document page count", async () => {
    // Recognition is the slow part of reading a scanned document, and the only honest way to show
    // a reader how far it has got. A free-form sentence cannot drive a progress bar, so the
    // position and the extent are reported as numbers rather than spelled into the message.
    const reported: Array<{ page: number; current: number; total: number; totalPages: number; message: string }> = [];

    await ocrPages(
      {
        bytes: await buildTextPagePdf(),
        pages: [2, 5],
        totalPages: 628,
        onProgress: (progress) => reported.push({ ...progress }),
      },
      {
        dpi: 72,
        rasterise: blankRasteriser([]),
        createRecogniser: async () => recogniserRecording([], () => ({ text: "words", lines: [] })),
      },
    );

    expect(reported.map((entry) => ({ page: entry.page, current: entry.current, total: entry.total, totalPages: entry.totalPages }))).toEqual([
      { page: 2, current: 1, total: 2, totalPages: 628 },
      { page: 5, current: 2, total: 2, totalPages: 628 },
    ]);
    expect(reported[0]?.message).toContain("2");
  }, 60_000);
});
