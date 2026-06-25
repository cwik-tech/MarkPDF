import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outlineHeading = "Executive Summary";
const targetText = "Bookmark target phrase";

async function createPdfFixture(filePath: string) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([612, 792]);

  page.drawText(outlineHeading, {
    x: 72,
    y: 700,
    size: 24,
    font: bold,
    color: rgb(0, 0, 0),
  });

  page.drawText(targetText, {
    x: 72,
    y: 650,
    size: 18,
    font,
    color: rgb(0, 0, 0),
  });

  await writeFile(filePath, Buffer.from(await pdfDoc.save()));
}

async function selectRenderedText(page: Page) {
  const textLayer = page.getByTestId("text-layer-1");
  await expect(textLayer).toBeVisible({ timeout: 30_000 });

  const target = textLayer.locator("span").filter({ hasText: targetText }).first();
  await expect(target).toBeVisible({ timeout: 30_000 });
  const box = await target.boundingBox();
  if (!box) throw new Error("Could not locate rendered PDF text.");

  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  await target.evaluate((element) => {
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
}

async function closeApp(app: ElectronApplication) {
  await app
    .evaluate(async ({ app: electronApp }) => {
      electronApp.exit(0);
    })
    .catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("creates a bookmark from selected text and lists it in the sidebar", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-bookmarks-"));
  const pdfPath = path.join(tempDir, "bookmark-fixture.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createPdfFixture(pdfPath);

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

    await selectRenderedText(window);
    await window.getByRole("button", { name: "Bookmark selection" }).click();

    await expect(
      window.getByRole("button", { name: `Bookmark: ${targetText}` }),
    ).toBeVisible();

    await window.getByRole("button", { name: "Pages" }).first().click();
    await window.getByRole("button", { name: "Outline" }).click();
    await expect(window.getByText("Generated outline")).toBeVisible();
    await expect(
      window.getByRole("button", { name: `${outlineHeading} 1` }),
    ).toBeVisible();

    await window.getByRole("button", { name: "Bookmarks" }).click();
    await expect(
      window.getByRole("button", {
        name: `Bookmark on page 1: ${targetText}`,
      }),
    ).toBeVisible();
    await expect(window.getByRole("heading", { name: "Selection" })).toHaveCount(
      0,
    );
  } finally {
    if (app) await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
