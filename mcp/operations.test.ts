import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import { indexDocument } from "../dist-core/index/indexDocument.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { readSemanticSettings } from "../dist-core/settings/appSettings.js";
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

/** One search hit from a tool payload, checked rather than assumed. */
interface CheckedSearchHit {
  page: number;
  heading_path: string[];
  headings: Array<{ title: string; page: number | null }>;
  heading_inherited: boolean;
}

/** The `results` of a search payload, validated entry by entry. */
function searchHitsOf(payload: Record<string, unknown>): CheckedSearchHit[] {
  const results = payload.results;
  if (!Array.isArray(results)) throw new Error(`Expected a results array, got ${JSON.stringify(payload)}`);
  return results.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Result ${index} is not an object: ${JSON.stringify(entry)}`);
    }
    const page = Reflect.get(entry, "page");
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      throw new Error(`Result ${index} has no usable page: ${JSON.stringify(entry)}`);
    }
    const headingPath = Reflect.get(entry, "heading_path");
    if (!Array.isArray(headingPath) || !headingPath.every((title) => typeof title === "string")) {
      throw new Error(`Result ${index} has no usable heading_path: ${JSON.stringify(entry)}`);
    }
    const headings = Reflect.get(entry, "headings");
    if (!Array.isArray(headings)) {
      throw new Error(`Result ${index} has no usable headings: ${JSON.stringify(entry)}`);
    }
    const checkedHeadings = headings.map((heading, headingIndex) => {
      if (typeof heading !== "object" || heading === null || Array.isArray(heading)) {
        throw new Error(`Result ${index} heading ${headingIndex} is not an object: ${JSON.stringify(heading)}`);
      }
      const title = Reflect.get(heading, "title");
      const headingPage = Reflect.get(heading, "page");
      if (typeof title !== "string" || title.length === 0) {
        throw new Error(`Result ${index} heading ${headingIndex} has no title: ${JSON.stringify(heading)}`);
      }
      if (headingPage !== null && (typeof headingPage !== "number" || !Number.isInteger(headingPage) || headingPage < 1)) {
        throw new Error(`Result ${index} heading ${headingIndex} has no usable page: ${JSON.stringify(heading)}`);
      }
      return { title, page: headingPage };
    });
    const inherited = Reflect.get(entry, "heading_inherited");
    if (typeof inherited !== "boolean") {
      throw new Error(`Result ${index} has no usable heading_inherited: ${JSON.stringify(entry)}`);
    }
    return { page, heading_path: headingPath.map((title) => String(title)), headings: checkedHeadings, heading_inherited: inherited };
  });
}

function contextWith(overrides: Partial<ToolContext> = {}): ToolContext & { reads: string[] } {
  const filesystem = spyFilesystem();
  const written: Array<{ path: string; text: string }> = [];
  return {
    reads: filesystem.reads,
    store: () => store,
    // The fixture is indexed with the default model; any other id gets its own deterministic
    // embedder, the way the server would build one.
    embedder: (modelId: string) => (modelId === embedder.modelId ? embedder : createDeterministicEmbedder(384, modelId)),
    allowlist: () => ({ readRoots: [], writeRoots: [] }),
    openDocuments: () => ({ windows: 0, activeRef: null, documents: [], unreadableWindows: 0 }),
    // Read from disk per call, like the server: a test that rewrites the settings file sees
    // the rewrite on the next operation.
    settings: () => readSemanticSettings(dataDir),
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
    // Nothing was missing from this document, and the reply says so rather than staying silent —
    // an agent that cannot tell "no gaps" from "gaps not reported" has to assume the worse one.
    expect(outcome.payload.unresolvedPages).toEqual([]);
  }, 60_000);

  it("names the pages of an indexed document that nothing managed to read", async () => {
    // This tool never opens a file, so it cannot repair a gap. What it can do is refuse to present
    // one as a blank page — otherwise an agent reads an empty string and reports the page as empty.
    const hash = await indexTheFixture();
    const document = store.getDocument(hash);
    expect(document).not.toBeNull();
    if (document === null) return;
    // Rewrite the cache as a build that could not read page 2 would have left it.
    const cached = store.getMarkdown(document.id, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION);
    expect(cached).not.toBeNull();
    if (cached === null) return;
    store.putMarkdown(document.id, {
      engineId: MARKDOWN_ENGINE_ID,
      markdownVersion: MARKDOWN_VERSION,
      pages: cached.pages.map((page) => (page.page === 2 ? { page: 2, markdown: "" } : page)),
      pageProvenance: cached.pages.map((page) => ({
        page: page.page,
        status: page.page === 2 ? ("unresolved" as const) : ("read" as const),
      })),
    });

    const context = contextWith();
    const outcome = await runReadPages(context, { path: fixture, pages: "2" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.payload.unresolvedPages).toEqual([2]);
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

describe("where a search hit's headings come from", () => {
  /** Indexes a document whose heading closes page 1 while the answer text opens page 2. */
  async function indexInheritedHeadingDocument(): Promise<void> {
    // The page text is what chunking sees, so the heading markup must live there — the cache
    // only records it for later readers.
    const pageOne = `# Annual Report\n\n${PAGE_ONE}\n\n## Revenue by Segment`;
    const bytes = new Uint8Array(readFileSync(fixture));
    const result = await indexDocument(store, embedder, {
      bytes,
      name: "annual-report.pdf",
      filePath: fixture,
      pageCount: 2,
      chunkingProfile: "balanced",
      pages: [
        { page: 1, text: pageOne, source: "pdf" },
        { page: 2, text: PAGE_TWO, source: "pdf" },
      ],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: [
          { page: 1, markdown: pageOne },
          { page: 2, markdown: PAGE_TWO },
        ],
      },
    });
    if (result.status === "cancelled") throw new Error("indexing was cancelled");
  }

  it("keeps heading_path and adds each heading's page, flagging the inherited ones", async () => {
    await indexInheritedHeadingDocument();
    const context = contextWith();

    const outcome = await runSearch(context, { path: fixture, query: "Enterprise 1204", min_score: 0.05 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const results = searchHitsOf(outcome.payload);
    const hit = results.find((entry) => entry.page === 2);
    expect(hit).toBeDefined();
    // The breadcrumb stays exactly as it was...
    expect(hit?.heading_path).toContain("Revenue by Segment");
    // ...and the provenance says the heading came from the previous page.
    expect(hit?.headings).toContainEqual({ title: "Revenue by Segment", page: 1 });
    expect(hit?.heading_inherited).toBe(true);
  }, 60_000);

  it("reports a heading the passage's own page carries as not inherited", async () => {
    // The heading opens page 2, the same page as the answer text.
    const pageTwo = `## Revenue by Segment\n\n${PAGE_TWO}`;
    const bytes = new Uint8Array(readFileSync(fixture));
    const indexed = await indexDocument(store, embedder, {
      bytes,
      name: "annual-report.pdf",
      filePath: fixture,
      pageCount: 2,
      chunkingProfile: "balanced",
      pages: [
        { page: 1, text: PAGE_ONE, source: "pdf" },
        { page: 2, text: pageTwo, source: "pdf" },
      ],
      markdownCache: {
        engineId: MARKDOWN_ENGINE_ID,
        markdownVersion: MARKDOWN_VERSION,
        textExtractionVersion: TEXT_EXTRACTION_VERSION,
        ocrExtractionVersion: OCR_EXTRACTION_VERSION,
        pages: [
          { page: 1, markdown: PAGE_ONE },
          { page: 2, markdown: pageTwo },
        ],
      },
    });
    if (indexed.status === "cancelled") throw new Error("indexing was cancelled");
    const context = contextWith();

    const outcome = await runSearch(context, { path: fixture, query: "Enterprise 1204", min_score: 0.05 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const results = searchHitsOf(outcome.payload);
    const hit = results.find((entry) => entry.page === 2);
    expect(hit?.headings).toContainEqual({ title: "Revenue by Segment", page: 2 });
    expect(hit?.heading_inherited).toBe(false);
  }, 60_000);
});

describe("search under the settings the application is using", () => {
  it("falls back to the settings' threshold when the call names none, and to the argument when it does", async () => {
    await indexTheFixture();
    // A threshold high enough that nothing in this fixture clears it.
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ semanticSearch: { ...defaultSemanticSearchSettings, minSemanticScore: 0.95 } })}\n`,
      "utf8",
    );
    const context = contextWith();

    const blocked = await runSearch(context, { path: fixture, query: "Enterprise 1204" });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(searchHitsOf(blocked.payload)).toEqual([]);

    // An explicit argument outranks the setting — otherwise the setting could not be overridden.
    const allowed = await runSearch(context, { path: fixture, query: "Enterprise 1204", min_score: 0.05 });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(searchHitsOf(allowed.payload).length).toBeGreaterThan(0);
  }, 60_000);

  it("reads the settings exactly once for one call, and every consumer of the call sees that read", async () => {
    await indexTheFixture();
    let reads = 0;
    const context = contextWith({
      settings: () => {
        reads += 1;
        return { ...defaultSemanticSearchSettings, minSemanticScore: 0.05 };
      },
    });

    const outcome = await runSearch(context, { path: fixture, query: "Enterprise 1204" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // One call, one read: the profile and the threshold the search ran under cannot disagree
    // about which settings they came from.
    expect(reads).toBe(1);
    expect(searchHitsOf(outcome.payload).length).toBeGreaterThan(0);
  }, 60_000);
});
