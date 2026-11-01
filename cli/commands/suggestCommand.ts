import { randomUUID } from "node:crypto";
import { resolveReadableDocument } from "../../dist-core/agent/documentTarget.js";
import { sendDesktopRequest } from "../../dist-core/agent/desktopChannel.js";
import { cleanAgentName, DESKTOP_REQUEST_VERSION } from "../../dist-core/agent/desktopRequests.js";
import { readOpenDocuments } from "../../dist-core/session/openDocuments.js";
import type { CommandContext } from "../context.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

const SUGGEST_DEADLINE_MS = 30_000;

/**
 * `markpdf suggest`: propose a highlight or a comment for the person to accept or reject.
 *
 * The rules of the MCP tool: a read grant on the file, the grants that already exist and no
 * others, and an open tab — a suggestion lives in an open tab, so this never starts MarkPDF.
 */
export async function runSuggestCommand(context: CommandContext, options: ParsedOptions): Promise<ExitCode> {
  const quote = options.text("quote") ?? null;
  const note = options.text("note") ?? null;
  if (quote === null && note === null) {
    context.report.problem({ code: EXIT_CODE.usage, message: "Give --quote, --note, or both." });
    return EXIT_CODE.usage;
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
  const open = target.open ?? readOpenDocuments(context.dataDir).documents.find((entry) => entry.path === target.path) ?? null;
  if (open === null) {
    context.report.problem({ code: EXIT_CODE.notFound, message: `${target.name} is not open in MarkPDF. Suggestions go to an open document.` });
    return EXIT_CODE.notFound;
  }

  const page = options.number("page");
  const result = await sendDesktopRequest({
    dataDir: context.dataDir,
    signal: context.signal,
    request: {
      version: DESKTOP_REQUEST_VERSION,
      id: randomUUID(),
      kind: "suggest",
      deadline: Date.now() + SUGGEST_DEADLINE_MS,
      target: { ref: open.ref },
      page,
      quote,
      note,
      agent: cleanAgentName(options.requiredText("agent")),
    },
  });
  if (result.status !== "added") {
    const code = result.reason === "access_denied" ? EXIT_CODE.accessDenied : EXIT_CODE.partialFailure;
    context.report.problem({ code, message: `${result.message ?? "MarkPDF did not add the suggestion."} (${result.reason ?? result.status})` });
    return code;
  }
  context.report.emit(
    { command: "suggest", status: "added", suggestionId: result.suggestionId ?? null, name: target.name, page },
    () => `Suggested on ${target.name}, page ${String(page)}. The person accepts or rejects it in MarkPDF.\n`,
  );
  return EXIT_CODE.success;
}
