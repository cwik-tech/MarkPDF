import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { renderMarkdownDocument, type MarkdownRenderMode } from "../../dist-core/convert/renderMarkdown.js";
import { readDocumentPages } from "../../dist-core/extract/readDocumentPages.js";
import { batchExitCode, createFailureLog } from "../batch.js";
import type { CommandContext } from "../context.js";
import { classifyDocumentFailure } from "../errors.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import { createOcrResolver } from "../ocrResolver.js";
import { parsePageSelection } from "../pageRange.js";
import type { ParsedOptions } from "../parse.js";

interface ConvertedReport {
  path: string;
  pageCount: number;
  pages: number[];
  out: string | null;
  markdown: string | null;
}

/** `clean` is the plan's spelling at the command line; the renderer knows the same two modes. */
function renderMode(value: string): MarkdownRenderMode {
  return value === "clean" ? "clean" : "page-preserving";
}

export async function runConvertCommand(
  context: CommandContext,
  positionals: readonly string[],
  options: ParsedOptions,
): Promise<ExitCode> {
  const mode = renderMode(options.requiredText("mode"));
  const out = options.text("out");
  const pagesOption = options.text("pages");

  // Syntax is settled before anything is read: a mistyped range should not cost a parse, and
  // certainly should not cost a permission prompt.
  const selection = pagesOption === undefined ? null : parsePageSelection(pagesOption);
  if (selection !== null && !selection.ok) {
    context.report.problem({ code: EXIT_CODE.usage, message: selection.message });
    return EXIT_CODE.usage;
  }

  const converted: ConvertedReport[] = [];
  const log = createFailureLog((failure) => context.report.problem(failure));

  for (const given of positionals) {
    if (context.signal.aborted) return EXIT_CODE.interrupted;
    try {
      const resolved = await context.requireAccess(given, "read");
      // The same reading as `index` and `outline`. Converting a scan to an empty page while
      // indexing the same document recognised it would be the worst of both.
      const read = await readDocumentPages({
        bytes: await context.readFile(resolved),
        resolveOcr: createOcrResolver(context, basename(given)),
        // The selection bounds the recognition too. Filtering afterwards would still have
        // rasterised and read every scanned page in the document first.
        ...(selection === null || !selection.ok ? {} : { ocrOnlyPages: selection.pages }),
        signal: context.signal,
      });
      if (read.status === "cancelled") return EXIT_CODE.interrupted;
      const all = read.pages;

      let chosen = all.map((page) => ({ page: page.page, markdown: page.markdown }));
      if (selection !== null && selection.ok) {
        const beyond = selection.pages.filter((page) => page > all.length);
        if (beyond.length > 0) {
          log.add(given, {
            code: EXIT_CODE.usage,
            message: `--pages names page ${beyond.join(", ")}, but ${basename(given)} has ${all.length}.`,
          });
          continue;
        }
        const wanted = new Set(selection.pages);
        chosen = chosen.filter((page) => wanted.has(page.page));
      }

      const markdown = renderMarkdownDocument(chosen, mode);
      let writtenTo: string | null = null;
      if (out !== undefined) {
        // A separate grant. Permission to read a library is not permission to write into it,
        // and this is the command where that distinction is doing real work.
        writtenTo = await context.requireAccess(out, "write");
        await writeFile(writtenTo, markdown, "utf8");
        context.report.note(`Wrote ${writtenTo}`);
      }

      converted.push({
        path: resolved,
        pageCount: all.length,
        pages: chosen.map((page) => page.page),
        out: writtenTo,
        // Left out when it is already on disk: repeating a whole document in the JSON report
        // would double the memory and tell the caller nothing it cannot read from the file.
        markdown: writtenTo === null ? markdown : null,
      });
    } catch (error) {
      log.add(given, classifyDocumentFailure(error, given));
    }
  }

  // Exactly one write to stdout, whatever the mode. Emitting each document as it finished would
  // put several JSON objects on the stream and leave nothing able to parse it.
  context.report.emit(
    { command: "convert", documents: converted, failures: log.reports },
    () => converted.map((document) => document.markdown ?? "").join("\n"),
  );
  return batchExitCode(converted.length, log.failures);
}
