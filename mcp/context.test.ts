import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "./context.js";
import { defaultSemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../dist-core/index/embedderSelection.js";

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
