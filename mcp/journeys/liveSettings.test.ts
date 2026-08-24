import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXIT_CODE } from "../../cli/exit.js";
import { runCli, OFFLINE_NODE_OPTIONS } from "../../cli/journeys/runCli.test-support.js";
import { buildReportPdf } from "../../cli/journeys/fixtures.test-support.js";
import { defaultSemanticSearchSettings } from "../../dist-core/ipc/settings.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";

/**
 * The settings a search runs under are the ones on disk when the call arrives.
 *
 * Journey B pins the parity claim: the command line and the MCP tool, given identical arguments
 * against one index, agree passage for passage and order for order. Journey C pins the
 * freshness claim: the application's settings rewritten while an MCP client is connected change
 * what the very next call does, on the same connection — because a session can live for hours,
 * and a person who changed the model in the application would otherwise keep getting answers
 * from the old one until they thought to restart their editor.
 *
 * Only the embedding model is substituted, through the same guarded seam every other journey
 * uses. The settings file is the application's own: `<dataDir>/config.json`, the path
 * `core/settings/appSettings.ts` names.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

const QUERY = "Enterprise 1204 1318";
const ALTERNATE_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let dataDir: string;
let libraryDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-live-settings-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-live-settings-library-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-live-settings-journey", version: "0.0.0" });
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

/** A JSON object read from the tool's reply, the way `core/store/rows.ts` reads a row. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = typeof result === "object" && result !== null ? Reflect.get(result, "content") : undefined;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (typeof first !== "object" || first === null || Reflect.get(first, "type") !== "text") {
    throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  }
  const text = Reflect.get(first, "text");
  if (typeof text !== "string") throw new Error(`Expected a text block, got ${JSON.stringify(result)}`);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected an object, got ${text}`);
  }
  return parsed as Record<string, unknown>;
}

/** One passage of a search reply, checked rather than assumed. */
interface SearchHit {
  page: number;
  id: string;
}

/**
 * The `results` of a search payload, validated entry by entry. The two surfaces name the chunk
 * differently — `id` in the command line's JSON, `chunk_id` in the tool's — so the caller says
 * which.
 */
function searchHitsOf(payload: Record<string, unknown>, idField: "id" | "chunk_id"): SearchHit[] {
  const results = payload.results;
  if (!Array.isArray(results)) throw new Error(`Expected a results array, got ${JSON.stringify(payload)}`);
  return results.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Result ${index} is not an object: ${JSON.stringify(entry)}`);
    }
    const page = Reflect.get(entry, "page");
    const id = Reflect.get(entry, idField);
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      throw new Error(`Result ${index} has no usable page: ${JSON.stringify(entry)}`);
    }
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Result ${index} has no usable ${idField}: ${JSON.stringify(entry)}`);
    }
    return { page, id };
  });
}

/** A JSON object parsed from a command's standard output, validated the same way. */
function payloadOfJson(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected an object on standard output, got ${stdout}`);
  }
  return parsed as Record<string, unknown>;
}

/** Rewrite the application's settings file the way the application would. */
function writeSettings(minSemanticScore: number, activeModelId: string): void {
  writeFileSync(
    join(dataDir, "config.json"),
    `${JSON.stringify({ semanticSearch: { ...defaultSemanticSearchSettings, minSemanticScore, activeModelId } })}\n`,
    "utf8",
  );
}

describe("Journey B — one index, two surfaces, identical arguments", () => {
  it("answers the same passages in the same order through the command line and the tool", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);
    expect((await runCli(["index", fixture, "--json"], { dataDir, env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS } })).code).toBe(
      EXIT_CODE.success,
    );

    const cli = await runCli(
      ["search", QUERY, "--path", fixture, "--min-score", "0.1", "--top-k", "12", "--json"],
      { dataDir },
    );
    expect(cli.code).toBe(EXIT_CODE.success);
    const cliResults = searchHitsOf(payloadOfJson(cli.stdout), "id");
    expect(cliResults.length).toBeGreaterThan(0);

    const client = await connect();
    try {
      const mcpResults = searchHitsOf(
        payloadOf(
          await client.callTool({
            name: "search",
            arguments: { path: fixture, query: QUERY, min_score: 0.1, top_k: 12 },
          }),
        ),
        "chunk_id",
      );

      // Passage for passage, order for order: one store, one rule, two doors.
      expect(mcpResults).toEqual(cliResults);
    } finally {
      await client.close();
    }
  }, 180_000);
});

describe("Journey C — settings rewritten mid-session", () => {
  it("takes effect on the very next call over the same connection", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);
    expect((await runCli(["index", fixture, "--json"], { dataDir, env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS } })).code).toBe(
      EXIT_CODE.success,
    );

    const client = await connect();
    try {
      const first = searchHitsOf(
        payloadOf(
          await client.callTool({
            name: "search",
            arguments: { path: fixture, query: QUERY, min_score: 0.1, top_k: 12 },
          }),
        ),
        "chunk_id",
      );
      expect(first.length).toBeGreaterThan(0);

      // The person changes the model in the application: the settings file says so, and the
      // command line — which reads its settings per run — indexes into the new scope.
      writeSettings(0.3, ALTERNATE_MODEL_ID);
      const reindexed = await runCli(["index", fixture, "--json"], {
        dataDir,
        env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS },
      });
      expect(reindexed.code).toBe(EXIT_CODE.success);

      // The same connection, the same call — answered under the new settings, not the ones the
      // session started with. Under the old ones there is nothing left to find: re-indexing
      // moved the embeddings into the new model's scope.
      const second = searchHitsOf(
        payloadOf(
          await client.callTool({
            name: "search",
            arguments: { path: fixture, query: QUERY, min_score: 0.1, top_k: 12 },
          }),
        ),
        "chunk_id",
      );
      expect(second.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 180_000);
});
