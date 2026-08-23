import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReportPdf } from "../../cli/journeys/fixtures.test-support.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";

/**
 * stdout belongs to the protocol.
 *
 * A single stray byte on that stream breaks the frame a client is parsing, and the failure is a
 * dead session rather than a bad answer. So this drives the server with a raw pipe instead of the
 * SDK's client, and looks at what actually came out.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

let dataDir: string;
let libraryDir: string;
let fixture: string;

interface Session {
  stdout: string;
  stderr: string;
}

/** Send these JSON-RPC frames, then close stdin and collect both streams verbatim. */
async function converse(frames: readonly unknown[]): Promise<Session> {
  return await new Promise<Session>((resolve, reject) => {
    const child = spawn(process.execPath, [serverEntryPoint], {
      env: {
        PATH: process.env.PATH ?? "",
        MARKPDF_DATA_DIR: dataDir,
        MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
        MARKPDF_TEST_USER_DATA: dataDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    child.stdin.end();
  });
}

const initialise = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-purity-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-purity-lib-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});
afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("what comes out of stdout", () => {
  it("is JSON-RPC and nothing else, line by line", async () => {
    const session = await converse([
      initialise,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "outline", arguments: { path: fixture } } },
    ]);

    const lines = session.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const frame: unknown = JSON.parse(line);
      expect(typeof frame).toBe("object");
      expect((frame as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }
  }, 60_000);

  it("keeps the server's own remarks on the other stream", async () => {
    // The banner says which index is in use, which is worth saying — and would be a protocol
    // violation on the stream the client is parsing.
    const session = await converse([initialise]);

    expect(session.stderr).toContain(dataDir);
    expect(session.stdout).not.toContain(dataDir);
  }, 60_000);

  it("puts a refused tool call in the protocol rather than on the error stream", async () => {
    // A refusal is an answer. Writing it to stderr would leave the client waiting for a reply it
    // was never going to get.
    const session = await converse([
      initialise,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "to_markdown", arguments: { path: fixture } } },
    ]);

    const replies = session.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: { isError?: boolean; content?: unknown } });
    const refusal = replies.find((reply) => reply.id === 2);

    expect(refusal?.result?.isError).toBe(true);
    expect(JSON.stringify(refusal?.result?.content)).toContain("--allow-read");
  }, 60_000);

  it("says nothing at all on stdout for a request it cannot even parse", async () => {
    const session = await converse([initialise, "this is not a frame"]);

    for (const line of session.stdout.split("\n").filter((line) => line.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 60_000);
});
