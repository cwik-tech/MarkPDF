import { AccessDeniedError, isMissingPathError, remedyFor } from "../dist-core/consent/allowlist.js";
import { AllowlistLockedError } from "../dist-core/consent/allowlistFile.js";
import { PdfInspectorError } from "../dist-core/extract/pdfInspector.js";
import { RasterisationCancelled } from "../dist-core/ocr/rasterisePages.js";
import { OcrEngineError } from "../dist-core/ocr/tesseractEngine.js";
import { OcrDataUnavailableError } from "../dist-core/ocr/trainedData.js";
import { EXIT_CODE, type ExitCode } from "./exit.js";

/**
 * One thing that went wrong, in the terms the caller reads: a number, a sentence, and where
 * possible a command that would fix it.
 */
export interface CliFailure {
  code: ExitCode;
  message: string;
  /** A runnable command that would make the same run succeed, when one exists. */
  remedy?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * An error and everything it was raised from.
 *
 * Boundaries wrap what they catch, so the fact worth classifying is often one level down: a
 * native module that will not load surfaces as the extractor's own error with the real reason
 * as its cause. Bounded, because a cause chain can be circular.
 */
function* causeChain(error: unknown, limit = 8): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < limit; depth += 1) {
    yield current;
    if (typeof current !== "object" || current === null || !("cause" in current)) return;
    current = current.cause;
  }
}

/**
 * Is this the store telling us somebody else holds the write lock?
 *
 * better-sqlite3 raises `SqliteError` with a `code` of `SQLITE_BUSY`, which is a condition
 * rather than a fault: the application is indexing and this run should be tried again.
 */
function isBusy(error: unknown): boolean {
  return [...causeChain(error)].some((link) => codeOf(link)?.startsWith("SQLITE_BUSY") === true);
}

const DEPENDENCY_CODES = new Set(["ERR_DLOPEN_FAILED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]);

/** A native module or bundled asset that will not load. Distinct from anything the user did. */
function isMissingDependency(error: unknown): boolean {
  for (const link of causeChain(error)) {
    const code = codeOf(link);
    if (code !== undefined && DEPENDENCY_CODES.has(code)) return true;
    // Narrow on purpose. An earlier version also matched any message mentioning a `.node` file,
    // which a perfectly ordinary native error does.
    if (/Cannot find module|dlopen/.test(messageOf(link))) return true;
  }
  return false;
}

/**
 * Classify a failure that happened while working on one document.
 *
 * **`parseFailed` is claimed only for errors that came out of the parse boundary**, which is the
 * one place that knows a document could not be read: `extractPagesFromPdf` gives everything its
 * native call raises the type `PdfInspectorError`. Anything else — a model that would not load, a
 * socket that closed, a method that was not a function — stays `unexpected`, because telling
 * somebody their PDF is corrupt sends them to look at the wrong thing entirely.
 *
 * Order matters: a missing native module surfaces *through* the parse boundary, wrapped, so it
 * is recognised before the wrapper's own type is.
 */
export function classifyDocumentFailure(error: unknown, target: string): CliFailure {
  if (error instanceof AccessDeniedError) {
    return { code: EXIT_CODE.accessDenied, message: error.message, remedy: remedyFor(error.path, error.kind, error.scope) };
  }
  // Stopping is an outcome, not a fault. Rendering a page is the one step long enough to be
  // cancelled part-way, and reporting that as an unexpected failure would tell an agent the tool
  // is broken when somebody had simply pressed Ctrl-C.
  if (error instanceof RasterisationCancelled) return { code: EXIT_CODE.interrupted, message: messageOf(error) };
  // Waiting is the remedy. This reaches here through the interactive grant, which changes the
  // consent record from inside a command.
  if (error instanceof AllowlistLockedError) {
    return {
      code: EXIT_CODE.indexBusy,
      message: error.message,
      ...(error.recoverCommand === undefined ? {} : { remedy: error.recoverCommand }),
    };
  }
  if (isMissingPathError(error)) return { code: EXIT_CODE.notFound, message: `No such file: ${target}` };
  // A directory where a document was expected is a mistyped command, not a fault. It reached the
  // `unexpected` fallback before, which is documented as "a bug, not a condition".
  if (codeOf(error) === "EISDIR") return { code: EXIT_CODE.usage, message: `${target} is a directory, not a document.` };
  // The OCR language data is a bundled asset this installation is missing, which is what code 8
  // is for. Reporting it as a bad PDF would send somebody to look at a document that is fine.
  // Both are the installation rather than the document: language data that is missing or will not
  // load, and an engine that will not start or fails a page. Reporting either as a bad PDF would
  // send somebody to look at a file that is fine.
  if (error instanceof OcrDataUnavailableError || error instanceof OcrEngineError) {
    return { code: EXIT_CODE.missingDependency, message: messageOf(error) };
  }
  if (isMissingDependency(error)) return { code: EXIT_CODE.missingDependency, message: messageOf(error) };
  if (isBusy(error)) return { code: EXIT_CODE.indexBusy, message: `The index is in use by another process: ${messageOf(error)}` };
  if (error instanceof PdfInspectorError) {
    return { code: EXIT_CODE.parseFailed, message: `Could not read ${target} as a PDF: ${messageOf(error)}` };
  }
  return { code: EXIT_CODE.unexpected, message: `Failed while reading ${target}: ${messageOf(error)}` };
}

/**
 * Classify a failure that ended the whole run.
 *
 * The fallback here is `unexpected`, not `parseFailed`: outside the per-document loop there is no
 * document to blame, and claiming there was would send the caller looking at the wrong thing.
 */
export function classifyRunFailure(error: unknown): CliFailure {
  if (error instanceof AccessDeniedError) {
    return { code: EXIT_CODE.accessDenied, message: error.message, remedy: remedyFor(error.path, error.kind, error.scope) };
  }
  if (error instanceof RasterisationCancelled) return { code: EXIT_CODE.interrupted, message: messageOf(error) };
  if (error instanceof AllowlistLockedError) {
    return {
      code: EXIT_CODE.indexBusy,
      message: error.message,
      ...(error.recoverCommand === undefined ? {} : { remedy: error.recoverCommand }),
    };
  }
  if (error instanceof OcrDataUnavailableError || error instanceof OcrEngineError) {
    return { code: EXIT_CODE.missingDependency, message: messageOf(error) };
  }
  if (isMissingDependency(error)) return { code: EXIT_CODE.missingDependency, message: messageOf(error) };
  if (isBusy(error)) return { code: EXIT_CODE.indexBusy, message: messageOf(error) };
  return { code: EXIT_CODE.unexpected, message: messageOf(error) };
}
