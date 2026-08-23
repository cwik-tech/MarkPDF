import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isPackagedModulePath } from "./packaging.js";
import { createTerminalConfirm } from "./prompt.js";
import { classifyRunFailure } from "./errors.js";
import { failureLines } from "./report.js";
import { runCli } from "./run.js";
import { EXIT_CODE } from "./exit.js";

const here = fileURLToPath(import.meta.url);

/**
 * The version, read from the manifest that shipped with this copy.
 *
 * `createRequire` rather than a JSON import: it resolves inside `app.asar` exactly as it does in
 * a checkout, and needs no import attribute whose syntax has moved twice.
 */
function readVersion(): string {
  try {
    const manifest: unknown = createRequire(here)("../package.json");
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = manifest.version;
      if (typeof version === "string") return version;
    }
  } catch {
    // A missing manifest is not worth failing a search over.
  }
  return "unknown";
}

/**
 * Nothing escapes without a code and a sentence.
 *
 * The contract this command line makes is that every ending is a number in the table and a line
 * on stderr. A dependency that throws from inside its own event callback breaks that: the promise
 * `runCli` is waiting on never settles, and Node prints a stack trace and exits 1 with nothing on
 * stdout. Observed from `tesseract.js` 7.0.0, which dereferences an already-deleted promise in its
 * worker message handler after a job is rejected.
 *
 * This is a backstop, not a substitute for handling failures where they happen — a diagnosis that
 * reaches here has lost the context that would have made it specific.
 */
function endWith(error: unknown): void {
  // Through the same renderer as every other failure. A dependency's error text is the least
  // trustworthy string this program handles — it can carry a file name, a shell fragment, or
  // whatever a native library put in it — and this is the one path it takes.
  const failure = classifyRunFailure(error);
  process.stderr.write(failureLines(failure));
  process.exit(failure.code);
}

process.on("uncaughtException", endWith);
process.on("unhandledRejection", endWith);

const controller = new AbortController();
// Interrupted work is an outcome, not a crash: the handler aborts, the run unwinds through its
// own cancellation checks, and nothing half-written is committed.
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  version: readVersion(),
  isPackaged: isPackagedModulePath(here),
  confirmGrant: interactive
    ? createTerminalConfirm(process.stdin, (text) => process.stderr.write(text), () => controller.abort())
    : undefined,
  signal: controller.signal,
});

// `exitCode` rather than `exit()`, so buffered stdout is flushed before the process ends. A
// piped stdout is not synchronous, and exiting outright can truncate the result.
process.exitCode = controller.signal.aborted ? EXIT_CODE.interrupted : code;
