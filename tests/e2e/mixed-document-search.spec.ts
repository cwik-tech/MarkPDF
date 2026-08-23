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
 * The exit criterion for layout surviving recognition: the real application indexes a document
 * whose answer table exists only as a picture, and an agent both reads that table back with its
 * columns associated and finds the answer cell through search — without the header that flat
 * adjacent recognition would paste against the row.
 *
 * Two assertions discriminate reconstruction from flat text, and both were chosen by measurement
 * (the recorded recognition of this fixture's page 10):
 *
 * - **Column association.** Flat recognition returns `Sales & Marketing 4110 4620 5170 5890` —
 *   the right values with no statement of which year each belongs to. A reconstructed table is
 *   the only thing that can answer "which cell sits at this row and column".
 * - **The header is not glued to the row.** In the flat text the header line and the answer row
 *   are adjacent lines with no blank line between them, so they merge into one block whose
 *   snippet necessarily carries `Approved 2026`. After reconstruction the header is a table
 *   header, stored apart from the rows, so no snippet of the answer carries it.
 *
 * Excluding the other rows' values (`3020`, `1180`) is deliberately NOT an assertion here: the
 * measured flat text has blank lines between body rows, so those rows already form separate
 * blocks before any reconstruction exists, and an assertion they were absent would pass against
 * the defect. The decoy values from other pages (`4980`, `1140`) are asserted absent because a
 * search that answers from a neighbouring page is the other wrong answer this journey protects
 * against.
 *
 * Only the embedding model is substituted, through the guarded seam the application and the
 * command line already use.
 */

const require = createRequire(import.meta.url);
const electronModule: unknown = require("electron");
if (typeof electronModule !== "string") throw new Error("The Electron package did not expose its executable path.");
const electronPath = electronModule;
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
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-mixed-search-"));
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
    const row: unknown = db.prepare("SELECT COUNT(*) AS count FROM documents").get();
    db.close();
    const count = property(row, "count");
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

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
  const client = new Client({ name: "markpdf-mixed-search-journey", version: "0.0.0" });
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

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = property(result, "content");
  const first = Array.isArray(content) ? content[0] : undefined;
  const rawText = property(first, "text");
  const text = typeof rawText === "string" ? rawText : "";
  if (property(result, "isError") === true) throw new Error(`The tool refused instead of answering: ${text}`);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected an object, got ${text}`);
  }
  return { ...parsed };
}

interface ReadPagePayload {
  page: number;
  markdown: string;
}

function pagesOf(payload: Record<string, unknown>): ReadPagePayload[] {
  const pages = payload.pages;
  if (!Array.isArray(pages)) throw new Error("The read reply did not contain a pages array.");
  return pages.map((value, index) => {
    const page = property(value, "page");
    const markdown = property(value, "markdown");
    if (typeof page !== "number" || !Number.isInteger(page) || typeof markdown !== "string") {
      throw new Error(`The read reply contained an invalid page at index ${index}.`);
    }
    return { page, markdown };
  });
}

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

/** The pipe-delimited rows of the first table in a page's Markdown, cells trimmed. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

interface SearchHit {
  page: number;
  snippet: string;
  score: number;
}

function searchHitsOf(payload: Record<string, unknown>): SearchHit[] {
  const results = payload.results;
  if (!Array.isArray(results)) throw new Error("The search reply did not contain a results array.");
  return results.map((value, index) => {
    const page = property(value, "page");
    const snippet = property(value, "snippet");
    const score = property(value, "score");
    if (
      typeof page !== "number" ||
      !Number.isInteger(page) ||
      typeof snippet !== "string" ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    ) {
      throw new Error(`The search reply contained an invalid result at index ${index}.`);
    }
    return { page, snippet, score };
  });
}

test("an agent gets the cell from the picture, its column associated and no header glued to it", async () => {
  test.setTimeout(360_000);

  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching the application";

  try {
    // Arrange: the application opens and indexes the thirteen-page report whose tenth page is a
    // financial table drawn as ink. The window's density sample sees eleven text-rich pages and
    // recognises nothing itself; the reading that reaches the index is the one the main process
    // did, so what the agent gets back is a statement about that reading's shape.
    app = await launch(fixture);
    const window = await app.firstWindow();

    stage = "waiting for the document to be indexed";
    await waitForIndexing(window, fixture);

    stage = "asking the agent's server for the document";
    client = await connectAgent(fixture.userDataPath);
    const described = payloadOf(await client.callTool({ name: "read_open_document", arguments: {} }));
    const contentHash = described.contentHash;
    if (typeof contentHash !== "string" || contentHash.length === 0) {
      throw new Error(`No content hash in the reply: ${JSON.stringify(described).slice(0, 400)}`);
    }

    // Assert, first half: page ten comes back as a table whose rows and columns can be crossed.
    // Flat text carries the same words with no association between them, so this is the
    // reconstruction made observable.
    stage = "reading page 10 as a table";
    const read = payloadOf(await client.callTool({ name: "read_open_document", arguments: { pages: "10" } }));
    const pages = pagesOf(read);
    expect(pages.map((page) => page.page)).toEqual([ADVERSARIAL.imageOnlyPage]);

    const rows = tableRows(pages[0]?.markdown ?? "");
    expect(rows.length, "a header, a divider, and one row per body line of the pictured table").toBeGreaterThanOrEqual(5);

    const header = rows.find((row) => row.includes("Line item"));
    expect(header, "the table's header row").toBeDefined();
    const answerColumn = header?.findIndex((cell) => cell === `${ADVERSARIAL.page10.columnPrefix} 2028`) ?? -1;
    expect(answerColumn, "the Approved 2028 column").toBeGreaterThan(-1);

    const answerRow = rows.find((row) => row[0] === ADVERSARIAL.page10.rowLabel);
    expect(answerRow, `the ${ADVERSARIAL.page10.rowLabel} row`).toBeDefined();
    expect(answerRow?.[answerColumn]).toBe(ADVERSARIAL.page10.salesMarketing2028);

    // Assert, second half: search retrieves that cell, and the snippet answers without the
    // header glued to it. The flat text merges the header line and the answer row into one
    // block, so a snippet carrying `Approved 2026` is the defect speaking; the reconstructed
    // table stores its header apart from its rows.
    //
    // The store selects by score and then presents the selected hits in page order. The score,
    // rather than array position, therefore identifies the best passage for an agent.
    stage = "searching for the answer cell";
    const search = payloadOf(
      await client.callTool({
        name: "search",
        arguments: { id: contentHash, query: ADVERSARIAL.query, min_score: 0.1, top_k: 12 },
      }),
    );
    const results = searchHitsOf(search);
    expect(results.length, "the selective cut kept results").toBeGreaterThan(0);
    const highestScoring = results.reduce((best, hit) => (hit.score > best.score ? hit : best));
    expect(highestScoring.page, "the highest-scoring passage is on the pictured table's page").toBe(
      ADVERSARIAL.imageOnlyPage,
    );

    const fromAnswerPage = results.filter((hit) => hit.page === ADVERSARIAL.imageOnlyPage);
    expect(fromAnswerPage.length, "the pictured table's page ranked inside the selective cut").toBeGreaterThan(0);
    expect(
      fromAnswerPage.some(
        (hit) => hit.snippet.includes(ADVERSARIAL.page10.rowLabel) && hit.snippet.includes(ADVERSARIAL.page10.salesMarketing2028),
      ),
      "a snippet names the row and the answer value",
    ).toBe(true);

    const gluedHeader = `${ADVERSARIAL.page10.columnPrefix} 2026`;
    for (const hit of fromAnswerPage) {
      expect(hit.snippet, "no snippet on the answer page carries the table's header").not.toContain(gluedHeader);
    }

    for (const decoy of [ADVERSARIAL.page3.salesMarketing2028, ADVERSARIAL.chart.marketing2028]) {
      for (const hit of fromAnswerPage) {
        expect(hit.snippet, "a decoy value from another page").not.toContain(decoy);
      }
    }

    // And both replies name a document, never a place on this disk.
    expect(JSON.stringify(read)).not.toContain(fixture.libraryDir);
    expect(JSON.stringify(search)).not.toContain(fixture.libraryDir);
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message}\n--- failed during: ${stage} ---`;
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app, 15_000);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});
