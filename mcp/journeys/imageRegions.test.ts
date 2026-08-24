import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVERSARIAL, buildAdversarialPdf } from "../../cli/journeys/adversarialFixture.test-support.js";
import { runCli, OFFLINE_NODE_OPTIONS } from "../../cli/journeys/runCli.test-support.js";
import { EXIT_CODE } from "../../cli/exit.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";

/**
 * Journey I: a figure that exists only inside a picture on an ordinary text page is retrievable,
 * and no ordinary text page was rasterised to find it.
 *
 * The document is indexed through the real command line with the network blocked; the search is
 * asked through a real MCP client over stdio. What records which pages ever rendered is the
 * guarded recording seam in the rasteriser, enabled for this run alone. Only the embedding model
 * is substituted, through the same guarded seam every other journey uses.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

const RECORD_TOKEN = "record";

let dataDir: string;
let libraryDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-image-regions-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-image-regions-library-")));
  fixture = join(libraryDir, "operating-plan.pdf");
  writeFileSync(fixture, await buildAdversarialPdf("mixed"));
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-image-regions-journey", version: "0.0.0" });
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
function searchHitsOf(payload: Record<string, unknown>): Array<{ page: number; snippet: string }> {
  const results = payload.results;
  if (!Array.isArray(results)) throw new Error(`Expected a results array, got ${JSON.stringify(payload)}`);
  return results.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Result ${index} is not an object: ${JSON.stringify(entry)}`);
    }
    const page = Reflect.get(entry, "page");
    const snippet = Reflect.get(entry, "snippet");
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      throw new Error(`Result ${index} has no usable page: ${JSON.stringify(entry)}`);
    }
    if (typeof snippet !== "string") {
      throw new Error(`Result ${index} has no usable snippet: ${JSON.stringify(entry)}`);
    }
    return { page, snippet };
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

/** The index report's per-document status, checked rather than assumed. */
function indexedStatusOf(payload: Record<string, unknown>): string {
  const documents = payload.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error(`Expected a non-empty documents array, got ${JSON.stringify(payload)}`);
  }
  const first = documents[0];
  const status = typeof first === "object" && first !== null ? Reflect.get(first, "status") : undefined;
  if (typeof status !== "string") throw new Error(`First document has no usable status: ${JSON.stringify(first)}`);
  return status;
}

/** Which pages the recording seam says were ever rendered, ascending. */
function rasterisedPages(): number[] {
  const raw = JSON.parse(readFileSync(join(dataDir, "rasterised-pages.json"), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("The rasterisation record is not a list.");
  return raw
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
    .sort((a, b) => a - b);
}

describe("Journey I — a figure inside a picture on a text page", () => {
  it("retrieves the pictured figure and rasterises nothing it did not have to", async () => {
    // Arrange: grant, then index with the recording seam armed for this run alone.
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);
    const indexed = await runCli(["index", fixture, "--json"], {
      dataDir,
      env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS, MARKPDF_E2E_RASTERISATION_RECORD: RECORD_TOKEN },
    });
    expect(indexed.code).toBe(EXIT_CODE.success);
    expect(indexedStatusOf(payloadOfJson(indexed.stdout))).toBe("ready");

    // Assert, retrieval half: the number that exists nowhere as text — only inside the picture
    // on page 4 — is found there, and on no other page.
    const client = await connect();
    try {
      const results = searchHitsOf(
        payloadOf(
          await client.callTool({
            name: "search",
            arguments: { path: fixture, query: ADVERSARIAL.page4.label, min_score: 0.1 },
          }),
        ),
      );
      const answerHits = results.filter(
        (hit) => hit.page === ADVERSARIAL.figurePage && hit.snippet.includes(ADVERSARIAL.page4.value2028),
      );
      expect(answerHits.length, "a passage on the figure's page carries the pictured number").toBeGreaterThan(0);
      expect(
        answerHits.every((hit) => hit.snippet.includes(ADVERSARIAL.page4.label)),
        "the passage that carries the number also names the row",
      ).toBe(true);
      expect(
        results.every((hit) => hit.page === ADVERSARIAL.figurePage || !hit.snippet.includes(ADVERSARIAL.page4.value2028)),
        "no passage on any other page carries the pictured number",
      ).toBe(true);
    } finally {
      await client.close();
    }

    // Assert, cost half: rendered pages are exactly the two whole-page scans, the blank page the
    // extractor cannot account for, and the region crop on page 4 — never the small logo on
    // page 2 and never any text-only page. (Pages 10 and 12 are flagged `needsOcr` by the
    // extractor and page 13 is blank; page 4 is the one region page.)
    const rendered = rasterisedPages();
    expect(rendered).toEqual([4, ADVERSARIAL.imageOnlyPage, ADVERSARIAL.chartPage, ADVERSARIAL.blankPage]);
    expect(rendered).not.toContain(ADVERSARIAL.logoPage);
    for (const textOnly of [1, 3, 5, 6, 7, 8, 9, 11]) {
      expect(rendered, `text-only page ${textOnly}`).not.toContain(textOnly);
    }
  }, 300_000);
});
