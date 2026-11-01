import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const executablePath: unknown = createRequire(import.meta.url)("electron");
if (typeof executablePath !== "string") throw new Error("Electron executable is unavailable");
const projectRoot = process.cwd();

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "markpdf-folder-settings-")));
  const dataDir = path.join(dir, "user-data");
  const a = path.join(dir, "A");
  const b = path.join(dir, "B");
  await mkdir(path.join(dataDir, "consent"), { recursive: true });
  await mkdir(a);
  await mkdir(b);
  const record = path.join(dataDir, "consent/allowlist.json");
  await writeFile(record, JSON.stringify({ readRoots: [a], writeRoots: [] }));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Folder access acceptance document", { font, size: 18 });
  const document = path.join(b, "unindexed.pdf");
  await writeFile(document, await pdf.save());
  return { dir, dataDir, a, b, record, document };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function launch(f: Fixture) {
  return electron.launch({
    executablePath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js")],
    env: { ...process.env, MARKPDF_TEST_USER_DATA: f.dataDir, MARKPDF_DATA_DIR: f.dataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
  });
}
async function general(page: Page) {
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Folder access", exact: true })).toBeVisible();
}
async function close(app: ElectronApplication | undefined, f: Fixture) {
  if (app) {
    await app.evaluate(({ app: application }) => application.exit(0)).catch(() => undefined);
    await app.close();
  }
  await rm(f.dir, { recursive: true, force: true });
}
// Only the native dialogs are substituted: OS modal interaction is unavailable to Playwright.
async function picker(app: ElectronApplication, selected: string | null) {
  await app.evaluate(({ dialog }, selection) => {
    dialog.showOpenDialog = async () => ({ canceled: selection === null, filePaths: selection === null ? [] : [selection] });
  }, selected);
}
async function confirmation(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showMessageBox = async () => ({ response: selected, checkboxChecked: false });
  }, response);
}

test("manages the folders agents can use from Settings", async () => {
  test.setTimeout(30_000);
  const f = await fixture();
  let app: ElectronApplication | undefined;
  let client: Client | undefined;
  try {
    app = await launch(f);
    const page = await app.firstWindow();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocusable()))).toBe(true);
    await general(page);
    const a = page.getByRole("group", { name: `Access for ${f.a}`, exact: true });
    await expect(a.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
    await a.getByRole("button", { name: "Read and write", exact: true }).click();
    await expect.poll(() => readFile(f.record, "utf8").then(JSON.parse)).toEqual({ readRoots: [f.a], writeRoots: [f.a] });
    await picker(app, f.b);
    await page.getByRole("button", { name: "Add folder", exact: true }).click();
    const b = page.getByRole("group", { name: `Access for ${f.b}`, exact: true });
    await expect(b.getByRole("button", { name: "Read", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => readFile(f.record, "utf8").then(JSON.parse)).toEqual({ readRoots: [f.a, f.b], writeRoots: [f.a] });
    client = new Client({ name: "folder-access-settings", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(projectRoot, "dist-mcp/main.js")],
      env: { PATH: process.env.PATH ?? "", MARKPDF_DATA_DIR: f.dataDir, MARKPDF_TEST_USER_DATA: f.dataDir }, stderr: "pipe" }), { timeout: 5_000 });
    const allowed = await client.callTool({ name: "outline", arguments: { path: f.document } }, undefined, { timeout: 5_000 });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain("pageCount");
    await confirmation(app, 0);
    await page.getByRole("button", { name: `Remove ${f.b}`, exact: true }).click();
    await expect(b).toHaveCount(0);
    await expect.poll(() => readFile(f.record, "utf8").then(JSON.parse)).toEqual({ readRoots: [f.a], writeRoots: [f.a] });
    const denied = await client.callTool({ name: "outline", arguments: { path: f.document } }, undefined, { timeout: 5_000 });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("Not permitted to read");
  } finally {
    await client?.close();
    await close(app, f);
  }
});

test("cancelling the picker or the removal changes nothing", async () => {
  test.setTimeout(30_000);
  const f = await fixture();
  let app: ElectronApplication | undefined;
  try {
    const before = await readFile(f.record, "utf8");
    app = await launch(f);
    const page = await app.firstWindow();
    await general(page);
    await picker(app, null);
    await page.getByRole("button", { name: "Add folder", exact: true }).click();
    const row = page.getByRole("group", { name: `Access for ${f.a}`, exact: true });
    await expect(row.getByRole("button", { name: "Read", exact: true })).toBeEnabled();
    expect(await readFile(f.record, "utf8")).toBe(before);
    await confirmation(app, 1);
    await page.getByRole("button", { name: `Remove ${f.a}`, exact: true }).click();
    await expect(row.getByRole("button", { name: "Read", exact: true })).toBeEnabled();
    expect(await readFile(f.record, "utf8")).toBe(before);
    await expect(page.getByRole("group", { name: /^Access for / })).toHaveCount(1);
  } finally { await close(app, f); }
});

test("a page that is not MarkPDF cannot use folder access", async () => {
  test.setTimeout(30_000);
  const f = await fixture();
  let app: ElectronApplication | undefined;
  try {
    const before = await readFile(f.record, "utf8");
    app = await launch(f);
    const page = await app.firstWindow();
    await expect(page.getByTitle("Settings")).toBeVisible();
    await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      if (!target) throw new Error("No application window");
      await target.loadURL("data:text/html,<h1>Untrusted page</h1>");
    });
    await page.waitForURL("data:**");
    await page.waitForLoadState("domcontentloaded");
    const result = await page.evaluate((root) => window.pdfReader.folderAccess.setLevel(root, "read-write"), f.a);
    expect(result).toMatchObject({ ok: false, reason: "untrusted" });
    expect(await readFile(f.record, "utf8")).toBe(before);
  } finally { await close(app, f); }
});

test("retries folder access after a rejected first load", async () => {
  test.setTimeout(30_000);
  const f = await fixture();
  let app: ElectronApplication | undefined;
  try {
    const before = await readFile(f.record, "utf8");
    app = await launch(f);
    const page = await app.firstWindow();
    await expect(page.getByTitle("Settings")).toBeVisible();
    // A missing public IPC registration produces a real rejected preload invocation.
    // Restore the actual registration below, so retry still uses the real consent file.
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("folder-access:list"));
    await general(page);
    const section = page.locator(".settings-section", { has: page.getByRole("heading", { name: "Folder access", exact: true }) });
    await expect(section.getByRole("alert")).toContainText("No handler registered");
    await expect(section.getByText("Loading folder access...", { exact: true })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();

    await app.evaluate(({ ipcMain, BrowserWindow, dialog, app: application }, modulePath) => {
      const require = process.getBuiltinModule("module").createRequire(modulePath);
      const handlers: unknown = require(modulePath);
      if (typeof handlers !== "object" || handlers === null || !("registerFolderAccess" in handlers) || typeof handlers.registerFolderAccess !== "function") {
        throw new Error("Folder access registration is unavailable");
      }
      for (const action of ["list", "add", "set-level", "remove"]) ipcMain.removeHandler(`folder-access:${action}`);
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("No application window");
      handlers.registerFolderAccess({
        dataDir: () => application.getPath("userData"), ipc: ipcMain, dialog, entryUrl: window.webContents.getURL(),
        windowFor: (event: { sender: Electron.WebContents }) => BrowserWindow.fromWebContents(event.sender),
      });
    }, path.join(projectRoot, "dist-electron/folderAccess.js"));
    await section.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("group", { name: `Access for ${f.a}`, exact: true })).toBeVisible();
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Add folder", exact: true })).toBeEnabled();
    expect(await readFile(f.record, "utf8")).toBe(before);
  } finally { await close(app, f); }
});

test("explains unavailable access choices by keyboard without changing grants", async () => {
  test.setTimeout(30_000);
  const f = await fixture();
  let app: ElectronApplication | undefined;
  try {
    await writeFile(f.record, JSON.stringify({ readRoots: [], writeRoots: [f.a] }));
    await rm(f.a, { recursive: true });
    const before = await readFile(f.record, "utf8");
    app = await launch(f);
    const page = await app.firstWindow();
    await general(page);
    const group = page.getByRole("group", { name: `Access for ${f.a}`, exact: true });
    const write = group.getByRole("button", { name: "Read and write", exact: true });
    await write.focus();
    await expect(page.getByRole("tooltip", { name: "Read and write. Agents can also save files here.", exact: true })).toBeVisible();
    const tooltipIsTopmost = await page.getByRole("tooltip", {
      name: "Read and write. Agents can also save files here.", exact: true,
    }).evaluate(element => {
      const rect = element.getBoundingClientRect();
      const painted = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return painted !== null && element.contains(painted);
    });
    expect(tooltipIsTopmost).toBe(true);
    await write.press("Enter");
    // aria-disabled remains focusable; dispatch the pointer click that a browser permits.
    await write.click({ force: true });
    await expect(page.getByRole("alert")).toHaveCount(0);
    const read = group.getByRole("button", { name: "Read", exact: true });
    await read.focus();
    await expect(page.getByRole("tooltip", { name: "Read. Agents can find and read files here.", exact: true })).toBeVisible();
    await read.press("Space");
    await page.getByRole("button", { name: `Remove ${f.a}`, exact: true }).focus();
    await expect(page.getByRole("tooltip", { name: "Remove folder access", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await readFile(f.record, "utf8")).toBe(before);
  } finally { await close(app, f); }
});
