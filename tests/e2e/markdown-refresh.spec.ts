import { expect, test as base, _electron as electron } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath: unknown = require("electron");
if (typeof electronPath !== "string") throw new Error("Electron executable not found");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const original = "# Original notes\n\n" + Array.from(
  { length: 80 }, (_, index) => `Paragraph ${index + 1}: the zebra is here.\n\n`,
).join("");

const test = base.extend<{ document: { window: Page; file: string } }>({
  document: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), "markpdf-refresh-"));
    const file = path.join(directory, "notes.md");
    await writeFile(file, original);
    const app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), file],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: path.join(directory, "profile"),
        MARKPDF_DATA_DIR: path.join(directory, "data"),
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    try {
      const window = await app.firstWindow();
      await expect(window.getByRole("heading", { name: "Original notes" })).toBeVisible();
      await use({ window, file });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test("refresh reads external edits into the same tab without losing zoom or reading position", async ({ document }) => {
  const { window, file } = document;
  const refresh = window.getByRole("button", { name: "Refresh file", exact: true });
  await expect(refresh).toBeEnabled();
  await window.getByRole("button", { name: "Zoom in", exact: true }).click();
  const pane = window.locator(".markdown-document-scroll");
  await pane.evaluate((element) => { element.scrollTop = 700; });
  await expect(pane).toHaveJSProperty("scrollTop", 700);
  await expect(window.locator(".tabs .tab")).toHaveCount(1);

  await writeFile(file, original.replace("Original notes", "Updated notes"));
  await refresh.click();

  await expect(window.getByRole("heading", { name: "Updated notes" })).toHaveCount(1);
  await expect(window.getByRole("heading", { name: "Original notes" })).toHaveCount(0);
  await expect(window.locator(".tabs .tab")).toHaveCount(1);
  await expect(window.locator(".zoom-label")).toHaveText("110%");
  await expect(pane).toHaveJSProperty("scrollTop", 700);
  await expect(refresh).toBeEnabled();

  // A second refresh must read again, even if the file was atomically replaced.
  const replacement = `${file}.new`;
  await writeFile(replacement, original.replace("Original notes", "Latest notes"));
  await rename(replacement, file);
  await refresh.click();
  await expect(window.getByRole("heading", { name: "Latest notes" })).toHaveCount(1);
});

test("a missing file keeps the current preview and allows refresh after recovery", async ({ document }) => {
  const { window, file } = document;
  const refresh = window.getByRole("button", { name: "Refresh file", exact: true });
  await expect(refresh).toBeEnabled();
  await rm(file);
  const [message] = await Promise.all([
    window.waitForEvent("dialog", { timeout: 5000 }).then(async (dialog) => {
      await dialog.accept();
      return dialog.message();
    }),
    refresh.click(),
  ]);
  expect(message).toContain("Could not refresh");
  await expect(window.getByRole("heading", { name: "Original notes" })).toBeVisible();
  await expect(refresh).toBeEnabled();

  await writeFile(file, "# Recovered notes\n");
  await refresh.click();
  await expect(window.getByRole("heading", { name: "Recovered notes" })).toBeVisible();
});

test("refresh updates matches for the current search", async ({ document }) => {
  const { window, file } = document;
  await window.locator(".search-box").click();
  await window.getByPlaceholder("Find text").fill("zebra");
  await expect(window.locator(".search-count")).toHaveText("1/80");
  await writeFile(file, "# Updated notes\n\nOne zebra remains.\n");
  await window.getByRole("button", { name: "Refresh file", exact: true }).click();
  await expect(window.locator(".search-count")).toHaveText("1/1");
  await expect(window.locator(".markdown-preview mark")).toHaveCount(1);
});
