import { randomUUID } from "node:crypto";
import { resolveIndexedDocument, resolveReadableDocument, type DocumentIdentity } from "../dist-core/agent/documentTarget.js";
import { makeEvidenceLink } from "../dist-core/agent/evidenceLink.js";
import { resolveRealPath } from "../dist-core/consent/allowlist.js";
import {
  cleanAgentName,
  DESKTOP_REQUEST_VERSION,
  UNNAMED_AGENT,
  type DesktopResult,
  type RevealRequest,
  type SuggestRequest,
} from "../dist-core/agent/desktopRequests.js";
import type { ArgumentValue } from "./arguments.js";
import type { ToolContext, ToolOutcome } from "./operations.js";

/**
 * `reveal`: show the person the passage an agent cites.
 *
 * Every rule that protects the person's documents is applied twice: here, so a refused request
 * never starts a process, and again in the desktop, which trusts nothing a request file says. The
 * first of those is a read grant on the document's file, also when the document is open and also
 * when it is indexed — the window matches the quote against the live document, and whether it was
 * found is information about that document.
 */

/** How long a reveal may take, including MarkPDF starting and opening the document. */
export const REVEAL_DEADLINE_MS = 30_000;
/** How long a suggestion may take. The document is already open, so this is generous. */
export const SUGGEST_DEADLINE_MS = 30_000;

function text(args: Record<string, ArgumentValue>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

export function agentNameOf(context: ToolContext): string {
  return cleanAgentName(context.clientName?.() ?? UNNAMED_AGENT);
}

/** A refused or failed answer from the desktop, as one sentence an agent can act on. */
export function desktopRefusal(result: DesktopResult): ToolOutcome {
  const reason = result.reason === undefined ? "" : ` (${result.reason})`;
  return { ok: false, message: `${result.message ?? "MarkPDF did not do this."}${reason}` };
}

function realPathOrSame(path: string): string {
  try {
    return resolveRealPath(path);
  } catch {
    return path;
  }
}

/** The signed link for a passage of an indexed document, or why there is none. */
export function evidenceLinkFor(
  context: ToolContext,
  identity: DocumentIdentity,
  page: number,
  quote: string | null,
): { ok: true; link: string; name: string } | { ok: false; reason: string; message: string } {
  const store = context.store();
  const indexed = resolveIndexedDocument(identity, {
    openDocuments: context.openDocuments,
    documentByHash: (contentHash) => store.getDocument(contentHash),
    documentByPath: (path) => store.getDocumentByPath(path) ?? store.getDocumentByPath(realPathOrSame(path)),
  });
  if (!indexed.ok) return indexed;
  if (context.evidenceLinkKey === undefined) return { ok: false, reason: "not_indexed", message: "Links cannot be made by this server." };
  const made = makeEvidenceLink(context.evidenceLinkKey(), { contentHash: indexed.contentHash, page, quote });
  if (!made.ok) {
    return {
      ok: false,
      reason: made.reason,
      message: made.reason === "quote_too_long" ? "The quote is too long for a link. Quote fewer words." : "No link can be made for this passage.",
    };
  }
  return { ok: true, link: made.link, name: indexed.name };
}

export async function runReveal(context: ToolContext, args: Record<string, ArgumentValue>, signal?: AbortSignal): Promise<ToolOutcome> {
  const page = args.page;
  if (typeof page !== "number") throw new Error("page reached reveal without validation.");
  const identity: DocumentIdentity = { path: text(args, "path"), id: text(args, "id"), ref: text(args, "ref") };
  const quote = text(args, "quote") ?? null;

  if (args.mode === "link") {
    // A link reads only the index and shows nothing now. Opening what it names is checked on click.
    const linked = evidenceLinkFor(context, identity, page, quote);
    if (!linked.ok) return { ok: false, message: `${linked.message} (${linked.reason})` };
    return { ok: true, payload: { status: "link", name: linked.name, page, link: linked.link } };
  }

  const target = resolveReadableDocument(
    identity,
    {
      allowlist: context.allowlist(),
      openDocuments: context.openDocuments,
      indexedPath: (contentHash) => context.store().getDocument(contentHash)?.filePath ?? null,
    },
  );
  if (!target.ok) return { ok: false, message: target.message };
  if (context.desktopRequest === undefined) return { ok: false, message: "MarkPDF's window cannot be reached from this server." };

  const request: RevealRequest = {
    version: DESKTOP_REQUEST_VERSION,
    id: randomUUID(),
    kind: "reveal",
    deadline: Date.now() + REVEAL_DEADLINE_MS,
    // A tab is named by its concrete reference, resolved once here: "active" could mean another
    // tab by the time the desktop reads the request.
    target: target.open === null ? { path: target.path } : { ref: target.open.ref },
    page,
    quote,
    agent: agentNameOf(context),
  };
  const result = await context.desktopRequest(request, signal ?? new AbortController().signal);
  if (result.status !== "shown" && result.status !== "page_only") return desktopRefusal(result);
  // A link to cite in the answer, when the document is indexed. Its absence is not a failure.
  const linked = evidenceLinkFor(context, identity, page, quote);
  return {
    ok: true,
    payload: {
      status: result.status,
      name: target.name,
      page,
      occurrences: result.occurrences ?? 0,
      ...(result.ref === undefined ? {} : { ref: result.ref }),
      link: linked.ok ? linked.link : null,
    },
  };
}

/**
 * `suggest_annotation`: propose a highlight or a comment for the person to accept or reject.
 *
 * The same read rule as a reveal, for the same reason, and one more: the document must already be
 * open. A suggestion lives in an open tab and nowhere else, so this never starts MarkPDF and never
 * opens a document — a refused suggestion starts no process at all.
 */
export async function runSuggest(context: ToolContext, args: Record<string, ArgumentValue>, signal?: AbortSignal): Promise<ToolOutcome> {
  const page = args.page;
  if (typeof page !== "number") throw new Error("page reached suggest_annotation without validation.");
  const quote = text(args, "quote") ?? null;
  const note = text(args, "note") ?? null;
  if (quote === null && note === null) return { ok: false, message: "Give a quote, a note, or both." };

  const target = resolveReadableDocument(
    { path: text(args, "path"), id: text(args, "id"), ref: text(args, "ref") },
    {
      allowlist: context.allowlist(),
      openDocuments: context.openDocuments,
      indexedPath: (contentHash) => context.store().getDocument(contentHash)?.filePath ?? null,
    },
  );
  if (!target.ok) return { ok: false, message: target.message };
  if (context.desktopRequest === undefined) return { ok: false, message: "MarkPDF's window cannot be reached from this server." };

  // A path or an id that no tab shows is refused here, before anything starts. The desktop applies
  // the same rule again for a request that skipped this check.
  const open = target.open ?? context.openDocuments().documents.find((entry) => entry.path === target.path) ?? null;
  if (open === null) {
    return { ok: false, message: `${target.name} is not open in MarkPDF. Suggestions go to an open document; ask the person to open it. (not_open)` };
  }

  const request: SuggestRequest = {
    version: DESKTOP_REQUEST_VERSION,
    id: randomUUID(),
    kind: "suggest",
    deadline: Date.now() + SUGGEST_DEADLINE_MS,
    target: { ref: open.ref },
    page,
    quote,
    note,
    agent: agentNameOf(context),
  };
  const result = await context.desktopRequest(request, signal ?? new AbortController().signal);
  if (result.status !== "added") return desktopRefusal(result);
  return {
    ok: true,
    payload: {
      status: "added",
      suggestionId: result.suggestionId ?? null,
      name: target.name,
      ref: open.ref,
      page,
      ...(quote === null ? {} : { occurrences: result.occurrences ?? 0 }),
    },
  };
}
