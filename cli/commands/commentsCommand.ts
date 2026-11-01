import { resolveReadableDocument } from "../../dist-core/agent/documentTarget.js";
import { buildCommentsReply, readComments } from "../../dist-core/annotations/commentsReply.js";
import { parsePageSelection } from "../../dist-core/documents/pageSelection.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET, renderReply } from "../../dist-core/output/budget.js";
import { readOpenDocuments } from "../../dist-core/session/openDocuments.js";
import type { CommandContext } from "../context.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

/**
 * `markpdf comments`: the comments and highlights of a saved PDF, bounded as the MCP tool is.
 *
 * The reply is built in core, so both surfaces promise the same bound and the same pagination. It
 * uses only the grants that exist: the shared resolver applies them, and nothing here asks the
 * person at the terminal for a new one, because a command an agent runs must not be able to widen
 * its own access.
 */

interface ReplyComment {
  page: number;
  type: string;
  origin: string;
  author: string | null;
  note: string | null;
  quote: string | null;
}

const ORIGIN_LABEL: Record<string, string> = {
  person_in_markpdf: "you, in MarkPDF",
  agent_via_markpdf: "AI agent",
  other_application: "another application",
};

function isReplyComment(value: unknown): value is ReplyComment {
  return typeof value === "object" && value !== null && "page" in value && "type" in value && "origin" in value;
}

function renderHuman(payload: Record<string, unknown>): string {
  const comments = Array.isArray(payload.comments) ? payload.comments.filter(isReplyComment) : [];
  const lines = [`${String(payload.name)}: ${String(payload.totalComments)} comments`];
  for (const comment of comments) {
    const who = comment.author === null ? ORIGIN_LABEL[comment.origin] : `${comment.author} (${ORIGIN_LABEL[comment.origin] ?? comment.origin})`;
    lines.push(`p${String(comment.page)}  ${comment.type}  ${who ?? ""}`);
    if (comment.quote !== null) lines.push(`    "${comment.quote}"`);
    if (comment.note !== null) lines.push(`    ${comment.note}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runCommentsCommand(context: CommandContext, options: ParsedOptions): Promise<ExitCode> {
  const pagesText = options.text("pages");
  let pages: number[] | undefined;
  if (pagesText !== undefined) {
    const selection = parsePageSelection(pagesText);
    if (!selection.ok) {
      context.report.problem({ code: EXIT_CODE.usage, message: selection.message });
      return EXIT_CODE.usage;
    }
    pages = selection.pages;
  }

  const target = resolveReadableDocument(
    { path: options.text("path"), id: options.text("id"), ref: options.text("ref") },
    {
      allowlist: context.allowlist(),
      openDocuments: () => readOpenDocuments(context.dataDir),
      indexedPath: (contentHash) => context.store().getDocument(contentHash)?.filePath ?? null,
    },
  );
  if (!target.ok) {
    const code = target.reason === "access_denied" ? EXIT_CODE.accessDenied : EXIT_CODE.notFound;
    context.report.problem({ code, message: target.message });
    return code;
  }

  let comments;
  try {
    comments = await readComments(await context.readFile(target.path), pages === undefined ? {} : { pages });
  } catch (error) {
    const where = target.open === null ? ` ${target.path}` : "";
    context.report.problem({
      code: EXIT_CODE.notFound,
      message: `Reading ${target.name}${where} failed: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`,
    });
    return EXIT_CODE.notFound;
  }

  const payload = buildCommentsReply({
    name: target.name,
    documentHash: comments.documentHash,
    entries: comments.entries,
    offset: options.number("offset"),
    contentBudget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    extra:
      target.open === null
        ? {}
        : { ref: target.open.ref, unsavedChanges: target.open.unsavedChanges, suggestions: target.open.suggestions ?? [] },
  });

  // The bounded reply, written as it was measured: compact JSON, not a pretty-printed copy that
  // would be larger than the bound it was fitted to.
  context.report.emitRendered(`${renderReply(payload)}\n`, () => renderHuman(payload));
  if (typeof payload.nextOffset === "number") {
    context.report.note(`More comments follow. Continue with --offset ${String(payload.nextOffset)}.`);
  }
  return EXIT_CODE.success;
}
