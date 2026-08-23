import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderShim } from "../../dist-core/install/cliShim.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";
import { EXIT_CODE } from "../exit.js";
import { buildReportPdf } from "./fixtures.test-support.js";

/**
 * The installed shim, run against the real Electron binary as a plain Node process.
 *
 * Opt-in, because it needs the Electron binary rather than the `node` the rest of the suite runs
 * under. It is the check that turns `ELECTRON_RUN_AS_NODE=1` from a plan into an observation:
 * `better-sqlite3` and `@firecrawl/pdf-inspector` are N-API modules that have to load under a
 * different runtime from the one every other test uses, and the shim has to reach them.
 *
 * **What it does not exercise.** It selects the offline embedder through the same guarded seam the
 * rest of the suite uses, so ONNX Runtime and the real model are not loaded here — production
 * embedding from the installed command remains unverified, as the ADRs say. It also runs against
 * this checkout rather than a packaged bundle; `V11` covers the packaged case, with the same
 * limitation for the same reason.
 *
 * Run with `npm run test:live`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const electronBinary = join(repoRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const entryPoint = join(repoRoot, "dist-cli", "main.js");

let dataDir: string;
let libraryDir: string;
let binDir: string;
let shim: string;
let fixture: string;

async function runShim(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(shim, args, {
      env: {
        PATH: process.env.PATH ?? "",
        MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
        MARKPDF_TEST_USER_DATA: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-shim-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-shim-library-")));
  binDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-shim-bin-")));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());

  shim = join(binDir, "markpdf");
  // Exactly what the install action writes, with this checkout standing in for a bundle.
  writeFileSync(
    shim,
    renderShim({
      version: "0.0.0-live",
      appPath: repoRoot,
      electronPath: electronBinary,
      entryPoint,
      dataDir,
    }),
  );
  chmodSync(shim, 0o755);
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir, binDir]) rmSync(directory, { recursive: true, force: true });
});

describe("the installed command, running on the application's own runtime", () => {
  it("starts at all", async () => {
    expect(existsSync(electronBinary)).toBe(true);

    const result = await runShim(["--version"]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it("uses the data directory the shim baked in, without being told", async () => {
    // No `MARKPDF_DATA_DIR` in the environment above: the shim supplies it, which is what makes
    // the command and the application share one index.
    const granted = await runShim(["--allow-read", libraryDir, "--json"]);

    expect(granted.code).toBe(EXIT_CODE.success);
    expect(existsSync(join(dataDir, "consent", "allowlist.json"))).toBe(true);
  }, 120_000);

  it("loads SQLite and the extractor under that runtime, and indexes a real document", async () => {
    // `better-sqlite3` and `@firecrawl/pdf-inspector` are N-API modules loaded under a runtime
    // that is not the `node` binary the rest of the suite uses. This is where that stops being an
    // assumption. The embedding is the offline stand-in, so nothing here says anything about
    // ONNX Runtime or the real model.
    await runShim(["--allow-read", libraryDir]);

    const indexed = await runShim(["index", fixture, "--json"]);

    expect(indexed.code).toBe(EXIT_CODE.success);
    const report = JSON.parse(indexed.stdout) as { documents: Array<{ pageCount: number; chunkCount: number }> };
    expect(report.documents[0]?.pageCount).toBe(3);
    expect(report.documents[0]?.chunkCount).toBeGreaterThan(0);

    const found = await runShim(["search", "Enterprise 1204 1318", "--path", fixture, "--min-score", "0.1", "--json"]);
    expect(found.code).toBe(EXIT_CODE.success);
    expect((JSON.parse(found.stdout) as { results: Array<{ page: number }> }).results[0]?.page).toBe(2);
  }, 300_000);
});
