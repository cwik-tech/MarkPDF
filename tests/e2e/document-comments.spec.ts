import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
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
 * This has to run in Electron. The comment is a pin beside the marked line and a popover over the
 * page, both placed from the rendered page's geometry, and the sidebar list is the other half of
 * the same answer.
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

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("opens a comment another application wrote, and offers no way to rewrite it", async () => {
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
    await expect(pin).toBeVisible({ timeout: 30_000 });

    await pin.click();
    await expect(window.getByText(note)).toBeVisible();
    await expect(window.getByText(reviewer).first()).toBeVisible();
    // The document owns this annotation. A Delete button here would look like it removed the
    // reviewer's comment while the saved file went on carrying it.
    await expect(window.getByRole("button", { name: "Delete" })).toHaveCount(0);

    await window.getByRole("button", { name: "Pages" }).first().click();
    await window.getByRole("button", { name: "Comments" }).click();
    await expect(
      window.getByRole("button", { name: `Comment on page 1 by ${reviewer}: ${note}` }),
    ).toBeVisible();
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
