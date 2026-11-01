import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { updateAllowlist } from "../../dist-core/consent/allowlistFile.js";

/**
 * An agent proposes, the person decides, and only what the person accepted reaches the file.
 *
 * The suggestions live in the open tab, not in the document. They look like an agent's work on the
 * page and in the comments pane, they never change the file while they wait, and after the person
 * accepts one and saves, the saved annotation says an AI agent wrote it — to MarkPDF on the next
 * open and to any other reader through the annotation's author.
 *
 * Electron, because every part of this is something only the running window shows: the pins, the
 * pane, the accept and reject controls, the prompts, and the file a save writes.
 */

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");
const AGENT = "markpdf-suggest-journey";
const LINES = {
  termination: "Termination requires thirty days notice",
  payment: "Payment is due within sixty days",
  notices: "Notices go to the registered address",
} as const;

async function buildContract(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(LINES.termination, { x: 72, y: 700, size: 12, font });
  page.drawText(LINES.payment, { x: 72, y: 650, size: 12, font });
  page.drawText(LINES.notices, { x: 72, y: 600, size: 12, font });
  await writeFile(path, await pdf.save());
}

interface Fixture {
  directory: string;
  dataDir: string;
  contract: string;
  env: Record<string, string>;
}

async function makeFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-suggest-"));
  const dataDir = join(directory, "data");
  const contract = join(directory, "contract.pdf");
  await buildContract(contract);
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }]);
  return {
    directory,
    dataDir,
    contract,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? directory,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MARKPDF_TEST_USER_DATA: dataDir,
      MARKPDF_DATA_DIR: dataDir,
      MARKPDF_TEST_SINGLE_INSTANCE: "1",
      MARKPDF_E2E_EMBEDDER: "deterministic",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  };
}

type Agent = { close: () => Promise<void>; callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> };

async function connectAgent(fixture: Fixture): Promise<Agent> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: AGENT, version: "1" });
  await client.connect(new StdioClientTransport({ command: electronPath, args: [resolve("dist-mcp/main.js")], env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" } }));
  return client;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = Reflect.get(Object(result), "content");
  const text = Array.isArray(content) ? Reflect.get(Object(content[0]), "text") : undefined;
  if (typeof text !== "string") throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  if (Reflect.get(Object(result), "isError") === true) throw new Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}

async function suggest(agent: Agent, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return payloadOf(await agent.callTool({ name: "suggest_annotation", arguments: { ref: "active", page: 1, ...args } }));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Wait until the window has told other processes which documents it has open. */
async function waitUntilListed(agent: Agent, count = 1): Promise<void> {
  await expect
    .poll(async () => {
      const listed = payloadOf(await agent.callTool({ name: "list_open_documents", arguments: {} }));
      return Array.isArray(listed.documents) ? listed.documents.length : 0;
    }, { timeout: 15_000 })
    .toBe(count);
}

async function unsaved(agent: Agent): Promise<unknown> {
  const listed = payloadOf(await agent.callTool({ name: "list_open_documents", arguments: {} }));
  return Array.isArray(listed.documents) ? listed.documents.map((entry: unknown) => Reflect.get(Object(entry), "unsavedChanges")) : null;
}

/** The annotations MarkPDF wrote into a saved file, as another reader would find them. */
async function markpdfAnnotations(path: string): Promise<Array<{ author: string; subject: string; contents: string }>> {
  const pdf = await PDFDocument.load(await readFile(path));
  const found: Array<{ author: string; subject: string; contents: string }> = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
      const dict = annots?.lookupMaybe(index, PDFDict);
      const text = (key: string) => dict?.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText() ?? "";
      if (text("NM").startsWith("markpdf:")) found.push({ author: text("T"), subject: text("Subj"), contents: text("Contents") });
    }
  }
  return found;
}

async function openPane(window: Page): Promise<void> {
  const pane = window.getByRole("heading", { name: "Comments" });
  if ((await pane.count()) === 0) await window.getByRole("button", { name: /^Comments/ }).click();
  await expect(pane).toBeVisible();
}

async function reopen(app: ElectronApplication, window: Page, path: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, file) => {
    electronApp.emit("open-file", { preventDefault() {} }, file);
  }, path);
  await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (app === null) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

const suggestionPins = (window: Page) => window.getByRole("button", { name: `Suggestion by AI agent ${AGENT}, not accepted` });
const suggestionCard = (window: Page, note: string) => window.getByRole("group", { name: new RegExp(`Suggestion by AI agent ${AGENT} on page 1: ${note}`) });

test("a person accepts one agent suggestion and rejects another, and only the accepted one reaches the file, marked as the agent's", async () => {
  test.setTimeout(180_000);
  const fixture = await makeFixture();
  const before = await sha256(fixture.contract);
  let app: ElectronApplication | null = null;
  let agent: Agent | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    window.on("dialog", (dialog) => void dialog.accept());
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    agent = await connectAgent(fixture);
    await waitUntilListed(agent);
    await expect.poll(async () => await unsaved(agent as Agent)).toEqual([false]);

    // The agent proposes three annotations.
    expect(await suggest(agent, { quote: LINES.termination, note: "Ask for 60 days." })).toMatchObject({ status: "added" });
    expect(await suggest(agent, { quote: LINES.payment, note: "Fine as written." })).toMatchObject({ status: "added" });
    expect(await suggest(agent, { quote: LINES.notices, note: "Check the address." })).toMatchObject({ status: "added" });

    // They are on the page and in the pane as an agent's proposals, and nothing changed yet.
    await expect(suggestionPins(window)).toHaveCount(3);
    await openPane(window);
    await expect(window.getByText("Suggested by agents (3)")).toBeVisible();
    expect(await sha256(fixture.contract)).toBe(before);
    expect(await unsaved(agent)).toEqual([false]);

    // The person accepts one, rejects one, and leaves one pending.
    await suggestionCard(window, "Ask for 60 days.").getByRole("button", { name: "Accept" }).click();
    await suggestionCard(window, "Fine as written.").getByRole("button", { name: "Reject" }).click();
    await expect(window.getByText("Suggested by agents (1)")).toBeVisible();
    await expect(window.getByRole("button", { name: `Comment on page 1 by AI agent ${AGENT}: Ask for 60 days.` })).toBeVisible();
    await expect.poll(async () => await unsaved(agent as Agent)).toEqual([true]);

    // The save writes exactly the accepted one, as the agent's.
    await window.getByTitle("Save", { exact: true }).click();
    await expect.poll(async () => await unsaved(agent as Agent), { timeout: 30_000 }).toEqual([false]);
    expect(await markpdfAnnotations(fixture.contract)).toEqual([
      { author: `${AGENT} (AI agent)`, subject: "AI agent comment", contents: "Ask for 60 days." },
    ]);
    await expect(window.getByText("Suggested by agents (1)")).toBeVisible();

    // Closed (discarding the one still pending) and opened again, it is still the agent's.
    await window.getByTitle("Close contract.pdf", { exact: true }).click();
    await expect(window.getByTestId("text-layer-1")).toHaveCount(0);
    await reopen(app, window, fixture.contract);
    await expect(window.getByRole("button", { name: `Comment by AI agent ${AGENT}` })).toBeVisible();
    await expect(suggestionPins(window)).toHaveCount(0);
    await openPane(window);
    await expect(window.getByText(`AI agent · ${AGENT}`)).toBeVisible();

    // An agent that reads the comments learns that an agent wrote it.
    await waitUntilListed(agent);
    const read = payloadOf(await agent.callTool({ name: "read_comments", arguments: { ref: "active" } }));
    expect(read.comments).toEqual([
      expect.objectContaining({ origin: "agent_via_markpdf", author: AGENT, note: "Ask for 60 days.", quote: LINES.termination }),
    ]);
  } finally {
    await agent?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("an accepted agent highlight keeps its agent label after save and reload", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;
  let agent: Agent | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    window.on("dialog", (dialog) => void dialog.accept());
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    agent = await connectAgent(fixture);
    await waitUntilListed(agent);

    expect(await suggest(agent, { quote: LINES.payment })).toMatchObject({ status: "added" });
    await openPane(window);
    await window.getByRole("group", { name: new RegExp(`Suggestion by AI agent ${AGENT} on page 1`) }).getByRole("button", { name: "Accept" }).click();
    await window.getByTitle("Save", { exact: true }).click();
    await expect.poll(async () => (await markpdfAnnotations(fixture.contract)).map((entry) => entry.subject), { timeout: 30_000 }).toEqual(["AI agent highlight"]);

    await window.getByTitle("Close contract.pdf", { exact: true }).click();
    await reopen(app, window, fixture.contract);
    await expect(window.getByRole("button", { name: `Highlight by AI agent ${AGENT}` })).toBeVisible();
    await openPane(window);
    await expect(window.getByRole("button", { name: new RegExp(`Highlight on page 1 by AI agent ${AGENT}: ${LINES.payment}`) })).toBeVisible();
  } finally {
    await agent?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a flattened export of agent annotations asks first", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  const before = await sha256(fixture.contract);
  let app: ElectronApplication | null = null;
  let agent: Agent | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    agent = await connectAgent(fixture);
    await waitUntilListed(agent);
    expect(await suggest(agent, { quote: LINES.termination, note: "Ask for 60 days." })).toMatchObject({ status: "added" });
    await openPane(window);
    await suggestionCard(window, "Ask for 60 days.").getByRole("button", { name: "Accept" }).click();

    const question = window.waitForEvent("dialog");
    await window.getByTitle("Save options").click();
    // The click does not finish until the question is answered, so it is not awaited first.
    const exporting = window.getByRole("button", { name: "Export flattened PDF" }).click();
    const dialog = await question;
    expect(dialog.message()).toContain("will not record that an AI agent wrote 1 of its annotations");
    await dialog.dismiss();
    await exporting;
    expect(await sha256(fixture.contract)).toBe(before);
  } finally {
    await agent?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a page change ends pending suggestions", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;
  let agent: Agent | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    agent = await connectAgent(fixture);
    await waitUntilListed(agent);
    expect(await suggest(agent, { quote: LINES.termination, note: "One." })).toMatchObject({ status: "added" });
    expect(await suggest(agent, { quote: LINES.payment, note: "Two." })).toMatchObject({ status: "added" });
    await expect(suggestionPins(window)).toHaveCount(2);

    await window.getByRole("button", { name: "Pages", exact: true }).click();
    await window.getByTitle("Insert blank page after current page").click();
    await expect(suggestionPins(window)).toHaveCount(0);
    await expect(window.getByTestId("agent-toast")).toContainText("2 agent suggestions were discarded");
    // The window writes its record a moment after a change, so the agent's view is polled.
    await expect
      .poll(async () => {
        const read = payloadOf(await (agent as Agent).callTool({ name: "read_comments", arguments: { ref: "active" } }));
        return (read.suggestions as Array<{ status: string }>).map((entry) => entry.status);
      })
      .toEqual(["discarded", "discarded"]);
  } finally {
    await agent?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("closing a tab asks before it discards pending suggestions, and the file is unchanged", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  const before = await sha256(fixture.contract);
  let app: ElectronApplication | null = null;
  let agent: Agent | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    agent = await connectAgent(fixture);
    await waitUntilListed(agent);
    expect(await suggest(agent, { quote: LINES.notices, note: "Check the address." })).toMatchObject({ status: "added" });

    // Cancelled: the tab stays, with its suggestion. A click that asks a question does not finish
    // until it is answered, so it is not awaited first.
    let question = window.waitForEvent("dialog");
    let closing = window.getByTitle("Close contract.pdf", { exact: true }).click();
    let dialog = await question;
    expect(dialog.message()).toContain("discard 1 agent suggestion");
    await dialog.dismiss();
    await closing;
    await expect(suggestionPins(window)).toHaveCount(1);

    // Confirmed: the tab closes, and nothing about the file changed.
    question = window.waitForEvent("dialog");
    closing = window.getByTitle("Close contract.pdf", { exact: true }).click();
    dialog = await question;
    await dialog.accept();
    await closing;
    await expect(window.getByTestId("text-layer-1")).toHaveCount(0);
    await reopen(app, window, fixture.contract);
    await expect(suggestionPins(window)).toHaveCount(0);
    expect(await sha256(fixture.contract)).toBe(before);
  } finally {
    await agent?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
