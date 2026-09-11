import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
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

async function closeApp(app: ElectronApplication) {
  await app
    .evaluate(async ({ app: electronApp }) => {
      electronApp.exit(0);
    })
    .catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("zooming a Markdown document enlarges the sheet and its Mermaid chart", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-md-zoom-"));
  const markdownPath = path.join(tempDir, "notes.md");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    markdownPath,
    [
      "# Notes",
      "",
      "A paragraph of prose that sits on the sheet next to the chart below.",
      "",
      "```mermaid",
      "flowchart LR",
      '  A["Alpha"] --> B["Beta"]',
      "```",
      "",
    ].join("\n"),
  );

  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), markdownPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const window = await app.firstWindow();

    const sheet = window.locator(".markdown-preview");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    const diagram = window.getByRole("img", { name: "Mermaid diagram" });
    await expect(diagram).toBeVisible({ timeout: 30_000 });
    await expect(diagram).toHaveAttribute("aria-busy", "false");
    const chart = diagram.locator("svg");
    await expect(chart).toBeVisible();

    const zoomIn = window.getByRole("button", { name: "Zoom in" });
    const zoomOut = window.getByRole("button", { name: "Zoom out" });
    await expect(zoomIn).toBeEnabled();
    await expect(zoomOut).toBeEnabled();

    const sheetBoxBefore = await sheet.boundingBox();
    const chartBoxBefore = await chart.boundingBox();
    expect(sheetBoxBefore).not.toBeNull();
    expect(chartBoxBefore).not.toBeNull();

    await zoomIn.click();
    await expect(window.locator(".zoom-label")).toHaveText("110%");

    const sheetBoxAfter = await sheet.boundingBox();
    const chartBoxAfter = await chart.boundingBox();
    expect(sheetBoxAfter).not.toBeNull();
    expect(chartBoxAfter).not.toBeNull();
    expect(sheetBoxAfter!.width).toBeGreaterThan(sheetBoxBefore!.width * 1.05);
    expect(chartBoxAfter!.width).toBeGreaterThan(chartBoxBefore!.width * 1.05);

    await zoomOut.click();
    await expect(window.locator(".zoom-label")).toHaveText("100%");
  } finally {
    if (app) await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
