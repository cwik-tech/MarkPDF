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

test("renders a Mermaid fence as a chart instead of source code", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mermaid-"));
  const markdownPath = path.join(tempDir, "chart.md");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    markdownPath,
    [
      "# Chart",
      "",
      "```mermaid",
      "flowchart TD",
      '  HOME["🏠 Home<br/><i>Positioning + proof + CTA</i>"]',
      '  HOW["1. How It Works<br/><i>Technology & installation</i>"]',
      '  FORM(["Field Evaluation Request<br/><b>PRIMARY CONVERSION</b>"])',
      "  HOME --> HOW",
      "  HOW --> FORM",
      "  classDef primary fill:#2d6a4f,stroke:#1b4332,color:#fff",
      "  class FORM primary",
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

    const diagram = window.getByRole("img", { name: "Mermaid diagram" });
    await expect(diagram).toBeVisible({ timeout: 30_000 });
    await expect(diagram.locator("svg")).toBeVisible();
    await expect(diagram).toHaveAttribute("aria-busy", "false");
    await expect(diagram).toContainText("Home");
    await expect(diagram).toContainText("PRIMARY CONVERSION");
    await expect(window.locator("pre").filter({ hasText: "flowchart TD" })).toHaveCount(0);
  } finally {
    if (app) await closeApp(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
