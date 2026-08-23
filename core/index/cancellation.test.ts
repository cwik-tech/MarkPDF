import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticStore, type ChunkScope, type SemanticStore } from "../store/index.js";
import { indexDocument } from "./indexDocument.js";
import { createDeterministicEmbedder } from "./deterministicEmbedder.js";
import { deferred } from "./deferred.test-support.js";
import type { Embedder } from "./embeddings.js";
import { expectIndexed } from "./indexResult.test-support.js";

let dataDir: string;
let store: SemanticStore;

const PAGES = [
  { page: 1, text: "Introduction and preamble concerning administrative matters of record", source: "pdf" as const },
  { page: 2, text: "The escape velocity of Deimos is five point six metres per second", source: "pdf" as const },
];

function makeInput(overrides: Partial<Parameters<typeof indexDocument>[2]> = {}) {
  return {
    bytes: new TextEncoder().encode("one shared document"),
    name: "shared.pdf",
    filePath: null,
    pages: PAGES,
    pageCount: 2,
    chunkingProfile: "balanced" as const,
    ...overrides,
  };
}

function scopeFor(documentId: number): ChunkScope {
  return {
    documentId,
    chunkingProfile: "balanced",
    chunkingVersion: 1,
    modelId: "Xenova/bge-small-en-v1.5",
    modelVersion: "hf-transformers-js",
    dimensions: 384,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-cancel-"));
  store = openSemanticStore({ dataDir });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("deciding an index is already complete", () => {
  it("rebuilds when the same total is spread across different pages", async () => {
    // The count alone is not identity. Chunk ids embed page and per-page position, so the same
    // file can yield [page1:0, page1:1] on one run and [page1:0, page2:0] on the next when the
    // extracted text is distributed differently — which happens because OCR output is not
    // deterministic and the content hash covers the file, not the extracted text.
    const inner = createDeterministicEmbedder(384);
    const words = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
    const bytes = new TextEncoder().encode("one file, two extraction outcomes");

    // 500 words on a single page: balanced chunking (420 tokens, 350 stride) yields two chunks.
    const onePage = await indexDocument(store, inner, {
      bytes, name: "shifting.pdf", filePath: null, pageCount: 2, chunkingProfile: "balanced",
      pages: [{ page: 1, text: words(500, "a"), source: "pdf" }],
    });
    const scope = scopeFor(expectIndexed(onePage).documentId);
    expect(store.countIndexedChunks(scope)).toBe(2);

    // The same file, extracted as two pages of 250 words: also two chunks, different ids.
    const twoPages = await indexDocument(store, inner, {
      bytes, name: "shifting.pdf", filePath: null, pageCount: 2, chunkingProfile: "balanced",
      pages: [
        { page: 1, text: words(250, "a"), source: "pdf" },
        { page: 2, text: words(250, "b"), source: "pdf" },
      ],
    });

    expect(twoPages.status).toBe("ready");
    const pages = store.search(scope, await inner.embed("a1", "query"), 10, 0).map((hit) => hit.page);
    expect(pages).toContain(2);
  });

  it("rebuilds when the scope holds more rows than expected, rather than trusting a surplus", async () => {
    // An excess row is inconsistent state, not a finished index. Treating "at least as many as
    // expected" as complete means a document that once produced more chunks keeps serving the
    // leftovers forever.
    const inner = createDeterministicEmbedder(384);
    const first = await indexDocument(store, inner, makeInput());
    const scope = scopeFor(expectIndexed(first).documentId);
    expect(store.countIndexedChunks(scope)).toBe(2);

    // Add a surplus row directly, as a partially-superseded write would have left behind.
    store.insertChunkBatch(scope, [
      {
        id: "surplus-chunk",
        page: 2,
        index: 99,
        text: "left over from an earlier shape of this document",
        headingPath: [],
        vector: await inner.embed("surplus", "passage"),
      },
    ]);
    expect(store.countIndexedChunks(scope)).toBe(3);

    const second = await indexDocument(store, inner, makeInput());

    expect(second.status).toBe("ready");
    expect(store.countIndexedChunks(scope)).toBe(2);
  });
});

describe("cancelling an index job", () => {
  it("does not destroy a completed index belonging to another job for the same document", async () => {
    // The hazard: job B queues behind job A, is cancelled while still waiting, then runs
    // anyway, clears the scope, and returns "cancelled" — wiping A's finished work. A
    // cancelled job must never reach the destructive replace.
    //
    // B forces a rebuild, which is what the reindex path does. That skips the completeness
    // check, so B goes straight to the destructive clear — the reachable form of this bug.
    const inner = createDeterministicEmbedder(384);
    const firstEmbedStarted = deferred();
    const releaseFirstEmbed = deferred();
    let embedCalls = 0;

    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        embedCalls += 1;
        if (embedCalls === 1) {
          firstEmbedStarted.resolve();
          await releaseFirstEmbed.promise;
        }
        return inner.embed(text, mode);
      },
    };

    const bController = new AbortController();
    const jobA = indexDocument(store, gated, makeInput());
    await firstEmbedStarted.promise; // A now holds the queue and is mid-embed

    const jobB = indexDocument(store, gated, makeInput({ signal: bController.signal, force: true }));
    bController.abort(); // cancelled while queued behind A

    releaseFirstEmbed.resolve();
    const [resultA, resultB] = await Promise.all([jobA, jobB]);

    expect(resultA.status).toBe("ready");
    expect(resultB.status).toBe("cancelled");

    // A's index must survive B's cancellation intact.
    expect(store.countIndexedChunks(scopeFor(expectIndexed(resultA).documentId))).toBe(2);
    expect(store.info().chunkCount).toBe(2);
  });

  it("writes nothing after cancellation is observed, so a concurrent clear stays cleared", async () => {
    // The dangerous shape: a clear runs while this job is awaiting an embedding. If the
    // continuation then commits the batch it had already prepared, it repopulates a database
    // the user just emptied — or fails a foreign key, because its document row is gone.
    const inner = createDeterministicEmbedder(384);
    const firstEmbedDone = deferred();
    const releaseSecondEmbed = deferred();
    let calls = 0;
    const controller = new AbortController();

    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        calls += 1;
        const vector = await inner.embed(text, mode);
        if (calls === 1) {
          firstEmbedDone.resolve();
          await releaseSecondEmbed.promise; // held open while the clear happens
        }
        return vector;
      },
    };

    const job = indexDocument(store, gated, makeInput({ signal: controller.signal }));
    await firstEmbedDone.promise;

    // The clear cancels first, then empties the store — the ordering the main process uses.
    controller.abort();
    store.clear();
    releaseSecondEmbed.resolve();

    const result = await job;

    expect(result.status).toBe("cancelled");
    // Nothing from the cancelled job may have landed after the clear.
    expect(store.info().chunkCount).toBe(0);
    expect(store.info().embeddingCount).toBe(0);
    expect(store.info().documentCount).toBe(0);
  });

  it("does not commit a batch when cancellation arrives after its last embedding", async () => {
    // The narrow window the per-chunk check cannot see: every chunk in the batch has been
    // embedded, the loop has ended, and cancellation lands before the commit. Without a
    // re-check at that point the batch is written anyway.
    const inner = createDeterministicEmbedder(384);
    let calls = 0;
    const controller = new AbortController();
    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        calls += 1;
        const vector = await inner.embed(text, mode);
        if (calls === 2) controller.abort(); // during the final embedding of the batch
        return vector;
      },
    };

    const result = await indexDocument(store, gated, makeInput({ signal: controller.signal }));

    expect(result.status).toBe("cancelled");
    expect(calls).toBe(2);
    expect(store.info().chunkCount).toBe(0);
  });

  it("stops between individual embeddings rather than only at batch boundaries", async () => {
    const inner = createDeterministicEmbedder(384);
    const controller = new AbortController();
    let embedCalls = 0;
    const gated: Embedder = {
      modelId: inner.modelId,
      dimensions: inner.dimensions,
      async embed(text, mode) {
        embedCalls += 1;
        controller.abort(); // cancel after the very first embedding
        return inner.embed(text, mode);
      },
    };

    const result = await indexDocument(store, gated, makeInput({ signal: controller.signal }));

    expect(result.status).toBe("cancelled");
    // Both chunks sit in one 32-item batch, so a batch-boundary-only check would embed both.
    expect(embedCalls).toBe(1);
  });
});

describe("yielding between batches", () => {
  it("awaits the injected yield after reporting progress, so the interface can render it", async () => {
    const inner = createDeterministicEmbedder(384);
    const order: string[] = [];

    await indexDocument(store, inner, {
      ...makeInput(),
      onProgress: (progress) => {
        if (progress.status === "indexing") order.push(`progress:${progress.current}/${progress.total}`);
      },
      yieldControl: async () => {
        order.push("yield");
      },
    });

    // One batch here, so one progress event followed by exactly one yield. The yield must come
    // after the event, otherwise it buys the interface nothing.
    expect(order).toEqual(["progress:2/2", "yield"]);
  });
});

describe("a job cancelled before it reaches the work", () => {
  it("writes no document row, reports no progress, and embeds nothing", async () => {
    // Cancellation has to be honoured at the very top of the exclusive section, not after it.
    // `upsertDocument` is already a write, and an unforced request whose chunks are all present
    // returns "reused" without ever consulting the signal — so a job cancelled while queued
    // behind another for the same document would still touch the store and report success.
    const controller = new AbortController();
    controller.abort();

    let embedCalls = 0;
    const counting: Embedder = {
      modelId: "Xenova/bge-small-en-v1.5",
      dimensions: 384,
      embed: async (text, mode) => {
        embedCalls += 1;
        return createDeterministicEmbedder(384).embed(text, mode);
      },
    };
    const progress: string[] = [];

    const result = await indexDocument(
      store,
      counting,
      makeInput({ signal: controller.signal, onProgress: (event) => progress.push(event.status) }),
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(store.info().documentCount).toBe(0);
    expect(progress).toEqual([]);
    expect(embedCalls).toBe(0);
  });

  it("does not report a complete index as reused when the job was already cancelled", async () => {
    // The reuse path is the one that looks harmless. A cancelled job returning "reused" tells
    // the caller the document is indexed and ready, and the tab goes searchable off the back of
    // a job the user stopped.
    const embedder = createDeterministicEmbedder(384);
    const first = expectIndexed(await indexDocument(store, embedder, makeInput()));
    expect(first.status).toBe("ready");

    const controller = new AbortController();
    controller.abort();
    const second = await indexDocument(store, embedder, makeInput({ signal: controller.signal }));

    expect(second).toEqual({ status: "cancelled" });
  });
});
