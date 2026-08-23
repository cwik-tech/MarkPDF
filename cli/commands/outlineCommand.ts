import { readDocumentPages } from "../../dist-core/extract/readDocumentPages.js";
import { findIndexedDocument } from "../../dist-core/index/documentLookup.js";
import type { MarkdownPage } from "../../dist-core/index/markdownBlocks.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION } from "../../dist-core/models.js";
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

/**
 * The pages this document's headings come from, preferring the ones already stored.
 *
 * The same order as `search`: a document already in the index is answered from the index, so
 * outlining a library you have indexed needs no filesystem permission. Only a miss reads the
 * file, and only that branch can be refused.
 */
async function pagesFor(
  context: CommandContext,
  given: string,
): Promise<{ pages: MarkdownPage[]; fromIndex: boolean } | { cancelled: true }> {
  // Read each path at most once. The lookup's fallback branch hashes the file to find it by
  // content, and extraction below needs the same bytes; without this a granted document that is
  // not yet indexed would be read off disk twice.
  const reads = new Map<string, Promise<Uint8Array>>();
  const readOnce = (path: string): Promise<Uint8Array> => {
    const started = reads.get(path);
    if (started !== undefined) return started;
    const pending = context.readFile(path);
    reads.set(path, pending);
    return pending;
  };

  const lookup = await findIndexedDocument(context.store(), context.allowlist(), {
    path: given,
    readFile: readOnce,
  });

  if (lookup.status === "found") {
    const cached = context.store().getMarkdown(lookup.document.id, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION);
    if (cached !== null) {
      // `source` is recorded per chunk, not per cached page, and heading detection does not
      // depend on it — a `## Heading` line is one however the text was read.
      return { pages: cached.map((page) => ({ page: page.page, markdown: page.markdown, source: "pdf" })), fromIndex: true };
    }
  }

  const resolved = await context.requireAccess(given, "read");
  // The same reading as `index` and `convert`: a scanned page is recognised rather than left
  // blank, so a document has one outline whichever command asks for it.
  const read = await readDocumentPages({
    bytes: await readOnce(resolved),
    resolveOcr: createOcrResolver(context, given),
    signal: context.signal,
  });
  if (read.status === "cancelled") return { cancelled: true };
  return {
    pages: read.pages.map((page) => ({
      page: page.page,
      markdown: page.markdown,
      // A page nothing could read has no text, so it contributes no headings either way. `pdf`
      // is the honest label for "not recognised text".
      source: page.source === "ocr" ? "ocr" : "pdf",
    })),
    fromIndex: false,
  };
}

export async function runOutlineCommand(
  context: CommandContext,
  positionals: readonly string[],
  options: ParsedOptions,
): Promise<ExitCode> {
  const given = positionals[0] ?? "";
  const depth = options.number("depth");

  let source: Awaited<ReturnType<typeof pagesFor>>;
  try {
    source = await pagesFor(context, given);
  } catch (error) {
    const failure = classifyDocumentFailure(error, given);
    context.report.problem(failure);
    return failure.code;
  }
  if ("cancelled" in source) return EXIT_CODE.interrupted;

  const entries = outlineFromPages(source.pages, depth);
  if (entries.length === 0) context.report.note(`No headings found in ${given}.`);

  context.report.emit(
    { command: "outline", path: given, depth, readFromIndex: source.fromIndex, entries },
    () => renderHuman(entries),
  );
  return EXIT_CODE.success;
}
