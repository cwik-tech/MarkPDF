/**
 * Library search at library scale, measured on demand rather than per pull request.
 *
 *   npm run build:core && heavy-run --label markpdf -- node scripts/bench/librarySearchBenchmark.mjs [sizes] [queriesPerCell]
 *
 *   sizes           comma-separated chunk counts, default 10000,100000
 *   queriesPerCell  queries for each mode and query kind, default 20
 *
 * Plain JavaScript against `dist-core/`, like `chunkingBenchmark.mjs`, so it needs no extra tool.
 * Every write goes through the production store API, so the exact-word triggers run as they do in
 * use. Vectors are random unit vectors and the text comes from a synthetic vocabulary of 24,000
 * words: this measures the store and the ranking, not the model. The query embedding is excluded.
 *
 * Reported for each size:
 * - write time with the exact-word triggers, and without them, on the same data
 * - backfill time from an empty exact-word index, and the longest single backfill transaction
 * - p50 and p95 search latency for each mode and each kind of query, and the first query of the run
 * - forget and clear time
 * - store size, and the exact-word index's share of it when SQLite can report it
 * - peak resident memory
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSemanticStore } from "../../dist-core/store/index.js";
import { semanticIndexPath } from "../../dist-core/paths.js";
import { searchLibrary } from "../../dist-core/index/librarySearch.js";
import { completeExactIndex } from "../../dist-core/index/exactIndexBackfill.js";
import { activeChunkScopeContract } from "../../dist-core/index/search.js";
import { semanticChunkingVersion } from "../../dist-core/models.js";

const DIMENSIONS = 384;
const sizes = (process.argv[2] ?? "10000,100000").split(",").map(Number);
const queriesPerCell = Number(process.argv[3] ?? 20);

let seed = 20261031;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const SYLLABLES = ["ka", "lo", "mi", "ne", "ru", "ta", "vo", "shi", "pe", "dra", "gon", "tel", "mar", "bis", "quo", "zen", "fur", "lix", "pra", "dum"];
const vocabulary = [];
for (let index = 0; vocabulary.length < 24_000; index += 1) {
  const word = [index % 20, Math.floor(index / 20) % 20, Math.floor(index / 400) % 20, Math.floor(index / 8000) % 20]
    .map((position) => SYLLABLES[position])
    .join("");
  vocabulary.push(word);
}
// Zipf-like: a few words are everywhere, most are rare — the shape of real prose.
const word = () => vocabulary[Math.floor(vocabulary.length * random() ** 3)];
const COMMON = [vocabulary[0], vocabulary[1], vocabulary[2]];

function unitVector() {
  const vector = new Float32Array(DIMENSIONS);
  let magnitude = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) {
    vector[index] = random() - 0.5;
    magnitude += vector[index] * vector[index];
  }
  magnitude = Math.sqrt(magnitude);
  for (let index = 0; index < DIMENSIONS; index += 1) vector[index] /= magnitude;
  return vector;
}

const embedder = {
  modelId: "Xenova/bge-small-en-v1.5",
  dimensions: DIMENSIONS,
  embed: async () => unitVector(),
};
const contract = activeChunkScopeContract(embedder, "balanced");

let peakRss = 0;
const sampleMemory = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const memoryTimer = setInterval(sampleMemory, 50);

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** Documents of skewed size: most short, a few very long. */
function documentSizes(totalChunks) {
  const result = [];
  let left = totalChunks;
  while (left > 0) {
    const size = Math.min(left, Math.max(5, Math.floor(20 + 2000 * random() ** 6)));
    result.push(size);
    left -= size;
  }
  return result;
}

function writeLibrary(store, totalChunks) {
  let written = 0;
  for (const [documentIndex, chunkCount] of documentSizes(totalChunks).entries()) {
    const hash = documentIndex.toString(16).padStart(64, "0");
    const document = store.upsertDocument({
      contentHash: hash, name: `doc-${documentIndex}.pdf`, filePath: `/library/doc-${documentIndex}.pdf`, pathProvenance: "resolved",
      fileSize: 1, pageCount: Math.ceil(chunkCount / 3), textSource: "pdf", textExtractionVersion: 2, ocrExtractionVersion: 2,
      markdownEngine: null, markdownVersion: null,
    });
    const scope = { documentId: document.id, ...contract };
    for (let offset = 0; offset < chunkCount; offset += 512) {
      const batch = [];
      for (let index = offset; index < Math.min(chunkCount, offset + 512); index += 1) {
        const words = Array.from({ length: 120 }, word);
        batch.push({
          id: `${hash}:balanced:${semanticChunkingVersion}:${index}`,
          page: 1 + Math.floor(index / 3),
          index: index % 3,
          text: `${words.join(" ")} ref${written}`,
          headingPath: [],
          vector: unitVector(),
        });
        written += 1;
      }
      store.insertChunkBatch(scope, batch);
    }
  }
  return written;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function exactIndexBytes(path) {
  try {
    const db = new Database(path, { readonly: true });
    const row = db.prepare("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'chunk_text%'").get();
    db.close();
    return row?.bytes ?? null;
  } catch {
    return null;
  }
}

async function measure(totalChunks) {
  const dataDir = mkdtempSync(join(tmpdir(), "markpdf-library-bench-"));
  const report = { chunks: totalChunks };
  try {
    // Without triggers: the same writes, with the exact-word triggers dropped on this file only.
    {
      const plainDir = mkdtempSync(join(tmpdir(), "markpdf-library-bench-plain-"));
      const plain = openSemanticStore({ dataDir: plainDir });
      plain.close();
      const db = new Database(semanticIndexPath(plainDir));
      db.exec("DROP TRIGGER document_chunks_text_insert; DROP TRIGGER document_chunks_text_delete;");
      db.close();
      const reopened = openSemanticStore({ dataDir: plainDir });
      seed = 7;
      const started = now();
      writeLibrary(reopened, totalChunks);
      report.writeWithoutTriggersMs = Math.round(now() - started);
      reopened.close();
      rmSync(plainDir, { recursive: true, force: true });
    }

    const store = openSemanticStore({ dataDir });
    seed = 7;
    let started = now();
    report.written = writeLibrary(store, totalChunks);
    report.writeWithTriggersMs = Math.round(now() - started);
    report.triggerOverheadPercent = Math.round((100 * (report.writeWithTriggersMs - report.writeWithoutTriggersMs)) / report.writeWithoutTriggersMs);

    const path = semanticIndexPath(dataDir);
    store.close();
    report.storeMB = Math.round(statSync(path).size / 1048576);
    const indexBytes = exactIndexBytes(path);
    report.exactIndexMB = indexBytes === null ? "dbstat unavailable" : Math.round(indexBytes / 1048576);

    // Backfill from an empty exact-word index, as an upgraded store has it.
    {
      const db = new Database(path);
      db.exec(`DELETE FROM chunk_text_keys; INSERT INTO chunk_text_fts(chunk_text_fts) VALUES('delete-all');
               UPDATE schema_meta SET value = 'backfilling' WHERE key = 'exact_index_state';
               UPDATE schema_meta SET value = '' WHERE key = 'exact_index_cursor';`);
      db.close();
    }
    const reopened = openSemanticStore({ dataDir });
    let longest = 0;
    const original = reopened.backfillExactIndexBatch.bind(reopened);
    reopened.backfillExactIndexBatch = (limit) => {
      const batchStarted = now();
      const result = original(limit);
      longest = Math.max(longest, now() - batchStarted);
      return result;
    };
    started = now();
    await completeExactIndex(reopened);
    report.backfillMs = Math.round(now() - started);
    report.longestBackfillTransactionMs = Math.round(longest);

    const queries = {
      rare: () => `ref${Math.floor(random() * report.written)}`,
      common: () => COMMON[Math.floor(random() * COMMON.length)],
      multiWord: () => `${word()} ${word()} ${word()}`,
      noHit: () => `absentword${Math.floor(random() * 1e9)}`,
    };
    const discover = () => true;
    started = now();
    await searchLibrary(reopened, embedder, { query: "first query", chunkingProfile: "balanced", mode: "hybrid", minScore: 0, discover });
    report.firstQueryMs = Math.round(now() - started);

    report.latency = {};
    for (const mode of ["hybrid", "semantic", "exact"]) {
      for (const [kind, make] of Object.entries(queries)) {
        if (mode === "semantic" && kind !== "common") continue; // A semantic scan does not depend on the words.
        const times = [];
        for (let index = 0; index < queriesPerCell; index += 1) {
          const queryStarted = now();
          await searchLibrary(reopened, embedder, { query: make(), chunkingProfile: "balanced", mode, minScore: 0, discover });
          times.push(now() - queryStarted);
        }
        report.latency[`${mode}/${kind}`] = { p50: Math.round(percentile(times, 0.5)), p95: Math.round(percentile(times, 0.95)) };
      }
    }

    started = now();
    reopened.forgetDocument((0).toString(16).padStart(64, "0"));
    report.forgetMs = Math.round(now() - started);
    started = now();
    reopened.clear();
    report.clearMs = Math.round(now() - started);
    reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  sampleMemory();
  report.peakRssMB = Math.round(peakRss / 1048576);
  return report;
}

for (const size of sizes) {
  console.log(JSON.stringify(await measure(size), null, 1));
}
clearInterval(memoryTimer);
