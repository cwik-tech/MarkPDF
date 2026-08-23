import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { indexDocument } from "../dist-core/index/indexDocument.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION, OCR_EXTRACTION_VERSION, TEXT_EXTRACTION_VERSION } from "../dist-core/models.js";
import { outputBudget, DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../dist-core/output/budget.js";
import { buildReportPdf } from "../cli/journeys/fixtures.test-support.js";
import { parseToolArguments } from "./arguments.js";
import { TOOLS } from "./toolSchemas.js";
import {
  runOutline as outlineOperation,
  runReadPages as readPagesOperation,
  runSearch as searchOperation,
  runToMarkdown as toMarkdownOperation,
  type ToolContext,
} from "./operations.js";

/**
 * What the four tools do, against a real index and the real extractor.
 *
 * The properties under test are the ones the access model exists for: which tools reach the
 * filesystem and which do not, what a withdrawn grant refuses, and that nothing a document
 * contains reaches a caller unbounded.
 */

/**
 * Call an operation the way the server calls it: through the tool's own schema.
 *
 * Defaults reach an operation from the command table by way of that schema, so calling one with
 * raw arguments would leave them out — and a test that filled them in itself would be asserting
 * against numbers the product does not use.
 */
function validated(tool: string, args: Record<string, unknown>) {
  const schema = TOOLS.find((candidate) => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new Error(`There is no ${tool} tool.`);
  const parsed = parseToolArguments(schema, args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

const runOutline = (context: ToolContext, args: Record<string, unknown>) =>
  outlineOperation(context, validated("outline", args));
const runSearch = (context: ToolContext, args: Record<string, unknown>) =>
  searchOperation(context, validated("search", args));
const runReadPages = (context: ToolContext, args: Record<string, unknown>) =>
  readPagesOperation(context, validated("read_pages", args));
const runToMarkdown = (context: ToolContext, args: Record<string, unknown>) =>
  toMarkdownOperation(context, validated("to_markdown", args));

let dataDir: string;
let libraryDir: string;
let store: SemanticStore;
let fixture: string;
const embedder = createDeterministicEmbedder(384);
const PAGE_ONE = "Administrative preamble concerning departmental record keeping.";
const PAGE_TWO = "Revenue by Segment. Enterprise 1204 1318.";

/** Records every read, so a test can assert that a tool touched nothing. */
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

function contextWith(overrides: Partial<ToolContext> = {}): ToolContext & { reads: string[] } {
  const filesystem = spyFilesystem();
  const written: Array<{ path: string; text: string }> = [];
  return {
    reads: filesystem.reads,
    store: () => store,
    embedder: () => embedder,
    allowlist: () => ({ readRoots: [], writeRoots: [] }),
    settings: defaultSemanticSearchSettings,
    readFile: filesystem.readFile,
    writeFile: async (path, text) => {
      written.push({ path, text });
      writeFileSync(path, text, "utf8");
    },
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    // These call the operations directly; the scheduler is a call-boundary concern, tested there.
    scheduler: new BoundedScheduler(1),
    ...overrides,
  };
}

const granted = () => ({ readRoots: [libraryDir], writeRoots: [] });

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
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-ops-data-")));
  // Realpathed: allowlist roots are canonical boundaries, and an unresolved one matches nothing.
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-ops-lib-")));
  store = openSemanticStore({ dataDir });
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});
afterEach(() => {
  store.close();
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("tools that read the index only", () => {
  it("reads pages of an indexed document with nothing granted and nothing opened", async () => {
    await indexTheFixture();
    const context = contextWith();

    const outcome = await runReadPages(context, { path: fixture, pages: "2" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.payload.pages as Array<{ page: number }>).map((page) => page.page)).toEqual([2]);
    expect(context.reads).toEqual([]);
  }, 60_000);

  it("searches an indexed document with nothing granted and nothing opened", async () => {
    await indexTheFixture();
    const context = contextWith();

    const outcome = await runSearch(context, { path: fixture, query: "Enterprise 1204", min_score: 0.05 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.payload.results as unknown[]).length).toBeGreaterThan(0);
    expect(context.reads).toEqual([]);
  }, 60_000);

  it("says a document is not indexed rather than reaching for it, even when it is granted", async () => {
    // `search` is classed as reading the index. Falling back to hashing the file would make the
    // highest-traffic tool need a permission the whole design says it does not.
    const context = contextWith({ allowlist: granted });

    const outcome = await runSearch(context, { path: fixture, query: "anything" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("not in the index");
    expect(context.reads).toEqual([]);
  });
});

describe("a tool classed as reading the file", () => {
  it("is refused once the grant is withdrawn, although the index still holds the text", async () => {
    // Serving `to_markdown` from a cached copy after consent was withdrawn would make the
    // withdrawal decorative.
    await indexTheFixture();
    const context = contextWith();

    const outcome = await runToMarkdown(context, { path: fixture });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("--allow-read");
    expect(context.reads).toEqual([]);
  }, 60_000);

  it("answers from the index once the grant is in place, rather than re-reading", async () => {
    await indexTheFixture();
    const context = contextWith({ allowlist: granted });

    const outcome = await runToMarkdown(context, { path: fixture });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.markdown).toContain("Revenue by Segment");
    expect(context.reads).toEqual([]);
  }, 60_000);

  it("needs a separate grant to write, and says so", async () => {
    await indexTheFixture();
    const context = contextWith({ allowlist: granted });

    const outcome = await runToMarkdown(context, { path: fixture, output_path: join(libraryDir, "out.md") });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("--allow-write");
  }, 60_000);

  it("writes the whole document when writing is granted, unbounded, because a file is not the wire", async () => {
    await indexTheFixture();
    const out = join(libraryDir, "out.md");
    const context = contextWith({ allowlist: () => ({ readRoots: [libraryDir], writeRoots: [libraryDir] }) });

    const outcome = await runToMarkdown(context, { path: fixture, output_path: out });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.outputPath).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("Revenue by Segment");
  }, 60_000);
});

describe("nothing a document contains reaches a caller unbounded", () => {
  it("bounds the outline's headings and says how much it left out", async () => {
    await indexTheFixture();
    const context = contextWith({ budget: outputBudget(6) });

    const outcome = await runOutline(context, { path: fixture });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.truncated).toBe(true);
    expect(outcome.payload.omittedBytes).toBeGreaterThan(0);
    expect(outcome.payload.totalBytes).toBeGreaterThan(0);
  }, 60_000);

  it("bounds a search's snippets and the headings above them together", async () => {
    // Both came from the document. Measuring only the snippet would let a deep heading path carry
    // an arbitrary amount of document text past the budget.
    await indexTheFixture();
    const context = contextWith({ budget: outputBudget(10) });

    const outcome = await runSearch(context, { path: fixture, query: "Enterprise Revenue Administrative", min_score: 0.01 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.totalBytes).toBeGreaterThan(0);
    expect(typeof outcome.payload.omittedBytes).toBe("number");
  }, 60_000);

  it("bounds a conversion and reports the shortfall", async () => {
    await indexTheFixture();
    const context = contextWith({ allowlist: granted, budget: outputBudget(20) });

    const outcome = await runToMarkdown(context, { path: fixture });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.truncated).toBe(true);
    expect(Buffer.byteLength(String(outcome.payload.markdown), "utf8")).toBeLessThanOrEqual(20);
    expect(outcome.payload.omittedBytes).toBeGreaterThan(0);
  }, 60_000);

  it("bounds the pages it returns", async () => {
    await indexTheFixture();
    const context = contextWith({ budget: outputBudget(12) });

    const outcome = await runReadPages(context, { path: fixture, pages: "1,2" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.truncated).toBe(true);
    expect(outcome.payload.omittedBytes).toBeGreaterThan(0);
  }, 60_000);
  it("accounts for every byte when the reply has room for none of the document", async () => {
    // Two cuts, so two shortfalls, and adding them wrongly is easy: the empty case reports what it
    // was handed rather than what the document held, or the whole document would be counted twice.
    // Both bounds have to bite for the sum to be testable at all: with only one of them cutting,
    // the right answer and the double-counted one are the same number.
    await indexTheFixture();
    const context = contextWith({ allowlist: granted, budget: outputBudget(30), replyBudget: outputBudget(150) });

    const outcome = await runToMarkdown(context, { path: fixture });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.markdown).toBe("");
    expect(outcome.payload.truncated).toBe(true);
    expect(outcome.payload.totalBytes).toBeGreaterThan(30);
    expect(outcome.payload.omittedBytes).toBe(outcome.payload.totalBytes);
  }, 60_000);
});

describe("a document with no text layer", () => {
  it("is given the same recognition the command line gives it", async () => {
    // Without the capability wired through, an unindexed scan answers with blank pages — the one
    // failure that looks exactly like a correct answer.
    let asked: readonly number[] = [];
    const context = contextWith({
      allowlist: granted,
      resolveOcr: async (request) => {
        asked = request.pages;
        return request.pages.map((page) => ({ page, text: `recognised page ${page}` }));
      },
    });
    const { buildScannedPdf } = await import("../cli/journeys/fixtures.test-support.js");
    const scan = join(libraryDir, "scan.pdf");
    writeFileSync(scan, await buildScannedPdf());

    const outcome = await runToMarkdown(context, { path: scan });

    expect(asked).toEqual([1]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.markdown).toContain("recognised page 1");
  }, 120_000);
});

describe("naming a document by its content hash", () => {
  it("works for every tool, because every tool's schema says it does", async () => {
    const hash = await indexTheFixture();
    const context = contextWith({ allowlist: granted });

    expect((await runOutline(context, { id: hash })).ok).toBe(true);
    expect((await runSearch(context, { id: hash, query: "Enterprise", min_score: 0.01 })).ok).toBe(true);
    expect((await runReadPages(context, { id: hash, pages: "1" })).ok).toBe(true);
    expect((await runToMarkdown(context, { id: hash })).ok).toBe(true);
  }, 120_000);

  it("still proves read permission for the filesystem-classed tool, using the path it was indexed from", async () => {
    // A hash is not a way around a grant. The document's recorded path is what consent is checked
    // against, so withdrawing the folder refuses the hash too.
    const hash = await indexTheFixture();
    const context = contextWith();

    const outcome = await runToMarkdown(context, { id: hash });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("--allow-read");
  }, 60_000);

  it("says plainly when a document was indexed with no path to check", async () => {
    const bytes = new TextEncoder().encode("indexed from bytes alone");
    const indexed = await indexDocument(store, embedder, {
      bytes,
      name: "pasted.pdf",
      filePath: null,
      pageCount: 1,
      chunkingProfile: "balanced",
      pages: [{ page: 1, text: "Some text that arrived without a file.", source: "pdf" }],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: [{ page: 1, markdown: "Some text that arrived without a file." }],
      },
    });
    if (indexed.status === "cancelled") throw new Error("indexing was cancelled");
    const context = contextWith({ allowlist: granted });

    const outcome = await runToMarkdown(context, { id: indexed.contentHash });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("indexed without a path on disk");
    // And the index-only tools are unaffected: they never needed a path.
    expect((await runReadPages(context, { id: indexed.contentHash, pages: "1" })).ok).toBe(true);
  }, 60_000);
});

describe("asking for pages a document does not have", () => {
  it("says which ones, rather than quietly returning fewer", async () => {
    await indexTheFixture();
    const context = contextWith();

    const outcome = await runReadPages(context, { path: fixture, pages: "9" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("page 9");
  }, 60_000);
});
