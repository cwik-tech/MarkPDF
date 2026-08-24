import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { findImageRegions, MIN_IMAGE_COVERAGE, MIN_SINGLE_IMAGE_AREA_PT2 } from "./imageRegions.js";
import { openPdfDocument, RasterisationCancelled, type PdfjsDocumentHandle } from "../ocr/rasterisePages.js";

/**
 * Finding the pictures on a page that reads perfectly well as text.
 *
 * The literals come from a measured probe of the operator-list walk, not from the detector under
 * test: a 0.7 % logo and a 10.6 % figure separate cleanly either side of the thresholds, which
 * is what makes the thresholds defensible rather than arbitrary. Stating them here first is what
 * keeps a change to the rule a visible decision instead of a silent retune.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_AREA = PAGE_WIDTH * PAGE_HEIGHT;

async function buildProbePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const mark = (width: number, height: number): Uint8Array => {
    const canvas = createCanvas(Math.max(width, 8), Math.max(height, 8));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "bold 8px Helvetica";
    context.fillText("mark", 1, canvas.height / 2);
    return canvas.toBuffer("image/png");
  };

  const textPage = () => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText("Ordinary prose that the structural extractor reads without help.", {
      x: 60,
      y: 720,
      size: 11,
      font,
    });
    return page;
  };

  // 1 — text only.
  textPage();

  // 2 — text plus a mark too small to be worth recognising.
  {
    const page = textPage();
    const logo = await pdf.embedPng(mark(80, 40));
    page.drawImage(logo, { x: 460, y: 700, width: 80, height: 40 });
  }

  // 3 — text plus a figure comfortably over the floor.
  {
    const page = textPage();
    const figure = await pdf.embedPng(mark(320, 160));
    page.drawImage(figure, { x: 60, y: 300, width: 320, height: 160 });
  }

  // 4 — text plus a larger figure.
  {
    const page = textPage();
    const figure = await pdf.embedPng(mark(500, 250));
    page.drawImage(figure, { x: 60, y: 300, width: 500, height: 250 });
  }

  // 5 — a full-page raster: coverage of one.
  {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const whole = await pdf.embedPng(mark(PAGE_WIDTH, PAGE_HEIGHT));
    page.drawImage(whole, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  // 6 — many small marks whose *total* clears the coverage rule while no single one clears the
  // floor. This is the case the single-image rule exists for: coverage alone would send a page
  // of decorative icons to the recogniser.
  {
    const page = textPage();
    const small = await pdf.embedPng(mark(80, 40));
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        page.drawImage(small, { x: 60 + column * 100, y: 660 - row * 60, width: 80, height: 40 });
      }
    }
  }

  // 7 — a figure large enough to qualify, on a page turned sideways. The crop arithmetic is
  // stated for upright pages, so a rotated page declines rather than guess.
  {
    const page = textPage();
    const figure = await pdf.embedPng(mark(320, 160));
    page.drawImage(figure, { x: 60, y: 300, width: 320, height: 160 });
    page.setRotation(degrees(90));
  }

  return await pdf.save();
}

describe("finding image regions on a page the extractor read", () => {
  it("reports no regions on a text-only page", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [1] });

    expect(found).toHaveLength(1);
    expect(found[0]?.regions).toEqual([]);
    expect(found[0]?.coverage).toBe(0);
    expect(found[0]?.qualifies).toBe(false);
  }, 60_000);

  it("reports the logo's box exactly, and does not qualify it", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [2] });
    const page = found[0];

    expect(page?.regions).toHaveLength(1);
    const region = page?.regions[0];
    expect(region?.x).toBeCloseTo(460, 1);
    expect(region?.y).toBeCloseTo(700, 1);
    expect(region?.width).toBeCloseTo(80, 1);
    expect(region?.height).toBeCloseTo(40, 1);
    expect(region?.areaPt2).toBeCloseTo(3_200, 0);
    // Measured: 0.7 % of the page. Under the 5 % rule, and the single image under the floor.
    expect(page?.coverage).toBeCloseTo(3_200 / PAGE_AREA, 5);
    expect(page?.qualifies).toBe(false);
  }, 60_000);

  it("qualifies a figure of 320 by 160 points, measured at 10.6 % coverage", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [3] });
    const page = found[0];

    expect(page?.regions).toHaveLength(1);
    expect(page?.regions[0]?.areaPt2).toBeCloseTo(51_200, 0);
    expect(page?.coverage).toBeCloseTo(51_200 / PAGE_AREA, 5);
    expect(page?.qualifies).toBe(true);
  }, 60_000);

  it("qualifies a figure of 500 by 250 points, measured at 25.8 % coverage", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [4] });
    const page = found[0];

    expect(page?.regions).toHaveLength(1);
    expect(page?.coverage).toBeCloseTo(125_000 / PAGE_AREA, 5);
    expect(page?.qualifies).toBe(true);
  }, 60_000);

  it("reports a full-page raster as one region covering the whole page", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [5] });
    const page = found[0];

    expect(page?.regions).toHaveLength(1);
    expect(page?.coverage).toBeCloseTo(1, 5);
    expect(page?.qualifies).toBe(true);
  }, 60_000);

  it("does not qualify many small images whose total clears the coverage rule but no single one clears the floor", async () => {
    // Twenty marks of 3 200 pt²: 13.2 % of the page in total, each an order of magnitude under
    // the floor. Coverage alone would qualify this page; the floor exists so it does not.
    const found = await findImageRegions(await buildProbePdf(), { pages: [6] });
    const page = found[0];

    expect(page?.regions).toHaveLength(20);
    expect(page?.coverage).toBeCloseTo((20 * 3_200) / PAGE_AREA, 5);
    expect(page?.coverage).toBeGreaterThan(MIN_IMAGE_COVERAGE);
    expect(page?.qualifies).toBe(false);
  }, 60_000);

  it("does not qualify a page turned sideways, even for a figure that would otherwise qualify", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [7] });

    expect(found[0]?.qualifies).toBe(false);
  }, 60_000);

  it("scans only the pages it was given", async () => {
    const found = await findImageRegions(await buildProbePdf(), { pages: [3, 5] });

    expect(found.map((page) => page.page)).toEqual([3, 5]);
  }, 60_000);

  it("scans every page when none are named", async () => {
    const found = await findImageRegions(await buildProbePdf(), {});

    expect(found.map((page) => page.page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 60_000);

  it("publishes the thresholds as named constants with their measured justification", async () => {
    // 5 % sits between the measured logo (0.7 %) and the measured figure (10.6 %); the floor
    // sits between the logo's 3 200 pt² and the figure's 51 200 pt². A constant that drifted
    // outside those pairs would change the answer for the probe document.
    expect(MIN_IMAGE_COVERAGE).toBe(0.05);
    expect(MIN_SINGLE_IMAGE_AREA_PT2).toBe(10_000);
    expect(3_200 / PAGE_AREA).toBeLessThan(MIN_IMAGE_COVERAGE);
    expect(51_200 / PAGE_AREA).toBeGreaterThan(MIN_IMAGE_COVERAGE);
    expect(3_200).toBeLessThan(MIN_SINGLE_IMAGE_AREA_PT2);
    expect(51_200).toBeGreaterThan(MIN_SINGLE_IMAGE_AREA_PT2);
  });

  it("stops when cancelled rather than walking the rest of the document", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      findImageRegions(await buildProbePdf(), { pages: [1, 2], signal: controller.signal }),
    ).rejects.toThrow(RasterisationCancelled);
  }, 60_000);

  it("declines a page whose box is degenerate, and still gives its resources back exactly once", async () => {
    // A zero-area page cannot have coverage of anything. pdf.js's own fallback hides such a box
    // when it reads a real file, so the page is supplied directly: the contract with a handle is
    // structural (a page count, and pages answering to view, rotate, the operator list and
    // cleanup), and a counted cleanup proves the degenerate branch gives the page back too.
    let cleanups = 0;
    const page = {
      view: [0, 0, 0, 0],
      rotate: 0,
      getOperatorList: async () => ({ fnArray: [] as number[], argsArray: [] as unknown[] }),
      cleanup: () => {
        cleanups += 1;
      },
    };
    const handle = {
      pdf: {
        numPages: 1,
        getPage: async () => page,
      },
      release: async () => {},
    } as unknown as PdfjsDocumentHandle;

    const found = await findImageRegions(new Uint8Array(), { pages: [1], document: handle });

    expect(cleanups).toBe(1);
    expect(found).toEqual([
      { page: 1, regions: [], coverage: 0, qualifies: false, pageBox: { width: 0, height: 0 } },
    ]);
  }, 60_000);
});

describe("sharing an already-open document", () => {
  it("accepts an open handle instead of paying the open a second time", async () => {
    const bytes = await buildProbePdf();
    const handle = await openPdfDocument(bytes);
    try {
      const found = await findImageRegions(bytes, { pages: [3], document: handle });

      expect(found[0]?.qualifies).toBe(true);
    } finally {
      await handle.release();
    }
  }, 60_000);

  it("leaves a supplied handle open, because the caller owns it", async () => {
    const bytes = await buildProbePdf();
    const handle = await openPdfDocument(bytes);
    try {
      await findImageRegions(bytes, { pages: [3], document: handle });

      // Still usable afterwards: ownership did not move.
      const page = await handle.pdf.getPage(2);
      expect(page.pageNumber).toBe(2);
    } finally {
      await handle.release();
    }
  }, 60_000);
});
