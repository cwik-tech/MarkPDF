import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";

/**
 * The exit criterion for open-document awareness: a real agent, over a real stdio transport,
 * asking a running MarkPDF what it has open and reading it — without ever being told a path.
 *
 * Nothing between the two processes is replaced. The application writes its snapshot through the
 * real preload bridge and the real main process; the MCP server is the real entry point, given
 * only the same data directory the application was given. Only the embedding model is substituted,
 * through the guarded seam the application and the command line already use.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntryPoint = path.join(projectRoot, "dist-mcp", "main.js");

/**
 * Two documents that cannot be confused for one another.
 *
 * Distinct bytes on purpose: the index keys on content, so two tabs holding identical bytes would
 * become one indexed document and a test that read "the active one" could not tell which it got.
 */
async function buildPdf(sentinel: string, heading: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([612, 792]);
  first.drawText(heading, { x: 60, y: 720, size: 20, font: bold });
  first.drawText("Administrative preamble concerning departmental record keeping and", {
    x: 60,
    y: 680,
    size: 12,
    font,
  });
  first.drawText("filing procedures retained for audit review across the reporting year.", {
    x: 60,
    y: 660,
    size: 12,
    font,
  });

  const second = pdf.addPage([612, 792]);
  second.drawText(sentinel, { x: 60, y: 700, size: 14, font: bold });
  second.drawText("Supporting detail follows the statement above for the current period.", {
    x: 60,
    y: 670,
    size: 12,
    font,
  });

  return pdf.save();
}

function indexedDocumentCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
    db.close();
    return row.count;
  } catch {
    return 0;
  }
}

async function connectAgent(dataDir: string): Promise<Client> {
  const client = new Client({ name: "markpdf-open-documents-journey", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntryPoint],
      env: {
        PATH: process.env.PATH ?? "",
        MARKPDF_DATA_DIR: dataDir,
        MARKPDF_E2E_EMBEDDER: "deterministic",
        MARKPDF_TEST_USER_DATA: dataDir,
      },
      stderr: "pipe",
    }),
  );
  return client;
}

/** Every tool answers with one JSON document; this is the only place that shape is unpacked. */
function payloadOf(result: unknown): Record<string, unknown> {
  const typed = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = typed.content?.[0]?.text ?? "";
  if (typed.isError === true) {
    throw new Error(`The tool refused instead of answering: ${text}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Expected an object, got ${text}`);
  return { ...parsed };
}

interface ListedDocument {
  ref: string;
  kind: string;
  name: string;
  pageCount: number;
  indexed: boolean;
  unsavedChanges: boolean;
  active: boolean;
  activeInWindow: boolean;
  window: number;
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
      // already gone
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Fixture {
  tempDir: string;
  libraryDir: string;
  userDataPath: string;
  dbPath: string;
  quiet: string;
  loud: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `markpdf-open-${label}-`));
  const libraryDir = path.join(tempDir, "library");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userDataPath, { recursive: true });

  const quiet = path.join(libraryDir, "quarterly-review.pdf");
  const loud = path.join(libraryDir, "annual-report.pdf");
  await writeFile(quiet, await buildPdf(QUIET_SENTINEL, "Quarterly Review"));
  await writeFile(loud, await buildPdf(LOUD_SENTINEL, "Annual Report"));

  return {
    tempDir,
    libraryDir,
    userDataPath,
    dbPath: path.join(userDataPath, "semantic-search", "semantic-index.sqlite"),
    quiet,
    loud,
  };
}

const QUIET_SENTINEL = "Quarterly figures were restated once during the interim period";
const LOUD_SENTINEL = "Annual turnover reached one billion four hundred million exactly";

function launch(fixture: Fixture, openPaths: string[]): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js"), ...openPaths],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MARKPDF_TEST_USER_DATA: fixture.userDataPath,
      MARKPDF_DATA_DIR: fixture.userDataPath,
      MARKPDF_E2E_EMBEDDER: "deterministic",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  });
}

/** Indexing has finished for `count` documents and the window is no longer busy with any of them. */
async function waitForIndexing(window: Page, fixture: Fixture, count: number): Promise<void> {
  await expect
    .poll(
      async () =>
        indexedDocumentCount(fixture.dbPath) >= count &&
        (await window.locator(".ocr-status.semantic").count()) === 0,
      { timeout: 120_000 },
    )
    .toBe(true);
}

test("an agent reads the document the user has open, without being told a path", async () => {
  test.setTimeout(240_000);

  const fixture = await makeFixture("read");
  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching the application";

  try {
    // Arrange: two documents open in one window. The last one opened is the active tab.
    app = await launch(fixture, [fixture.quiet, fixture.loud]);
    const window = await app.firstWindow();

    stage = "waiting for both documents to be indexed";
    await waitForIndexing(window, fixture, 2);

    stage = "asking the agent's server what is open";
    client = await connectAgent(fixture.userDataPath);
    const listed = payloadOf(await client.callTool({ name: "list_open_documents", arguments: {} }));

    // Assert: both tabs are reported, and exactly one of them is the active document.
    const documents = listed.documents as ListedDocument[];
    expect(documents.map((entry) => entry.name).sort()).toEqual([
      "annual-report.pdf",
      "quarterly-review.pdf",
    ]);
    expect(documents.filter((entry) => entry.active).map((entry) => entry.name)).toEqual([
      "annual-report.pdf",
    ]);
    expect(listed.activeRef).toBe(documents.find((entry) => entry.active)?.ref);
    expect(listed.windows).toBe(1);

    // The reply names documents, never places. Nothing an agent reads here discloses where on
    // this disk the user keeps their files.
    expect(JSON.stringify(listed)).not.toContain(fixture.libraryDir);
    expect(JSON.stringify(listed)).not.toContain(".pdf\",\"path");

    stage = "reading the active document with no arguments at all";
    const read = payloadOf(await client.callTool({ name: "read_open_document", arguments: {} }));

    // Assert: page-numbered Markdown from the active document, not the other one.
    const pages = read.pages as Array<{ page: number; markdown: string }>;
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((page) => page.page)).toEqual([...pages].map((page) => page.page).sort((a, b) => a - b));
    const whole = pages.map((page) => page.markdown).join("\n");
    expect(whole).toContain("Annual turnover reached one billion");
    expect(whole).not.toContain("Quarterly figures were restated");
    expect(read.ref).toBe(listed.activeRef);
    expect(read.name).toBe("annual-report.pdf");
    expect(JSON.stringify(read)).not.toContain(fixture.libraryDir);

    // The page the sentinel is on, proved independently of the extractor: the builder put it on
    // page two of a two-page document.
    const sentinelPage = pages.find((page) => page.markdown.includes("Annual turnover reached one billion"));
    expect(sentinelPage?.page).toBe(2);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n--- failed during: ${stage} ---`;
    }
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app, 15_000);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("the window the user last brought to the front decides which document is active", async () => {
  test.setTimeout(240_000);

  const fixture = await makeFixture("focus");
  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching the application";

  try {
    // Arrange: one document per window, which is what makes "the active one" a real question.
    app = await launch(fixture, [fixture.quiet]);
    const first = await app.firstWindow();

    stage = "opening the second document in its own window";
    await first.evaluate(async (file: string) => {
      await (window as unknown as { pdfReader: { openFileInNewWindow: (path: string) => Promise<void> } }).pdfReader.openFileInNewWindow(
        file,
      );
    }, fixture.loud);
    await expect.poll(async () => app!.windows().length, { timeout: 60_000 }).toBe(2);
    const second = app.windows()[1]!;

    stage = "waiting for both documents to be indexed";
    await waitForIndexing(first, fixture, 2);
    await waitForIndexing(second, fixture, 2);

    stage = "asking which document is active";
    client = await connectAgent(fixture.userDataPath);
    const listed = payloadOf(await client.callTool({ name: "list_open_documents", arguments: {} }));
    const documents = listed.documents as ListedDocument[];

    // Both windows are reported, and each names its own front tab.
    expect(listed.windows).toBe(2);
    expect(documents.map((entry) => entry.name).sort()).toEqual(["annual-report.pdf", "quarterly-review.pdf"]);
    expect(documents.filter((entry) => entry.activeInWindow)).toHaveLength(2);
    // Only one of them is the document a person would point at: the newest window took focus.
    expect(documents.filter((entry) => entry.active).map((entry) => entry.name)).toEqual(["annual-report.pdf"]);

    stage = "bringing the first window back to the front";
    // The one seam this journey replaces, and it is the operating system's. A Playwright-launched
    // Electron application is never the frontmost application, so `focus()` is a no-op and the
    // window server delivers no focus event — measured, not assumed: a probe run recorded zero
    // `browser-window-focus` events and `isFocused()` false after calling `focus()`. Emitting the
    // event the window server would have emitted drives the real listener in `electron/main.ts`
    // and everything after it: the main process, the file it writes, and the server that reads it.
    const firstWindowId = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      // Not `getAllWindows()[0]` — that is not creation order. The smallest identifier is the
      // window that was made first.
      const target = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0]!;
      electronApp.emit("browser-window-focus", {}, target);
      return target.id;
    });
    expect(typeof firstWindowId).toBe("number");

    stage = "asking again, now that focus has moved";
    await expect
      .poll(
        async () => {
          const now = payloadOf(await client!.callTool({ name: "list_open_documents", arguments: {} }));
          return (now.documents as ListedDocument[]).find((entry) => entry.active)?.name ?? null;
        },
        { timeout: 30_000 },
      )
      .toBe("quarterly-review.pdf");

    // And reading with no reference now follows the front window, not the newest one.
    const read = payloadOf(await client.callTool({ name: "read_open_document", arguments: {} }));
    expect(read.name).toBe("quarterly-review.pdf");
    expect((read.pages as Array<{ markdown: string }>).map((page) => page.markdown).join("\n")).toContain(
      "Quarterly figures were restated",
    );
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n--- failed during: ${stage} ---`;
    }
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app, 15_000);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("a MarkPDF that was killed leaves an agent nothing to see", async () => {
  test.setTimeout(240_000);

  const fixture = await makeFixture("crash");
  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching the application";

  try {
    app = await launch(fixture, [fixture.loud]);
    const window = await app.firstWindow();

    stage = "waiting for the document to be indexed";
    await waitForIndexing(window, fixture, 1);

    stage = "confirming the document is visible while the application is running";
    client = await connectAgent(fixture.userDataPath);
    const before = payloadOf(await client.callTool({ name: "list_open_documents", arguments: {} }));
    expect((before.documents as ListedDocument[]).map((entry) => entry.name)).toEqual(["annual-report.pdf"]);
    await client.close();
    client = null;

    stage = "killing the application outright";
    // Not a quit. A quit removes its own record, which would prove nothing about what happens when
    // the application never gets the chance — so the record is deliberately left on disk and the
    // reader has to notice for itself that the process behind it is gone.
    const child = app.process();
    child.kill("SIGKILL");
    await expect.poll(() => child.killed || child.exitCode !== null, { timeout: 30_000 }).toBe(true);
    app = null;

    stage = "asking an agent what is open now";
    client = await connectAgent(fixture.userDataPath);
    const after = payloadOf(await client.callTool({ name: "list_open_documents", arguments: {} }));

    expect(after.documents).toEqual([]);
    expect(after.windows).toBe(0);
    expect(after.activeRef).toBeNull();

    const refused = (await client.callTool({ name: "read_open_document", arguments: {} })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text ?? "").toMatch(/no document open/i);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message}\n--- failed during: ${stage} ---`;
    }
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app, 15_000);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});
