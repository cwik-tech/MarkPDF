import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../../dist-core/index/embedderSelection.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The built entry point, run as a real process — the same file the shim will invoke. */
export const cliEntryPoint = join(repoRoot, "dist-cli", "main.js");

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  dataDir: string;
  /** Extra environment for this run. Overrides the defaults below. */
  env?: Record<string, string>;
  /** Where the child starts. Set it to a scratch directory to catch anything written there. */
  cwd?: string;
}

/**
 * A `NODE_OPTIONS` value that makes every network call throw, worker threads included.
 *
 * `--require` propagates into `worker_threads`, which is what makes this a real check: the OCR
 * engine runs in one, and it downloads its language data from a CDN unless told otherwise.
 */
export const OFFLINE_NODE_OPTIONS = `--require ${join(dirname(fileURLToPath(import.meta.url)), "blockNetwork.cjs")}`;

/**
 * Run the command line surface as a child process.
 *
 * The environment is built from nothing rather than inherited, so a `MARKPDF_*` variable that
 * happens to be set in the developer's shell cannot change what the journey observes. `PATH` is
 * carried because the child is `node`; `HOME` deliberately is not, so any code path that fell
 * back to a real user directory would fail loudly here instead of writing to one.
 */
export async function runCli(args: readonly string[], options: RunCliOptions): Promise<CliRun> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    MARKPDF_DATA_DIR: options.dataDir,
    // The default suite must stay offline. This is the same seam the Electron journey uses, and
    // it refuses to engage unless the process is unpackaged and pointed at a test directory.
    MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
    MARKPDF_TEST_USER_DATA: options.dataDir,
    ...options.env,
  };

  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntryPoint, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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

/**
 * Put a real `markpdf` on `PATH`, so a printed remedy can be run as written.
 *
 * The remedy's whole claim is that it is a runnable command. Asserting its text would prove
 * only that the text is what we expected; running it through a shell proves the quoting too,
 * which is the part that breaks on a directory whose name has a space in it.
 */
export function installShim(binDir: string): string {
  const shim = join(binDir, "markpdf");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntryPoint)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/** Run a command line through a real shell, with `markpdf` resolvable on `PATH`. */
export async function runShell(command: string, options: RunCliOptions & { binDir: string }): Promise<CliRun> {
  const env: Record<string, string> = {
    PATH: `${options.binDir}:${process.env.PATH ?? ""}`,
    MARKPDF_DATA_DIR: options.dataDir,
    MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
    MARKPDF_TEST_USER_DATA: options.dataDir,
    ...options.env,
  };
  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
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

/** Parse a `--json` run's stdout, naming the run when it is not JSON at all. */
export function jsonOf(run: CliRun): unknown {
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`Expected JSON on stdout, exit ${run.code}. stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }
}
