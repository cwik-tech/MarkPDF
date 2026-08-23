import { resolveDocumentPages } from "../dist-core/documents/documentPages.js";
import { boundPages, fitReply } from "../dist-core/output/budget.js";
import type { OpenDocumentEntry } from "../dist-core/session/openDocuments.js";
import type { ArgumentValue } from "./arguments.js";
import { bytesOfText, selectPages, type ToolContext, type ToolOutcome } from "./operations.js";
import { ACTIVE_DOCUMENT } from "./toolSchemas.js";

/**
 * The two tools that reach the running application rather than a path somebody typed.
 *
 * Everything here is about turning "the document I have open" into the identity the rest of the
 * program already understands. Once that is done the work is `resolveDocumentPages`, exactly as it
 * is for `read_pages` — there is no second way to read a document in this program, and adding one
 * would be a second place for the access rules to be almost right.
 *
 * **A path never leaves these tools.** The application records one so that permission can be
 * proved for a document that is not yet indexed, and that is its only use. A caller reaching for
 * these tools is one that does not know where anything is; answering with a path would hand over
 * precisely what it was spared from asking for, and it would do so for every document in the list
 * rather than the one being read.
 */

function text(args: Record<string, ArgumentValue>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The one thing a thrown error may contribute to a reply: its code, never its message.
 *
 * Node puts the path it was working on into the message of almost every filesystem error —
 * `ENOENT: no such file or directory, open '/Users/...'` — and the call boundary answers a thrown
 * exception with that message verbatim. For the four tools that take a path that is fine, because
 * the caller supplied it. Here it would disclose, inside a failure, the one thing these tools
 * promise never to return.
 *
 * A code is different in kind: a short constant from a fixed vocabulary, checked against that
 * shape so nothing longer or stranger can arrive by this route. It is also the useful half — an
 * `ENOENT` says the file went away, which is exactly what happens when somebody moves a document
 * MarkPDF still has open.
 */
function failureCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null;
}

function because(error: unknown): string {
  const code = failureCode(error);
  return code === null ? "" : ` (${code})`;
}

/** The record of what is open could not be read at all. Said without naming where it is kept. */
function recordUnavailable(error: unknown): string {
  return `MarkPDF's record of which documents are open could not be read${because(error)}. This does not mean nothing is open; try again.`;
}

/** What an open document looks like to a caller: a name and a handle, and nowhere on disk. */
function publicView(entry: OpenDocumentEntry, indexed: boolean): Record<string, unknown> {
  return {
    ref: entry.ref,
    kind: entry.kind,
    name: entry.name,
    pageCount: entry.pageCount,
    indexed,
    unsavedChanges: entry.unsavedChanges,
    active: entry.active,
    activeInWindow: entry.activeInWindow,
    window: entry.window,
  };
}

/**
 * Is this document actually in the index, rather than merely remembered as having been?
 *
 * The window records a content hash when it finishes indexing and has no way to hear that somebody
 * later cleared the index or forgot the document. Checking makes `indexed` mean what a caller will
 * find when it reads, instead of what was true once.
 */
function isIndexed(context: ToolContext, entry: OpenDocumentEntry): boolean {
  if (entry.contentHash === null) return false;
  return context.store().getDocument(entry.contentHash) !== null;
}

export function runListOpenDocuments(context: ToolContext, _args: Record<string, ArgumentValue>): Promise<ToolOutcome> {
  let view;
  let entries;
  try {
    view = context.openDocuments();
    // Resolved before fitting, because `fitReply` builds the reply several times and each rebuild
    // would otherwise repeat every index lookup.
    //
    // Both of these reach outside this process — one reads the record on disk, the other the
    // index — and both raise errors that name the directory they were reading. The guard is drawn
    // around exactly those two and nothing else, so a fault in the bounding below is still
    // reported as itself.
    entries = view.documents.map((entry) => publicView(entry, isIndexed(context, entry)));
  } catch (error) {
    return Promise.resolve({ ok: false, message: recordUnavailable(error) });
  }

  // Bounded like every other reply. This one carries no document text, so what can make it large
  // is many tabs with long names — and the list arrives active-first, so the document a caller is
  // most likely to have asked about is never the one a cut removes.
  const fitted = fitReply(entries.length, context.replyBudget, (keep) => ({
    windows: view.windows,
    activeRef: view.activeRef,
    documents: entries.slice(0, keep),
    truncated: keep < entries.length,
    omittedDocuments: entries.length - keep,
    omittedBytes: bytesOfText(entries.slice(keep), (entry) => String(entry.name)),
    unreadableWindows: view.unreadableWindows,
  }));

  // Nothing open is an answer, not a failure: "you have nothing open" is what was asked for.
  return Promise.resolve({ ok: true, payload: fitted.payload });
}

/** The open document a caller meant, or a sentence explaining why there is not one. */
function chosen(context: ToolContext, args: Record<string, ArgumentValue>): OpenDocumentEntry | string {
  const view = context.openDocuments();
  const ref = text(args, "ref") ?? ACTIVE_DOCUMENT;

  if (ref === ACTIVE_DOCUMENT) {
    if (view.activeRef === null) {
      return "MarkPDF has no document open. Open one, or name a document by path with read_pages.";
    }
    const active = view.documents.find((entry) => entry.ref === view.activeRef);
    if (active === undefined) {
      return "MarkPDF reported an active document it did not list. Call list_open_documents and name one.";
    }
    return active;
  }

  const named = view.documents.find((entry) => entry.ref === ref);
  if (named === undefined) {
    return `No open document has the reference ${ref}. Call list_open_documents for current references; a document that has been closed no longer has one.`;
  }
  return named;
}

export async function runReadOpenDocument(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  let target;
  try {
    target = chosen(context, args);
  } catch (error) {
    // Reading the record is the first thing this does, and it can fail before there is a document
    // to talk about.
    return { ok: false, message: recordUnavailable(error) };
  }
  if (typeof target === "string") return { ok: false, message: target };

  // Named rather than silently skipped. Somebody looking at their notes who asks about "the
  // document I have open" must not be answered about a different file that happens to be a PDF.
  if (target.kind !== "pdf") {
    return {
      ok: false,
      message: `The document ${target.name} is a Markdown file, and this tool reads PDF documents. list_open_documents shows which of the open documents are PDFs.`,
    };
  }

  let resolved;
  try {
    resolved = await resolveDocumentPages(context.store(), context.allowlist(), {
      // Identity comes from the application's own record. It is a name, not an authority: the
      // resolver below applies the same consent rules it applies to a path a caller typed, so a
      // forged record buys nothing a forged path would not.
      ...(target.contentHash === null ? {} : { contentHash: target.contentHash }),
      ...(target.path === null ? {} : { path: target.path }),
      // Index first, so a document the application has already indexed — which is nearly all of
      // them — is read with no filesystem permission at all, and the file is opened only when it
      // has not been.
      access: "index-first",
      readFile: context.readFile,
      ...(context.resolveOcr === undefined ? {} : { resolveOcr: context.resolveOcr }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // The document was permitted and the file was reached for, and opening it failed — which is
    // what a document moved, renamed or deleted since MarkPDF opened it looks like. The exception
    // carries the path; this answer does not.
    return {
      ok: false,
      message: `MarkPDF has ${target.name} open, but reading it failed${because(error)}. The file may have been moved, renamed or deleted since MarkPDF opened it, or may no longer be readable.`,
    };
  }

  if (resolved.status !== "found") {
    return { ok: false, message: explainOpen(resolved.status, target) };
  }

  const chosenPages = selectPages(args, resolved.pages);
  if (!chosenPages.ok) return { ok: false, message: chosenPages.message };

  const bounded = boundPages(chosenPages.pages, context.budget);
  const fitted = fitReply(bounded.pages.length, context.replyBudget, (keep) => ({
    ref: target.ref,
    name: target.name,
    contentHash: resolved.document?.contentHash ?? null,
    readFromIndex: resolved.fromIndex,
    unsavedChanges: target.unsavedChanges,
    pages: bounded.pages.slice(0, keep),
    truncated: bounded.truncated || keep < bounded.pages.length,
    omittedBytes: bounded.omittedBytes + bytesOfText(bounded.pages.slice(keep), (page) => page.markdown),
    totalBytes: bounded.totalBytes,
  }));

  return { ok: true, payload: fitted.payload };
}

/**
 * Why an open document could not be read, said without naming where it lives.
 *
 * The four tools that take a path echo it back in a refusal, because the caller supplied it and
 * the remedy has to be pastable. Here the caller supplied a reference, so the path is something
 * only this program knows — and a refusal is not an excuse to disclose it. The remedy names the
 * action instead of the folder, which is the most that can be said without giving it away.
 */
function explainOpen(status: string, target: OpenDocumentEntry): string {
  switch (status) {
    case "denied":
      return `MarkPDF has ${target.name} open, but this server is not permitted to read it and it is not in the index. Index it in MarkPDF, or grant its folder with markpdf --allow-read.`;
    case "no-stored-text":
      return `${target.name} is indexed, but its text was not stored. Index it again to make its pages readable.`;
    case "no-recorded-path":
    case "not-indexed":
      return `${target.name} is open in MarkPDF but has not been indexed, and there is no saved file to read it from. Once MarkPDF has indexed it, this tool can read it.`;
    case "cancelled":
      return "The request was cancelled.";
    default:
      return `${target.name} could not be read.`;
  }
}
