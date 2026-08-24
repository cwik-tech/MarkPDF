import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type SemanticStore } from "../store/index.js";
import { indexDocument } from "./indexDocument.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import type { Embedder } from "./embeddings.js";
import { deferred } from "./deferred.test-support.js";
import { expectIndexed } from "./indexResult.test-support.js";
import { semanticChunkingVersion } from "../models.js";
import { BoundedScheduler } from "./boundedScheduler.js";

let dataDir: string;
let store: SemanticStore;

/**
 * Holds the first embedding open until released, so the second job is provably in flight while
 * the first is unfinished. A latch rather than a delay: timing-based overlap is slow when it
 * works and flaky when the machine is busy.
 */
function gatedEmbedder(): { embedder: Embedder; firstStarted: Promise<void>; release: () => void } {
  const inner = createDeterministicEmbedder(384);
  const started = deferred();
  const gate = deferred();
  let calls = 0;
  return {
    embedder: {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return inner.embed(text, mode);
      },
    },
    firstStarted: started.promise,
    release: () => gate.resolve(),
  };
}

const PAGES = [
  { page: 1, text: "Introduction and preamble concerning administrative matters of record", source: "pdf" as const },
  { page: 2, text: "The escape velocity of Deimos is five point six metres per second", source: "pdf" as const },
];

function input() {
  return {
    bytes: new TextEncoder().encode("same document bytes"),
    name: "same.pdf",
    filePath: null,
    pages: PAGES,
    pageCount: 2,
    chunkingProfile: "balanced" as const,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-concurrency-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the same document indexed twice at once", () => {
  it("completes both jobs and leaves exactly one correct set of chunks", async () => {
    // Two tabs holding the same PDF is ordinary. Without serialisation the second job clears
    // the scope after the first has already cleared it, then both insert the same
    // deterministic chunk ids and the later insert collides on the primary key.
    const { embedder, firstStarted, release } = gatedEmbedder();

    const first = indexDocument(store, embedder, input());
    await firstStarted; // the first job is provably mid-embed
    const second = indexDocument(store, embedder, input());
    release();

    const results = await Promise.all([first, second]);
    const raw = results[0];
    if (raw === undefined) throw new Error("expected a result from the first job");
    const primary = expectIndexed(raw);
    const secondary = results[1];
    if (secondary === undefined) throw new Error("expected a result from the second job");

    expect(primary.contentHash).toBe(expectIndexed(secondary).contentHash);
    const scope = {
      documentId: primary.documentId,
      chunkingProfile: "balanced",
      chunkingVersion: semanticChunkingVersion,
      modelId: "Xenova/bge-small-en-v1.5",
      modelVersion: "hf-transformers-js",
      dimensions: 384,
    };
    expect(store.countIndexedChunks(scope)).toBe(2);
    expect(store.info().chunkCount).toBe(2);
  });
});

describe("cancelling work queued behind a bounded resource", () => {
  it("removes the waiter and never starts its work", async () => {
    const scheduler = new BoundedScheduler(1);
    const holding = deferred();
    const started = deferred();
    const first = scheduler.run(async () => {
      started.resolve();
      await holding.promise;
    });
    await started.promise;

    const controller = new AbortController();
    let queuedRan = false;
    const queued = scheduler.run(async () => {
      queuedRan = true;
    }, controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "SchedulerCancelled" });
    expect(queuedRan).toBe(false);
    expect(scheduler.active).toBe(1);

    holding.resolve();
    await first;
    expect(scheduler.active).toBe(0);
    expect(queuedRan).toBe(false);
  });
});
