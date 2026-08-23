import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { indexDocument } from "../dist-core/index/indexDocument.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../dist-core/models.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET, outputBudget } from "../dist-core/output/budget.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { CONCURRENT_TOOL_CALLS } from "./context.js";
import { callTool } from "./server.js";
import type { ToolContext } from "./operations.js";

/**
 * How many calls this server does work for at once, and what happens to the rest.
 *
 * The SDK's protocol layer starts every request handler as soon as its frame arrives and never
 * waits for an earlier one, so nothing upstream of here limits anything. What a client sends is
 * frames; what this decides is how many of them become work.
 *
 * Every call below is gated at the one place all four tools must pass through to reach a
 * document — the read of its bytes — which is what makes "in flight" observable without a clock.
 */

let dataDir: string;
let libraryDir: string;
let store: SemanticStore;
const embedder = createDeterministicEmbedder(384);

/** Let the event loop run far enough that anything unbounded would have piled up by now. */
async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A filesystem that stops every read at a gate and then refuses.
 *
 * Refusing rather than returning a document keeps these tests about scheduling: what a tool then
 * answers is a failure either way, and the interesting number is how many of them were inside the
 * gate at once.
 */
function gatedFilesystem() {
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    started,
    peak: () => peak,
    inFlight: () => inFlight,
    release: () => release(),
    readFile: async (path: string): Promise<Uint8Array> => {
      started.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      throw new Error("this read was never going to finish");
    },
  };
}

function contextWith(scheduler: BoundedScheduler, readFile: ToolContext["readFile"]): ToolContext {
  return {
    store: () => store,
    embedder: () => embedder,
    allowlist: () => ({ readRoots: [libraryDir], writeRoots: [] }),
    openDocuments: () => ({ windows: 0, activeRef: null, documents: [], unreadableWindows: 0 }),
    settings: defaultSemanticSearchSettings,
    readFile,
    writeFile: async () => {},
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    scheduler,
  };
}

function documentAt(name: string): string {
  const path = join(libraryDir, name);
  writeFileSync(path, "not a real document, and never read as one");
  return path;
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-server-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-server-lib-")));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("how much work a client can start at once", () => {
  it("does the work of at most as many calls as the limit allows, however many arrive", async () => {
    // Six frames, two permits. Without a bound all six would be extracting documents against one
    // SQLite connection and one embedding session, and peak memory would be the client's decision
    // rather than this program's.
    const scheduler = new BoundedScheduler(2);
    const filesystem = gatedFilesystem();
    const context = contextWith(scheduler, filesystem.readFile);
    const paths = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf", "f.pdf"].map(documentAt);

    const calls = paths.map((path) => callTool(context, "to_markdown", { path }));
    await settle();

    expect(filesystem.inFlight()).toBe(2);
    expect(filesystem.started).toHaveLength(2);

    filesystem.release();
    const replies = await Promise.all(calls);

    expect(filesystem.peak()).toBe(2);
    // Every call was answered — bounded, not dropped.
    expect(replies).toHaveLength(6);
    for (const reply of replies) expect(reply.isError).toBe(true);
    expect(new Set(filesystem.started).size).toBe(6);
  }, 30_000);

  it("answers a queued call that was given up on without ever starting its work", async () => {
    // The difference between bounding concurrency and merely delaying it. A call can wait as long
    // as everything ahead of it takes, and a client that has stopped waiting must not have its
    // document opened when its turn finally comes.
    const scheduler = new BoundedScheduler(1);
    const filesystem = gatedFilesystem();
    const context = contextWith(scheduler, filesystem.readFile);
    const holding = documentAt("holding.pdf");
    const abandoned = documentAt("abandoned.pdf");

    const first = callTool(context, "to_markdown", { path: holding });
    await settle();
    expect(filesystem.started).toEqual([holding]);

    const controller = new AbortController();
    const queued = callTool(context, "to_markdown", { path: abandoned }, controller.signal);
    await settle();
    // Still waiting: nothing of its own has been opened.
    expect(filesystem.started).toEqual([holding]);

    controller.abort();
    filesystem.release();
    const [, reply] = await Promise.all([first, queued]);

    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain("cancelled");
    // The point of the whole exercise: its turn came, and its work did not happen.
    expect(filesystem.started).toEqual([holding]);
  }, 30_000);

  it("does not even take a place in the queue for a call that was cancelled before it arrived", async () => {
    const scheduler = new BoundedScheduler(1);
    const filesystem = gatedFilesystem();
    const context = contextWith(scheduler, filesystem.readFile);
    const controller = new AbortController();
    controller.abort();

    const reply = await callTool(context, "to_markdown", { path: documentAt("stale.pdf") }, controller.signal);

    expect(reply.isError).toBe(true);
    expect(scheduler.active).toBe(0);
    expect(filesystem.started).toEqual([]);
  }, 30_000);

  it("ships a finite limit, which is the whole point of having one", () => {
    expect(Number.isInteger(CONCURRENT_TOOL_CALLS)).toBe(true);
    expect(CONCURRENT_TOOL_CALLS).toBeGreaterThanOrEqual(1);
    expect(CONCURRENT_TOOL_CALLS).toBeLessThan(16);
  });
});

/**
 * Control characters, built rather than typed, so this file carries none of them.
 *
 * They are the worst case for JSON escaping: one byte of document becomes six of reply.
 */
const control = (code: number): string => String.fromCharCode(code);

/** Put a document in the index with exactly the Markdown a test wants to get back out. */
async function indexed(name: string, markdown: readonly string[]): Promise<{ path: string; hash: string }> {
  const path = join(libraryDir, name);
  writeFileSync(path, "the bytes are never read; every tool below answers from the index");
  const pages = markdown.map((text, offset) => ({ page: offset + 1, markdown: text }));
  const result = await indexDocument(store, embedder, {
    bytes: new TextEncoder().encode(name),
    name,
    filePath: path,
    pageCount: pages.length,
    chunkingProfile: "balanced",
    pages: pages.map((page) => ({ page: page.page, text: page.markdown, source: "pdf" as const })),
    markdownCache: {
      engineId: MARKDOWN_ENGINE_ID,
      markdownVersion: MARKDOWN_VERSION,
      textExtractionVersion: TEXT_EXTRACTION_VERSION,
      ocrExtractionVersion: OCR_EXTRACTION_VERSION,
      pages,
    },
  });
  if (result.status === "cancelled") throw new Error("indexing was cancelled");
  return { path, hash: result.contentHash };
}

function replyBytesOf(reply: { content: Array<{ text: string }> }): number {
  return Buffer.byteLength(reply.content.map((block) => block.text).join(""), "utf8");
}

function readingContext(): ToolContext {
  return contextWith(new BoundedScheduler(CONCURRENT_TOOL_CALLS), async () => {
    throw new Error("no tool in this group should be opening a file");
  });
}

describe("how much text one call can hand back", () => {
  it("holds the bound for a document that escapes badly", async () => {
    // Every character here costs more as JSON than it does as text: a quote and a backslash double,
    // a newline doubles, and a control character becomes six bytes. Measuring the document text
    // alone would put this reply at four to six times the number it claims.
    const nasty = `${control(0x01)}${control(0x02)}"quoted"\\backslash\ntab${control(0x07)}`.repeat(400);
    const { path } = await indexed("escaping.pdf", [nasty, nasty, nasty, nasty]);
    const context = readingContext();

    for (const call of [
      { name: "read_pages", args: { path, pages: "1-4" } },
      { name: "to_markdown", args: { path } },
      { name: "search", args: { path, query: "quoted backslash", min_score: 0 } },
      { name: "outline", args: { path } },
    ]) {
      const reply = await callTool(context, call.name, call.args);
      expect(replyBytesOf(reply)).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET);
    }
  }, 60_000);

  it("holds the bound for a document that is almost entirely headings", async () => {
    // Three words of document text per entry, and a JSON object around each one. The content
    // measure sees a few kilobytes; the reply is an order of magnitude larger.
    const headings = Array.from({ length: 4_000 }, (unused, index) => `# H${index}`).join("\n\n");
    const { path } = await indexed("headings.pdf", [headings]);
    const context = readingContext();

    const reply = await callTool(context, "outline", { path, depth: 6 });

    expect(replyBytesOf(reply)).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET);
    const payload: unknown = JSON.parse(reply.content[0]!.text);
    expect((payload as { truncated: boolean }).truncated).toBe(true);
    expect((payload as { omittedEntries: number }).omittedEntries).toBeGreaterThan(0);
  }, 60_000);

  it("holds the bound for a document of very many pages, whose numbers are metadata of their own", async () => {
    // The page numbers alone are the hazard. Listed one at a time, twelve hundred of them are
    // kilobytes of reply before a word of the document appears — and the branch that writes to a
    // file carries nothing else at all, so there is no text for a shortfall to be taken out of.
    //
    // The declared budget here is small, which is the point: the bound is whatever this server was
    // told it is, not a number that happens to be comfortable for the sizes we thought of.
    const budget = outputBudget(4_000);
    const { path } = await indexed("long.pdf", Array.from({ length: 1_200 }, (unused, index) => `Page ${index + 1}.`));
    const context: ToolContext = {
      ...contextWith(new BoundedScheduler(CONCURRENT_TOOL_CALLS), async () => {
        throw new Error("answered from the index");
      }),
      allowlist: () => ({ readRoots: [libraryDir], writeRoots: [libraryDir] }),
      replyBudget: budget,
    };

    for (const call of [
      { name: "read_pages", args: { path, pages: "1-1200" } },
      { name: "to_markdown", args: { path, pages: "1-1200" } },
      { name: "to_markdown", args: { path, pages: "1-1200", output_path: join(libraryDir, "out.md") } },
    ]) {
      const reply = await callTool(context, call.name, call.args);

      expect(reply.isError).toBeUndefined();
      expect(replyBytesOf(reply)).toBeLessThanOrEqual(budget);
    }
  }, 60_000);

  it("refuses to hand back a reply it could not fit, rather than handing back an oversized one", async () => {
    // A budget too small for even the smallest well-formed reply. Each operation fits its own
    // reply, so nothing in the four reaches this today — it is the check that stands between a
    // future branch, or a fixed part that outgrew the cap, and a caller who was promised a limit.
    const budget = outputBudget(12);
    const { path } = await indexed("tiny.pdf", ["# One\n\nA sentence."]);
    const context: ToolContext = { ...readingContext(), replyBudget: budget };

    const reply = await callTool(context, "read_pages", { path, pages: "1" });

    expect(reply.isError).toBe(true);
    expect(replyBytesOf(reply)).toBeLessThanOrEqual(budget);
  }, 60_000);

  it("holds the bound when the thing being echoed back is the client's own", async () => {
    // A refusal repeats what it was given. Every one of these is a value a client chose, and the
    // bound has to hold for the cases a client controls completely as well as the ones it does not.
    const context = readingContext();
    const enormous = "n".repeat(400_000);

    for (const reply of [
      await callTool(context, enormous, { path: "/tmp/x.pdf" }),
      await callTool(context, "outline", { path: `/${enormous}.pdf` }),
      await callTool(context, "read_pages", { path: `/${enormous}.pdf`, pages: "1" }),
      await callTool(context, "search", { path: "/tmp/x.pdf", query: enormous }),
      await callTool(context, "outline", { [enormous]: 1, path: "/tmp/x.pdf" }),
    ]) {
      expect(reply.isError).toBe(true);
      expect(replyBytesOf(reply)).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET);
    }
  }, 60_000);
  it("keeps the active document when a great many open tabs will not fit", async () => {
    // The one case where truncating a list can give a wrong answer rather than a short one: a
    // caller asking about "the document I have open" must not have that document be the entry the
    // bound removed. The list arrives active-first so that the cut can never reach it.
    const many = Array.from({ length: 500 }, (unused, index) => ({
      tabId: `tab-${index}`,
      kind: "pdf" as const,
      name: `${"long-document-name-".repeat(20)}${index}.pdf`,
      path: null,
      pageCount: 10,
      contentHash: null,
      unsavedChanges: false,
      ref: `1-1:tab-${index}`,
      window: 1,
      activeInWindow: index === 499,
      active: index === 499,
    }));
    const context: ToolContext = {
      ...readingContext(),
      openDocuments: () => ({
        windows: 1,
        activeRef: "1-1:tab-499",
        // Active first, exactly as the reader hands it over.
        documents: [many[499]!, ...many.slice(0, 499)],
        unreadableWindows: 0,
      }),
    };

    const reply = await callTool(context, "list_open_documents", {});
    const payload = JSON.parse(reply.content[0]!.text) as {
      documents: Array<{ ref: string; active: boolean }>;
      truncated: boolean;
      omittedDocuments: number;
    };

    expect(replyBytesOf(reply)).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET);
    expect(payload.truncated).toBe(true);
    expect(payload.omittedDocuments).toBeGreaterThan(0);
    expect(payload.documents[0]).toMatchObject({ ref: "1-1:tab-499", active: true });
  }, 60_000);
  it("never hands back a path when the read behind an open document throws", async () => {
    // The public contract these two tools carry: no absolute path in any reply, success or
    // failure. A thrown filesystem error is the way that promise is easiest to break, because the
    // call boundary answers an exception with its message and Node puts the path in the message.
    const secret = "/Users/someone/Private Papers/annual-report.pdf";
    const context: ToolContext = {
      ...readingContext(),
      allowlist: () => ({ readRoots: ["/Users/someone/Private Papers"], writeRoots: [] }),
      // A real Node error: the path genuinely does not exist, so this is the exception a document
      // moved out from under MarkPDF actually raises, path in the message and all.
      readFile: async () => new Uint8Array(await readFile(secret)),
      openDocuments: () => ({
        windows: 1,
        activeRef: "1-1:tab-a",
        documents: [
          {
            tabId: "tab-a",
            kind: "pdf" as const,
            name: "annual-report.pdf",
            path: secret,
            pageCount: 2,
            contentHash: null,
            unsavedChanges: false,
            ref: "1-1:tab-a",
            window: 1,
            activeInWindow: true,
            active: true,
          },
        ],
        unreadableWindows: 0,
      }),
    };

    const reply = await callTool(context, "read_open_document", {});
    const text = reply.content.map((block) => block.text).join("");

    expect(reply.isError).toBe(true);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("/Users/someone");
    // Still an answer somebody can act on: which document, and why it could not be read.
    expect(text).toContain("annual-report.pdf");
    expect(text).toContain("ENOENT");
  }, 60_000);
});
