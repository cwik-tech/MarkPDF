import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { indexDocument } from "../dist-core/index/indexDocument.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../dist-core/output/budget.js";
import { openDocumentReference, type OpenDocumentEntry, type OpenDocumentsView } from "../dist-core/session/openDocuments.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { buildReviewedContract, REVIEWER } from "../core/annotations/reviewedContract.test-support.js";
import { parseToolArguments } from "./arguments.js";
import { runReadComments } from "./commentOperations.js";
import type { ToolContext, ToolOutcome } from "./operations.js";
import { TOOLS } from "./toolSchemas.js";

/**
 * Reading comments is reading the file. The index holds the text of a document, not its
 * annotations, so there is no route to them that does not open the file — and therefore no route
 * that does not need a read grant, whether the document is indexed, open, or named by its hash.
 */

let dataDir: string;
let libraryDir: string;
let store: SemanticStore;
let fixture: string;
const embedder = createDeterministicEmbedder(384);

function validated(args: Record<string, unknown>) {
  const schema = TOOLS.find((tool) => tool.name === "read_comments")?.inputSchema;
  if (schema === undefined) throw new Error("There is no read_comments tool.");
  const parsed = parseToolArguments(schema, args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function contextWith(overrides: Partial<ToolContext> = {}): ToolContext & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    store: () => store,
    embedder: () => embedder,
    allowlist: () => ({ readRoots: [], writeRoots: [] }),
    openDocuments: (): OpenDocumentsView => ({ windows: 0, activeRef: null, documents: [], unreadableWindows: 0 }),
    readOpenDocumentContent: () => null,
    settings: () => defaultSemanticSearchSettings,
    readFile: async (path: string) => {
      reads.push(path);
      return new Uint8Array(readFileSync(path));
    },
    writeFile: async () => {},
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    scheduler: new BoundedScheduler(1),
    ...overrides,
  };
}

function refusalOf(outcome: ToolOutcome): string {
  if (outcome.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(outcome.payload)}`);
  return outcome.message;
}

function payloadOf(outcome: ToolOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`Expected an answer, got: ${outcome.message}`);
  return outcome.payload;
}

function openEntry(path: string, overrides: Partial<OpenDocumentEntry> = {}): OpenDocumentEntry {
  return {
    tabId: "tab-a",
    kind: "pdf",
    name: "contract.pdf",
    path,
    pageCount: 1,
    currentPage: 1,
    contentHash: null,
    hasContentSnapshot: false,
    contentChars: 0,
    contentBytes: 0,
    snapshotTruncated: false,
    unsavedChanges: true,
    ref: openDocumentReference(process.pid, 1, "tab-a"),
    window: 1,
    process: process.pid,
    activeInWindow: true,
    active: true,
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-comment-ops-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-comment-ops-lib-")));
  store = openSemanticStore({ dataDir });
  fixture = join(libraryDir, "contract.pdf");
  writeFileSync(fixture, await buildReviewedContract());
});

afterEach(() => {
  store.close();
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("read_comments", () => {
  it("needs a read grant also for an indexed document, and reads nothing without one", async () => {
    const bytes = new Uint8Array(readFileSync(fixture));
    const indexed = await indexDocument(store, embedder, {
      bytes,
      name: "contract.pdf",
      filePath: fixture,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: "Termination requires thirty days notice", source: "pdf" }],
    });
    if (indexed.status === "cancelled") throw new Error("indexing was cancelled");
    const context = contextWith();

    const message = refusalOf(await runReadComments(context, validated({ id: indexed.contentHash })));
    expect(message).toContain("--allow-read");
    expect(context.reads).toEqual([]);
  });

  it("reads the file of an open document within the grants, and says that the tab has unsaved changes", async () => {
    const entry = openEntry(fixture);
    const context = contextWith({
      allowlist: () => ({ readRoots: [libraryDir], writeRoots: [] }),
      openDocuments: () => ({ windows: 1, activeRef: entry.ref, documents: [entry], unreadableWindows: 0 }),
    });

    const payload = payloadOf(await runReadComments(context, validated({ ref: "active" })));
    expect(payload).toMatchObject({ name: "contract.pdf", unsavedChanges: true, totalComments: 3 });
    expect(JSON.stringify(payload)).toContain(REVIEWER);
    expect(JSON.stringify(payload)).not.toContain(libraryDir);
  });

  it("refuses a page selection it cannot read", async () => {
    const context = contextWith({ allowlist: () => ({ readRoots: [libraryDir], writeRoots: [] }) });
    expect(refusalOf(await runReadComments(context, validated({ path: fixture, pages: "3-1" })))).toContain("--pages");
  });
});
