import { resolveReadableDocument } from "../dist-core/agent/documentTarget.js";
import { buildCommentsReply, readComments } from "../dist-core/annotations/commentsReply.js";
import { parsePageSelection } from "../dist-core/documents/pageSelection.js";
import type { ArgumentValue } from "./arguments.js";
import type { ToolContext, ToolOutcome } from "./operations.js";

/**
 * `read_comments`: the comments and highlights a saved PDF carries, as data.
 *
 * The annotations are in the file and nowhere else — the index holds a document's text, not what
 * people wrote on it — so this always reads the file and always needs a read grant, whichever way
 * the document was named. The reply is built in core, the same reply the command line prints.
 */

function text(args: Record<string, ArgumentValue>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : "";
}

export async function runReadComments(context: ToolContext, args: Record<string, ArgumentValue>): Promise<ToolOutcome> {
  const pagesText = text(args, "pages");
  let pages: number[] | undefined;
  if (pagesText !== undefined) {
    const selection = parsePageSelection(pagesText);
    if (!selection.ok) return { ok: false, message: selection.message };
    pages = selection.pages;
  }

  const target = resolveReadableDocument(
    { path: text(args, "path"), id: text(args, "id"), ref: text(args, "ref") },
    {
      allowlist: context.allowlist(),
      openDocuments: context.openDocuments,
      indexedPath: (contentHash) => context.store().getDocument(contentHash)?.filePath ?? null,
    },
  );
  if (!target.ok) return { ok: false, message: target.message };

  let bytes: Uint8Array;
  try {
    bytes = await context.readFile(target.path);
  } catch (error) {
    // The path is the caller's own only when the caller typed it.
    const where = target.open === null ? ` ${target.path}` : "";
    return { ok: false, message: `Reading ${target.name}${where} failed${codeOf(error)}. It may have been moved or deleted.` };
  }

  let comments;
  try {
    comments = await readComments(bytes, pages === undefined ? {} : { pages });
  } catch (error) {
    return { ok: false, message: `${target.name} could not be read as a PDF${codeOf(error)}.` };
  }

  const offset = typeof args.offset === "number" ? args.offset : 0;
  const payload = buildCommentsReply({
    name: target.name,
    documentHash: comments.documentHash,
    entries: comments.entries,
    offset,
    contentBudget: context.budget,
    replyBudget: context.replyBudget,
    // For an open tab: whether it has unsaved edits, and what the person decided about each agent
    // suggestion — ids and decisions only, never text.
    extra:
      target.open === null
        ? {}
        : { ref: target.open.ref, unsavedChanges: target.open.unsavedChanges, suggestions: target.open.suggestions ?? [] },
  });
  return { ok: true, payload };
}
