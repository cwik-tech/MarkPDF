import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONCURRENT_OCR_CALLS, createToolContext } from "./context.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../dist-core/index/embedderSelection.js";
import type { Embedder } from "../dist-core/index/embeddings.js";
import { resolveOcrWithProgress } from "./operations.js";
import type { ToolProgress } from "./progress.js";

/**
 * A session's view of the application's settings, and the embedders it builds from them.
 *
 * A session lives as long as the client does — hours — so both are held the way consent and the
 * open-document record already are: read when asked, not cached at startup. Only the embedding
 * model is substituted, through the same guarded seam every other test uses.
 */

const MODEL_A = "Xenova/bge-small-en-v1.5";
const MODEL_B = "Xenova/all-MiniLM-L6-v2";
const MODEL_C = "Xenova/bge-base-en-v1.5";

let dataDir: string;

const testEnv = (dir: string) => ({
  MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
  MARKPDF_TEST_USER_DATA: dir,
});

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-mcp-context-")));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeSettings(patch: Partial<typeof defaultSemanticSearchSettings>): void {
  writeFileSync(
    join(dataDir, "config.json"),
    `${JSON.stringify({ semanticSearch: { ...defaultSemanticSearchSettings, ...patch } })}\n`,
    "utf8",
  );
}

describe("settings read per call", () => {
  it("answers from the file as it is when asked, not as it was when the session started", () => {
    const { context, close } = createToolContext({ dataDir, env: testEnv(dataDir), isPackaged: false });
    try {
      expect(context.settings()).toEqual(defaultSemanticSearchSettings);

      writeSettings({ minSemanticScore: 0.42 });
      expect(context.settings().minSemanticScore).toBe(0.42);
    } finally {
      close();
    }
  });

  it("does not touch the settings file just to exist", () => {
    // A directory where the file should be: opening it throws. A context that read its settings
    // at startup would fail to start; one that reads per call starts and leaves the failure for
    // the call that actually needs them.
    mkdirSync(join(dataDir, "config.json"));

    expect(() => createToolContext({ dataDir, env: testEnv(dataDir), isPackaged: false })).not.toThrow();
  });
});

describe("one embedder per model, bounded", () => {
  it("keeps the same instance for the same model id", () => {
    const { context, close } = createToolContext({ dataDir, env: testEnv(dataDir), isPackaged: false });
    try {
      const first = context.embedder(MODEL_A);

      expect(context.embedder(MODEL_A)).toBe(first);
      expect(context.embedder(MODEL_A).modelId).toBe(MODEL_A);
    } finally {
      close();
    }
  });

  it("builds a separate embedder for a different model id", () => {
    const { context, close } = createToolContext({ dataDir, env: testEnv(dataDir), isPackaged: false });
    try {
      const first = context.embedder(MODEL_A);
      const second = context.embedder(MODEL_B);

      expect(second).not.toBe(first);
      expect(second.modelId).toBe(MODEL_B);
    } finally {
      close();
    }
  });

  it("holds at most two models, dropping the one used least recently", () => {
    // Without a bound a session that worked through the catalogue would hold every model's
    // runtime at once. Two keeps the current model and the one before it — enough for a change
    // of mind — and nothing older.
    const { context, close } = createToolContext({ dataDir, env: testEnv(dataDir), isPackaged: false });
    try {
      const first = context.embedder(MODEL_A);
      const second = context.embedder(MODEL_B);
      context.embedder(MODEL_C);

      // A was asked for least recently, so B survived C's arrival and A did not.
      expect(context.embedder(MODEL_B)).toBe(second);
      expect(context.embedder(MODEL_A)).not.toBe(first);
    } finally {
      close();
    }
  });
});

describe("operation progress producers", () => {
  it("forwards OCR page progress to the current call without replacing the resolver listener", async () => {
    // The counters travel too. A client that asked for progress can now draw a bar over the pages
    // being recognised instead of reading a sentence and guessing how much is left; the sentence is
    // still sent, because it names the page of the document rather than the position in the run.
    const resolverSeen: Array<{ page: number; current: number; total: number; totalPages: number }> = [];
    const callSeen: ToolProgress[] = [];
    const { context, close } = createToolContext(
      { dataDir, env: testEnv(dataDir), isPackaged: false },
      {
        ocr: async (request) => {
          request.onProgress?.({ page: 3, current: 1, total: 2, totalPages: request.totalPages, message: "Reading page 3 with OCR" });
          return [];
        },
      },
    );
    try {
      const resolve = resolveOcrWithProgress({
        ...context,
        progress: (update) => callSeen.push(update),
      });
      if (resolve === undefined) throw new Error("OCR resolver was not configured");

      await resolve({
        bytes: new Uint8Array(),
        pages: [3, 4],
        totalPages: 628,
        onProgress: ({ page, current, total, totalPages }) => resolverSeen.push({ page, current, total, totalPages }),
      });

      expect(resolverSeen).toEqual([{ page: 3, current: 1, total: 2, totalPages: 628 }]);
      expect(callSeen).toEqual([{ progress: 3, total: 628, message: "Reading page 3 with OCR" }]);
    } finally {
      close();
    }
  });

  it("publishes model download bytes to every call watching the cached embedder", async () => {
    let publish: ((progress: { loaded: number; total: number }) => void) | undefined;
    const fake: Embedder = {
      modelId: MODEL_A,
      dimensions: 2,
      async embed() {
        publish?.({ loaded: 25, total: 100 });
        return new Float32Array([0, 1]);
      },
    };
    const { context, close } = createToolContext(
      { dataDir, env: testEnv(dataDir), isPackaged: false },
      {
        createEmbedder: (_modelId, onProgress) => {
          publish = onProgress;
          return fake;
        },
      },
    );
    const first: Array<{ loaded: number; total: number }> = [];
    const second: Array<{ loaded: number; total: number }> = [];
    try {
      const firstEmbedder = context.embedder(MODEL_A, (progress) => first.push(progress));
      const secondEmbedder = context.embedder(MODEL_A, (progress) => second.push(progress));

      await Promise.all([
        firstEmbedder.embed("one", "query"),
        secondEmbedder.embed("two", "query"),
      ]);

      expect(first).toContainEqual({ loaded: 25, total: 100 });
      expect(second).toContainEqual({ loaded: 25, total: 100 });
      expect(context.embedder(MODEL_A)).toBe(fake);
    } finally {
      close();
    }
  });
});

describe("resource-specific scheduling", () => {
  it("caps OCR at one while cheap work continues through the tool scheduler", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let active = 0;
    let peak = 0;
    let firstStarted: () => void = () => undefined;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const { context, close } = createToolContext(
      { dataDir, env: testEnv(dataDir), isPackaged: false },
      {
        ocr: async () => {
          started += 1;
          active += 1;
          peak = Math.max(peak, active);
          firstStarted();
          await gate;
          active -= 1;
          return [];
        },
      },
    );
    try {
      const resolve = context.resolveOcr;
      if (resolve === undefined) throw new Error("OCR resolver was not configured");
      const first = resolve({ bytes: new Uint8Array(), pages: [1], totalPages: 2 });
      await firstStart;
      const second = resolve({ bytes: new Uint8Array(), pages: [2], totalPages: 2 });

      let cheapWorkFinished = false;
      await context.scheduler.run(async () => {
        cheapWorkFinished = true;
      });

      expect(cheapWorkFinished).toBe(true);
      expect(started).toBe(1);
      expect(active).toBe(1);
      expect(CONCURRENT_OCR_CALLS).toBe(1);

      release();
      await Promise.all([first, second]);
      expect(started).toBe(2);
      expect(peak).toBe(1);
    } finally {
      release();
      close();
    }
  });
});
