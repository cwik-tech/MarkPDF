import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { updateAllowlist } from "../../dist-core/consent/allowlistFile.js";
import { makeEvidenceLink, readOrCreateLinkKey } from "../../dist-core/agent/evidenceLink.js";
import { contentHash } from "../../dist-core/hash.js";

/**
 * A citation in an agent's answer that opens the cited passage when the person clicks it.
 *
 * Three promises. A link MarkPDF made opens the passage, whether the document is open or not. A
 * link MarkPDF did not make does nothing. And a link inside a document — a PDF link annotation or a
 * Markdown link — never reaches the desktop as a reveal at all.
 *
 * The operating system's delivery of the address is the one seam replaced: the journey emits
 * `open-url` in the main process, or passes the address on the command line for a cold start.
 */

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");
const QUOTE = "Termination requires thirty days written notice";

async function buildContract(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const topic of ["definitions", "payment", "termination"]) {
    pdf.addPage([612, 792]).drawText(`This page is about ${topic} and nothing else.`, { x: 72, y: 680, size: 12, font });
  }
  pdf.getPage(2).drawText(`${QUOTE} to the other party.`, { x: 72, y: 400, size: 12, font });
  return await pdf.save();
}

interface Fixture {
  directory: string;
  dataDir: string;
  contract: string;
  env: Record<string, string>;
}

async function makeFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "markpdf-link-"));
  const dataDir = join(directory, "data");
  const contract = join(directory, "contract.pdf");
  await writeFile(contract, await buildContract());
  updateAllowlist(dataDir, [{ change: "allow", access: "read", path: directory }]);
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

/** Index the contract through the command line, as an agent's preparation would. */
async function indexWithCli(fixture: Fixture): Promise<void> {
  await promisify(execFile)(electronPath, [resolve("dist-cli/main.js"), "index", fixture.contract, "--no-input"], {
    env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 60_000,
  });
}

async function linkFor(fixture: Fixture, quote = QUOTE): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const made = makeEvidenceLink(readOrCreateLinkKey(fixture.dataDir), {
    contentHash: contentHash(new Uint8Array(await readFile(fixture.contract))),
    page: 3,
    quote,
  });
  if (!made.ok) throw new Error(made.reason);
  return made.link;
}

async function deliver(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, address) => {
    electronApp.emit("open-url", { preventDefault() {} }, address);
  }, url);
}

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

test("a citation link from an agent opens the cited passage, open or not", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  await indexWithCli(fixture);
  let app: ElectronApplication | null = null;
  let client: { close: () => Promise<void>; callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> } | null = null;

  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });

    // The agent asks for a link instead of showing the passage now.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const connected = new Client({ name: "markpdf-link-journey", version: "1" });
    await connected.connect(new StdioClientTransport({ command: electronPath, args: [resolve("dist-mcp/main.js")], env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" } }));
    client = connected;
    const result = await connected.callTool({ name: "reveal", arguments: { path: fixture.contract, page: 3, quote: QUOTE, mode: "link" } });
    const text = String(Reflect.get(Object(Reflect.get(Object(result), "content"))[0] ?? {}, "text"));
    const reply = JSON.parse(text) as { link?: string; status?: string };
    expect(reply.status).toBe("link");
    const link = reply.link ?? "";
    expect(link.startsWith("markpdf://reveal?")).toBe(true);
    expect(link).not.toContain(fixture.directory);
    // A link request changes nothing on the screen.
    expect(await pageIsInView(window, 3)).toBe(false);

    // The person clicks it while the document is open.
    await deliver(app, link);
    await expect.poll(async () => await pageIsInView(window, 3)).toBe(true);
    await expect(window.getByTestId("evidence-mark").first()).toBeVisible();
    await expect(window.getByTestId("agent-toast")).toContainText("Shown by AI agent, page 3");

    // And again after the tab is closed: the link names the document, and it opens again.
    await window.getByTitle("Close contract.pdf", { exact: true }).click();
    await expect(window.getByTestId("text-layer-1")).toHaveCount(0);
    await deliver(app, link);
    await expect.poll(async () => await pageIsInView(window, 3), { timeout: 30_000 }).toBe(true);
    await expect(window.getByTestId("evidence-mark").first()).toBeVisible();
  } finally {
    await client?.close().catch(() => undefined);
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a link that MarkPDF did not make, and a link inside a document, do nothing", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  await indexWithCli(fixture);
  const link = await linkFor(fixture);
  const forged = new URL(link);
  forged.searchParams.set("q", "Termination requires no notice");

  // A PDF whose link annotation points at a valid evidence link, and a Markdown note with the same.
  const linking = await PDFDocument.create();
  const font = await linking.embedFont(StandardFonts.Helvetica);
  const page = linking.addPage([612, 792]);
  page.drawText("Click here to see the evidence", { x: 72, y: 700, size: 14, font });
  const annotation = linking.context.register(
    linking.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [70, 696, 320, 716],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(link) },
    }),
  );
  page.node.set(PDFName.of("Annots"), linking.context.obj([annotation]));
  const linkingPdf = join(fixture.directory, "linking.pdf");
  await writeFile(linkingPdf, await linking.save());
  const note = join(fixture.directory, "note.md");
  await writeFile(note, `# Evidence\n\n[Show the clause](${link})\n`);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), fixture.contract], env: fixture.env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    // Record every address handed to the operating system from here on.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      Reflect.set(globalThis, "openedAddresses", opened);
      shell.openExternal = async (address: string) => {
        opened.push(address);
      };
    });

    // A forged link: refused, said so, and the view stays where it was.
    await deliver(app, forged.href);
    await expect(window.getByTestId("agent-toast")).toContainText("MarkPDF ignored a link that it did not make.");
    expect(await pageIsInView(window, 3)).toBe(false);
    await expect(window.getByTestId("evidence-mark")).toHaveCount(0);

    // A link annotation in a PDF is not even drawn as a link.
    await app.evaluate(({ app: electronApp }, path) => {
      electronApp.emit("open-file", { preventDefault() {} }, path);
    }, linkingPdf);
    await expect(window.getByTitle("Close linking.pdf", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("button", { name: /markpdf:/ })).toHaveCount(0);

    // A Markdown link to it opens nothing and shows nothing.
    await app.evaluate(({ app: electronApp }, path) => {
      electronApp.emit("open-file", { preventDefault() {} }, path);
    }, note);
    const markdownLink = window.getByRole("link", { name: "Show the clause" });
    await expect(markdownLink).toBeVisible({ timeout: 30_000 });
    await markdownLink.click();
    await window.waitForTimeout(1_000);
    const opened = await app.evaluate(() => Reflect.get(globalThis, "openedAddresses") as string[]);
    expect(opened.filter((address) => address.startsWith("markpdf:"))).toEqual([]);
    await expect(window.getByTestId("evidence-mark")).toHaveCount(0);
    await expect(window.getByTestId("agent-toast")).not.toContainText("Shown by AI agent");
  } finally {
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a cold start from a link opens a valid one and nothing for a forged one", async () => {
  test.setTimeout(150_000);
  const fixture = await makeFixture();
  await indexWithCli(fixture);
  const link = await linkFor(fixture);
  const forged = new URL(link);
  forged.searchParams.set("page", "2");

  // A forged link starts MarkPDF, which then leaves without opening a window.
  const process = spawn(electronPath, [resolve("dist-electron/bootstrap.js"), forged.href], { env: fixture.env, stdio: "ignore" });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("MarkPDF did not exit for a forged link")), 30_000);
    process.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  expect(exitCode).toBe(0);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve("dist-electron/bootstrap.js"), link], env: fixture.env });
    const window = await app.firstWindow();
    await expect.poll(async () => await pageIsInView(window, 3), { timeout: 30_000 }).toBe(true);
    await expect(window.getByTestId("evidence-mark").first()).toBeVisible();
  } finally {
    await closeApp(app);
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
