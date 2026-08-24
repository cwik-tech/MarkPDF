import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildAdversarialPdf } from "../../cli/journeys/adversarialFixture.test-support.js";
import { EXIT_CODE } from "../../cli/exit.js";
import { runCli } from "../../cli/journeys/runCli.test-support.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

let dataDir: string;
let libraryDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-progress-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-progress-library-")));
  fixture = join(libraryDir, "scanned-operating-plan.pdf");
  writeFileSync(fixture, await buildAdversarialPdf("scanned"));
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-progress-journey", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverEntryPoint],
    env: {
      PATH: process.env.PATH ?? "",
      MARKPDF_DATA_DIR: dataDir,
    },
    stderr: "pipe",
  }));
  return client;
}

describe("Journey F — progress for a long MCP tool call", () => {
  it("reports nondecreasing OCR progress naming the page before the call resolves", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);
    const updates: Array<{ progress: number; message?: string }> = [];
    const client = await connect();
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool(
        { name: "to_markdown", arguments: { path: fixture } },
        undefined,
        {
          onprogress: (notification) => {
            updates.push({
              progress: notification.progress,
              ...(notification.message === undefined ? {} : { message: notification.message }),
            });
          },
        },
      );
    } finally {
      await client.close();
    }

    expect(result.isError).not.toBe(true);
    expect(updates.some((update) => /page\s+\d+/iu.test(update.message ?? ""))).toBe(true);
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index]?.progress).toBeGreaterThanOrEqual(updates[index - 1]?.progress ?? 0);
    }
  }, 300_000);
});
