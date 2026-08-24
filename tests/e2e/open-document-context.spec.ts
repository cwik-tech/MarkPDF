import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAdversarialPdf } from "../../cli/journeys/adversarialFixture.test-support.js";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntryPoint = path.join(projectRoot, "dist-mcp", "main.js");
const MARKDOWN_SENTINEL = "ADVERSARIAL.markdownTabSentinel-5817";

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} was not an object: ${JSON.stringify(value)}`);
  }
  return { ...value };
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} was not text.`);
  return value;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${what} was not an integer.`);
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${what} was not a boolean.`);
  return value;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const envelope = record(result, "tool result");
  const content = envelope.content;
  if (!Array.isArray(content)) throw new Error("tool result content was not a list.");
  const first = record(content[0], "first tool result item");
  const body = text(first.text, "tool result text");
  if (envelope.isError === true) throw new Error(`The tool refused instead of answering: ${body}`);
  return record(JSON.parse(body), "tool payload");
}

function documentsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(payload.documents)) throw new Error("documents was not a list.");
  return payload.documents.map((entry, index) => record(entry, `document ${index}`));
}

async function connectAgent(dataDir: string): Promise<Client> {
  const client = new Client({ name: "markpdf-open-context-journey", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntryPoint],
      env: {
        PATH: process.env.PATH ?? "",
        MARKPDF_DATA_DIR: dataDir,
        MARKPDF_TEST_USER_DATA: dataDir,
      },
      stderr: "pipe",
    }),
  );
  return client;
}

async function closeBounded(app: ElectronApplication | null): Promise<void> {
  if (app === null) return;
  const child = app.process();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("graceful close timed out")), 15_000);
      }),
    ]);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("an agent sees the current PDF page and reads saved or unsaved open notes without a path", async () => {
  test.setTimeout(240_000);

  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-open-context-"));
  const libraryDir = path.join(tempDir, "private-library");
  const userDataPath = path.join(tempDir, "user-data");
  const pdfPath = path.join(libraryDir, "mixed.pdf");
  const notesPath = path.join(libraryDir, "meeting-notes.md");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(pdfPath, await buildAdversarialPdf("mixed"));
  await writeFile(notesPath, `# Meeting notes\n\n${MARKDOWN_SENTINEL}\n`);

  let app: ElectronApplication | null = null;
  let client: Client | null = null;
  let stage = "launching MarkPDF";

  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(projectRoot, "dist-electron/bootstrap.js"), pdfPath, notesPath],
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

    stage = "editing the Markdown tab without saving";
    const editor = window.getByRole("textbox", { name: "Edit meeting-notes.md" });
    await expect(editor).toHaveValue(new RegExp(MARKDOWN_SENTINEL));
    await editor.fill(`# Meeting notes\n\n${MARKDOWN_SENTINEL}\n\nunsaved observation`);

    stage = "navigating the PDF to page ten and leaving it active";
    await window.getByRole("button", { name: /mixed\.pdf/ }).click();
    const pageBox = window.locator(".page-box input");
    await pageBox.fill("10");
    await pageBox.press("Enter");
    await expect(pageBox).toHaveValue("10");

    stage = "asking MCP for the live tab context";
    client = await connectAgent(userDataPath);
    let listed: Record<string, unknown> = {};
    await expect
      .poll(async () => {
        listed = payloadOf(await client!.callTool({ name: "list_open_documents", arguments: {} }));
        const documents = documentsOf(listed);
        const pdf = documents.find((entry) => entry.name === "mixed.pdf");
        const notes = documents.find((entry) => entry.name === "meeting-notes.md");
        return {
          page: pdf === undefined ? null : integer(pdf.currentPage, "PDF currentPage"),
          dirty: notes === undefined ? null : flag(notes.unsavedChanges, "notes unsavedChanges"),
          chars: notes === undefined ? 0 : integer(notes.contentChars, "notes contentChars"),
        };
      }, { timeout: 30_000 })
      .toEqual({ page: 10, dirty: true, chars: 74 });

    const documents = documentsOf(listed);
    const notes = documents.find((entry) => entry.name === "meeting-notes.md");
    if (notes === undefined) throw new Error("The Markdown tab was not listed.");
    const notesRef = text(notes.ref, "notes ref");

    stage = "reading the unsaved Markdown buffer";
    const unsaved = payloadOf(
      await client.callTool({ name: "read_open_document", arguments: { ref: notesRef } }),
    );
    expect(text(unsaved.text, "unsaved Markdown text")).toContain(MARKDOWN_SENTINEL);
    expect(flag(unsaved.unsavedChanges, "unsaved reply flag")).toBe(true);
    expect(JSON.stringify(unsaved)).not.toContain(libraryDir);
    expect(JSON.stringify(listed)).not.toContain(libraryDir);

    stage = "saving the Markdown tab";
    await window.getByRole("button", { name: /meeting-notes\.md/ }).click();
    await window.getByRole("button", { name: "Save", exact: true }).click();

    stage = "reading the same open buffer after save";
    await expect
      .poll(async () => {
        const afterSave = payloadOf(
          await client!.callTool({ name: "read_open_document", arguments: { ref: notesRef } }),
        );
        return {
          dirty: flag(afterSave.unsavedChanges, "saved reply flag"),
          hasSentinel: text(afterSave.text, "saved Markdown text").includes(MARKDOWN_SENTINEL),
          leaksPath: JSON.stringify(afterSave).includes(libraryDir),
        };
      }, { timeout: 30_000 })
      .toEqual({ dirty: false, hasSentinel: true, leaksPath: false });
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message}\n--- failed during: ${stage} ---`;
    throw error;
  } finally {
    await client?.close().catch(() => {});
    await closeBounded(app);
    await rm(tempDir, { recursive: true, force: true });
  }
});
