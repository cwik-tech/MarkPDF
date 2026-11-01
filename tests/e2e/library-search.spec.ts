import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The person's journey for library search: find a passage in a document that is not open.
 *
 * Two PDFs are opened and indexed. The second is closed. The search pane is switched to the
 * library, a phrase that only the closed document holds is searched, and its hit is clicked: the
 * closed document opens again at the page that holds the passage, with the passage highlighted.
 *
 * The page numbers and the phrase are properties of the fixtures written here. The embedding model
 * is the deterministic stand-in, selected only for an unpackaged run with a test data directory.
 */

const PHRASE = "pilotage boarding ground";
const RULES_PAGES = ["Harbour rules for small craft and tenders.", "Mooring buoys are inspected every spring tide."];
const NOTES_PAGES = [
  "Port notes, collected by the harbour office.",
  "Tide tables are posted beside the slipway.",
  "The pilotage boarding ground lies north of the breakwater.",
];
const EXPECTED_PAGE = 3;

async function writePdf(filePath: string, pages: readonly string[]): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const line of pages) pdf.addPage([612, 792]).drawText(line, { x: 60, y: 700, size: 13, font });
  await writeFile(filePath, await pdf.save());
}

function indexedDocumentCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(DISTINCT c.document_id) AS count FROM document_chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id").get() as { count: number };
    db.close();
    return row.count;
  } catch {
    return 0;
  }
}

async function closeBounded(app: ElectronApplication | null, ms: number): Promise<void> {
  if (app === null) return;
  const child = app.process();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("graceful close timed out")), ms);
      }),
    ]);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function pageState(window: Page): Promise<string> {
  try {
    return JSON.stringify(
      await window.evaluate(() => ({
        tabs: [...document.querySelectorAll(".tabs .tab")].map((tab) => `${tab.textContent ?? ""}${tab.classList.contains("active") ? " (active)" : ""}`),
        pane: document.querySelector(".semantic-sidebar")?.textContent?.slice(0, 400) ?? null,
        pageBox: document.querySelector<HTMLInputElement>(".page-box input")?.value ?? null,
        hits: document.querySelectorAll(".semantic-hit").length,
      })),
      null,
      2,
    );
  } catch (error) {
    return `page state unavailable: ${String(error)}`;
  }
}

test("finds a passage in a closed document from the library and opens it at that page", async () => {
  test.setTimeout(180_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-library-"));
  const rulesPath = path.join(tempDir, "harbour-rules.pdf");
  const notesPath = path.join(tempDir, "port-notes.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await writePdf(rulesPath, RULES_PAGES);
  await writePdf(notesPath, NOTES_PAGES);
  const dbPath = path.join(userDataPath, "semantic-search", "semantic-index.sqlite");

  const consoleLines: string[] = [];
  let stage = "launching the application";
  let app: ElectronApplication | null = null;
  let window: Page | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), rulesPath, notesPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        MARKPDF_DATA_DIR: userDataPath,
        MARKPDF_E2E_EMBEDDER: "deterministic",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    window = await app.firstWindow();
    window.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    window.on("pageerror", (error) => consoleLines.push(`pageerror: ${String(error)}`));

    stage = "waiting for both documents to be indexed";
    await expect(window.locator(".tabs .tab")).toHaveCount(2, { timeout: 30_000 });
    await expect
      .poll(async () => indexedDocumentCount(dbPath) === 2 && (await window!.locator(".ocr-status.semantic").count()) === 0, {
        timeout: 90_000,
      })
      .toBe(true);

    stage = "closing the document that holds the phrase";
    await window.locator(".tabs .tab", { hasText: "port-notes.pdf" }).locator(".tab-close-icon").click();
    await expect(window.locator(".tabs .tab")).toHaveCount(1);

    stage = "searching the library";
    const searchInput = window.locator(".search-box input");
    await window.locator(".search-box").click();
    await searchInput.fill(PHRASE);
    await searchInput.press("Enter");
    await expect(window.locator(".semantic-sidebar")).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Library", exact: true }).click();

    stage = "waiting for the library hit";
    const hit = window.locator(".library-result", { hasText: "port-notes.pdf" }).first();
    await expect(hit).toBeVisible({ timeout: 45_000 });
    await expect(hit).toContainText(`Page ${EXPECTED_PAGE}`);
    await expect(hit).toContainText("pilotage boarding ground");

    stage = "opening the hit";
    await hit.click();

    stage = "checking the document opened at the page with the passage highlighted";
    await expect(window.locator(".tabs .tab.active")).toContainText("port-notes.pdf", { timeout: 30_000 });
    await expect(window.locator(".page-box input")).toHaveValue(String(EXPECTED_PAGE), { timeout: 30_000 });
    await expect(window.locator(".semantic-hit").first()).toBeVisible({ timeout: 30_000 });

    stage = "checking the page and the highlight stay once the window settles";
    // The search box still holds the query, and a newly active tab used to run its own search 250 ms
    // later, which moved the page and cleared the highlight. Nothing announces that it did not run,
    // so the journey waits past it and looks again.
    await window.waitForTimeout(1_500);
    await expect(window.locator(".page-box input")).toHaveValue(String(EXPECTED_PAGE));
    await expect(window.locator(".semantic-hit").first()).toBeVisible();
  } catch (error) {
    const diagnostics = [
      "",
      `--- failed during: ${stage} ---`,
      window === null ? "no window" : await pageState(window),
      "--- renderer console (last 30) ---",
      consoleLines.slice(-30).join("\n") || "(none)",
    ].join("\n");
    if (error instanceof Error) {
      error.message = `${error.message}\n${diagnostics}`;
      throw error;
    }
    throw new Error(`${String(error)}\n${diagnostics}`);
  } finally {
    await closeBounded(app, 15_000);
    await rm(tempDir, { recursive: true, force: true });
  }
});
