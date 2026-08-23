import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCachedModels, isModelCached } from "./modelCache.js";
import { modelCacheDir } from "../paths.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-modelcache-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedModel(modelId: string, relativeFile: string) {
  const dir = join(modelCacheDir(dataDir), modelId);
  mkdirSync(join(dir, relativeFile, ".."), { recursive: true });
  writeFileSync(join(dir, relativeFile), "weights");
}

describe("deciding whether an embedding model is actually on disk", () => {
  it("reports a model with no cache directory as absent", () => {
    // The case that matters: settings can claim a model is downloaded while the cache was
    // cleared, the data directory moved, or the download never finished. Trusting the setting
    // means the next index silently starts a 133 MB fetch with no progress anywhere.
    expect(isModelCached(dataDir, "Xenova/bge-small-en-v1.5")).toBe(false);
  });

  it("reports an empty cache directory as absent, because a created folder is not a model", () => {
    mkdirSync(join(modelCacheDir(dataDir), "Xenova/bge-small-en-v1.5"), { recursive: true });
    expect(isModelCached(dataDir, "Xenova/bge-small-en-v1.5")).toBe(false);
  });

  it("reports a model whose weights are on disk as present", () => {
    seedModel("Xenova/bge-small-en-v1.5", "onnx/model_quantized.onnx");
    expect(isModelCached(dataDir, "Xenova/bge-small-en-v1.5")).toBe(true);
  });

  it("finds weights nested under the model directory, which is how the cache lays them out", () => {
    seedModel("Xenova/all-MiniLM-L6-v2", "onnx/deep/model.onnx");
    expect(isModelCached(dataDir, "Xenova/all-MiniLM-L6-v2")).toBe(true);
  });

  it("drops claimed models whose cache is missing, keeping the order of those that remain", () => {
    seedModel("Xenova/bge-small-en-v1.5", "config.json");
    seedModel("Xenova/bge-base-en-v1.5", "config.json");

    expect(
      filterCachedModels(dataDir, [
        "Xenova/bge-small-en-v1.5",
        "Xenova/all-MiniLM-L6-v2",
        "Xenova/bge-base-en-v1.5",
      ]),
    ).toEqual(["Xenova/bge-small-en-v1.5", "Xenova/bge-base-en-v1.5"]);
  });
});
