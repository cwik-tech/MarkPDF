import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ADVERSARIAL,
  buildAdversarialReplacementPair,
} from "../../cli/journeys/adversarialFixture.test-support.js";
import { EXIT_CODE } from "../../cli/exit.js";
import { OFFLINE_NODE_OPTIONS, runCli } from "../../cli/journeys/runCli.test-support.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";
import { contentHash } from "../../dist-core/hash.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntryPoint = join(repoRoot, "dist-mcp", "main.js");

let dataDir: string;
let libraryDir: string;
let fixture: string;
let indexedV1: Uint8Array;
let replacementV2: Uint8Array;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-stale-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-stale-library-")));
  fixture = join(libraryDir, "operating-plan.pdf");
  const pair = await buildAdversarialReplacementPair();
  indexedV1 = pair.v1;
  replacementV2 = pair.v2;
  writeFileSync(fixture, indexedV1);
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "markpdf-stale-document-journey", version: "0.0.0" });
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

function payloadOf(result: unknown): Record<string, unknown> {
  const content = typeof result === "object" && result !== null ? Reflect.get(result, "content") : undefined;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (typeof first !== "object" || first === null || Reflect.get(first, "type") !== "text") {
    throw new Error(`Expected one text block, got ${JSON.stringify(result)}`);
  }
  const text = Reflect.get(first, "text");
  if (typeof text !== "string") throw new Error(`Expected text content, got ${JSON.stringify(first)}`);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected an object payload, got ${text}`);
  }
  return parsed as Record<string, unknown>;
}

function documentText(payload: Record<string, unknown>): string {
  const markdown = payload.markdown;
  if (typeof markdown === "string") return markdown;
  const pages = payload.pages;
  if (!Array.isArray(pages)) throw new Error(`Expected markdown or pages, got ${JSON.stringify(payload)}`);
  return pages
    .map((page, index) => {
      const text = typeof page === "object" && page !== null ? Reflect.get(page, "markdown") : undefined;
      if (typeof text !== "string") throw new Error(`Page ${index} has no Markdown: ${JSON.stringify(page)}`);
      return text;
    })
    .join("\n");
}

function snapshotDisclosure(payload: Record<string, unknown>): { indexSnapshot: boolean; snapshotRecordedAt: string | null } {
  const indexSnapshot = payload.indexSnapshot;
  const snapshotRecordedAt = payload.snapshotRecordedAt;
  if (typeof indexSnapshot !== "boolean") {
    throw new Error(`Expected indexSnapshot boolean, got ${JSON.stringify(payload)}`);
  }
  if (snapshotRecordedAt !== null && typeof snapshotRecordedAt !== "string") {
    throw new Error(`Expected snapshotRecordedAt string or null, got ${JSON.stringify(payload)}`);
  }
  return { indexSnapshot, snapshotRecordedAt };
}

function contentHashOf(payload: Record<string, unknown>): string {
  const value = payload.contentHash;
  if (typeof value !== "string") throw new Error(`Expected contentHash string, got ${JSON.stringify(payload)}`);
  return value;
}

describe("Journey D — live filesystem bytes and indexed snapshots", () => {
  it("reads replacement bytes from disk while disclosing the older indexed snapshot until force re-index", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);
    expect(
      (
        await runCli(["index", fixture, "--json"], {
          dataDir,
          env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS },
        })
      ).code,
    ).toBe(EXIT_CODE.success);

    const v2 = replacementV2;
    const v1 = indexedV1;
    expect(v2.byteLength, "the mutation must not be detectable by file size").toBe(v1.byteLength);
    const overwrittenAt = Date.now();
    writeFileSync(fixture, v2);

    const client = await connect();
    try {
      const live = payloadOf(
        await client.callTool({ name: "to_markdown", arguments: { path: fixture, pages: "1" } }),
      );
      expect(documentText(live)).toContain(ADVERSARIAL.v2Sentinel);
      expect(documentText(live)).not.toContain(ADVERSARIAL.v1Sentinel);
      expect(contentHashOf(live)).toBe(contentHash(v2));
      expect(snapshotDisclosure(live)).toEqual({ indexSnapshot: false, snapshotRecordedAt: null });

      const stale = payloadOf(
        await client.callTool({ name: "read_pages", arguments: { path: fixture, pages: "1" } }),
      );
      expect(documentText(stale)).toContain(ADVERSARIAL.v1Sentinel);
      expect(documentText(stale)).not.toContain(ADVERSARIAL.v2Sentinel);
      expect(contentHashOf(stale)).toBe(contentHash(v1));
      const staleDisclosure = snapshotDisclosure(stale);
      expect(staleDisclosure.indexSnapshot).toBe(true);
      expect(staleDisclosure.snapshotRecordedAt).not.toBeNull();
      expect(Date.parse(staleDisclosure.snapshotRecordedAt ?? "invalid")).toBeLessThanOrEqual(overwrittenAt);

      expect(
        (
          await runCli(["index", fixture, "--force", "--json"], {
            dataDir,
            env: { NODE_OPTIONS: OFFLINE_NODE_OPTIONS },
          })
        ).code,
      ).toBe(EXIT_CODE.success);

      const refreshed = payloadOf(
        await client.callTool({ name: "read_pages", arguments: { path: fixture, pages: "1" } }),
      );
      expect(documentText(refreshed)).toContain(ADVERSARIAL.v2Sentinel);
      expect(documentText(refreshed)).not.toContain(ADVERSARIAL.v1Sentinel);
      expect(contentHashOf(refreshed)).toBe(contentHash(v2));

      const liveAfterReindex = payloadOf(
        await client.callTool({ name: "to_markdown", arguments: { path: fixture, pages: "1" } }),
      );
      expect(documentText(liveAfterReindex)).toContain(ADVERSARIAL.v2Sentinel);
      expect(snapshotDisclosure(liveAfterReindex)).toEqual({ indexSnapshot: false, snapshotRecordedAt: null });
    } finally {
      await client.close();
    }
  }, 300_000);
});
