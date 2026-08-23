import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransformersEmbedder } from "./embeddings.js";
import { modelCacheDir } from "../paths.js";

/**
 * Opt-in. Run with `npm run test:live`; excluded from `npm test`.
 *
 * WHY THE DEFAULT SUITE SUBSTITUTES THIS
 * --------------------------------------
 * Everywhere else, a deterministic bag-of-words embedder stands in for the real model. That
 * substitution keeps the suite offline and fast, but it proves nothing about:
 *
 *   - whether the weights actually download and land in the shared filesystem cache;
 *   - whether onnxruntime-node initialises under the shipped runtime;
 *   - whether `dtype: "q8"` quantisation produces usable output;
 *   - whether real rankings are good, and whether the 0.3 default threshold still suits them;
 *   - whether the vector width the catalogue advertises matches what the model emits.
 *
 * This check covers exactly those, which is why it must exist even though it cannot gate a
 * pull request. It requires network access on a cold cache.
 */
describe("the real embedding model", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "markpdf-live-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("loads, emits the advertised vector width, and caches to the shared directory", async () => {
    const embedder = createTransformersEmbedder({ modelId: "Xenova/bge-small-en-v1.5", dataDir });
    const vector = await embedder.embed("the escape velocity of Deimos", "passage");

    expect(vector).toBeInstanceOf(Float32Array);
    // The catalogue advertises 384. A mismatch here would mislabel every stored vector.
    expect(vector.length).toBe(embedder.dimensions);
    expect(vector.length).toBe(384);

    const magnitude = Math.sqrt([...vector].reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 3); // normalize: true

    expect(existsSync(modelCacheDir(dataDir))).toBe(true);
  });

  it("ranks a topically related passage above an unrelated one", async () => {
    const embedder = createTransformersEmbedder({ modelId: "Xenova/bge-small-en-v1.5", dataDir });
    const dot = (a: Float32Array, b: Float32Array) => [...a].reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

    const query = await embedder.embed("escape velocity of a Martian moon", "query");
    const related = await embedder.embed("Deimos has an escape velocity of 5.6 metres per second.", "passage");
    const unrelated = await embedder.embed("The invoice is due on the fifteenth of March.", "passage");

    expect(dot(query, related)).toBeGreaterThan(dot(query, unrelated));
  });
});
