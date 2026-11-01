import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** A chart wide enough that the sheet has to shrink it, which is the case the controls exist for. */
const WIDE_CHART = [
  "# Plan",
  "",
  "The chart below is wider than the sheet.",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant You",
  "  participant Launcher as cf launcher",
  "  participant Git as git",
  "  participant Folder as Project folder",
  "  participant Orca",
  "  participant Author as Brief author",
  "  participant Sparrer as Sparrer",
  "  You->>Launcher: Alpha step typed in a terminal",
  "  Launcher->>Git: find the repository root and the main checkout name",
  "  Launcher->>Folder: create the folder, templates and the factory link",
  "  Launcher->>Orca: agent launch, surface terminal, first prompt",
  "  Orca->>Author: new tab with the first prompt",
  "  Author->>Sparrer: new tab, the prompt names the review file",
  "  Sparrer->>Folder: write the review, last line Verdict",
  "```",
  "",
].join("\n");

async function closeApp(app: ElectronApplication) {
  await app
    .evaluate(async ({ app: electronApp }) => {
      electronApp.exit(0);
    })
    .catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function openMarkdown(markdownPaths: string | string[], userDataPath: string) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js")].concat(markdownPaths),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MARKPDF_TEST_USER_DATA: userDataPath,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  });
  const window = await app.firstWindow();
  const diagram = window.getByRole("img", { name: "Mermaid diagram" }).first();
  await expect(diagram).toBeVisible({ timeout: 30_000 });
  await expect(window.locator('[aria-label="Mermaid diagram"][aria-busy="true"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(diagram.locator("svg").first()).toBeVisible();
  // One-time Markdown engine setup shows a progress modal that blocks clicks; wait it out.
  await expect(window.locator(".modal-backdrop")).toHaveCount(0, { timeout: 120_000 });
  return { app, window, diagram };
}

async function widthOf(window: Page, selector: Parameters<Page["locator"]>[0]) {
  const box = await window.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
}

/** Layout widths are fractional, so two that CSS makes equal can differ in the last pixel. */
function expectNear(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
}

async function withChart(
  run: (paths: { markdownPath: string; userDataPath: string; tempDir: string }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mermaid-viewer-"));
  const markdownPath = path.join(tempDir, "plan.md");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(markdownPath, WIDE_CHART);
  try {
    await run({ markdownPath, userDataPath, tempDir });
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

test("expanding a Mermaid diagram fills the document pane until the reader closes it", async () => {
  test.setTimeout(180_000);
  await withChart(async ({ markdownPath, userDataPath }) => {
    let app: ElectronApplication | null = null;
    try {
      const opened = await openMarkdown(markdownPath, userDataPath);
      app = opened.app;
      const { window, diagram } = opened;

      const expandButton = window.getByRole("button", { name: "Expand diagram" });
      await expandButton.click();

      // The diagram takes the whole pane the document is shown in, and only that pane:
      // the application toolbar above it stays where it was.
      const expanded = window.getByRole("dialog", { name: "Expanded Mermaid diagram" });
      await expect(expanded).toBeVisible();
      await expect(expanded.getByRole("img", { name: "Mermaid diagram" }).locator("svg")).toBeVisible();
      await expect(expanded).toContainText("Alpha step");
      const stage = await window.locator(".document-stage").boundingBox();
      const pane = await expanded.boundingBox();
      expect(stage).not.toBeNull();
      expect(pane).not.toBeNull();
      expect(Math.abs(pane!.x - stage!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(pane!.y - stage!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(pane!.width - stage!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(pane!.height - stage!.height)).toBeLessThanOrEqual(1);

      // Escape returns the diagram to its place in the document.
      await window.keyboard.press("Escape");
      await expect(expanded).toHaveCount(0);
      await expect(diagram.locator("svg")).toBeVisible();
      await expect(expandButton).toBeFocused();

      // So does the button in the expanded view's own header.
      await expandButton.click();
      await expect(expanded).toBeVisible();
      await expanded.getByRole("button", { name: "Collapse diagram" }).click();
      await expect(expanded).toHaveCount(0);
      await expect(diagram.locator("svg")).toBeVisible();
    } finally {
      if (app) await closeApp(app);
    }
  });
});

test("zooming a Mermaid diagram enlarges it in its frame and in the expanded view", async () => {
  test.setTimeout(180_000);
  await withChart(async ({ markdownPath, userDataPath }) => {
    let app: ElectronApplication | null = null;
    try {
      const opened = await openMarkdown(markdownPath, userDataPath);
      app = opened.app;
      const { window } = opened;
      const chart = '[role="img"][aria-label="Mermaid diagram"] svg';

      const sheetBefore = await widthOf(window, ".markdown-preview");
      const fitted = await widthOf(window, chart);
      const level = window.getByRole("button", { name: "Reset diagram size" });
      await expect(level).toHaveText("100%");

      await window.getByRole("button", { name: "Enlarge diagram" }).click();
      await expect(level).toHaveText("125%");
      expectNear(await widthOf(window, chart), fitted * 1.25);
      // Only the diagram grows. The document around it keeps its size.
      expectNear(await widthOf(window, ".markdown-preview"), sheetBefore);

      await window.getByRole("button", { name: "Shrink diagram" }).click();
      await window.getByRole("button", { name: "Shrink diagram" }).click();
      await expect(level).toHaveText("75%");
      expectNear(await widthOf(window, chart), fitted * 0.75);

      await level.click();
      await expect(level).toHaveText("100%");
      expectNear(await widthOf(window, chart), fitted);

      // The expanded view has the same controls, and it opens fitted to its larger pane.
      await window.getByRole("button", { name: "Expand diagram" }).click();
      const expanded = window.getByRole("dialog", { name: "Expanded Mermaid diagram" });
      await expect(expanded.getByRole("img", { name: "Mermaid diagram" }).locator("svg")).toBeVisible();
      const expandedLevel = expanded.getByRole("button", { name: "Reset diagram size" });
      await expect(expandedLevel).toHaveText("100%");
      const expandedFitted = await widthOf(window, '[role="dialog"] [role="img"] svg');
      expect(expandedFitted).toBeGreaterThan(fitted);

      await expanded.getByRole("button", { name: "Enlarge diagram" }).click();
      await expect(expandedLevel).toHaveText("125%");
      expectNear(await widthOf(window, '[role="dialog"] [role="img"] svg'), expandedFitted * 1.25);
    } finally {
      if (app) await closeApp(app);
    }
  });
});

test("zooming a diagram narrower than its frame enlarges it from its own size", async () => {
  test.setTimeout(180_000);
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mermaid-small-"));
  const markdownPath = path.join(tempDir, "small.md");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    markdownPath,
    ["# Small", "", "```mermaid", "flowchart LR", '  A["Alpha"] --> B["Beta"]', "```", ""].join("\n"),
  );

  let app: ElectronApplication | null = null;
  try {
    const opened = await openMarkdown(markdownPath, userDataPath);
    app = opened.app;
    const { window } = opened;
    const chart = '[role="img"][aria-label="Mermaid diagram"] svg';
    const frame = await widthOf(window, '[role="img"][aria-label="Mermaid diagram"]');
    const fitted = await widthOf(window, chart);
    expect(fitted).toBeLessThan(frame / 2);

    await window.getByRole("button", { name: "Enlarge diagram" }).click();
    await expect(window.getByRole("button", { name: "Reset diagram size" })).toHaveText("125%");
    expectNear(await widthOf(window, chart), fitted * 1.25);
  } finally {
    if (app) await closeApp(app);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});

test("downloading a Mermaid diagram saves it as an SVG file where the reader chose", async () => {
  test.setTimeout(180_000);
  await withChart(async ({ markdownPath, userDataPath, tempDir }) => {
    let app: ElectronApplication | null = null;
    const savePath = path.join(tempDir, "chosen-name.svg");
    try {
      const opened = await openMarkdown(markdownPath, userDataPath);
      app = opened.app;
      const { window } = opened;

      // The native save dialog cannot be driven from here, so the reader's answer to it is given
      // in advance: the main process gets back the path a reader would have picked.
      await app.evaluate(({ dialog }, target) => {
        Object.assign(dialog, {
          showSaveDialog: async () => ({ canceled: false, filePath: target }),
        });
      }, savePath);

      await window.getByRole("button", { name: "Download diagram" }).click();

      await expect
        .poll(async () => await readFile(savePath, "utf8").catch(() => ""), { timeout: 10_000 })
        .toContain("</svg>");
      const saved = await readFile(savePath, "utf8");
      expect(saved).toMatch(/^(<\?xml[^>]*\?>\s*)?<svg\b/);
      expect(saved).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(saved).toContain("Alpha step");
      // A file opened on its own shows the chart at its own size, not stretched to a page.
      expect(saved).toMatch(/<svg\b[^>]*\swidth="\d+(\.\d+)?"/);
      // And on the background the reader saw behind it, so light text drawn for the dark theme
      // stays readable in a viewer that shows the file on white.
      const seen = await window
        .locator('[role="img"][aria-label="Mermaid diagram"] > svg')
        .evaluate((chart) => {
          for (let node = chart.parentElement; node; node = node.parentElement) {
            const color = getComputedStyle(node).backgroundColor;
            if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
          }
          return "";
        });
      expect(seen).not.toBe("");
      expect(saved).toContain(`background-color: ${seen}`);
    } finally {
      if (app) await closeApp(app);
    }
  });
});

/** A Markdown file in its own temporary folder, removed after the run. */
async function withFiles(
  files: Record<string, string>,
  run: (paths: { files: Record<string, string>; userDataPath: string }) => Promise<void>,
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mermaid-viewer-"));
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  const written: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    written[name] = path.join(tempDir, name);
    await writeFile(written[name], content);
  }
  try {
    await run({ files: written, userDataPath });
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

test("zooming a diagram keeps the icons it draws in proportion to the chart", async () => {
  test.setTimeout(180_000);
  const architecture = [
    "# Services",
    "",
    "```mermaid",
    "architecture-beta",
    "  group api(cloud)[API]",
    "  service db(database)[Database] in api",
    "  service server(server)[Server] in api",
    "  db:L -- R:server",
    "```",
    "",
  ].join("\n");
  await withFiles({ "services.md": architecture }, async ({ files, userDataPath }) => {
    let app: ElectronApplication | null = null;
    try {
      const opened = await openMarkdown(files["services.md"], userDataPath);
      app = opened.app;
      const { window } = opened;
      const chart = '[role="img"][aria-label="Mermaid diagram"] > svg';
      const icon = `${chart} svg >> nth=0`;

      const chartBefore = await widthOf(window, chart);
      const iconBefore = await widthOf(window, icon);
      // An icon is a small part of the chart, not as wide as the chart itself.
      expect(iconBefore).toBeLessThan(chartBefore / 3);

      await window.getByRole("button", { name: "Enlarge diagram" }).click();
      await expect(window.getByRole("button", { name: "Reset diagram size" })).toHaveText("125%");
      expectNear(await widthOf(window, chart), chartBefore * 1.25);
      expectNear(await widthOf(window, icon), iconBefore * 1.25);
    } finally {
      if (app) await closeApp(app);
    }
  });
});

test("changing to another Markdown tab shows its diagram in place, not the expanded one", async () => {
  test.setTimeout(180_000);
  const chart = (label: string) =>
    ["# Notes", "", "```mermaid", "flowchart LR", `  A["${label}"] --> B["End"]`, "```", ""].join(
      "\n",
    );
  await withFiles(
    { "first.md": chart("Alpha"), "second.md": chart("Gamma") },
    async ({ files, userDataPath }) => {
      let app: ElectronApplication | null = null;
      try {
        const opened = await openMarkdown([files["first.md"], files["second.md"]], userDataPath);
        app = opened.app;
        const { window } = opened;
        const tab = (name: string) => window.locator(`.tabs .tab[title="${files[name]}"]`);
        const diagram = window.getByRole("img", { name: "Mermaid diagram" });

        await tab("first.md").click();
        await expect(diagram).toContainText("Alpha", { timeout: 30_000 });
        await expect(diagram).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        await window.getByRole("button", { name: "Enlarge diagram" }).click();
        await window.getByRole("button", { name: "Expand diagram" }).click();
        const expanded = window.getByRole("dialog", { name: "Expanded Mermaid diagram" });
        await expect(expanded).toContainText("Alpha");

        await tab("second.md").click();
        await expect(expanded).toHaveCount(0);
        await expect(diagram).toContainText("Gamma", { timeout: 30_000 });
        await expect(diagram).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
        await expect(window.getByRole("button", { name: "Reset diagram size" })).toHaveText("100%");
      } finally {
        if (app) await closeApp(app);
      }
    },
  );
});

test("keyboard focus stays out of the document hidden behind an expanded diagram", async () => {
  test.setTimeout(180_000);
  const twoCharts = [
    "# Two charts",
    "",
    "[Jump to the end](#end)",
    "",
    "```mermaid",
    "flowchart LR",
    '  A["Alpha"] --> B["Beta"]',
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    '  C["Gamma"] --> D["Delta"]',
    "```",
    "",
    "## End",
    "",
  ].join("\n");
  await withFiles({ "two.md": twoCharts }, async ({ files, userDataPath }) => {
    let app: ElectronApplication | null = null;
    try {
      const opened = await openMarkdown(files["two.md"], userDataPath);
      app = opened.app;
      const { window } = opened;

      await window.getByRole("button", { name: "Expand diagram" }).first().click();
      const expanded = window.getByRole("dialog", { name: "Expanded Mermaid diagram" });
      await expect(expanded.getByRole("button", { name: "Collapse diagram" })).toBeFocused();

      for (let press = 0; press < 10; press += 1) {
        await window.keyboard.press("Shift+Tab");
        const inCoveredDocument = await window.evaluate(
          () => document.activeElement?.closest(".markdown-document-scroll") !== null,
        );
        expect(inCoveredDocument, `focus after ${press + 1} presses`).toBe(false);
      }
      await expect(expanded).toHaveCount(1);
    } finally {
      if (app) await closeApp(app);
    }
  });
});

test("expanding and closing a tall diagram keeps the reader's place in the document", async () => {
  test.setTimeout(180_000);
  const steps = Array.from({ length: 24 }, (_, index) => `  S${index}["Step ${index}"]`);
  const links = Array.from({ length: 23 }, (_, index) => `  S${index} --> S${index + 1}`);
  const tall = [
    "# Long notes",
    "",
    ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index} of the text before the chart.\n`),
    "```mermaid",
    "flowchart TD",
    ...steps,
    ...links,
    "```",
    "",
    "The end.",
    "",
  ].join("\n");
  await withFiles({ "long.md": tall }, async ({ files, userDataPath }) => {
    let app: ElectronApplication | null = null;
    try {
      const opened = await openMarkdown(files["long.md"], userDataPath);
      app = opened.app;
      const { window } = opened;
      const header = window.getByRole("group", { name: "Diagram controls" });

      // Bring the diagram's header near the top of the pane, as a reader about to expand it would.
      await window.locator(".markdown-document-scroll").evaluate((pane) => {
        const frame = pane.querySelector(".markdown-mermaid-frame");
        if (!frame) throw new Error("No diagram frame");
        const offset = frame.getBoundingClientRect().top - pane.getBoundingClientRect().top;
        pane.scrollTop += offset - 40;
      });
      const before = await header.boundingBox();
      expect(before).not.toBeNull();

      await window.getByRole("button", { name: "Expand diagram" }).click();
      await expect(window.getByRole("dialog", { name: "Expanded Mermaid diagram" })).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(window.getByRole("dialog", { name: "Expanded Mermaid diagram" })).toHaveCount(0);

      const after = await header.boundingBox();
      expect(after).not.toBeNull();
      expectNear(after!.y, before!.y);
    } finally {
      if (app) await closeApp(app);
    }
  });
});
