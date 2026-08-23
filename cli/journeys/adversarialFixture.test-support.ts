import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * A thirteen-page document built to be hostile to the reading pipeline in specific, named ways.
 *
 * `fixtures.test-support.ts` proves a page number survives extraction. This one proves the harder
 * thing: that a figure which exists only as pixels is found, that it is not confused with a
 * deliberately similar figure that exists as text, and that the surrounding noise — repeated
 * footers, letter-spaced slide labels, a table spanning a page break, a chart full of adjacent
 * numbers — does not win instead.
 *
 * **Every expectation is a property of this builder**, written in `ADVERSARIAL` below and never
 * copied back from what an extractor returned. That is what makes a failure here mean the pipeline
 * is wrong rather than that the pipeline changed.
 */

/** Page geometry, in PDF points. One place, because several expectations are areas. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/**
 * The image sizes the region detector must separate, chosen either side of its floor.
 *
 * The logo is 3 200 pt² — an order of magnitude under the 10 000 pt² single-image floor — and the
 * figure is 51 200 pt², comfortably over it. A fixture whose two cases sat close together would
 * pass or fail on rounding rather than on the rule.
 */
const LOGO_SIZE = { width: 80, height: 40 };
const FIGURE_SIZE = { width: 320, height: 160 };

/**
 * What this document contains, stated before anything reads it.
 *
 * Frozen so a test cannot quietly adjust an expectation to match a result.
 */
export const ADVERSARIAL = Object.freeze({
  pageCount: 13,
  imageOnlyPage: 10,
  blankPage: 13,
  chartPage: 12,
  /** Carries an image far too small to qualify for region recognition. */
  logoPage: 2,
  /** Carries a figure large enough to qualify, on an otherwise text-rich page. */
  figurePage: 4,

  /**
   * The answer, and it exists only as pixels on page 10.
   *
   * Exactly three body rows: enough repeated geometry to establish columns while keeping the
   * acceptance page small enough to inspect as one coherent financial table.
   */
  page10: Object.freeze({
    title: "Approved operating plan",
    rowLabel: "Sales & Marketing",
    columnPrefix: "Approved",
    salesMarketing2028: "5170",
    row2026: "4110",
    row2027: "4620",
    row2029: "5890",
    /** Neighbouring rows used to prove the reconstructed table preserves every body row. */
    otherRows: Object.freeze({ rd2026: "3020", ga2026: "1180" }),
  }),

  /** Pixels on a text-rich page. These words appear in no text layer anywhere in the document. */
  page4: Object.freeze({ label: "Channel rebate", value2028: "6420" }),

  /** A table of the same shape, in real text, with values close enough to be tempting. */
  page3: Object.freeze({ rowLabel: "Sales & Marketing", salesMarketing2028: "4980" }),

  /** A chart with adjacent labels and numbers, none of them the answer. */
  chart: Object.freeze({ marketing2028: "1140" }),

  nearCollisionLabels: Object.freeze(["Marketing", "Sales & Marketing", "Total Sales"]),

  /** Repeated on every page that is drawn as text, so nine identical blocks compete with content. */
  footer: "MarkPDF planning pack - confidential draft",
  /**
   * Exactly which pages carry it.
   *
   * Not "2 to 12": page 1 opens the document and carries none, pages 10 and 12 are pictures with no
   * text layer to put one in, and page 11 is left without one so that its trailing label genuinely
   * has nothing after it. Stated as the list rather than as a range, because a range that was almost
   * right is how a repetition rule comes to be tested against pages that never carried the text.
   */
  footerPages: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]),

  /**
   * Literals that exist in this document only as ink.
   *
   * The premise of the whole fixture: if any of these turns up in a text layer, a test that finds
   * one has proved nothing about recognition.
   */
  pixelOnlyLiterals: Object.freeze([
    "Approved operating plan",
    "5170",
    "Channel rebate",
    "6420",
    "1140",
  ]),

  /** Page 6: a label with content after it on the same page. */
  slideLabelWithFollower: "T R A C T I O N",
  /** Page 11: a label with nothing after it, which must therefore survive as a chunk. */
  slideLabelAlone: "S U M M A R Y",

  /** Page 10 sits under a heading that closed page 9 and has none of its own. */
  inheritedHeading: Object.freeze({ title: "Operating Plan", page: 9, appliesToPage: 10 }),
  /** Page 11 opens its own, so a chunk there must not claim page 9's. */
  localHeading: Object.freeze({ title: "Appendix A", page: 11 }),

  /** Crosses the balanced profile's token budget and continues onto the next page. */
  longTable: Object.freeze({
    page: 7,
    continuesOn: 8,
    bodyRows: 46,
    headerRepeatEvery: 12,
    heading: "Commercial",
    rowLabel: (index: number): string => `Cost centre ${String(index + 1).padStart(2, "0")}`,
    /** The header's year cells, in order. Row values never collide with this. */
    headerYears: "2026 2027 2028 2029",
    /** How many rows the first page carries, so the split across the break is a stated fact. */
    rowsOnFirstPage: 23,
  }),

  /**
   * The query the default suite uses.
   *
   * Not the natural phrasing. The offline embedder is a bag of words, and measured against it the
   * natural phrasing ranks the chart decoy first and the correct passage fifth — whatever the
   * pipeline does. `Approved` appears only in the page-10 image, which is what makes the query
   * separable at all. The natural phrasing belongs in an opt-in check against the real model.
   */
  query: "Approved 2028 Sales Marketing operating plan",

  /** Pixel sizes the region rule must separate, as areas in square points. */
  logoArea: LOGO_SIZE.width * LOGO_SIZE.height,
  figureArea: FIGURE_SIZE.width * FIGURE_SIZE.height,
  pageArea: PAGE_WIDTH * PAGE_HEIGHT,

  /**
   * Pages drawn as pictures in the `scanned` variant.
   *
   * Chosen to be exactly what the window's text-density sampler looks at for a thirteen-page
   * document — pages 1, 2, 3, the middle, and the last — so that sampler concludes the whole
   * document is a scan and recognises it in the window. That is the path on which a window-supplied
   * reading would otherwise replace the one this program does itself.
   */
  scannedPages: Object.freeze([1, 2, 3, 7, 13]),
});

export type AdversarialVariant = "mixed" | "scanned";

const PROSE = [
  "Administrative preamble concerning departmental record keeping and filing",
  "procedures retained for audit review across the whole reporting year period.",
  "Supporting detail follows the statement above for the current period under",
  "consideration by the committee responsible for the operating plan review.",
];

/** A picture of a page, for the variant whose text layer has been taken away. */
function rasteriseText(title: string, lines: readonly string[]): Uint8Array {
  const canvas = createCanvas(PAGE_WIDTH * 2, PAGE_HEIGHT * 2);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "bold 40px Helvetica";
  context.fillText(title, 120, 150);
  context.font = "28px Helvetica";
  let y = 230;
  for (const line of lines) {
    context.fillText(line, 120, y);
    y += 44;
  }
  return canvas.toBuffer("image/png");
}

/**
 * The page-10 table, as ink.
 *
 * Drawn at a size measured to survive recognition, and spaced so that word positions cluster
 * unambiguously into columns. Both halves were checked against the real engine rather than assumed.
 */
function rasteriseAnswerTable(): Uint8Array {
  // Wide enough that no two column headings touch. At 1224 across, `Approved 2026` was about 250
  // pixels of ink in a 170-pixel column, so consecutive headings overlapped and were recognised as
  // `Approved 28gproved 2A@@roved` — a header that no column rule could recover. The body rows read
  // correctly even then, which is exactly why this had to be checked rather than assumed.
  const canvas = createCanvas(1800, 2330);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";

  context.font = "bold 48px Helvetica";
  context.fillText(ADVERSARIAL.page10.title, 80, 170);

  const columns = [80, 640, 930, 1220, 1510];
  context.font = "bold 36px Helvetica";
  const headers = [
    "Line item",
    `${ADVERSARIAL.page10.columnPrefix} 2026`,
    `${ADVERSARIAL.page10.columnPrefix} 2027`,
    `${ADVERSARIAL.page10.columnPrefix} 2028`,
    `${ADVERSARIAL.page10.columnPrefix} 2029`,
  ];
  headers.forEach((cell, column) => context.fillText(cell, columns[column]!, 400));

  context.font = "36px Helvetica";
  const rows = [
    [
      ADVERSARIAL.page10.rowLabel,
      ADVERSARIAL.page10.row2026,
      ADVERSARIAL.page10.row2027,
      ADVERSARIAL.page10.salesMarketing2028,
      ADVERSARIAL.page10.row2029,
    ],
    ["R&D", ADVERSARIAL.page10.otherRows.rd2026, "3310", "3640", "3980"],
    ["G&A", ADVERSARIAL.page10.otherRows.ga2026, "1240", "1310", "1390"],
  ];
  let y = 520;
  for (const row of rows) {
    row.forEach((cell, column) => context.fillText(cell, columns[column]!, y));
    y += 100;
  }
  return canvas.toBuffer("image/png");
}

/** The page-4 figure: a small financial table whose words exist in no text layer. */
function rasteriseFigure(): Uint8Array {
  const canvas = createCanvas(1280, 640);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "bold 44px Helvetica";
  context.fillText("Incentive schedule", 60, 110);
  context.font = "bold 40px Helvetica";
  context.fillText("Line item", 60, 250);
  context.fillText("2028", 760, 250);
  context.font = "40px Helvetica";
  context.fillText(ADVERSARIAL.page4.label, 60, 360);
  context.fillText(ADVERSARIAL.page4.value2028, 760, 360);
  return canvas.toBuffer("image/png");
}

/** A chart whose labels and numbers sit close to the answer without being it. */
function rasteriseChart(): Uint8Array {
  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "bold 44px Helvetica";
  context.fillText("Marketing spend trend", 90, 150);
  context.font = "36px Helvetica";
  const points: Array<[string, string]> = [
    ["2026", "980"],
    ["2027", "1010"],
    ["2028", ADVERSARIAL.chart.marketing2028],
    ["2029", "1260"],
  ];
  let y = 280;
  for (const [year, value] of points) {
    context.fillText(`Marketing ${year}`, 90, y);
    context.fillText(value, 620, y);
    y += 90;
  }
  return canvas.toBuffer("image/png");
}

/** A tiny mark, the kind every corporate template carries. Too small to be worth recognising. */
function rasteriseLogo(): Uint8Array {
  const canvas = createCanvas(320, 160);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "bold 48px Helvetica";
  context.fillText("MP", 20, 100);
  return canvas.toBuffer("image/png");
}

/** One row of the long table, deterministic so the same fixture is built every time. */
function longTableRow(index: number): string[] {
  // Based at 7000 so no cell can spell a figure this fixture declares elsewhere. At 1000 the table
  // ran straight through `1140`, the chart's decoy, and a check that the chart's figure exists only
  // as ink then failed against a row of an unrelated table.
  const value = (offset: number): string => String(7000 + index * 7 + offset);
  return [ADVERSARIAL.longTable.rowLabel(index), value(0), value(3), value(6), value(9)];
}

export interface AdversarialPdf {
  bytes: Uint8Array;
}

/**
 * Build the document.
 *
 * `mixed` is the ordinary case: a text-rich report with one page that is only a picture. `scanned`
 * is the same report with the pages the window samples replaced by pictures, so the window
 * concludes the whole document is a scan. The two exercise opposite branches of the same decision
 * and must both end up with the same text in the index.
 */
export async function buildAdversarialPdf(variant: AdversarialVariant = "mixed"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const scanned = variant === "scanned" ? new Set<number>(ADVERSARIAL.scannedPages) : new Set<number>();
  const answerImage = await pdf.embedPng(rasteriseAnswerTable());
  const figureImage = await pdf.embedPng(rasteriseFigure());
  const chartImage = await pdf.embedPng(rasteriseChart());
  const logoImage = await pdf.embedPng(rasteriseLogo());

  let pageNumber = 0;
  const addPage = () => {
    pageNumber += 1;
    return pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  };

  /** Title and prose, drawn as text or as a picture of text depending on the variant. */
  const textPage = async (title: string, titleSize: number, lines: readonly string[]) => {
    const page = addPage();
    if (scanned.has(pageNumber)) {
      const image = await pdf.embedPng(rasteriseText(title, lines));
      page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
      return { page, drawnAsText: false };
    }
    page.drawText(title, { x: 60, y: 720, size: titleSize, font: bold });
    let y = 690;
    for (const line of lines) {
      page.drawText(line, { x: 60, y, size: 11, font });
      y -= 18;
    }
    return { page, drawnAsText: true };
  };

  const footer = (page: ReturnType<typeof addPage>, drawnAsText: boolean) => {
    if (drawnAsText) page.drawText(ADVERSARIAL.footer, { x: 60, y: 48, size: 9, font });
  };

  // 1 — the document's own title. Sampled by the window's density check.
  await textPage("Operating Plan 2026-2029", 20, PROSE);

  // 2 — a page carrying a mark too small to be worth recognising.
  {
    const { page, drawnAsText } = await textPage("Method", 20, PROSE);
    if (drawnAsText) {
      page.drawImage(logoImage, { x: 460, y: 700, width: LOGO_SIZE.width, height: LOGO_SIZE.height });
    }
    footer(page, drawnAsText);
  }

  // 3 — the decoy: the same shape of table, in real text, with values close to the answer.
  {
    const { page, drawnAsText } = await textPage("Indicative spend (superseded)", 14, []);
    if (drawnAsText) {
      const columns = [60, 250, 340, 430, 520];
      let y = 680;
      ["Line item", "2026", "2027", "2028", "2029"].forEach((cell, column) =>
        page.drawText(cell, { x: columns[column]!, y, size: 11, font: bold }),
      );
      page.drawLine({ start: { x: 55, y: y - 6 }, end: { x: 560, y: y - 6 }, thickness: 1, color: rgb(0, 0, 0) });
      const rows = [
        [ADVERSARIAL.page3.rowLabel, "4210", "4600", ADVERSARIAL.page3.salesMarketing2028, "5700"],
        ["R&D", "2950", "3180", "3410", "3660"],
        ["G&A", "1120", "1190", "1250", "1320"],
      ];
      for (const row of rows) {
        y -= 22;
        row.forEach((cell, column) => page.drawText(cell, { x: columns[column]!, y, size: 11, font }));
      }
      page.drawLine({ start: { x: 55, y: y - 6 }, end: { x: 560, y: y - 6 }, thickness: 1, color: rgb(0, 0, 0) });
    }
    footer(page, drawnAsText);
  }

  // 4 — a text-rich page whose figure is the only place its numbers exist.
  {
    // Deliberately wordy. The structural extractor decides a page is a scan from the balance of
    // text against picture, not from the picture alone: with only a line or two of prose it throws
    // the whole text layer away and reports the page as unreadable, which would make this an
    // ordinary scanned page rather than the case it exists to be — a page that reads perfectly well
    // and is still missing what its figure says. Measured against the installed extractor.
    const { page, drawnAsText } = await textPage("Marketing", 14, [
      "Marketing owns demand generation across the plan horizon and reports",
      "against the incentive schedule reproduced below for the current year.",
      "The programme is funded centrally and recharged to each operating unit",
      "in proportion to the pipeline it generates over the preceding quarter.",
      "Channel partners are compensated separately under the schedule shown,",
      "which the committee reviews at the midpoint of every plan year in full.",
      "Rebates are accrued monthly and settled once the partner has met both",
      "the volume threshold and the certification requirement for the period.",
      "Nothing in this section supersedes the approved figures published for",
      "each function elsewhere in this pack, which remain the governing set.",
    ]);
    if (drawnAsText) {
      page.drawImage(figureImage, { x: 60, y: 300, width: FIGURE_SIZE.width, height: FIGURE_SIZE.height });
      page.drawText("Source: internal planning model, revision four.", { x: 60, y: 270, size: 11, font });
    }
    footer(page, drawnAsText);
  }

  // 5 — a label close enough to the answer's to be worth confusing it with.
  {
    const { page, drawnAsText } = await textPage("Total Sales", 14, [
      "Total Sales combines direct and channel revenue for the period across",
      "every segment, and is reconciled to the statutory accounts each quarter.",
    ]);
    footer(page, drawnAsText);
  }

  // 6 — a letter-spaced slide label with content after it on the same page.
  {
    const page = addPage();
    page.drawText(`**${ADVERSARIAL.slideLabelWithFollower}**`, { x: 60, y: 720, size: 11, font: bold });
    let y = 680;
    for (const line of [
      "Adoption grew steadily through the period as the channel programme",
      "reached its second cohort of partners and renewals began to compound.",
      "",
      "The committee expects the trend to continue into the next plan year.",
    ]) {
      if (line.length > 0) page.drawText(line, { x: 60, y, size: 11, font });
      y -= 18;
    }
    footer(page, true);
  }

  // 7 and 8 — one table, too long for a single passage, continuing across a page break.
  {
    const columns = [60, 250, 340, 430, 520];
    // `Line item`, not `Cost centre`: the row labels are `Cost centre 01`…`Cost centre 46`, and a
    // header reading `Cost centre 2026` contains `Cost centre 20` — so a search for that row found
    // it on both pages and the split across the break could not be checked.
    const header = ["Line item", "2026", "2027", "2028", "2029"];
    const drawHeader = (page: ReturnType<typeof addPage>, y: number) =>
      header.forEach((cell, column) => page.drawText(cell, { x: columns[column]!, y, size: 10, font: bold }));

    let row = 0;
    for (const [index, title] of [ADVERSARIAL.longTable.heading, null].entries()) {
      const page = addPage();
      if (scanned.has(pageNumber)) {
        // The window samples this page, so in the scanned variant it has to be a picture like the
        // others. The table spanning a page break is a property of the `mixed` variant, which is
        // where the heading and continuation rules are exercised; here the page only has to be
        // textless.
        const image = await pdf.embedPng(
          rasteriseText(
            ADVERSARIAL.longTable.heading,
            Array.from({ length: 6 }, (_unused, offset) => longTableRow(row + offset).join("   ")),
          ),
        );
        page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
        row += ADVERSARIAL.longTable.bodyRows - ADVERSARIAL.longTable.rowsOnFirstPage;
        continue;
      }
      if (title !== null) page.drawText(title, { x: 60, y: 730, size: 20, font: bold });
      let y = index === 0 ? 700 : 730;
      drawHeader(page, y);
      const rowsOnThisPage =
        index === 0
          ? ADVERSARIAL.longTable.rowsOnFirstPage
          : ADVERSARIAL.longTable.bodyRows - ADVERSARIAL.longTable.rowsOnFirstPage;
      for (let onPage = 0; onPage < rowsOnThisPage; onPage += 1) {
        y -= 13;
        if (onPage > 0 && onPage % ADVERSARIAL.longTable.headerRepeatEvery === 0) {
          drawHeader(page, y);
          y -= 13;
        }
        longTableRow(row).forEach((cell, column) =>
          page.drawText(cell, { x: columns[column]!, y, size: 10, font }),
        );
        row += 1;
      }
      footer(page, true);
    }
  }

  // 9 — the heading page 10 will have to inherit, because page 10 has none of its own.
  {
    const { page, drawnAsText } = await textPage(ADVERSARIAL.inheritedHeading.title, 20, [
      "The approved figures for each function are reproduced on the following page.",
    ]);
    footer(page, drawnAsText);
  }

  // 10 — the answer, as pixels and nothing else. No text is drawn on this page at all.
  {
    const page = addPage();
    page.drawImage(answerImage, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  // 11 — a fresh title, so a chunk here must not claim page 9's heading; and a label with no
  // follower, which must therefore survive as a chunk of its own.
  {
    const { page, drawnAsText } = await textPage(ADVERSARIAL.localHeading.title, 20, [
      "Definitions and sources for the schedules reproduced in this pack.",
    ]);
    if (drawnAsText) {
      page.drawText(`**${ADVERSARIAL.slideLabelAlone}**`, { x: 60, y: 600, size: 11, font: bold });
    }
    // No footer here, deliberately. This page's whole purpose is a label with *nothing* after it,
    // and a footer is something after it — one that would let a rule fold the label into the
    // footer and call the label preserved.
  }

  // 12 — a picture full of adjacent labels and numbers, none of them the answer.
  {
    const page = addPage();
    page.drawImage(chartImage, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  // 13 — genuinely blank. Nothing is drawn, and nothing should ever be reported for it.
  addPage();

  return await pdf.save();
}
