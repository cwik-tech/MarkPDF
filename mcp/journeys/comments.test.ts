import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";
import { writeOpenDocuments } from "../../dist-core/session/openDocuments.js";
import { runCli } from "../../cli/journeys/runCli.test-support.js";
import {
  buildReviewedContract,
  MARKPDF_NOTE,
  REVIEWER,
  REVIEWER_NOTE,
  TEXT_LINES,
} from "../../core/annotations/reviewedContract.test-support.js";

/**
 * An agent reads who said what, and where, without the window.
 *
 * The capability the person asked for: the comments and highlights of a document as data — the
 * author, the page, the words that were marked and the note. The fixture carries the three kinds a
 * real contract arrives with: a reviewer's highlight with a note, the same reviewer's highlight
 * with no note at all, and a comment the person made in MarkPDF and saved. Every expected value is
 * written in the fixture module, not copied back from what the reader produced.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

let dataDir: string;
let libraryDir: string;
let fixture: string;

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-comments-journey", version: "0.0.0" });
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

function textOf(result: unknown): string {
  const content = typeof result === "object" && result !== null ? Reflect.get(result, "content") : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = typeof first === "object" && first !== null ? Reflect.get(first, "text") : undefined;
  if (typeof text !== "string") throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  return text;
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && Reflect.get(result, "isError") === true;
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-comments-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-comments-library-")));
  fixture = join(libraryDir, "contract.pdf");
  writeFileSync(fixture, await buildReviewedContract());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("an agent reads the comments of a document", () => {
  it("reads each comment and highlight with its author, page, quote and note", async () => {
    // Consent is granted out of band, by a person, with the command line.
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(0);
    const client = await connect();
    try {
      const result = await client.callTool({ name: "read_comments", arguments: { path: fixture } });
      expect(isError(result)).toBe(false);
      const payload: unknown = JSON.parse(textOf(result));

      expect(payload).toMatchObject({
        totalComments: 3,
        truncated: false,
        nextOffset: null,
        comments: [
          {
            page: 1,
            type: "highlight",
            origin: "other_application",
            author: REVIEWER,
            note: REVIEWER_NOTE,
            quote: TEXT_LINES.termination,
          },
          {
            page: 1,
            type: "highlight",
            origin: "other_application",
            author: REVIEWER,
            note: null,
            quote: TEXT_LINES.payment,
          },
          {
            page: 1,
            type: "comment",
            origin: "person_in_markpdf",
            author: null,
            note: MARKPDF_NOTE,
            quote: TEXT_LINES.notices,
          },
        ],
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  it("refuses an open document it may not read, without naming where the file is", async () => {
    writeOpenDocuments(dataDir, {
      version: 2,
      pid: process.pid,
      windowId: 3,
      focusedAt: 1,
      writtenAt: "2026-10-31T12:00:00.000Z",
      activeTabId: "tab-contract",
      documents: [
        {
          tabId: "tab-contract",
          kind: "pdf",
          name: "contract.pdf",
          path: fixture,
          pageCount: 1,
          currentPage: 1,
          contentHash: null,
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
      const result = await client.callTool({ name: "read_comments", arguments: { ref: "active" } });
      expect(isError(result)).toBe(true);
      const message = textOf(result);
      expect(message).toContain("contract.pdf");
      expect(message).toContain("markpdf --allow-read");
      expect(message).not.toContain(libraryDir);
    } finally {
      await client.close();
    }
  }, 60_000);
});
