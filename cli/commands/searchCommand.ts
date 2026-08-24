import { remedyFor } from "../../dist-core/consent/allowlist.js";
import { shellQuote } from "../../dist-core/shellQuote.js";
import { findIndexedDocument, type DocumentLookup } from "../../dist-core/index/documentLookup.js";
import { searchDocument } from "../../dist-core/index/search.js";
import type { CommandContext } from "../context.js";
import { classifyDocumentFailure } from "../errors.js";
import { EXIT_CODE, type ExitCode } from "../exit.js";
import type { ParsedOptions } from "../parse.js";

/** What a hit's breadcrumb looks like once each heading carries the page it stands on. */
export interface SearchHitHeading {
  title: string;
  page: number | null;
}

export interface HumanSearchHit {
  page: number;
  score: number;
  snippet: string;
  headings: readonly SearchHitHeading[];
}

/**
 * The human rendering of search results.
 *
 * A heading the passage's own page carries is printed as its title alone; a heading inherited
 * from an earlier page says where it came from, because printing it bare is how a passage came
 * to appear to claim a heading it merely follows. A heading whose page was never recorded
 * prints bare too — guessing a page would be worse than not showing one.
 */
export function renderSearchResultsHuman(results: readonly HumanSearchHit[]): string {
  if (results.length === 0) return "";
  return `${results
    .map((hit) => {
      const titles = hit.headings.map((heading) =>
        heading.page !== null && heading.page !== hit.page ? `p${heading.page}: ${heading.title}` : heading.title,
      );
      const heading = titles.length > 0 ? `  ${titles.join(" › ")}` : "";
      return `p${hit.page}  ${hit.score.toFixed(3)}${heading}\n    ${hit.snippet}`;
    })
    .join("\n")}\n`;
}

/**
 * Find the document, then search it.
 *
 * The lookup order is the point: a path already in the index is answered by a database query
 * with no filesystem call at all, so searching a library you have already indexed needs no
 * permission. Only a miss falls through to reading and hashing, and only that branch can be
 * refused — or, when someone is watching, granted.
 */
export async function runSearchCommand(
  context: CommandContext,
  positionals: readonly string[],
  options: ParsedOptions,
): Promise<ExitCode> {
  const query = positionals[0] ?? "";
  const path = options.text("path");
  const id = options.text("id");

  const lookupInput = {
    ...(path === undefined ? {} : { path }),
    ...(id === undefined ? {} : { contentHash: id }),
    readFile: context.readFile,
  };

  let lookup: DocumentLookup;
  try {
    lookup = await findIndexedDocument(context.store(), context.allowlist(), lookupInput);
    if (lookup.status === "denied") {
      // The database did not know this path. Offering the grant here rather than inside the
      // lookup keeps core free of anything that talks to a person.
      await context.requireAccess(lookup.path, "read");
      lookup = await findIndexedDocument(context.store(), context.allowlist(), lookupInput);
    }
  } catch (error) {
    const failure = classifyDocumentFailure(error, path ?? id ?? query);
    context.report.problem(failure);
    return failure.code;
  }

  if (lookup.status === "denied") {
    context.report.problem({
      code: EXIT_CODE.accessDenied,
      message: `Access denied: not permitted to read ${lookup.path}.`,
      remedy: remedyFor(lookup.path, "read"),
    });
    return EXIT_CODE.accessDenied;
  }

  if (lookup.status === "not-indexed") {
    const target = path ?? id ?? "";
    context.report.problem({
      code: EXIT_CODE.notIndexed,
      message: `Not in the index: ${target}`,
      // Single-quoted, never `JSON.stringify`: this is a shell command, and double quotes would
      // let `$(…)`, a backtick or a `$VAR` inside a file name run when somebody pasted it.
      ...(path === undefined ? {} : { remedy: `markpdf index ${shellQuote(path)}` }),
    });
    return EXIT_CODE.notIndexed;
  }

  const results = await searchDocument(context.store(), context.embedder(), {
    contentHash: lookup.document.contentHash,
    query,
    chunkingProfile: context.settings.chunkingProfile,
    topK: options.number("top-k"),
    // An explicit argument outranks the setting; absence falls back to it. The settings were
    // read for this run alone, so the fallback is whatever the application says right now.
    minScore: options.optionalNumber("min-score") ?? context.settings.minSemanticScore,
    signal: context.signal,
  });

  // Nothing is printed after a cancel. `runCli` would return 130 either way, but a caller reading
  // stdout would already have taken an answer from a run it had stopped.
  if (context.signal.aborted) return EXIT_CODE.interrupted;

  context.report.emit(
    {
      command: "search",
      contentHash: lookup.document.contentHash,
      name: lookup.document.name,
      path: lookup.document.filePath,
      readFromDisk: lookup.usedFilesystem,
      results,
    },
    () => renderSearchResultsHuman(results),
  );
  return EXIT_CODE.success;
}
