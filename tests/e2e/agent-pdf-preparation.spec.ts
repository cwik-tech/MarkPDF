import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { updateAllowlist } from "../../dist-core/consent/allowlistFile.js";
import { expect, test, _electron as electron } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");

test("agent preparation saves a generated outline and returns the saved document identity", async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-prepare-"));
  const path = join(directory, "report.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.addPage().drawText("Executive Summary", { x: 70, y: 700, size: 26, font });
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.getPage(0);
  first.drawText("This paragraph contains ordinary report text about administrative record keeping.", { x: 60, y: 660, size: 10, font: body });
  first.drawText("Further supporting evidence is preserved for the current reporting period.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  updateAllowlist(join(directory, "data"), [
    { change: "allow", access: "read", path: directory },
    { change: "allow", access: "write", path: directory },
  ]);
  const app = await electron.launch({ executablePath: electronPath,
    args: [resolve("dist-electron/bootstrap.js"), path],
    env: { ...process.env, MARKPDF_TEST_USER_DATA: join(directory, "data"), MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("text-layer-1")).toBeVisible();
    const result = await page.evaluate(async () => {
      const bridge = window.pdfReader;
      if (bridge === undefined || !("prepareDocument" in bridge)) return { status: "unavailable" };
      return await bridge.prepareDocument();
    });
    expect(result).toMatchObject({ status: "ready", save: "saved", contentHash: createHash("sha256").update(await readFile(path)).digest("hex") });
    const saved = await PDFDocument.load(await readFile(path));
    expect(saved.getKeywords()).toContain("markpdf-outline:");
    await page.screenshot({ path: testInfo.outputPath("prepared.png") });
    await page.getByTitle("Close report.pdf", { exact: true }).click();
    await expect(page.getByTestId("text-layer-1")).toHaveCount(0);
    await app.evaluate(({ app }, filePath) => { app.emit("open-file", { preventDefault() {} }, filePath); }, path);
    await expect(page.getByTestId("text-layer-1")).toBeVisible();
    const heading = page.getByTestId("text-layer-1").locator("span").filter({ hasText: "Executive Summary" }).first();
    const headingBox = await heading.boundingBox();
    if (headingBox === null) throw new Error("Reopened heading has no rendered geometry");
    await page.mouse.move(headingBox.x + 2, headingBox.y + headingBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(headingBox.x + headingBox.width - 2, headingBox.y + headingBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await heading.evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: box.right, clientY: box.top + box.height / 2, view: window }));
    });
    await page.getByRole("button", { name: "Bookmark selection" }).click();
    const refused = await page.evaluate(async () => await window.pdfReader?.prepareDocument());
    expect(refused).toMatchObject({ status: "needs_user_action", save: "blocked" });

  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a CLI agent prepares a supplied PDF through the running desktop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-cli-prepare-"));
  const path = join(directory, "external.pdf");
  const dataDir = join(directory, "data");
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheet = pdf.addPage();
  sheet.drawText("Executive Summary", { x: 60, y: 700, size: 24, font: heading });
  sheet.drawText("Administrative record keeping preserves the complete independent source material.", { x: 60, y: 660, size: 10, font: body });
  sheet.drawText("Evidence supports the current period and is available for accurate retrieval.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }, { change: "allow", access: "write", path: directory }]);
  const env = { ...process.env, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env });
  try {
    await app.firstWindow();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const nextWindow = app.waitForEvent("window");
    const result = await promisify(execFile)(electronPath, [resolve("dist-cli/main.js"), "prepare", path, "--json"], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
    const reply: unknown = JSON.parse(result.stdout);
    expect(reply).toMatchObject({ status: "ready", save: "saved" });
    const preparedWindow = await nextWindow;
    await expect(preparedWindow.getByTestId("text-layer-1")).toBeVisible();
    expect((await PDFDocument.load(await readFile(path))).getKeywords()).toContain("markpdf-outline:");
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an MCP agent prepares a supplied PDF through the running desktop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-cli-prepare-"));
  const path = join(directory, "external.pdf");
  const dataDir = join(directory, "data");
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheet = pdf.addPage();
  sheet.drawText("Executive Summary", { x: 60, y: 700, size: 24, font: heading });
  sheet.drawText("Administrative record keeping preserves the complete independent source material.", { x: 60, y: 660, size: 10, font: body });
  sheet.drawText("Evidence supports the current period and is available for accurate retrieval.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }, { change: "allow", access: "write", path: directory }]);
  const env = { ...process.env, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env });
  try {
    await app.firstWindow();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "preparation-journey", version: "1" });
    const nextWindow = app.waitForEvent("window");
    try {
      await client.connect(new StdioClientTransport({ command: electronPath, args: [resolve("dist-mcp/main.js")], env: { PATH: process.env.PATH ?? "", ELECTRON_RUN_AS_NODE: "1", MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" } }));
      const result = await client.callTool({ name: "prepare_document", arguments: { path } });
      expect(result.isError).not.toBe(true);
      const content = result.content;
      if (!Array.isArray(content)) throw new Error("Expected tool content");
      const first: unknown = content[0];
      if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") throw new Error("Expected JSON preparation reply");
      const reply: unknown = JSON.parse(first.text);
      expect(reply).toMatchObject({ status: "ready", save: "saved" });
    } finally { await client.close(); }
    const preparedWindow = await nextWindow;
    await expect(preparedWindow.getByTestId("text-layer-1")).toBeVisible();
    expect((await PDFDocument.load(await readFile(path))).getKeywords()).toContain("markpdf-outline:");
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling before desktop readiness leaves the PDF unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-cli-prepare-"));
  const path = join(directory, "external.pdf");
  const dataDir = join(directory, "data");
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheet = pdf.addPage();
  sheet.drawText("Executive Summary", { x: 60, y: 700, size: 24, font: heading });
  sheet.drawText("Administrative record keeping preserves the complete independent source material.", { x: 60, y: 660, size: 10, font: body });
  sheet.drawText("Evidence supports the current period and is available for accurate retrieval.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }, { change: "allow", access: "write", path: directory }]);
  const env = { ...process.env, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env });
  try {
    await app.firstWindow();
    const preparationDir = join(dataDir, "session", "preparations");
    await mkdir(preparationDir, { recursive: true });
    const cancellation = new Promise<void>((resolveCancel, reject) => {
      const watcher = watch(preparationDir, (_event, name) => {
        if (name === null || !name.endsWith(".request.json")) return;
        watcher.close();
        void writeFile(join(preparationDir, name.replace(".request.json", ".cancel")), "cancel", { mode: 0o600 }).then(resolveCancel, reject);
      });
      watcher.once("error", reject);
    });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const nextWindow = app.waitForEvent("window");
    const result = await promisify(execFile)(electronPath, [resolve("dist-cli/main.js"), "prepare", path, "--json"], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 }).catch((error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 7 || !("stdout" in error) || typeof error.stdout !== "string") throw error;
      return { stdout: error.stdout };
    });
    const reply: unknown = JSON.parse(result.stdout);
    await cancellation;
    expect(reply).toMatchObject({ status: "cancelled", save: "not_needed" });
    const preparedWindow = await nextWindow;
    await expect(preparedWindow.getByTestId("text-layer-1")).toBeVisible();
    expect((await PDFDocument.load(await readFile(path))).getKeywords()).toBeUndefined();
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cold desktop start completes its correlated preparation request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-cli-prepare-"));
  const path = join(directory, "external.pdf");
  const dataDir = join(directory, "data");
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheet = pdf.addPage();
  sheet.drawText("Executive Summary", { x: 60, y: 700, size: 24, font: heading });
  sheet.drawText("Administrative record keeping preserves the complete independent source material.", { x: 60, y: 660, size: 10, font: body });
  sheet.drawText("Evidence supports the current period and is available for accurate retrieval.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }, { change: "allow", access: "write", path: directory }]);
  const env = { ...process.env, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
  const preparationDir = join(dataDir, "session", "preparations");
  await mkdir(preparationDir, { recursive: true });
  const id = "12345678-1234-4234-8234-123456789012";
  await writeFile(join(preparationDir, `${id}.request.json`), JSON.stringify({ path }), { mode: 0o600 });
  let stop = (): void => undefined;
  const completion = new Promise<unknown>((resolveResult, reject) => {
    const watcher = watch(preparationDir, (_event, name) => {
      if (name !== `${id}.result.json`) return;
      void readFile(join(preparationDir, name), "utf8").then((text) => { const result: unknown = JSON.parse(text); resolveResult(result); }, reject);
    });
    const timer = setTimeout(() => reject(new Error("No cold-start preparation result")), 30_000);
    stop = () => { watcher.close(); clearTimeout(timer); };
    watcher.once("error", reject);
  });
  const { VITE_DEV_SERVER_URL: _developmentServer, ...builtEnvironment } = env;
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), `--markpdf-prepare=${id}`], env: { ...builtEnvironment, PIP_NO_INDEX: "1", UV_OFFLINE: "1" } });
  try {
    const preparedWindow = await app.firstWindow();
    expect(await completion).toMatchObject({ status: "ready", save: "saved", requestId: id });
    await expect(preparedWindow.getByTestId("text-layer-1")).toBeVisible();
    await expect(stat(join(dataDir, "markdown-engines", "docling"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await PDFDocument.load(await readFile(path))).getKeywords()).toContain("markpdf-outline:");
  } finally {
    stop();
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the desktop uses the explicitly configured agent data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-data-identity-"));
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env: { PATH: process.env.PATH ?? "", MARKPDF_DATA_DIR: directory, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" } });
  try {
    await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(directory);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)); await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent agents receive a busy result instead of opening unbounded preparations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-cli-prepare-"));
  const path = join(directory, "external.pdf");
  const dataDir = join(directory, "data");
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheet = pdf.addPage();
  sheet.drawText("Executive Summary", { x: 60, y: 700, size: 24, font: heading });
  sheet.drawText("Administrative record keeping preserves the complete independent source material.", { x: 60, y: 660, size: 10, font: body });
  sheet.drawText("Evidence supports the current period and is available for accurate retrieval.", { x: 60, y: 640, size: 10, font: body });
  await writeFile(path, await pdf.save());
  const secondPath = join(directory, "second.pdf");
  await writeFile(secondPath, await pdf.save());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }, { change: "allow", access: "write", path: directory }]);
  const env = { ...process.env, MARKPDF_TEST_USER_DATA: dataDir, MARKPDF_DATA_DIR: dataDir, MARKPDF_TEST_SINGLE_INSTANCE: "1", MARKPDF_E2E_EMBEDDER: "deterministic", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
  const app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js")], env });
  try {
    await app.firstWindow();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = async (target: string): Promise<unknown> => {
      const result = await promisify(execFile)(electronPath, [resolve("dist-cli/main.js"), "prepare", target, "--json"], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 }).catch((error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 7 || !("stdout" in error) || typeof error.stdout !== "string") throw error;
        return { stdout: error.stdout };
      });
      const value: unknown = JSON.parse(result.stdout);
      if (typeof value !== "object" || value === null || !("status" in value)) throw new Error("Expected a preparation outcome");
      return value.status;
    };
    const outcomes = await Promise.all([run(path), run(secondPath)]);
    expect(outcomes.sort()).toEqual(["needs_user_action", "ready"]);
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
