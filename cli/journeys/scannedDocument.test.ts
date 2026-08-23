import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScannedPdf, SCANNED_PHRASE } from "./fixtures.test-support.js";
import { jsonOf, runCli, OFFLINE_NODE_OPTIONS } from "./runCli.test-support.js";
import { EXIT_CODE } from "../exit.js";

/**
 * V10: a page that is nothing but pixels, read from the command line with the network blocked.
 *
 * The application can index a scan today only because its renderer has already rasterised and
 * scanned the page for the visible text layer. The command line has no renderer to borrow from,
 * so this is the first time the whole path — rasterise, recognise, index — runs outside it.
 *
 * The network really is blocked, in the child process and in the worker thread the OCR engine
 * runs in, so a configuration that quietly reached a CDN would fail here rather than pass.
 */

let dataDir: string;
let libraryDir: string;
let workDir: string;
let fixture: string;

const offline = { NODE_OPTIONS: OFFLINE_NODE_OPTIONS };

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-library-")));
  // A scratch working directory, so anything written relative to it is visible.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-cwd-")));
  fixture = join(libraryDir, "survey-scan.pdf");
  writeFileSync(fixture, await buildScannedPdf());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir, workDir]) rmSync(directory, { recursive: true, force: true });
});

describe("V10 — a scanned document", () => {
  it("indexes text that exists only as pixels, offline, and answers a search about it", async () => {
    const granted = await runCli(["--allow-read", libraryDir], { dataDir, env: offline, cwd: workDir });
    expect(granted.code).toBe(EXIT_CODE.success);

    const indexed = await runCli(["index", fixture, "--json"], { dataDir, env: offline, cwd: workDir });

    expect(indexed.code).toBe(EXIT_CODE.success);
    const report = jsonOf(indexed) as { documents: Array<{ chunkCount: number; pageCount: number }> };
    expect(report.documents[0]?.pageCount).toBe(1);
    expect(report.documents[0]?.chunkCount).toBeGreaterThan(0);

    // Tesseract's Node worker defaults its cache to the current directory, which would drop an
    // `eng.traineddata` wherever the person happened to be standing.
    expect(readdirSync(workDir)).toEqual([]);

    const found = await runCli(
      ["search", "escape velocity of Deimos", "--path", fixture, "--min-score", "0.1", "--json"],
      { dataDir, env: offline, cwd: workDir },
    );

    expect(found.code).toBe(EXIT_CODE.success);
    const search = jsonOf(found) as { results: Array<{ page: number; snippet: string }> };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]?.page).toBe(1);
    expect(search.results.map((hit) => hit.snippet).join(" ")).toContain("Deimos");
  }, 300_000);

  it("is running under a block that really does refuse the network", async () => {
    // Without this, "it indexed offline" could equally mean the block was never in force. The
    // same preload, the same way of loading it, and an ordinary request that must not succeed.
    const probe = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "fetch('https://registry.npmjs.org/')"], {
        env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: OFFLINE_NODE_OPTIONS },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    });

    expect(probe.code).not.toBe(0);
    expect(probe.stderr).toContain("NETWORK BLOCKED");
  }, 60_000);

  it("converts the same recognised text, so one document does not read differently by command", async () => {
    // Before the three commands shared one reading, `index` recognised a scan while `convert`
    // returned an announced but empty page.
    await runCli(["--allow-read", libraryDir], { dataDir, env: offline, cwd: workDir });

    const result = await runCli(["convert", fixture], { dataDir, env: offline, cwd: workDir });

    expect(result.code).toBe(EXIT_CODE.success);
    expect(result.stdout).toContain("Deimos");
  }, 300_000);

  it("ends with a code and a sentence when the recognition engine fails, never a stack trace", async () => {
    // Two separate faults in `tesseract.js` 7.0.0 live here. A rejected job throws from inside its
    // own `worker.on("message")` handler unless an `errorHandler` is supplied — covered at the
    // unit layer in `core/ocr/ocr.test.ts`, because supplying one is a property of the options,
    // not of this run. The engine then posts a *resolve* for the job it just rejected and
    // dereferences the already-deleted promise (`createWorker.js:208`), which no option prevents.
    //
    // So what this asserts is the contract the command line can actually keep: whatever a
    // dependency throws out of band, the run ends with a code from the table and one sentence on
    // stderr, and a caller reading stdout is never handed half a result.
    const broken = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-broken-")));
    try {
      // Genuinely gzip, so it passes the shape check and reaches the engine, which then rejects
      // the job — the case the error handler exists for. A file that were not gzip at all would
      // be refused before the engine started and would prove nothing about this.
      writeFileSync(join(broken, "eng.traineddata.gz"), gzipSync(Buffer.from("gzip, but not language data")));
      await runCli(["--allow-read", libraryDir], { dataDir, env: offline, cwd: workDir });

      const result = await runCli(["index", fixture, "--json"], {
        dataDir,
        env: { ...offline, MARKPDF_OCR_DATA_DIR: broken },
        cwd: workDir,
      });

      expect(result.code).toBe(EXIT_CODE.unexpected);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("node_modules");
      expect(result.stderr).not.toContain("at Worker");
      expect(result.stderr.trimEnd().split("\n").at(-1)).toBe("Cannot read properties of undefined (reading 'resolve')");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  }, 300_000);

  it("refuses language data that is not even the right kind of file, before starting the engine", async () => {
    const wrong = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-wrong-")));
    try {
      writeFileSync(join(wrong, "eng.traineddata.gz"), "plain text pretending to be language data");
      await runCli(["--allow-read", libraryDir], { dataDir, env: offline, cwd: workDir });

      const result = await runCli(["index", fixture, "--json"], {
        dataDir,
        env: { ...offline, MARKPDF_OCR_DATA_DIR: wrong },
        cwd: workDir,
      });

      expect(result.code).toBe(EXIT_CODE.missingDependency);
      expect(result.stderr).toContain("not readable as compressed language data");
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  }, 300_000);

  it("exits 8 and indexes nothing when the language data is missing from the installation", async () => {
    // The document is fine; the installation is not. Recording it as a short document that
    // succeeded would tell an automated caller the work was done.
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-scan-nodata-")));
    try {
      await runCli(["--allow-read", libraryDir], { dataDir, env: offline, cwd: workDir });

      const result = await runCli(["index", fixture, "--json"], {
        dataDir,
        env: { ...offline, MARKPDF_OCR_DATA_DIR: empty },
        cwd: workDir,
      });

      expect(result.code).toBe(EXIT_CODE.missingDependency);
      expect(result.stderr).toContain("OCR language data");
      const report = jsonOf(result) as { documents: unknown[]; failures: Array<{ code: number }> };
      expect(report.documents).toEqual([]);
      expect(report.failures[0]?.code).toBe(EXIT_CODE.missingDependency);

      // And nothing was recorded, which a later search is the plainest way to show.
      const search = await runCli(["search", "Deimos", "--path", fixture], { dataDir, env: offline, cwd: workDir });
      expect(search.code).toBe(EXIT_CODE.notIndexed);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 300_000);
});
