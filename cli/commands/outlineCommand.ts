import { resolveDocumentPages, type DocumentPages } from "../../dist-core/documents/documentPages.js";
import type { MarkdownPage } from "../../dist-core/index/markdownBlocks.js";
import { outlineFromPages, type OutlineEntry } from "../../dist-core/outline/documentOutline.js";
import type { CommandContext } from "../context.js";
import { createOcrResolver } from "../ocrResolver.js";
import { classifyDocumentFailure } from "../errors.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

function renderHuman(entries: readonly OutlineEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries
    .map((entry) => `${"  ".repeat(entry.level - 1)}${entry.title}${" ".repeat(2)}p${entry.page}`)
    .join("\n")}\n`;
}

export async function runOutlineCommand(
  context: CommandContext,
  positionals: readonly string[],
  options: ParsedOptions,
): Promise<ExitCode> {
  const given = positionals[0] ?? "";
  const depth = options.number("depth");

  // One shared operation, the same one the MCP tools use: index first, filesystem only if it has
  // to. Written once because the order is a security property — a document already in the index is
  // answered from the index, and asking about it needs no permission.
  const resolve = async (): Promise<DocumentPages> =>
    await resolveDocumentPages(context.store(), context.allowlist(), {
      path: given,
      access: "index-first",
      readFile: context.readFile,
      resolveOcr: createOcrResolver(context, given),
      signal: context.signal,
    });

  let source: DocumentPages;
  try {
    source = await resolve();
    if (source.status === "denied") {
      // Offering the grant here rather than inside the shared operation keeps core free of
      // anything that talks to a person.
      await context.requireAccess(source.path, "read");
      source = await resolve();
    }
  } catch (error) {
    const failure = classifyDocumentFailure(error, given);
    context.report.problem(failure);
    return failure.code;
  }

  if (source.status === "cancelled") return EXIT_CODE.interrupted;
  if (source.status === "denied") {
    const failure = classifyDocumentFailure(
      Object.assign(new Error(`Access denied: not permitted to read ${source.path}.`), { code: "EACCES" }),
      given,
    );
    context.report.problem(failure);
    return EXIT_CODE.accessDenied;
  }
  // `no-recorded-path` cannot arise here — this command always names a file — but it is a state
  // of the shared resolver, and a surface that quietly failed to handle one would be a surface
  // that had drifted from it.
  if (source.status === "not-indexed" || source.status === "no-stored-text" || source.status === "no-recorded-path") {
    context.report.problem({ code: EXIT_CODE.notFound, message: `No such file: ${given}` });
    return EXIT_CODE.notFound;
  }

  const pages: MarkdownPage[] = source.pages;
  const entries = outlineFromPages(pages, depth);
  if (entries.length === 0) context.report.note(`No headings found in ${given}.`);

  context.report.emit(
    { command: "outline", path: given, depth, readFromIndex: source.fromIndex, entries },
    () => renderHuman(entries),
  );
  return EXIT_CODE.success;
}
