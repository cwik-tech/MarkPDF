import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { requireAccess } from "../../dist-core/consent/allowlist.js";
import { indexPdfDocument } from "../../dist-core/index/indexPdfDocument.js";
import { createOcrResolver } from "../ocrResolver.js";
import { batchExitCode, createFailureLog } from "../batch.js";
import type { CommandContext } from "../context.js";
import { classifyDocumentFailure, type CliFailure } from "../errors.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

interface IndexedReport {
  path: string;
  name: string;
  contentHash: string;
  pageCount: number;
  chunkCount: number;
  status: string;
}

interface Walk {
  files: string[];
  /** Directories that could not be opened, so one of them cannot lose the rest of the tree. */
  unreadable: string[];
}

/**
 * Every PDF under a directory, in a stable order.
 *
 * Entries beginning with a dot are skipped. `~/Library` and `.Trash` are full of documents
 * nobody meant to index, and a recursive walk that swept them in would quietly index things the
 * person was not thinking about when they granted the folder.
 *
 * Only regular files and real directories are followed. `readdir` with `withFileTypes` reports a
 * link as a link rather than as what it points at, so a link out of the granted tree is never
 * descended into or opened — and every file the walk produces is checked against the allowlist
 * again before it is read.
 *
 * A directory that cannot be opened is *recorded* rather than raised. Letting it propagate meant
 * one unreadable folder discarded every readable document in the tree and reported the run as a
 * bug.
 */
async function collectPdfs(root: string, into: Walk = { files: [], unreadable: [] }): Promise<Walk> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    into.unreadable.push(root);
    return into;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectPdfs(full, into);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) into.files.push(full);
  }
  return into;
}

/** Is this path a directory, without reading anything inside it? */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    // Missing, or unreadable. Either way the access check and the read below say so properly.
    return false;
  }
}

function renderHuman(documents: readonly IndexedReport[]): string {
  if (documents.length === 0) return "";
  return `${documents
    .map((document) => `${document.status.padEnd(7)} ${document.pageCount} pages, ${document.chunkCount} chunks  ${document.path}`)
    .join("\n")}\n`;
}

export async function runIndexCommand(
  context: CommandContext,
  positionals: readonly string[],
  options: ParsedOptions,
): Promise<ExitCode> {
  const recursive = options.boolean("recursive");
  const force = options.boolean("force");

  const documents: IndexedReport[] = [];
  const log = createFailureLog((failure) => context.report.problem(failure));
  const fail = (path: string, failure: CliFailure): void => log.add(path, failure);

  // Access is settled for every target before any of them is opened, and the store is only
  // touched inside the loop below — so a run refused on its only argument creates no index.
  const targets: string[] = [];
  for (const given of positionals) {
    // Read before every argument, not only before every document. A prompt cancelled with Ctrl-C
    // aborts the run's own cancellation rather than signalling the process, so a loop that never
    // looks would keep asking for each remaining path — and print a remedy for each — after the
    // person had already said no.
    if (context.signal.aborted) return EXIT_CODE.interrupted;

    // What the argument *is* is settled first. Demanding access before that meant a folder given
    // without `--recursive` was treated as a file, so the refusal offered a grant on the folder's
    // parent — every sibling of the folder somebody named — for a command that could not have
    // worked anyway. This costs one `lstat`, which the access check itself already performs.
    const directory = await isDirectory(given);
    if (directory && !recursive) {
      fail(given, { code: EXIT_CODE.usage, message: `${given} is a directory. Pass --recursive to index what is inside it.` });
      continue;
    }

    let resolved: string;
    try {
      // `--recursive` means the argument *is* the thing to work on, so a grant covers it rather
      // than everything beside it. Without `--recursive` the argument is one file, and the
      // containing folder is what a grant sensibly covers.
      resolved = await context.requireAccess(given, "read", directory ? "self" : "parent");
    } catch (error) {
      fail(given, classifyDocumentFailure(error, given));
      continue;
    }

    if (!directory) {
      targets.push(resolved);
      continue;
    }

    const walk = await collectPdfs(resolved);
    for (const path of walk.unreadable) {
      fail(path, { code: EXIT_CODE.accessDenied, message: `Could not open ${path}, so nothing under it was indexed.` });
    }
    if (walk.files.length === 0 && walk.unreadable.length === 0) context.report.note(`No PDFs under ${given}.`);
    for (const path of walk.files) {
      // Checked again, individually. The root was permitted once; these paths were produced by a
      // walk that took time, and the allowlist is what decides whether each one may be opened.
      try {
        targets.push(requireAccess(context.allowlist(), path, "read"));
      } catch (error) {
        fail(path, classifyDocumentFailure(error, path));
      }
    }
  }

  for (const target of targets) {
    if (context.signal.aborted) return EXIT_CODE.interrupted;
    let last = "";
    try {
      const bytes = await context.readFile(target);
      const result = await indexPdfDocument(context.store(), context.embedder(), {
        bytes,
        name: basename(target),
        filePath: target,
        chunkingProfile: context.settings.chunkingProfile,
        force,
        signal: context.signal,
        // The command line has no renderer, so a scanned page reaches the index only if
        // something here reads it. Passed as a function so that a document with a text layer
        // never loads the rasteriser or the recognition engine at all. It is not wrapped in a
        // catch: a document whose scanned pages could not be recognised must not be recorded as
        // a short document that succeeded.
        resolveOcr: createOcrResolver(context, basename(target)),
        onProgress: (progress) => {
          // Only when it changes. The pipeline reports per batch, and repeating one line for
          // every batch of a long document is noise rather than progress.
          const message = progress.message ?? "";
          if (message.length === 0 || message === last) return;
          last = message;
          context.report.progress(`${basename(target)}: ${message}`);
        },
      });
      if (result.status === "cancelled") return EXIT_CODE.interrupted;
      documents.push({
        path: target,
        name: basename(target),
        contentHash: result.contentHash,
        pageCount: result.pageCount,
        chunkCount: result.chunkCount,
        status: result.status,
      });
    } catch (error) {
      fail(target, classifyDocumentFailure(error, target));
    }
  }

  context.report.emit({ command: "index", documents, failures: log.reports }, () => renderHuman(documents));
  return batchExitCode(documents.length, log.failures);
}
