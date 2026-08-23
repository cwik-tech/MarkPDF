import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { ADVERSARIAL, buildAdversarialPdf } from "../../cli/journeys/adversarialFixture.test-support.js";

/**
 * The exit criterion for reading a page that is only a picture: the real application, indexing a
 * real document, and a real agent reading the page back.
 *
 * This has to be an Electron journey rather than a command-line one. The defect it protects against
 * lived in the wiring between the window and the main process — the window decided the document had
 * a text layer and stopped, and nothing in the main process read the page it had skipped. Both
 * halves of that are desktop behaviour, and a command-line run exercises neither.
 *
 * Only the embedding model is substituted, through the guarded seam the application and the command
 * line already use.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntryPoint = path.join(projectRoot, "dist-mcp", "main.js");

interface Fixture {
  tempDir: string;
  libraryDir: string;
  userDataPath: string;
  dbPath: string;
  document: string;
}

async function makeFixture(): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mixed-ocr-"));
  const libraryDir = path.join(tempDir, "library");
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userDataPath, { recursive: true });

  const document = path.join(libraryDir, "operating-plan.pdf");
  await writeFile(document, await buildAdversarialPdf("mixed"));

  return {
    tempDir,
    libraryDir,
    userDataPath,
    dbPath: path.join(userDataPath, "semantic-search", "semantic-index.sqlite"),
    document,
  };
}

function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js"), fixture.document],
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

/**
 * Indexing has finished and the window is no longer busy with it.
 *
 * Both halves matter. The document row is written before any page is read, so the row alone would
 * let this continue while the reading it is waiting for is still running.
 */
async function waitForIndexing(window: Page, fixture: Fixture): Promise<void> {
  await expect
    .poll(
      async () =>
        indexedDocumentCount(fixture.dbPath) >= 1 &&
        (await window.locator(".ocr-status.semantic").count()) === 0,
      { timeout: 180_000 },
    )
    .toBe(true);
}

async function connectAgent(dataDir: string): Promise<Client> {
  const client = new Client({ name: "markpdf-mixed-ocr-journey", version: "0.0.0" });
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
  if (typed.isError === true) throw new Error(`The tool refused instead of answering: ${text}`);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Expected an object, got ${text}`);
  return { ...parsed };
}

/**
 * Shut the application down without asking anybody anything.
 *
 * `app.close()` goes through the ordinary quit path, and a tab MarkPDF considers modified stops
 * there on a native "save before closing?" dialog. A modal cannot be answered from here, so the run
 * would sit on it until the timeout — and, because the dialog is a real window on a real desktop, it
 * would sit on it in front of whoever happens to be at the machine. `app.exit` skips the quit
 * handlers and the prompt with them, which is what a test teardown wants: the fixture directory is
 * about to be deleted, so there is nothing worth saving.
 */
async function closeBounded(app: ElectronApplication | null, ms: number): Promise<void> {
  if (app === null) return;
  const child = app.process();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("exit timed out")), ms);
      }),
    ]);
  } catch {
    // Fall through to the signal below.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

test("an agent reads the page that exists only as a picture, in a document MarkPDF indexed", async () => {
  test.setTimeout(360_000);

  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching the application";

  try {
    // Arrange: the application opens and indexes a thirteen-page report whose tenth page carries a
    // financial table and no text layer at all. Eleven of its pages are ordinary text, so the
    // window's density sample sees a healthy document and skips recognition entirely — which is
    // exactly the situation in which page ten used to be stored as nothing.
    app = await launch(fixture);
    const window = await app.firstWindow();

    stage = "waiting for the document to be indexed";
    await waitForIndexing(window, fixture);

    stage = "asking the agent's server for the page";
    client = await connectAgent(fixture.userDataPath);
    const read = payloadOf(await client.callTool({ name: "read_open_document", arguments: { pages: "10" } }));

    // Assert: the page the agent gets back is the one the reader can see.
    const pages = read.pages as Array<{ page: number; markdown: string }>;
    expect(pages.map((page) => page.page)).toEqual([ADVERSARIAL.imageOnlyPage]);

    const markdown = pages[0]?.markdown ?? "";
    expect(markdown).toContain(ADVERSARIAL.page10.rowLabel);
    expect(markdown).toContain(ADVERSARIAL.page10.salesMarketing2028);

    // And the reply names a document, never a place on this disk.
    expect(JSON.stringify(read)).not.toContain(fixture.libraryDir);
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message}\n--- failed during: ${stage} ---`;
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app, 15_000);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});
