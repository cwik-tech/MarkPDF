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

function filler(count: number) {
  return Array.from(
    { length: count },
    (_, index) => `Filler paragraph ${index + 1} with no search term in it.\n`,
  );
}

test("stepping to the next match scrolls that match into view", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-search-"));
  const markdownPath = path.join(tempDir, "search.md");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    markdownPath,
    [
      "# Long document",
      "",
      "The first zebra is near the top.",
      "",
      ...filler(60),
      "The second zebra is far below the fold.",
      "",
      ...filler(60),
      "The third zebra is further down again.",
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
    await expect(window.locator(".markdown-preview")).toBeVisible({
      timeout: 30_000,
    });

    await window.locator(".search-box").click();
    await window.getByPlaceholder("Find text").fill("zebra");

    const highlights = window.locator(".markdown-preview mark");
    await expect(highlights).toHaveCount(3);
    await expect(window.locator(".search-count")).toHaveText("1/3");
    await expect(highlights.nth(0)).toBeInViewport();
    await expect(highlights.nth(1)).not.toBeInViewport();

    await window.getByTitle("Next match").click();

    await expect(window.locator(".search-count")).toHaveText("2/3");
    await expect(highlights.nth(1)).toBeInViewport();

    await window.getByTitle("Previous match").click();

    await expect(window.locator(".search-count")).toHaveText("1/3");
    await expect(highlights.nth(0)).toBeInViewport();
  } finally {
    if (app) await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
