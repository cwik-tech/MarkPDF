import { randomUUID } from "node:crypto";
import { resolveIndexedDocument, resolveReadableDocument } from "../../dist-core/agent/documentTarget.js";
import { makeEvidenceLink, readOrCreateLinkKey } from "../../dist-core/agent/evidenceLink.js";
import { resolveRealPath } from "../../dist-core/consent/allowlist.js";
import { sendDesktopRequest } from "../../dist-core/agent/desktopChannel.js";
import { cleanAgentName, DESKTOP_REQUEST_VERSION } from "../../dist-core/agent/desktopRequests.js";
import { readOpenDocuments } from "../../dist-core/session/openDocuments.js";
import type { CommandContext } from "../context.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

/** How long a reveal may take, including MarkPDF starting and opening the document. */
const REVEAL_DEADLINE_MS = 30_000;

/**
 * `markpdf reveal`: show the person a cited passage in the running window.
 *
 * The same rules as the MCP tool, through the same shared resolver: a read grant on the file, the
 * grants that already exist and no others, and a concrete tab rather than "active" in the request
 * the desktop reads.
 */
function realPathOrSame(path: string): string {
  try {
    return resolveRealPath(path);
  } catch {
    return path;
  }
}

/** `--mode link`: a signed link from the index alone, shown nowhere now. */
function runLinkMode(context: CommandContext, options: ParsedOptions): ExitCode {
  const store = context.store();
  const indexed = resolveIndexedDocument(
    { path: options.text("path"), id: options.text("id"), ref: options.text("ref") },
    {
      openDocuments: () => readOpenDocuments(context.dataDir),
      documentByHash: (contentHash) => store.getDocument(contentHash),
      documentByPath: (path) => store.getDocumentByPath(path) ?? store.getDocumentByPath(realPathOrSame(path)),
    },
  );
  if (!indexed.ok) {
    context.report.problem({ code: EXIT_CODE.notFound, message: indexed.message });
    return EXIT_CODE.notFound;
  }
  const page = options.number("page");
  const made = makeEvidenceLink(readOrCreateLinkKey(context.dataDir), { contentHash: indexed.contentHash, page, quote: options.text("quote") ?? null });
  if (!made.ok) {
    context.report.problem({ code: EXIT_CODE.usage, message: "The quote is too long for a link. Quote fewer words." });
    return EXIT_CODE.usage;
  }
  context.report.emit({ command: "reveal", status: "link", name: indexed.name, page, link: made.link }, () => `${made.link}\n`);
  return EXIT_CODE.success;
}

export async function runRevealCommand(context: CommandContext, options: ParsedOptions): Promise<ExitCode> {
  if (options.requiredText("mode") === "link") return runLinkMode(context, options);
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

  const page = options.number("page");
  const result = await sendDesktopRequest({
    dataDir: context.dataDir,
    signal: context.signal,
    request: {
      version: DESKTOP_REQUEST_VERSION,
      id: randomUUID(),
      kind: "reveal",
      deadline: Date.now() + REVEAL_DEADLINE_MS,
      target: target.open === null ? { path: target.path } : { ref: target.open.ref },
      page,
      quote: options.text("quote") ?? null,
      agent: cleanAgentName(options.requiredText("agent")),
    },
  });

  if (result.status !== "shown" && result.status !== "page_only") {
    const code = result.reason === "access_denied" ? EXIT_CODE.accessDenied : EXIT_CODE.partialFailure;
    context.report.problem({ code, message: `${result.message ?? "MarkPDF did not show the passage."} (${result.reason ?? result.status})` });
    return code;
  }
  const reply = { command: "reveal", status: result.status, name: target.name, page, occurrences: result.occurrences ?? 0 };
  context.report.emit(reply, () =>
    result.status === "shown"
      ? `Showing ${target.name}, page ${String(page)}.\n`
      : `Showing ${target.name}, page ${String(page)}. The quote was not found on that page.\n`,
  );
  return EXIT_CODE.success;
}
