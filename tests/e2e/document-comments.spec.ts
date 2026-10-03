import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * What a reader gets when the document was commented on somewhere else.
 *
 * The reported case was a contract marked up in Acrobat: the highlights were on the page, because
 * PDF.js paints each annotation's own appearance, and the notes attached to them could not be
 * reached at all. MarkPDF kept its annotations in metadata of its own and read nothing else.
 *
 * A comment is read in the pane beside the page rather than in a box over it. A note that covers
 * the sentence it is about answers half the question and hides the other half, which is what the
 * first version of this did.
 *
 * This has to run in Electron. The pin is placed from the rendered page's geometry, and whether a
 * pane is open, closed or unavailable is a question only the running window can answer.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const reviewer = "Sumit Anand, Aggie Safety";
const note = "Limit this clause to press releases and marketing.";
const markedLine = "Publicity and disclosure of discussions";

/** A page one line long, marked up the way another application marks one up. */
async function createReviewedPdf(filePath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([612, 792]);

  page.drawText(markedLine, { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });

  const annotation = pdfDoc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [70, 696, 400, 718],
    QuadPoints: [72, 716, 398, 716, 72, 698, 398, 698],
    Contents: PDFString.of(note),
    T: PDFString.of(reviewer),
    NM: PDFString.of("reviewer-A0"),
    C: [1, 0.85, 0.2],
    F: 4,
  });
  page.node.set(PDFName.of("Annots"), pdfDoc.context.obj([pdfDoc.context.register(annotation)]));

  await writeFile(filePath, Buffer.from(await pdfDoc.save()));
}

/** The same page, with nothing written on it by anybody. */
async function createPlainPdf(filePath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pdfDoc
    .addPage([612, 792])
    .drawText(markedLine, { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });

  await writeFile(filePath, Buffer.from(await pdfDoc.save()));
}

/**
 * A page with more comments than the pane can show at once.
 *
 * Ten notes, each several sentences long, spaced far enough apart that their pins do not overlap.
 * The last one cannot be on screen when the pane opens, which is the whole point: selecting it has
 * to bring it into view rather than leave the reader looking at the first note.
 */
const longReviewNote =
  "This clause needs narrowing before signature. As drafted it reaches every engagement, " +
  "including ones the parties have not discussed, and the obligations survive indefinitely. " +
  "Limit the scope to the named deliverable and add an end date.";

async function createLongReviewPdf(filePath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([612, 792]);
  const annotations = [];

  for (let index = 0; index < 10; index += 1) {
    const bottom = 720 - index * 62;
    page.drawText(`Clause ${String(index + 1)} of this agreement`, {
      x: 72,
      y: bottom,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
    annotations.push(
      pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: PDFName.of("Annot"),
          Subtype: PDFName.of("Highlight"),
          Rect: [70, bottom - 2, 400, bottom + 16],
          QuadPoints: [72, bottom + 14, 398, bottom + 14, 72, bottom, 398, bottom],
          Contents: PDFString.of(`${String(index + 1)}. ${longReviewNote}`),
          T: PDFString.of(`Reviewer ${String(index + 1).padStart(2, "0")}`),
          NM: PDFString.of(`reviewer-${String(index)}`),
          C: [1, 0.85, 0.2],
          F: 4,
        }),
      ),
    );
  }

  page.node.set(PDFName.of("Annots"), pdfDoc.context.obj(annotations));

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

/** Where the selected card sits against the pane that is supposed to be showing it. */
async function selectedCardAgainstPane(window: Page) {
  return window.evaluate(() => {
    const pane = document.querySelector(".comments-sidebar");
    const card = document.querySelector(".comment-card.active");
    if (!pane || !card) return null;
    const paneRect = pane.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      paneTop: paneRect.top,
      paneBottom: paneRect.bottom,
      cardTop: cardRect.top,
      cardBottom: cardRect.bottom,
      scrollTop: pane.scrollTop,
    };
  });
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("opens a comment another application wrote in the pane beside the page", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-document-comments-"));
  const pdfPath = path.join(tempDir, "reviewed.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createReviewedPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const window = await app.firstWindow();

    const pin = window.getByRole("button", { name: `Comment by ${reviewer}` });
    const row = window.getByRole("button", {
      name: `Comment on page 1 by ${reviewer}: ${note}`,
    });
    const paneToggle = window.getByRole("button", { name: "Comments" });

    // The document has comments, so the pane can be opened — but it is not open until asked for.
    await expect(pin).toBeVisible({ timeout: 30_000 });
    await expect(paneToggle).toBeEnabled();
    await expect(row).toHaveCount(0);

    // Clicking the pin opens the pane and reads the note there, not over the page.
    await pin.click();
    await expect(row).toBeVisible();
    await expect(row).toContainText(note);
    await expect(window.getByPlaceholder("Add comment")).toHaveCount(0);
    // The document owns this annotation. Any control that changed it would show the reader one
    // thing while the saved file went on carrying another — so none of them may be offered, not
    // the card's own, not the generic inspector's, and not the Delete key.
    await expect(window.getByRole("button", { name: "Delete comment" })).toHaveCount(0);
    await expect(window.locator(".inspector")).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Delete selection" })).toHaveCount(0);

    await window.keyboard.press("Delete");
    await expect(row).toBeVisible();
    await window.keyboard.press("Backspace");
    await expect(row).toBeVisible();
    await expect(row).toContainText(note);

    // The toolbar toggle closes it again.
    await paneToggle.click();
    await expect(row).toHaveCount(0);
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("offers no comments pane for a document nobody has commented on", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-no-comments-"));
  const pdfPath = path.join(tempDir, "plain.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createPlainPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const window = await app.firstWindow();

    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("button", { name: "Comments" })).toBeDisabled();
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("brings the comment a reader picked on the page into view in the pane", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-long-review-"));
  const pdfPath = path.join(tempDir, "long-review.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createLongReviewPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    app = await launch(pdfPath, userDataPath);
    const window = await app.firstWindow();

    // Act: the last note on the page, which is far below anything the pane can show at first.
    const lastPin = window.getByRole("button", { name: "Comment by Reviewer 10" });
    await expect(lastPin).toBeVisible({ timeout: 30_000 });
    await lastPin.click();

    // Assert: the card is inside the pane a reader is looking at, not merely in the document.
    // `toBeVisible` passes for a card scrolled far below the pane's own viewport, which is
    // exactly how this was shipped.
    const revealed = await selectedCardAgainstPane(window);
    expect(revealed, "the selected card and its pane were both found").not.toBeNull();
    expect(revealed?.scrollTop, "the pane scrolled to reach it").toBeGreaterThan(0);
    expect(revealed?.cardTop ?? 0).toBeGreaterThanOrEqual((revealed?.paneTop ?? 0) - 1);
    expect(revealed?.cardTop ?? 0).toBeLessThan(revealed?.paneBottom ?? 0);

    // Act again: the reader scrolls the list away and picks the same pin a second time.
    await window.evaluate(() => {
      document.querySelector(".comments-sidebar")?.scrollTo({ top: 0 });
    });
    await expect
      .poll(async () => (await selectedCardAgainstPane(window))?.scrollTop)
      .toBe(0);
    await lastPin.click();

    // Assert: selecting a comment reveals it, whether or not it was already the selected one.
    await expect
      .poll(async () => (await selectedCardAgainstPane(window))?.scrollTop)
      .toBeGreaterThan(0);
    const again = await selectedCardAgainstPane(window);
    expect(again?.cardTop ?? 0).toBeGreaterThanOrEqual((again?.paneTop ?? 0) - 1);
    expect(again?.cardTop ?? 0).toBeLessThan(again?.paneBottom ?? 0);
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps a comment made here editable and deletable in the pane", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-own-comment-"));
  const pdfPath = path.join(tempDir, "plain.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createPlainPdf(pdfPath);

  let app: ElectronApplication | null = null;

  try {
    app = await launch(pdfPath, userDataPath);
    const window = await app.firstWindow();

    const textLayer = window.getByTestId("text-layer-1");
    await expect(textLayer).toBeVisible({ timeout: 30_000 });

    // Arrange: a comment of this reader's own, made from a selection.
    await textLayer.locator("span").filter({ hasText: markedLine }).first().evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          clientX: rect.right,
          clientY: rect.top + rect.height / 2,
          view: window,
        }),
      );
    });
    await window.getByRole("button", { name: "Comment on selection" }).click();

    // Act and assert: it is written in the pane, and removed from it.
    const editor = window.getByPlaceholder("Add comment");
    await expect(editor).toBeVisible();
    await editor.fill("Check this against the plan");
    await expect(editor).toHaveValue("Check this against the plan");

    await window.getByRole("button", { name: "Delete comment" }).click();
    await expect(window.getByRole("button", { name: "Open comment" })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "Comments", exact: true })).toBeDisabled();
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
