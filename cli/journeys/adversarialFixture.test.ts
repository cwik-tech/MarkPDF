import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { ADVERSARIAL, buildAdversarialPdf } from "./adversarialFixture.test-support.js";

/**
 * That the fixture is what `ADVERSARIAL` says it is.
 *
 * Checked with pdf.js rather than with the extractor the product uses. The point of the fixture is
 * to be an independent statement of what a document contains; verifying it with the same library
 * the pipeline reads it with would make the whole arrangement circular — a fixture that agreed with
 * the extractor by construction would prove nothing when the extractor was wrong.
 *
 * Nothing here asserts what the *product* makes of the document. That belongs in the journeys.
 */

const require = createRequire(import.meta.url);

function pdfjsAssetPaths(): { standardFontDataUrl: string; cMapUrl: string } {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  return {
    standardFontDataUrl: `${join(root, "standard_fonts")}${sep}`,
    cMapUrl: `${join(root, "cmaps")}${sep}`,
  };
}

type Matrix = [number, number, number, number, number, number];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

interface PageFacts {
  page: number;
  images: number;
  /** Total device-space area the images cover, in square points. */
  imageArea: number;
  /** The largest single image, in square points. */
  largestImage: number;
  /** Characters in the text layer, whitespace removed. */
  textCharacters: number;
  /**
   * The text layer as one line, runs separated by single spaces.
   *
   * Each `drawText` call is its own run, so joining with a space reproduces the reading order a
   * person would follow — a table row drawn cell by cell comes back as `label value value value`.
   */
  text: string;
}

/**
 * What each page actually carries, read straight from its content stream.
 *
 * pdf.js paints an image into the unit square and places it with the current transformation matrix,
 * so the area a painted image covers is the absolute determinant of that matrix. Walking
 * save/restore/transform is what keeps the matrix right across nested graphics states.
 */
async function readPages(bytes: Uint8Array): Promise<PageFacts[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The three paints that place one image with the current transformation matrix. The `Repeat` and
  // `Group` variants carry their own position arrays and do not mean "one image here", so counting
  // them as unit-square paints would report an area the page does not have. This fixture draws none
  // of them; naming only what is understood keeps that true rather than assumed.
  const imagePaints = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
  ]);

  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    ...pdfjsAssetPaths(),
    cMapPacked: true,
  }).promise;

  try {
    const facts: PageFacts[] = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const loaded = await document.getPage(page);
      const operators = await loaded.getOperatorList();

      let matrix: Matrix = [1, 0, 0, 1, 0, 0];
      const stack: Matrix[] = [];
      let images = 0;
      let imageArea = 0;
      let largestImage = 0;

      for (const [position, operator] of operators.fnArray.entries()) {
        if (operator === pdfjs.OPS.save) stack.push([...matrix] as Matrix);
        else if (operator === pdfjs.OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (operator === pdfjs.OPS.transform) {
          matrix = multiply(matrix, operators.argsArray[position] as Matrix);
        } else if (imagePaints.has(operator)) {
          const area = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
          images += 1;
          imageArea += area;
          largestImage = Math.max(largestImage, area);
        }
      }

      const content = await loaded.getTextContent();
      const runs = content.items.map((item) => ("str" in item ? item.str : ""));
      const textCharacters = runs.join("").replace(/\s/g, "").length;
      const text = runs.join(" ").replace(/\s+/g, " ").trim();

      loaded.cleanup();
      facts.push({ page, images, imageArea, largestImage, textCharacters, text });
    }
    return facts;
  } finally {
    await document.destroy();
  }
}

function pageFacts(facts: readonly PageFacts[], page: number): PageFacts {
  const found = facts.find((entry) => entry.page === page);
  if (found === undefined) throw new Error(`The fixture has no page ${page}.`);
  return found;
}

describe("the adversarial fixture, as built", () => {
  it("is thirteen pages, with the answer page carrying a picture and no text at all", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    expect(facts).toHaveLength(ADVERSARIAL.pageCount);

    const answer = pageFacts(facts, ADVERSARIAL.imageOnlyPage);
    expect(answer.images).toBe(1);
    expect(answer.textCharacters).toBe(0);
    // The picture covers the page, which is what makes this a scan rather than an illustration.
    expect(answer.imageArea).toBeCloseTo(ADVERSARIAL.pageArea, 0);
  }, 60_000);

  it("puts a qualifying figure and a disqualifying logo on pages that are otherwise text rich", async () => {
    // The two sizes the region rule has to separate, either side of its floor, on pages that both
    // have a healthy text layer. A rule that looked only at whether a page had an image would treat
    // these the same.
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    const figure = pageFacts(facts, ADVERSARIAL.figurePage);
    expect(figure.images).toBe(1);
    expect(figure.largestImage).toBeCloseTo(ADVERSARIAL.figureArea, 0);
    expect(figure.textCharacters).toBeGreaterThan(100);

    const logo = pageFacts(facts, ADVERSARIAL.logoPage);
    expect(logo.images).toBe(1);
    expect(logo.largestImage).toBeCloseTo(ADVERSARIAL.logoArea, 0);
    expect(logo.textCharacters).toBeGreaterThan(100);

    // Stated as a relationship rather than two numbers, so the fixture cannot drift into a state
    // where both sit on the same side of any sensible floor.
    expect(figure.largestImage).toBeGreaterThan(logo.largestImage * 10);
  }, 60_000);

  it("carries one page that is genuinely blank, not merely unreadable", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    const blank = pageFacts(facts, ADVERSARIAL.blankPage);
    expect(blank.images).toBe(0);
    expect(blank.textCharacters).toBe(0);
  }, 60_000);

  it("takes the text layer away from exactly the pages the window samples, in the scanned variant", async () => {
    // The window samples the first three pages, the middle one and the last. Replacing those five
    // is what makes it conclude the whole document is a scan, which is the branch on which a
    // window-supplied reading would otherwise reach the index.
    const facts = await readPages(await buildAdversarialPdf("scanned"));

    expect(facts).toHaveLength(ADVERSARIAL.pageCount);
    for (const page of ADVERSARIAL.scannedPages) {
      expect(pageFacts(facts, page).textCharacters).toBe(0);
    }
    // Page 13 is blank in both variants, so it is textless without being a picture; the other four
    // become pictures.
    for (const page of ADVERSARIAL.scannedPages.filter((entry) => entry !== ADVERSARIAL.blankPage)) {
      expect(pageFacts(facts, page).images).toBe(1);
    }

    // And the answer is still only a picture, so the two variants ask the same question.
    const answer = pageFacts(facts, ADVERSARIAL.imageOnlyPage);
    expect(answer.images).toBe(1);
    expect(answer.textCharacters).toBe(0);
  }, 60_000);

  it("keeps every literal that is meant to be ink out of every text layer", async () => {
    // The premise the rest of the suite rests on. A journey that searches for `5170` and finds it
    // has proved something about recognition only if `5170` is nowhere in the document's text —
    // otherwise it has found the decoy, or the fixture has quietly started drawing the answer.
    const facts = await readPages(await buildAdversarialPdf("mixed"));
    const everyTextLayer = facts.map((entry) => entry.text).join("\n");

    for (const literal of ADVERSARIAL.pixelOnlyLiterals) {
      expect(everyTextLayer).not.toContain(literal);
    }
  }, 60_000);

  it("puts the decoy figures in real text, so the answer has something to be confused with", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    // Page 3 carries a table of the same shape as the answer, with a different figure for the same
    // row and year. It is text, which is what makes it the easier thing to find.
    const decoy = pageFacts(facts, 3).text;
    expect(decoy).toContain(ADVERSARIAL.page3.rowLabel);
    expect(decoy).toContain(ADVERSARIAL.page3.salesMarketing2028);

    // And the labels that sit either side of the answer's, on their own pages.
    expect(pageFacts(facts, 4).text).toContain("Marketing");
    expect(pageFacts(facts, 5).text).toContain("Total Sales");
  }, 60_000);

  it("repeats one footer across the pages that carry text, and only those", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    const carrying = facts.filter((entry) => entry.text.includes(ADVERSARIAL.footer)).map((entry) => entry.page);

    expect(carrying).toEqual([...ADVERSARIAL.footerPages]);
  }, 60_000);

  it("carries a letter-spaced label with something after it, and one with nothing after it", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    // Page 6's label is followed by prose on the same page, so it can be folded into what follows.
    const withFollower = pageFacts(facts, 6).text;
    expect(withFollower).toContain(ADVERSARIAL.slideLabelWithFollower);
    expect(withFollower.length).toBeGreaterThan(ADVERSARIAL.slideLabelWithFollower.length + 100);

    // Page 11's is the last thing on its page, so folding it into anything would delete it.
    expect(pageFacts(facts, 11).text).toContain(ADVERSARIAL.slideLabelAlone);
    expect(pageFacts(facts, 11).text.trimEnd().endsWith(`**${ADVERSARIAL.slideLabelAlone}**`)).toBe(true);
  }, 60_000);

  it("puts a heading on the page before the picture, and a fresh one on the page after", async () => {
    // The pair that makes inherited heading provenance testable: page 10 has no heading of its own
    // and must borrow page 9's, while page 11 opens its own and must not borrow anything.
    const facts = await readPages(await buildAdversarialPdf("mixed"));

    expect(pageFacts(facts, ADVERSARIAL.inheritedHeading.page).text).toContain(
      ADVERSARIAL.inheritedHeading.title,
    );
    expect(pageFacts(facts, ADVERSARIAL.imageOnlyPage).text).toBe("");
    expect(pageFacts(facts, ADVERSARIAL.localHeading.page).text).toContain(ADVERSARIAL.localHeading.title);
  }, 60_000);

  it("runs one long table across a page break, repeating its header inside each page", async () => {
    const facts = await readPages(await buildAdversarialPdf("mixed"));
    const first = pageFacts(facts, ADVERSARIAL.longTable.page).text;
    const second = pageFacts(facts, ADVERSARIAL.longTable.continuesOn).text;

    // Every row exists exactly once, and the split falls where the builder says it does.
    for (let row = 0; row < ADVERSARIAL.longTable.bodyRows; row += 1) {
      const label = ADVERSARIAL.longTable.rowLabel(row);
      const onFirst = first.includes(label);
      const onSecond = second.includes(label);
      expect(onFirst || onSecond).toBe(true);
      expect(onFirst && onSecond).toBe(false);
      expect(onFirst).toBe(row < ADVERSARIAL.longTable.rowsOnFirstPage);
    }

    // The heading opens the table and is not repeated, which is what leaves the second page with
    // no heading of its own.
    expect(first).toContain(ADVERSARIAL.longTable.heading);
    expect(second).not.toContain(ADVERSARIAL.longTable.heading);

    // The header row itself repeats inside each page. Row values never spell the year sequence, so
    // counting it counts headers.
    const headerCount = (text: string): number => text.split(ADVERSARIAL.longTable.headerYears).length - 1;
    const expected =
      1 + Math.floor((ADVERSARIAL.longTable.rowsOnFirstPage - 1) / ADVERSARIAL.longTable.headerRepeatEvery);
    expect(headerCount(first)).toBe(expected);
    expect(headerCount(second)).toBe(expected);
  }, 60_000);

  it("keeps a text layer on the pages the window does not sample, in the scanned variant", async () => {
    // Without this the variant would be an ordinary scan rather than the awkward case: the sampler
    // must be wrong about the document, not right about it.
    const facts = await readPages(await buildAdversarialPdf("scanned"));

    for (const page of [4, 5, 6, 9, 11]) {
      expect(pageFacts(facts, page).textCharacters).toBeGreaterThan(50);
    }
  }, 60_000);
});
