import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * A Markdown document's own table of contents, followed in the real application.
 *
 * This has to run in Electron. What is under test is that the pane the document scrolls in actually
 * moves to the section, and that the click stays inside the reader's document rather than becoming
 * a navigation or a second window — none of which a rendered string can observe. Which heading gets
 * which name, and which links are anchors at all, are rules with many cases and belong to
 * `src/markdown/headingAnchors.test.ts` and `src/markdown/markdownAnchors.test.tsx`.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (app === null) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

/** Enough text between the sections that reaching one can only happen by scrolling. */
function filler(section: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${section} paragraph ${index + 1}, of no interest to anybody.\n`,
  );
}

const HANDBOOK = [
  "# Field handbook",
  "",
  "- [Getting started](#getting-started)",
  "- [What's next?](#whats-next)",
  "",
  ...filler("Introduction", 40),
  "## Getting started",
  "",
  "Install the command first.",
  "",
  ...filler("Installation", 40),
  "## What's next?",
  "",
  "Read the appendix when you are done.",
  "",
  ...filler("Appendix", 20),
].join("\n");

test("follows a Markdown document's contents links to the sections they name", async () => {
  test.setTimeout(120_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-section-links-"));
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  const documentPath = path.join(tempDir, "handbook.md");
  await writeFile(documentPath, HANDBOOK);

  let app: ElectronApplication | null = null;

  try {
    // Arrange: the handbook, open at the top, with both its sections well below the fold.
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), documentPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        MARKPDF_DATA_DIR: userDataPath,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const window = await app.firstWindow();
    await expect(window.locator(".markdown-preview")).toBeVisible({ timeout: 30_000 });

    const gettingStarted = window.locator("#getting-started");
    const whatsNext = window.locator("#whats-next");
    await expect(gettingStarted, "the first section starts out of view").not.toBeInViewport();
    await expect(whatsNext).not.toBeInViewport();

    const openedAt = window.url();

    // Act: follow the first contents row.
    await window.getByRole("link", { name: "Getting started" }).click();

    // Assert: the document moved to that section, inside the reader's own window.
    await expect(gettingStarted, "the section the link named").toBeInViewport();
    await expect(whatsNext, "the section further down").not.toBeInViewport();
    expect(app.windows(), "windows opened by a link to a section").toHaveLength(1);
    expect(window.url(), "the window navigated instead of scrolling").toBe(openedAt);

    // Act: follow the second row, whose heading is named after a title with punctuation in it.
    await window.getByRole("link", { name: "What's next?" }).click();

    await expect(whatsNext).toBeInViewport();
    await expect(gettingStarted, "the section left behind").not.toBeInViewport();
    expect(app.windows()).toHaveLength(1);
    expect(window.url()).toBe(openedAt);
  } finally {
    await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
