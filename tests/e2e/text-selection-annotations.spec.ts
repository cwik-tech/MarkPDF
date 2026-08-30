import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * What a reader gets when they drag across more than one line and annotate the selection.
 *
 * The contract is visual and it is about absence as much as presence: every line the reader
 * selected is covered, and the blank band between two lines is not. A single rectangle spanning
 * the whole selection satisfies "the lines are covered" perfectly well while painting over the
 * page in between, so both halves are asserted together or neither is worth asserting.
 *
 * This has to run in Electron. The geometry comes from `Range.getClientRects` over a rendered
 * PDF.js text layer, which no unit test can produce, and the recognised-text journey depends on
 * the window's own OCR overlay spans.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Two short lines, far enough apart that the band between them is unmistakable.
 *
 * 60 points of baseline separation at 18 points of type leaves roughly 40 points of blank page
 * between the drawn lines — wide enough that a union box covering it cannot be mistaken for
 * rounding, and wide enough for the assertion's midpoint to sit clear of both lines.
 */
const FIRST_LINE = "Alpha selection line";
const SECOND_LINE = "Beta selection line";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function createNativeTextPdf(filePath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([612, 792]);

  page.drawText(FIRST_LINE, { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  page.drawText(SECOND_LINE, { x: 72, y: 640, size: 18, font, color: rgb(0, 0, 0) });

  await writeFile(filePath, Buffer.from(await pdfDoc.save()));
}

/**
 * The same two lines, as pixels only.
 *
 * The reported defect was seen on recognised text, so the window has to reach these lines through
 * its own OCR overlay rather than through a text layer PDF.js produced. One page keeps the
 * recognition short; large type keeps it accurate.
 */
async function createRecognisedTextPdf(filePath: string): Promise<void> {
  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "bold 64px Helvetica";
  context.fillText(FIRST_LINE, 140, 300);
  context.fillText(SECOND_LINE, 140, 520);

  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(canvas.toBuffer("image/png"));
  const page = pdfDoc.addPage([612, 792]);
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });

  await writeFile(filePath, Buffer.from(await pdfDoc.save()));
}

function launch(documentPath: string, userDataPath: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js"), documentPath],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MARKPDF_TEST_USER_DATA: userDataPath,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  });
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

/** The boxes of the drawn lines, in viewport coordinates, top to bottom. */
async function lineRects(window: Page, selector: string): Promise<Rect[]> {
  return window.evaluate((spanSelector) => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>(spanSelector));
    return spans
      .map((span) => span.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }))
      .sort((a, b) => a.top - b.top);
  }, selector);
}

/**
 * Select from the first drawn line to the last, and tell the page a drag ended.
 *
 * The window builds its selection geometry in the page's `mouseup` handler, so a selection made
 * without one would never reach the popover. A synthesised range is used rather than a mouse drag
 * because the two lines are 40 points apart and a drag between them is a slower, less certain way
 * to arrive at exactly the same selection.
 */
async function selectAcrossLines(window: Page, spanSelector: string): Promise<void> {
  await window.evaluate((selector) => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>(selector)).sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
    const first = spans[0];
    const last = spans[spans.length - 1];
    if (!first || !last) throw new Error(`No drawn lines matched ${selector}`);

    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const rect = last.getBoundingClientRect();
    first.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: rect.right,
        clientY: rect.bottom,
        view: window,
      }),
    );
  }, spanSelector);
}

/**
 * Every rectangle the annotation layer actually paints on this page.
 *
 * Read from computed style rather than from a class name: what the requirement is about is the
 * colour a reader sees on the page, and a test that asked for a particular element would pass on
 * a layer that drew the right elements and the wrong area.
 */
async function paintedRects(window: Page): Promise<Rect[]> {
  return window.evaluate(() => {
    const layer = document.querySelector(".page-wrap[data-page-number='1'] .overlay-layer");
    if (!layer) return [];
    return Array.from(layer.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const background = window.getComputedStyle(element).backgroundColor;
        const parts = /rgba?\(([^)]+)\)/.exec(background);
        if (!parts) return false;
        const values = parts[1].split(",").map((value) => Number.parseFloat(value));
        return values.length < 4 || values[3] > 0.01;
      })
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
  });
}

function covers(rects: Rect[], x: number, y: number): boolean {
  return rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

/**
 * The shared exit criterion: each line painted, the band between lines left alone.
 *
 * The midpoints are taken from the drawn lines themselves, so the check describes the page the
 * reader is looking at rather than any number this test chose.
 */
function expectLinesPaintedAndGapsClear(lines: Rect[], painted: Rect[]): void {
  expect(lines.length, "the fixture drew more than one line").toBeGreaterThanOrEqual(2);

  for (const [index, line] of lines.entries()) {
    const x = (line.left + line.right) / 2;
    const y = (line.top + line.bottom) / 2;
    expect(
      covers(painted, x, y),
      `line ${String(index + 1)} at (${x.toFixed(1)}, ${y.toFixed(1)}) is painted, from ${JSON.stringify(painted)}`,
    ).toBe(true);
  }

  for (let index = 0; index + 1 < lines.length; index += 1) {
    const above = lines[index];
    const below = lines[index + 1];
    const gap = below.top - above.bottom;
    expect(gap, "the fixture leaves a visible band between the lines").toBeGreaterThan(6);
    const x = (above.left + above.right) / 2;
    const y = above.bottom + gap / 2;
    expect(
      covers(painted, x, y),
      `the band below line ${String(index + 1)} at (${x.toFixed(1)}, ${y.toFixed(1)}) is clear, from ${JSON.stringify(painted)}`,
    ).toBe(false);
  }
}

test("highlighting a selection that crosses two lines paints the lines and not the band between them", async () => {
  test.setTimeout(120_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-selection-highlight-"));
  const pdfPath = path.join(tempDir, "two-lines.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createNativeTextPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    // Arrange: a page with two short lines of native text and a wide blank band between them.
    app = await launch(pdfPath, userDataPath);
    const window = await app.firstWindow();
    const textLayer = window.getByTestId("text-layer-1");
    await expect(textLayer).toBeVisible({ timeout: 60_000 });
    const drawnLines = ".text-layer span:not(.markedContent)";
    await expect(window.locator(drawnLines).first()).toBeVisible({ timeout: 60_000 });

    // Act: drag across both lines and take the popover's highlight action.
    await selectAcrossLines(window, drawnLines);
    await window.getByRole("button", { name: "Highlight selection" }).click();

    // Assert: both lines are highlighted, and the page between them is untouched.
    const lines = await lineRects(window, drawnLines);
    const painted = await paintedRects(window);
    expectLinesPaintedAndGapsClear(lines, painted);
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("commenting on a recognised-text selection anchors to the recognised lines and keeps its pin and popup", async () => {
  test.setTimeout(300_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-selection-comment-"));
  const pdfPath = path.join(tempDir, "scanned-two-lines.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createRecognisedTextPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    // Arrange: a page that is only a picture, so the lines a reader can select exist solely
    // because the window recognised them. This is the path the defect was reported on.
    app = await launch(pdfPath, userDataPath);
    const window = await app.firstWindow();
    const recognisedLines = ".text-layer span[data-ocr]";
    await expect(window.locator(recognisedLines).first()).toBeVisible({ timeout: 240_000 });
    await expect
      .poll(async () => window.locator(recognisedLines).count(), { timeout: 240_000 })
      .toBeGreaterThanOrEqual(2);

    // Act: select across the recognised lines and take the popover's comment action.
    await selectAcrossLines(window, recognisedLines);
    await window.getByRole("button", { name: "Comment on selection" }).click();

    // Assert: the comment paints the recognised lines and leaves the band between them clear...
    const lines = await lineRects(window, recognisedLines);
    const painted = await paintedRects(window);
    expectLinesPaintedAndGapsClear(lines, painted);

    // ...and it is still a comment: a pin on the page and an open editor for its text.
    await expect(window.getByRole("button", { name: "Open comment" })).toBeVisible();
    const editor = window.getByPlaceholder("Add comment");
    await expect(editor).toBeVisible();
    await editor.fill("Check this against the plan");
    await expect(editor).toHaveValue("Check this against the plan");
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("selected highlight keeps its controls off the text and Delete removes it", async () => {
  test.setTimeout(120_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-selection-delete-"));
  const pdfPath = path.join(tempDir, "two-lines.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createNativeTextPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    app = await launch(pdfPath, userDataPath);
    const window = await app.firstWindow();
    const drawnLines = ".text-layer span:not(.markedContent)";
    await expect(window.locator(drawnLines).first()).toBeVisible({ timeout: 60_000 });

    await selectAcrossLines(window, drawnLines);
    await window.getByRole("button", { name: "Highlight selection" }).click();
    const deleteButton = window.getByTitle("Delete", { exact: true });
    await expect(deleteButton).toBeVisible();

    const lines = await lineRects(window, drawnLines);
    const selectedTop = Math.min(...lines.map((line) => line.top));
    const selectedRight = Math.max(...lines.map((line) => line.right));
    const deleteRect = await deleteButton.boundingBox();
    if (deleteRect === null) throw new Error("The selected highlight has no visible Delete control");

    await expect(window.getByTitle("Resize", { exact: true })).toHaveCount(0);
    expect(deleteRect.y + deleteRect.height).toBeLessThan(selectedTop);
    expect(deleteRect.x).toBeGreaterThan(selectedRight);

    await window.keyboard.press("Delete");

    await expect(window.getByTitle("Delete", { exact: true })).toHaveCount(0);
    await expect.poll(async () => paintedRects(window)).toEqual([]);
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
