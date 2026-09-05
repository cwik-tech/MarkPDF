import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildReportPdf, PAGE_TWO_HEADING } from "../../cli/journeys/fixtures.test-support.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";
import { writeOpenDocuments } from "../../dist-core/session/openDocuments.js";

/**
 * The MCP exit criterion: a real client, over a real stdio transport, against the real server.
 *
 * Nothing is replaced except the embedding model, and that through the same guarded seam the
 * application and the command line use. The client is the official SDK's, so what this proves is
 * that the protocol works — not that our idea of the protocol works.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

let dataDir: string;
let libraryDir: string;
let fixture: string;

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-journey", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntryPoint],
      env: {
        PATH: process.env.PATH ?? "",
        MARKPDF_DATA_DIR: dataDir,
        MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
        MARKPDF_TEST_USER_DATA: dataDir,
      },
      stderr: "pipe",
    }),
  );
  return client;
}

/** Every tool answers with one JSON document; this is the only place that shape is unpacked. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const first = content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  }
  const parsed: unknown = JSON.parse(first.text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Expected an object, got ${first.text}`);
  return { ...parsed };
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-library-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("an agent session over stdio", () => {
  it("lists exactly the six tools, with schemas a client can validate against", async () => {
    const client = await connect();
    try {
      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "list_open_documents",
        "outline",
        "read_open_document",
        "read_pages",
        "search",
        "to_markdown",
      ]);
      for (const tool of listed.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
    }
  }, 60_000);

  it("orients, searches, and reads the page that answers the question", async () => {
    // The journey the tool descriptions promise: look at the shape of a document, search it, then
    // read the page a hit points at. `--min-score` is set low because the offline embedder scores
    // on shared vocabulary alone.
    const client = await connect();
    try {
      // Granting is not an MCP tool: consent is granted out of band, with the command line.
      const { runCli } = await import("../../cli/journeys/runCli.test-support.js");
      expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(0);
      expect((await runCli(["index", fixture], { dataDir })).code).toBe(0);

      const outline = payloadOf(await client.callTool({ name: "outline", arguments: { path: fixture } }));
      expect(outline.pageCount).toBe(3);
      expect(JSON.stringify(outline.entries)).toContain(PAGE_TWO_HEADING);

      const search = payloadOf(
        await client.callTool({
          name: "search",
          arguments: { path: fixture, query: "Enterprise 1204 1318", min_score: 0.1 },
        }),
      );
      const results = search.results as Array<{ page: number; heading_path: string[]; chunk_id: string }>;
      expect(results[0]?.page).toBe(2);
      expect(results[0]?.heading_path).toContain(PAGE_TWO_HEADING);
      expect(results[0]?.chunk_id).toBeTruthy();

      const read = payloadOf(await client.callTool({ name: "read_pages", arguments: { path: fixture, pages: "2" } }));
      const pages = read.pages as Array<{ page: number; markdown: string }>;
      expect(pages.map((page) => page.page)).toEqual([2]);
      expect(pages[0]?.markdown).toContain("Enterprise");
    } finally {
      await client.close();
    }
  }, 180_000);

  it("searches the active indexed PDF by its open-document reference without disclosing its path", async () => {
    const { jsonOf, runCli } = await import("../../cli/journeys/runCli.test-support.js");
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(0);
    const indexed = await runCli(["index", fixture, "--json"], { dataDir });
    expect(indexed.code).toBe(0);
    const report = jsonOf(indexed);
    const documents =
      typeof report === "object" && report !== null && "documents" in report && Array.isArray(report.documents)
        ? report.documents
        : [];
    const first = documents[0];
    const contentHash =
      typeof first === "object" && first !== null && "contentHash" in first && typeof first.contentHash === "string"
        ? first.contentHash
        : null;
    if (contentHash === null) throw new Error("The indexed fixture did not return a content hash.");

    writeOpenDocuments(dataDir, {
      version: 2,
      pid: process.pid,
      windowId: 7,
      focusedAt: 1,
      writtenAt: "2026-09-05T12:00:00.000Z",
      activeTabId: "tab-report",
      documents: [
        {
          tabId: "tab-report",
          kind: "pdf",
          name: "annual-report.pdf",
          path: fixture,
          pageCount: 3,
          currentPage: 1,
          contentHash,
          hasContentSnapshot: false,
          contentChars: 0,
          contentBytes: 0,
          snapshotTruncated: false,
          unsavedChanges: false,
        },
      ],
    });

    const client = await connect();
    try {
      const listed = payloadOf(await client.callTool({ name: "list_open_documents", arguments: {} }));
      expect(JSON.stringify(listed)).not.toContain(libraryDir);

      const searched = payloadOf(
        await client.callTool({
          name: "search",
          arguments: { ref: "active", query: "Enterprise 1204 1318", min_score: 0.1 },
        }),
      );
      const results = searched.results as Array<{ page: number }>;
      expect(results[0]?.page).toBe(2);
      expect(searched.contentHash).toBe(contentHash);
      expect(JSON.stringify(searched)).not.toContain(libraryDir);

      const read = payloadOf(
        await client.callTool({ name: "read_pages", arguments: { id: contentHash, pages: "2" } }),
      );
      const pages = read.pages as Array<{ page: number; markdown: string }>;
      expect(pages.map((page) => page.page)).toEqual([2]);
      expect(pages[0]?.markdown).toContain("Enterprise");
      expect(JSON.stringify(read)).not.toContain(libraryDir);
    } finally {
      await client.close();
    }
  }, 180_000);

  it("refuses a document nobody granted, and says how to grant it", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: "to_markdown", arguments: { path: fixture } });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("--allow-read");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("answers about an indexed document with no filesystem permission at all", async () => {
    // The property the access model exists for: indexing was the consent event, and the grant that
    // allowed it has since been withdrawn.
    const { runCli } = await import("../../cli/journeys/runCli.test-support.js");
    await runCli(["--allow-read", libraryDir], { dataDir });
    await runCli(["index", fixture], { dataDir });
    await runCli(["--revoke-read", libraryDir], { dataDir });

    const client = await connect();
    try {
      const read = payloadOf(await client.callTool({ name: "read_pages", arguments: { path: fixture, pages: "1" } }));
      expect((read.pages as Array<{ page: number }>).map((page) => page.page)).toEqual([1]);

      const search = payloadOf(
        await client.callTool({ name: "search", arguments: { path: fixture, query: "Enterprise", min_score: 0.05 } }),
      );
      expect((search.results as unknown[]).length).toBeGreaterThan(0);

      // And the filesystem tool is still refused, because withdrawing consent withdrew it.
      const denied = await client.callTool({ name: "to_markdown", arguments: { path: fixture } });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 180_000);
});
