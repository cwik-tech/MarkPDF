import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("keeps the printable PDF available until printing finishes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-print-"));
  const userDataPath = path.join(tempDir, "user-data");
  const pdfPath = path.join(tempDir, "print.pdf");
  await mkdir(userDataPath, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  await writeFile(pdfPath, await pdf.save());

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
    await window.clock.install();
    // A real print call can consume paper; replace only that operating-system boundary.
    await window.addInitScript(() => {
      window.print = () => undefined;
    });

    await window.getByRole("button", { name: "Print", exact: true }).click();
    const printFrame = window.locator('iframe[src^="blob:"]');
    await expect(printFrame).toHaveCount(1);

    await window.clock.runFor(2_100);
    await expect(printFrame).toHaveCount(1);

    await printFrame.evaluate((frame) => {
      (frame as HTMLIFrameElement).contentWindow?.dispatchEvent(new Event("afterprint"));
    });
    await expect(printFrame).toHaveCount(0);
  } finally {
    if (app !== null) {
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
