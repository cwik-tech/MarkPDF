import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The configuration the settings screen tells a person to paste: `markpdf mcp`. The server a
 * client reaches must be the same one the direct entry point serves, through one extra process —
 * the command line — which must keep stdout pure for the protocol and pass the index location
 * straight through.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntryPoint = join(repoRoot, "dist-cli", "main.js");

let dataDir: string;

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-cli-launch-")));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("an MCP client connected through the command line", () => {
  it("reaches the same four tools by launching `markpdf mcp`", async () => {
    const client = new Client({ name: "markpdf-cli-launch-journey", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliEntryPoint, "mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          MARKPDF_DATA_DIR: dataDir,
          MARKPDF_TEST_USER_DATA: dataDir,
        },
        stderr: "pipe",
      }),
    );
    try {
      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["outline", "read_pages", "search", "to_markdown"]);
    } finally {
      await client.close();
    }
  }, 60_000);
});
