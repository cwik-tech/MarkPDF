import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { indexDocument } from "./indexDocument.js";
import { clearSemanticIndex } from "./clearIndex.js";
import { JobRegistry } from "./jobRegistry.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { deferred } from "./deferred.test-support.js";
import type { Embedder } from "./embeddings.js";

let dataDir: string;
let store: SemanticStore;
let registry: JobRegistry;

const PAGES = [
  { page: 1, text: "Introduction and preamble concerning administrative matters of record", source: "pdf" as const },
  { page: 2, text: "The escape velocity of Deimos is five point six metres per second", source: "pdf" as const },
];

function input(signal: AbortSignal) {
  return {
    bytes: new TextEncoder().encode("one shared document"),
    name: "shared.pdf",
    filePath: null,
    pages: PAGES,
    pageCount: 2,
    chunkingProfile: "balanced" as const,
    signal,
    force: true,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-clear-"));
  store = openSemanticStore({ dataDir });
  registry = new JobRegistry();
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("clearing the index while jobs are running", () => {
  it("leaves nothing behind when a queued job is cancelled mid-clear", async () => {
    // The gap: a second job for the same document waits in the per-content queue. Cancelling
    // marks it, the clear empties the store, and only then does the queued callback start —
    // writing its document row into the database the user just emptied, because the row is
    // written before the first cancellation check.
    const inner = createDeterministicEmbedder(384);
    const firstEmbedStarted = deferred();
    const releaseFirstEmbed = deferred();
    let calls = 0;

    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        calls += 1;
        if (calls === 1) {
          firstEmbedStarted.resolve();
          await releaseFirstEmbed.promise;
        }
        return inner.embed(text, mode);
      },
    };

    const runJob = (jobId: string) => {
      const token = registry.start(jobId);
      return indexDocument(store, gated, input(token.signal)).finally(() => {
        registry.finish(token);
      });
    };

    const first = runJob("tab-1");
    await firstEmbedStarted.promise;
    const second = runJob("tab-2"); // queued behind the first, same content hash

    // The clear cancels everything, waits for it to actually stop, then empties the store.
    const clearing = clearSemanticIndex(store, registry);
    releaseFirstEmbed.resolve();
    await clearing;
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Both jobs must have been told to stop. Waiting for them to finish on their own would
    // also empty the store in the end, but it would let a long index hold the clear open and
    // keep writing throughout — so the cancel is load-bearing, not just the wait.
    expect(firstResult.status).toBe("cancelled");
    expect(secondResult.status).toBe("cancelled");

    const info = store.info();
    expect(info.documentCount).toBe(0);
    expect(info.chunkCount).toBe(0);
    expect(info.embeddingCount).toBe(0);
  });

  it("refuses a job that starts while a clear is draining, rather than letting it write first", async () => {
    const inner = createDeterministicEmbedder(384);
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await release.promise;
        }
        return inner.embed(text, mode);
      },
    };

    const token = registry.start("tab-1");
    const running = indexDocument(store, gated, input(token.signal)).finally(() => {
      registry.finish(token);
    });
    await started.promise;

    const clearing = clearSemanticIndex(store, registry);
    expect(() => registry.start("tab-late")).toThrow(/clear/i);

    release.resolve();
    await clearing;
    await running;
    expect(store.info().documentCount).toBe(0);
  });
});
