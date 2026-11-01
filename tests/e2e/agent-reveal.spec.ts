import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { updateAllowlist } from "../../dist-core/consent/allowlistFile.js";

/**
 * An agent shows the person the evidence it cites.
 *
 * The person reads an agent's answer that says "page 3". Instead of searching for the passage, the
 * agent asks MarkPDF to show it: the window comes forward at that page and marks the quoted words
 * for a few seconds. Nothing about the document changes — no annotation, no unsaved edit, no byte
 * of the file.
 *
 * This has to run in Electron: the request travels from an MCP server process, through the
 * single-instance handoff, into a window, and what is observable is where the page scrolled and
 * what the window drew over it.
 */

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");

const CLIENT_NAME = "markpdf-reveal-journey";
const QUOTE = "Termination requires thirty days written notice";

/**
 * Three pages of plain text, all in one size. No line looks like a heading, so MarkPDF generates no
 * outline on open and the tab starts with nothing unsaved — which is what lets the journey prove
 * that the reveal left it that way.
 */
async function buildContract(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const topic of ["definitions", "payment", "termination"]) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`This page is about ${topic} and nothing else.`, { x: 72, y: 680, size: 12, font });
  }
  pdf.getPage(2).drawText(`${QUOTE} to the other party.`, { x: 72, y: 400, size: 12, font });
  await writeFile(path, await pdf.save());
}

interface Fixture {
  directory: string;
  dataDir: string;
  contract: string;
  env: Record<string, string>;
}

async function makeFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-reveal-"));
  const dataDir = join(directory, "data");
  const contract = join(directory, "contract.pdf");
  await buildContract(contract);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? directory,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    MARKPDF_TEST_USER_DATA: dataDir,
    MARKPDF_DATA_DIR: dataDir,
    MARKPDF_TEST_SINGLE_INSTANCE: "1",
    MARKPDF_E2E_EMBEDDER: "deterministic",
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
  };
  return { directory, dataDir, contract, env };
}

async function connectAgent(fixture: Fixture) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: CLIENT_NAME, version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: electronPath,
      args: [resolve("dist-mcp/main.js")],
      env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
    }),
  );
  return client;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = typeof result === "object" && result !== null ? Reflect.get(result, "content") : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = typeof first === "object" && first !== null ? Reflect.get(first, "text") : undefined;
  if (typeof text !== "string") throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  if (typeof result === "object" && result !== null && Reflect.get(result, "isError") === true) throw new Error(text);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Expected an object, got ${text}`);
  return { ...parsed };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Whether a page's element is inside the document pane's visible box. */
async function pageIsInView(window: Page, pageNumber: number): Promise<boolean> {
  return await window.evaluate((page) => {
    const pane = document.querySelector(".document-scroll");
    const element = document.querySelector(`[data-page-number="${String(page)}"]`);
    if (!pane || !element) return false;
    const paneBox = pane.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return box.top < paneBox.bottom && box.bottom > paneBox.top;
  }, pageNumber);
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (app === null) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("an agent shows the person the cited passage, and the document stays unchanged", async () => {
  test.setTimeout(120_000);
  const fixture = await makeFixture();
  updateAllowlist(fixture.dataDir, [{ change: "allow", access: "read", path: fixture.directory }]);
  const before = await sha256(fixture.contract);
  let app: ElectronApplication | null = null;
  let client: Awaited<ReturnType<typeof connectAgent>> | null = null;

  try {
    // Arrange: the contract is open at page 1. A new tab shows one page at a time, so page 3 is
    // not on screen at all.
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    expect(await pageIsInView(window, 3)).toBe(false);

    client = await connectAgent(fixture);
    const unsaved = async (): Promise<unknown> => {
      const listed = payloadOf(await client?.callTool({ name: "list_open_documents", arguments: {} }));
      const documents = listed.documents;
      return Array.isArray(documents) ? documents.map((entry: unknown) => Reflect.get(Object(entry), "unsavedChanges")) : null;
    };
    await expect.poll(unsaved).toEqual([false]);

    // Act: the agent cites page 3.
    const started = Date.now();
    const reply = payloadOf(
      await client.callTool({ name: "reveal", arguments: { ref: "active", page: 3, quote: QUOTE } }),
    );
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: "reveal-call-to-reply-ms", description: String(elapsed) });

    // Assert: the window shows the passage.
    expect(reply).toMatchObject({ status: "shown", page: 3, occurrences: 1 });
    await expect.poll(async () => await pageIsInView(window, 3)).toBe(true);
    await expect(window.getByTestId("text-layer-3")).toContainText(QUOTE);
    await expect(window.getByTestId("agent-toast")).toContainText(`Shown by AI agent · ${CLIENT_NAME}, page 3`);

    const mark = window.getByTestId("evidence-mark").first();
    await expect(mark).toBeVisible();
    const markBox = await mark.boundingBox();
    const quoted = window.getByTestId("text-layer-3").locator("span").filter({ hasText: "Termination requires" }).first();
    const quotedBox = await quoted.boundingBox();
    if (markBox === null || quotedBox === null) throw new Error("The mark or the quoted words have no geometry");
    // The mark covers the quoted words: it starts where they start and overlaps them vertically.
    expect(Math.abs(markBox.x - quotedBox.x)).toBeLessThan(4);
    expect(markBox.y).toBeLessThan(quotedBox.y + quotedBox.height);
    expect(markBox.y + markBox.height).toBeGreaterThan(quotedBox.y);

    // The mark is brief.
    await expect(window.getByTestId("evidence-mark")).toHaveCount(0, { timeout: 10_000 });

    // Nothing about the document changed: no comment was made, no edit is pending, no byte moved.
    await expect(window.getByRole("button", { name: "Comments" })).toBeDisabled();
    expect(await unsaved()).toEqual([false]);
    expect(await sha256(fixture.contract)).toBe(before);
  } finally {
    await client?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/** The close control of each open tab, which names the tab in its title. */
function openTabs(window: Page) {
  return window.getByTitle(/^Close /);
}

async function waitForResult(directory: string, id: string): Promise<Record<string, unknown>> {
  const file = join(directory, `${id}.result.json`);
  let text: string | null = null;
  await expect
    .poll(async () => {
      text = await readFile(file, "utf8").catch(() => null);
      return text !== null;
    }, { timeout: 30_000 })
    .toBe(true);
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

function revealRequest(id: string, path: string): string {
  return JSON.stringify({
    version: 1,
    id,
    kind: "reveal",
    deadline: Date.now() + 30_000,
    target: { path },
    page: 3,
    quote: QUOTE,
    agent: "direct-request",
  });
}

test("reveal opens a granted document at the cited page and refuses one outside the grants", async () => {
  test.setTimeout(120_000);
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "markpdf-reveal-outside-"));
  const secret = join(outside, "secret.pdf");
  await buildContract(secret);
  updateAllowlist(fixture.dataDir, [{ change: "allow", access: "read", path: fixture.directory }]);
  let app: ElectronApplication | null = null;
  let client: Awaited<ReturnType<typeof connectAgent>> | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env: fixture.env });
    const window = await app.firstWindow();
    await expect(openTabs(window)).toHaveCount(0);
    client = await connectAgent(fixture);

    const shown = payloadOf(await client.callTool({ name: "reveal", arguments: { path: fixture.contract, page: 3, quote: QUOTE } }));
    expect(shown).toMatchObject({ status: "shown", page: 3, name: "contract.pdf" });
    await expect(openTabs(window)).toHaveCount(1);
    await expect.poll(async () => await pageIsInView(window, 3)).toBe(true);
    await expect(window.getByTestId("evidence-mark").first()).toBeVisible();

    const refused = await client.callTool({ name: "reveal", arguments: { path: secret, page: 1 } });
    expect(Reflect.get(Object(refused), "isError")).toBe(true);
    expect(JSON.stringify(refused)).toContain("--allow-read");
    await expect(openTabs(window)).toHaveCount(1);
  } finally {
    await client?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the desktop refuses an ungranted request that skipped the client checks", async () => {
  test.setTimeout(120_000);
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "markpdf-reveal-outside-"));
  const secret = join(outside, "secret.pdf");
  await buildContract(secret);
  updateAllowlist(fixture.dataDir, [{ change: "allow", access: "read", path: fixture.directory }]);
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env: fixture.env });
    const window = await app.firstWindow();
    await expect(openTabs(window)).toHaveCount(0);

    // A request written straight into the channel, as any process of this user could write one.
    const directory = join(fixture.dataDir, "session", "desktop-requests");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = "12345678-1234-4234-8234-123456789012";
    await writeFile(join(directory, `${id}.request.json`), revealRequest(id, secret), { mode: 0o600 });
    const { spawn } = await import("node:child_process");
    spawn(electronPath, [resolve("dist-electron/bootstrap.js"), `--markpdf-request=${id}`], { env: fixture.env, stdio: "ignore", detached: true }).unref();

    expect(await waitForResult(directory, id)).toMatchObject({ requestId: id, status: "refused", reason: "access_denied" });
    await expect(openTabs(window)).toHaveCount(0);
  } finally {
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reveal starts MarkPDF for a granted document", async () => {
  test.setTimeout(120_000);
  const fixture = await makeFixture();
  updateAllowlist(fixture.dataDir, [{ change: "allow", access: "read", path: fixture.directory }]);
  const directory = join(fixture.dataDir, "session", "desktop-requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = "22345678-1234-4234-8234-123456789012";
  await writeFile(join(directory, `${id}.request.json`), revealRequest(id, fixture.contract), { mode: 0o600 });
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [resolve("dist-electron/bootstrap.js"), `--markpdf-request=${id}`],
      env: fixture.env,
    });
    const window = await app.firstWindow();
    expect(await waitForResult(directory, id)).toMatchObject({ requestId: id, status: "shown", page: 3 });
    await expect.poll(async () => await pageIsInView(window, 3)).toBe(true);
    await expect(window.getByTestId("agent-toast")).toContainText("Shown by AI agent · direct-request, page 3");
  } finally {
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
