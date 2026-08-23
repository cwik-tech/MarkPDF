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

// Both pages carry more than 100 non-whitespace characters so the automatic OCR check treats
// them as having a real text layer. That matters twice over: OCR would slow the run, and the
// stored snippet would then be Tesseract output rather than the text layer, which is what the
// highlight has to match against.
const PAGE_ONE_LINES = [
  "Introduction and preamble concerning unrelated administrative",
  "matters of record keeping, filing procedures, and departmental",
  "correspondence retained for audit.",
];
// The target sentence is the first line, so the snippet's leading words are contiguous in the
// text layer, which is how the highlight locates them.
const PAGE_TWO_LINES = [
  "The escape velocity of Deimos is five point six metres per second.",
  "Measured from its surface under standard planetary conditions.",
];
const QUERY = "escape velocity Deimos";
const EXPECTED_PAGE = 2;

async function createPdfFixture(filePath: string) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (const lines of [PAGE_ONE_LINES, PAGE_TWO_LINES]) {
    const page = pdfDoc.addPage([612, 792]);
    lines.forEach((line, index) => {
      page.drawText(line, { x: 60, y: 700 - index * 22, size: 13, font });
    });
  }
  await writeFile(filePath, await pdfDoc.save());
}

/** A ruled table on page 2, which PDF Inspector renders as a GFM table and a text layer cannot. */
async function createTablePdfFixture(filePath: string) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const first = pdfDoc.addPage([612, 792]);
  first.drawText("Annual Report", { x: 60, y: 720, size: 20, font: bold });
  first.drawText("Administrative preamble concerning departmental record keeping", { x: 60, y: 680, size: 12, font });

  const second = pdfDoc.addPage([612, 792]);
  second.drawText("Revenue by Segment", { x: 60, y: 720, size: 16, font: bold });
  const columnX = [60, 260, 420];
  let rowY = 680;
  ["Segment", "Revenue 2025", "Revenue 2026"].forEach((cell, column) => {
    second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font: bold });
  });
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1 });
  for (const row of [["Consumer", "412", "455"], ["Education", "308", "331"], ["Government", "677", "702"], ["Enterprise", "1204", "1318"]]) {
    rowY -= 24;
    row.forEach((cell, column) => second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font }));
  }
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1 });

  const third = pdfDoc.addPage([612, 792]);
  third.drawText("Notes", { x: 60, y: 720, size: 16, font: bold });
  third.drawText("Enterprise revenue is discussed on page 2 of this report", { x: 60, y: 680, size: 12, font });

  await writeFile(filePath, await pdfDoc.save());
}

function embeddingCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM chunk_embeddings").get() as { count: number };
    db.close();
    return row.count;
  } catch {
    return 0;
  }
}

/**
 * Close the application without letting teardown eat the test budget.
 *
 * A previous run failed an assertion, then spent the remaining minutes inside an unbounded
 * `app.close()`, so the only surviving evidence was a global timeout. Bounding the graceful
 * close and killing the process if it will not go keeps the original failure visible.
 */
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
      // already gone
    }
  } finally {
    // Clear the losing timer. Left running it keeps the process alive past a clean close and
    // makes the reported runtime meaningless.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Everything worth knowing about the renderer at the moment of failure. */
async function capturePageState(window: Page): Promise<string> {
  try {
    const state = await window.evaluate(() => ({
      url: location.href,
      bridge: typeof (window as unknown as { pdfReader?: unknown }).pdfReader,
      searchValue: document.querySelector<HTMLInputElement>(".search-box input")?.value ?? null,
      pageBox: document.querySelector<HTMLInputElement>(".page-box input")?.value ?? null,
      semanticSidebar: document.querySelector(".semantic-sidebar")?.textContent?.slice(0, 300) ?? null,
      resultCount: document.querySelectorAll(".semantic-result").length,
      statusBadge: document.querySelector(".ocr-status.semantic")?.textContent ?? null,
      hitCount: document.querySelectorAll(".semantic-hit").length,
    }));
    return JSON.stringify(state, null, 2);
  } catch (error) {
    return `page state unavailable: ${String(error)}`;
  }
}

/**
 * The user-visible outcome of moving the semantic index out of the renderer: open a document,
 * search it by meaning, and jump to the page that answers the query. This is the Phase 1
 * Electron exit criterion.
 *
 * The embedding model is replaced by a deterministic stand-in, selected only because this runs
 * unpackaged with MARKPDF_E2E_EMBEDDER and a temporary user-data directory. The real model is
 * covered by `npm run test:live`.
 */
test("finds a passage by meaning and navigates to the page that contains it", async () => {
  test.setTimeout(180_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-semantic-"));
  const pdfPath = path.join(tempDir, "semantic-fixture.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createPdfFixture(pdfPath);
  const dbPath = path.join(userDataPath, "semantic-search", "semantic-index.sqlite");

  const consoleLines: string[] = [];
  const stderrLines: string[] = [];
  let stage = "launching the application";
  let recordedProgress: { seen: string[]; badges: string[] } | null = null;
  let app: ElectronApplication | null = null;
  let window: Page | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        MARKPDF_DATA_DIR: userDataPath,
        MARKPDF_E2E_EMBEDDER: "deterministic",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    app.process().stderr?.on("data", (chunk: Buffer) => {
      stderrLines.push(String(chunk).trimEnd());
    });

    window = await app.firstWindow();
    window.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    window.on("pageerror", (error) => consoleLines.push(`pageerror: ${String(error)}`));

    stage = "recording progress events and status badge appearances";
    // Installed before indexing starts — it waits for OCR to settle and then debounces, which
    // leaves ample headroom. Records both the events crossing the bridge and whether the
    // application's own status badge actually rendered from them.
    await window.evaluate(() => {
      const seen: string[] = [];
      const badges: string[] = [];
      (globalThis as unknown as { __progress: { seen: string[]; badges: string[] } }).__progress = { seen, badges };
      (window as unknown as {
        pdfReader: {
          onSemanticProgress: (cb: (e: { kind: string; progress: { status: string } }) => void) => () => void;
        };
      }).pdfReader.onSemanticProgress((event) => {
        const detail = event as unknown as { progress: { current?: number; total?: number } };
        seen.push(
          `${event.kind}:${event.progress.status}:${String(detail.progress.current)}/${String(detail.progress.total)}`,
        );
      });
      new MutationObserver(() => {
        const badge = document.querySelector(".ocr-status.semantic");
        if (badge?.textContent) badges.push(badge.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    stage = "waiting for indexing to finish";
    // Two conditions together, because either alone is ambiguous. Embeddings in the store prove
    // the main process finished writing. The absent progress badge proves the renderer has left
    // its busy states — and because progress events deliberately never carry the tab to
    // "ready", only the resolved invoke result can clear the badge, which is the same moment the
    // content hash is recorded. Waiting for both means the query below is submitted exactly once.
    await expect
      .poll(
        async () => embeddingCount(dbPath) > 0 && (await window!.locator(".ocr-status.semantic").count()) === 0,
        { timeout: 60_000 },
      )
      .toBe(true);

    stage = "checking progress reached the interface";
    const progress = await window.evaluate(
      () => (globalThis as unknown as { __progress: { seen: string[]; badges: string[] } }).__progress,
    );
    recordedProgress = progress;
    // Preload delivery evidence. An "indexing" status carrying current/total can only come from
    // indexDocument in the main process — the renderer's own extraction reports "checking"
    // without counts — so seeing it here proves the channel and the preload narrowing work.
    expect(progress.seen.some((entry) => /^index:indexing:\d+\/\d+$/.test(entry))).toBe(true);

    // Deliberately NOT asserted here: that this event painted a badge. The renderer receives the
    // indexing event and the resolved invoke result in the same tick and coalesces them, so the
    // intermediate state is not reliably observable. Measured, not assumed: a run recording
    // events and badge mutations produced
    //   seen ["index:checking", "index:indexing", "index:ready"], badges ["Checking index"].
    // The mapping from event to tab state is covered instead by src/semanticProgress.test.ts,
    // which is deterministic. Forcing a paint would mean distorting production event
    // granularity, which is not worth it.

    stage = "submitting the semantic query";
    // Semantic search only activates on Enter; typing alone runs a plain text match and closes
    // the panel. Click first so the collapsed search pill expands and pins open.
    const searchInput = window.locator(".search-box input");
    await window.locator(".search-box").click();
    await searchInput.fill(QUERY);
    await searchInput.press("Enter");

    stage = "waiting for semantic results";
    // One submission, one result set. Pressing Enter again would bump the renderer's search
    // request id and abandon the in-flight query, which can starve the very result being
    // waited for.
    await expect(window.locator(".semantic-result").first()).toBeVisible({ timeout: 45_000 });

    stage = "checking the result names the right page";
    const firstResult = window.locator(".semantic-result").first();
    await expect(firstResult).toContainText(`Page ${EXPECTED_PAGE}`);
    await expect(firstResult).toContainText("escape velocity");

    stage = "selecting the result";
    await firstResult.click();

    stage = "checking navigation and highlight";
    await expect(window.locator(".page-box input")).toHaveValue(String(EXPECTED_PAGE));
    await expect(firstResult).toHaveClass(/active/);
    // The fixture places the snippet's leading words contiguously in the text layer, so the
    // highlight rectangle must render.
    await expect(window.locator(".semantic-hit").first()).toBeVisible({ timeout: 15_000 });

    stage = "checking the store as supporting cutover evidence";
    const db = new Database(dbPath, { readonly: true });
    // Any stamped schema can only have come from core's migration; the sql.js writer never set
    // `user_version` at all, so a legacy file reads 0. The exact number is the current schema
    // version and moves with it — what this journey is evidence for is the cutover, not which
    // migration ran last, and `core/store/store.test.ts` is where the versions themselves are
    // pinned.
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(2);
    const stored = db.prepare("SELECT name, text_source FROM documents LIMIT 1").get() as {
      name: string;
      text_source: string;
    };
    expect(stored.name).toBe("semantic-fixture.pdf");
    // "pdf" confirms the native text layer was indexed rather than OCR output, which is what
    // makes the highlight assertion above meaningful.
    expect(stored.text_source).toBe("pdf");
    db.close();
  } catch (error) {
    const pageState = window === null ? "no window" : await capturePageState(window);
    const diagnostics = [
      "",
      `--- failed during: ${stage} ---`,
      "--- renderer page state ---",
      pageState,
      "--- renderer console (last 40) ---",
      consoleLines.slice(-40).join("\n") || "(none)",
      "--- electron stderr (last 40) ---",
      stderrLines.slice(-40).join("\n") || "(none)",
      `--- embeddings in store: ${embeddingCount(dbPath)} ---`,
      "--- progress events seen / badge values rendered ---",
      recordedProgress === null ? "(not captured)" : JSON.stringify(recordedProgress),
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


/**
 * Cancellation has to cross the preload bridge, not merely stop the interface updating.
 *
 * The unit tests prove the registry's token rules; this proves the wiring. It starts a forced
 * rebuild through the real bridge and cancels the same job identifier immediately. `runIndexJob`
 * registers its token before awaiting the file read, and IPC preserves order, so the cancel
 * lands while the read is still yielding. The rebuild must report itself cancelled, and — the
 * part that matters — the index it would have replaced must still be intact.
 */
test("cancelling from the renderer stops a rebuild before it clears the existing index", async () => {
  test.setTimeout(180_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-cancel-"));
  const pdfPath = path.join(tempDir, "semantic-fixture.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createPdfFixture(pdfPath);
  const dbPath = path.join(userDataPath, "semantic-search", "semantic-index.sqlite");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        MARKPDF_DATA_DIR: userDataPath,
        MARKPDF_E2E_EMBEDDER: "deterministic",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const window = await app.firstWindow();

    await expect
      .poll(() => embeddingCount(dbPath), { timeout: 60_000 })
      .toBeGreaterThan(0);
    const before = embeddingCount(dbPath);

    const outcome = await window.evaluate(async (file: string) => {
      const bridge = (window as unknown as { pdfReader: {
        semantic: {
          indexDocument: (request: unknown) => Promise<{ status: string }>;
          cancelIndex: (jobId: string) => Promise<boolean>;
        };
      } }).pdfReader;

      const jobId = "cancellation-journey";
      const started = bridge.semantic.indexDocument({
        jobId,
        source: { kind: "path", path: file },
        name: "semantic-fixture.pdf",
        chunkingProfile: "balanced",
        force: true,
      });
      const foundLiveJob = await bridge.semantic.cancelIndex(jobId);
      const result = await started;
      return { status: result.status, foundLiveJob };
    }, pdfPath);

    // The cancel reached a job that was genuinely running in the main process.
    expect(outcome.foundLiveJob).toBe(true);
    expect(outcome.status).toBe("cancelled");
    // And the forced rebuild it stopped did not take the existing index with it.
    expect(embeddingCount(dbPath)).toBe(before);
  } finally {
    await closeBounded(app, 15_000);
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * The Phase 2 acceptance journey: a table read by PDF Inspector, cited on the page it is on.
 *
 * The distinguishing evidence is the pipes. The renderer's old text path read a PDF page as a
 * flat run of words and could not produce `|Enterprise|1204|1318|` under any circumstances — the
 * structure simply is not in the text layer. So a stored chunk containing GFM table syntax
 * proves the main-process extractor produced it, not merely that some path produced text.
 */
test("finds a table row extracted in the main process and navigates to its page", async () => {
  test.setTimeout(180_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-table-"));
  const pdfPath = path.join(tempDir, "revenue-report.pdf");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  await createTablePdfFixture(pdfPath);
  const dbPath = path.join(userDataPath, "semantic-search", "semantic-index.sqlite");

  const consoleLines: string[] = [];
  let stage = "launching the application";
  let app: ElectronApplication | null = null;
  let window: Page | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath],
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

    stage = "waiting for the document to finish indexing";
    await expect
      .poll(
        async () => embeddingCount(dbPath) > 0 && (await window!.locator(".ocr-status.semantic").count()) === 0,
        { timeout: 90_000 },
      )
      .toBe(true);

    stage = "checking the stored page-two chunk kept the table's structure";
    // Supporting store evidence, read before touching the interface so a later failure cannot
    // be confused with a search problem.
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT page_number AS page, text FROM document_chunks ORDER BY page_number")
      .all() as Array<{ page: number; text: string }>;
    db.close();

    const tableChunks = rows.filter((row) => row.text.includes("|Enterprise|1204|1318|"));
    expect(tableChunks.map((row) => row.page)).toEqual([2]);

    stage = "submitting the semantic query";
    const searchInput = window.locator(".search-box input");
    await window.locator(".search-box").click();
    await searchInput.fill("Enterprise revenue by segment");
    await searchInput.press("Enter");

    stage = "waiting for the result";
    await expect(window.locator(".semantic-result").first()).toBeVisible({ timeout: 45_000 });
    const firstResult = window.locator(".semantic-result").first();
    await expect(firstResult).toContainText("Page 2");

    stage = "navigating to the cited page";
    await firstResult.click();
    await expect(window.locator(".page-box input")).toHaveValue("2");
  } catch (error) {
    const diagnostics = [
      "",
      `--- failed during: ${stage} ---`,
      "--- renderer console (last 40) ---",
      consoleLines.slice(-40).join("\n") || "(none)",
      `--- embeddings in store: ${embeddingCount(dbPath)} ---`,
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
