import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { indexDocument } from "../dist-core/index/indexDocument.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../dist-core/models.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../dist-core/output/budget.js";
import { openDocumentReference, type OpenDocumentEntry, type OpenDocumentsView } from "../dist-core/session/openDocuments.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { buildReportPdf } from "../cli/journeys/fixtures.test-support.js";
import { parseToolArguments } from "./arguments.js";
import { runListOpenDocuments, runReadOpenDocument } from "./openDocumentOperations.js";
import type { ToolContext, ToolOutcome } from "./operations.js";
import { TOOLS } from "./toolSchemas.js";

/**
 * What an agent learns about the application's open documents, and what it does not.
 *
 * Two properties carry most of the weight. **No path ever leaves these tools** — an agent asked
 * what somebody is working on, not where they keep their files — and **having a document open is a
 * name, not an authority**: the snapshot is written by another process, so if open-ness granted
 * access, anything able to write that file could read anything on the disk through this server.
 */

/** Call an operation the way the server does: through the tool's own published schema. */
function validated(tool: string, args: Record<string, unknown>) {
  const schema = TOOLS.find((candidate) => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new Error(`There is no ${tool} tool.`);
  const parsed = parseToolArguments(schema, args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

const listOpen = (context: ToolContext, args: Record<string, unknown> = {}) =>
  runListOpenDocuments(context, validated("list_open_documents", args));
const readOpen = (context: ToolContext, args: Record<string, unknown> = {}) =>
  runReadOpenDocument(context, validated("read_open_document", args));

function payloadOf(outcome: ToolOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`Expected an answer, got a refusal: ${outcome.message}`);
  return outcome.payload;
}

function refusalOf(outcome: ToolOutcome): string {
  if (outcome.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(outcome.payload)}`);
  return outcome.message;
}

let dataDir: string;
let libraryDir: string;
let store: SemanticStore;
let fixture: string;
const embedder = createDeterministicEmbedder(384);
const PAGE_ONE = "Administrative preamble concerning departmental record keeping.";
const PAGE_TWO = "Revenue by Segment. Enterprise 1204 1318.";

/** Records every read, so a test can assert that a tool touched nothing on disk. */
function spyFilesystem() {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string) => {
      reads.push(path);
      return new Uint8Array(readFileSync(path));
    },
  };
}

const NOTHING_OPEN: OpenDocumentsView = { windows: 0, activeRef: null, documents: [], unreadableWindows: 0 };

function makeEntry(overrides: Partial<OpenDocumentEntry> = {}): OpenDocumentEntry {
  const tabId = overrides.tabId ?? "tab-a";
  return {
    tabId,
    kind: "pdf",
    name: "annual-report.pdf",
    path: null,
    pageCount: 2,
    contentHash: null,
    unsavedChanges: false,
    ref: openDocumentReference(4242, 1, tabId),
    window: 1,
    activeInWindow: true,
    active: true,
    ...overrides,
  };
}

/** One window, whose front tab is the first document given. */
function openWindow(...documents: OpenDocumentEntry[]): OpenDocumentsView {
  return {
    windows: 1,
    activeRef: documents.find((entry) => entry.active)?.ref ?? null,
    documents,
    unreadableWindows: 0,
  };
}

function contextWith(
  view: OpenDocumentsView,
  overrides: Partial<ToolContext> = {},
): ToolContext & { reads: string[] } {
  const filesystem = spyFilesystem();
  return {
    reads: filesystem.reads,
    store: () => store,
    embedder: () => embedder,
    allowlist: () => ({ readRoots: [], writeRoots: [] }),
    openDocuments: () => view,
    settings: defaultSemanticSearchSettings,
    readFile: filesystem.readFile,
    writeFile: async () => {},
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    scheduler: new BoundedScheduler(1),
    ...overrides,
  };
}

async function indexTheFixture(): Promise<string> {
  const bytes = new Uint8Array(readFileSync(fixture));
  const result = await indexDocument(store, embedder, {
    bytes,
    name: "annual-report.pdf",
    filePath: fixture,
    pageCount: 2,
    chunkingProfile: "balanced",
    pages: [
      { page: 1, text: PAGE_ONE, source: "pdf" },
      { page: 2, text: PAGE_TWO, source: "pdf" },
    ],
    markdownCache: {
      engineId: MARKDOWN_ENGINE_ID,
      markdownVersion: MARKDOWN_VERSION,
      textExtractionVersion: TEXT_EXTRACTION_VERSION,
      ocrExtractionVersion: OCR_EXTRACTION_VERSION,
      pages: [
        { page: 1, markdown: `# Annual Report\n\n${PAGE_ONE}` },
        { page: 2, markdown: `## Revenue by Segment\n\n${PAGE_TWO}` },
      ],
    },
  });
  if (result.status === "cancelled") throw new Error("indexing was cancelled");
  return result.contentHash;
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-open-ops-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-open-ops-lib-")));
  store = openSemanticStore({ dataDir });
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});

afterEach(() => {
  store.close();
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("saying what the application has open", () => {
  it("answers with an empty list, rather than a failure, when nothing is open", async () => {
    const payload = payloadOf(await listOpen(contextWith(NOTHING_OPEN)));

    expect(payload).toMatchObject({ windows: 0, activeRef: null, documents: [] });
  });

  it("names each open document and marks exactly one of them active", async () => {
    const view = openWindow(
      makeEntry({ tabId: "tab-a", name: "annual-report.pdf", active: true, activeInWindow: true }),
      makeEntry({ tabId: "tab-b", name: "notes.pdf", active: false, activeInWindow: false }),
    );

    const payload = payloadOf(await listOpen(contextWith(view)));
    const documents = payload.documents as Array<Record<string, unknown>>;

    expect(documents.map((entry) => entry.name)).toEqual(["annual-report.pdf", "notes.pdf"]);
    expect(documents.filter((entry) => entry.active === true)).toHaveLength(1);
    expect(payload.activeRef).toBe(documents[0]?.ref);
  });

  it("discloses no filesystem path, however the application recorded one", async () => {
    // The whole point of these tools is that a caller need not know where anything lives. Saying
    // so anyway would hand over exactly what it was spared from having to ask for.
    const view = openWindow(makeEntry({ path: "/Users/someone/Private Papers/annual-report.pdf" }));

    const payload = payloadOf(await listOpen(contextWith(view)));

    expect(JSON.stringify(payload)).not.toContain("/Users/someone");
    expect(JSON.stringify(payload)).not.toContain("Private Papers");
    expect(Object.keys((payload.documents as Array<Record<string, unknown>>)[0]!)).not.toContain("path");
  });

  it("says whether each document is in the index, checked against the index itself", async () => {
    const contentHash = await indexTheFixture();
    const view = openWindow(
      makeEntry({ tabId: "tab-a", contentHash, active: true }),
      // A hash the window recorded before somebody cleared the index. The claim is checked.
      makeEntry({ tabId: "tab-b", name: "gone.pdf", contentHash: "b".repeat(64), active: false, activeInWindow: false }),
      makeEntry({ tabId: "tab-c", name: "fresh.pdf", contentHash: null, active: false, activeInWindow: false }),
    );

    const documents = payloadOf(await listOpen(contextWith(view))).documents as Array<Record<string, unknown>>;

    expect(documents.map((entry) => entry.indexed)).toEqual([true, false, false]);
  });

  it("reports a Markdown tab rather than hiding it", async () => {
    const view = openWindow(makeEntry({ kind: "markdown", name: "notes.md", pageCount: 0 }));

    const documents = payloadOf(await listOpen(contextWith(view))).documents as Array<Record<string, unknown>>;

    expect(documents[0]).toMatchObject({ kind: "markdown", name: "notes.md" });
  });

  it("passes on the fact that a window holds unsaved changes", async () => {
    const view = openWindow(makeEntry({ unsavedChanges: true }));

    const documents = payloadOf(await listOpen(contextWith(view))).documents as Array<Record<string, unknown>>;

    expect(documents[0]?.unsavedChanges).toBe(true);
  });

  it("says how many windows could not be understood, rather than passing over them", async () => {
    const payload = payloadOf(await listOpen(contextWith({ ...NOTHING_OPEN, unreadableWindows: 2 })));

    expect(payload.unreadableWindows).toBe(2);
  });
});

describe("reading the document the application has open", () => {
  it("reads the active document when given no arguments at all", async () => {
    const contentHash = await indexTheFixture();
    const context = contextWith(openWindow(makeEntry({ contentHash })));

    const payload = payloadOf(await readOpen(context));
    const pages = payload.pages as Array<{ page: number; markdown: string }>;

    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages[1]?.markdown).toContain("Enterprise 1204 1318");
    expect(payload.name).toBe("annual-report.pdf");
  });

  it("costs no filesystem permission and opens nothing, for a document already indexed", async () => {
    // The property the access model exists for, reached through a reference instead of a path.
    const contentHash = await indexTheFixture();
    const context = contextWith(openWindow(makeEntry({ contentHash, path: fixture })));

    const payload = payloadOf(await readOpen(context));

    expect(context.reads).toEqual([]);
    expect(payload.readFromIndex).toBe(true);
  });

  it("reads the document a reference names, not the active one", async () => {
    const contentHash = await indexTheFixture();
    const wanted = makeEntry({ tabId: "tab-b", contentHash, active: false, activeInWindow: false });
    const context = contextWith(
      openWindow(makeEntry({ tabId: "tab-a", name: "other.pdf", active: true }), wanted),
    );

    const payload = payloadOf(await readOpen(context, { ref: wanted.ref }));

    expect(payload.ref).toBe(wanted.ref);
    expect((payload.pages as unknown[]).length).toBeGreaterThan(0);
  });

  it("honours a page selection", async () => {
    const contentHash = await indexTheFixture();
    const context = contextWith(openWindow(makeEntry({ contentHash })));

    const payload = payloadOf(await readOpen(context, { pages: "2" }));

    expect((payload.pages as Array<{ page: number }>).map((page) => page.page)).toEqual([2]);
  });

  it("discloses no filesystem path in what it returns", async () => {
    const contentHash = await indexTheFixture();
    const context = contextWith(openWindow(makeEntry({ contentHash, path: fixture })));

    expect(JSON.stringify(payloadOf(await readOpen(context)))).not.toContain(libraryDir);
  });

  it("says so when the application has nothing open", async () => {
    expect(refusalOf(await readOpen(contextWith(NOTHING_OPEN)))).toMatch(/no document open/i);
  });

  it("says so when a reference names a document that is no longer open", async () => {
    const context = contextWith(openWindow(makeEntry()));

    const message = refusalOf(await readOpen(context, { ref: "4242-1:tab-closed" }));

    expect(message).toContain("4242-1:tab-closed");
    expect(message).toMatch(/list_open_documents/);
  });

  it("refuses an active Markdown tab instead of quietly reading a PDF behind it", async () => {
    // The mistake worth preventing: a person looking at their notes asks about "the document I
    // have open" and is answered about a different file entirely.
    const contentHash = await indexTheFixture();
    const context = contextWith(
      openWindow(
        makeEntry({ tabId: "tab-m", kind: "markdown", name: "notes.md", pageCount: 0, active: true, activeInWindow: true }),
        makeEntry({ tabId: "tab-a", contentHash, active: false, activeInWindow: false }),
      ),
    );

    const message = refusalOf(await readOpen(context));

    expect(message).toContain("notes.md");
    expect(message).toMatch(/Markdown/);
    expect(message).not.toContain("annual-report.pdf");
  });

  it("refuses a Markdown tab named on purpose, with the same answer", async () => {
    const markdown = makeEntry({ tabId: "tab-m", kind: "markdown", name: "notes.md", active: false, activeInWindow: false });
    const context = contextWith(openWindow(makeEntry({ tabId: "tab-a", active: true }), markdown));

    expect(refusalOf(await readOpen(context, { ref: markdown.ref }))).toMatch(/Markdown/);
  });

  it("says a document that has never been saved and never been indexed has nothing to read yet", async () => {
    const context = contextWith(openWindow(makeEntry({ path: null, contentHash: null })));

    expect(refusalOf(await readOpen(context))).toMatch(/not been indexed/i);
  });

  it("refuses an unindexed document nobody granted, and does not name where it is", async () => {
    // Having a document open supplies a name, never an authority. The snapshot is written by
    // another process, so a forged one must buy nothing that a forged path would not.
    const context = contextWith(openWindow(makeEntry({ path: fixture, contentHash: null })));

    const message = refusalOf(await readOpen(context));

    expect(message).toMatch(/not permitted|permission/i);
    expect(message).not.toContain(libraryDir);
    expect(context.reads).toEqual([]);
  });

  it("refuses without naming where the document was when the read itself fails", async () => {
    // The case a granted-and-then-moved file produces: the resolver reaches the filesystem and the
    // read throws, carrying the path in its message. Left alone that exception travels out through
    // the call boundary, which answers with the message verbatim — so the one thing these tools
    // promise never to disclose arrives inside a failure instead of a success.
    const secret = "/Users/someone/Private Papers/annual-report.pdf";
    const context = contextWith(openWindow(makeEntry({ path: secret, contentHash: null })), {
      allowlist: () => ({ readRoots: ["/Users/someone/Private Papers"], writeRoots: [] }),
      // A real Node error, not a hand-written one: the path is genuinely absent, so this is the
      // exact exception — code, message and all — that a moved document produces.
      readFile: async () => new Uint8Array(await readFile(secret)),
    });

    const message = refusalOf(await readOpen(context));

    expect(message).not.toContain(secret);
    expect(message).not.toContain("/Users/someone");
    // Useful, not merely safe: which document, and the error code that says the file went away.
    expect(message).toContain("annual-report.pdf");
    expect(message).toContain("ENOENT");
  });

  it("says a listing could not be read without naming the data directory", async () => {
    // The record lives inside the application's data directory, so an error from reading it names
    // that directory. A caller is entitled to know the question could not be answered, and to
    // nothing else.
    const secret = "/Users/someone/Library/Application Support/markpdf/session/open-documents";
    const context = contextWith(NOTHING_OPEN, {
      openDocuments: () => {
        throw new Error(`EACCES: permission denied, scandir '${secret}'`);
      },
    });

    const message = refusalOf(await listOpen(context));

    expect(message).not.toContain(secret);
    expect(message).not.toContain("/Users/someone");
    expect(message).toMatch(/MarkPDF/);
  });

  it("refuses without naming the data directory when the read tool cannot reach the record", async () => {
    const secret = "/Users/someone/Library/Application Support/markpdf/session/open-documents";
    const context = contextWith(NOTHING_OPEN, {
      openDocuments: () => {
        throw new Error(`EACCES: permission denied, scandir '${secret}'`);
      },
    });

    expect(refusalOf(await readOpen(context))).not.toContain("/Users/someone");
  });

  it("reads an unindexed open document once its folder has been granted", async () => {
    const context = contextWith(openWindow(makeEntry({ path: fixture, contentHash: null })), {
      allowlist: () => ({ readRoots: [libraryDir], writeRoots: [] }),
    });

    const payload = payloadOf(await readOpen(context));

    expect(payload.readFromIndex).toBe(false);
    expect((payload.pages as unknown[]).length).toBeGreaterThan(0);
    expect(context.reads).toEqual([fixture]);
  });

  it("carries the unsaved-changes flag through, so an answer can be qualified", async () => {
    const contentHash = await indexTheFixture();
    const context = contextWith(openWindow(makeEntry({ contentHash, unsavedChanges: true })));

    expect(payloadOf(await readOpen(context)).unsavedChanges).toBe(true);
  });
});
