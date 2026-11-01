import { remedyFor } from "../../dist-core/consent/allowlist.js";
import { agentDiscovery } from "../../dist-core/consent/discovery.js";
import { searchLibrary, type LibrarySearchHit } from "../../dist-core/index/librarySearch.js";
import type { SemanticSearchResult } from "../../dist-core/index/search.js";
import { DEFAULT_CONTENT_BUDGET, DEFAULT_REPLY_BUDGET } from "../../dist-core/output/budget.js";
import { boundSearchReply } from "../../dist-core/output/searchReply.js";
import { shellQuote } from "../../dist-core/shellQuote.js";
import { findIndexedDocument, type DocumentLookup } from "../../dist-core/index/documentLookup.js";
import { searchDocument } from "../../dist-core/index/search.js";
import { planSearch, type SearchPlan } from "../../dist-core/index/searchMode.js";
import { isSearchMode } from "../../dist-core/models.js";
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

/** A library hit, as the human rendering needs it: which document, then the same as a single-document hit. */
export interface HumanLibraryHit extends HumanSearchHit {
  name: string;
  matchedBy: readonly string[];
}

/** One line per hit: document, page, score, which rankings found it, and the breadcrumb. */
export function renderLibraryResultsHuman(results: readonly HumanLibraryHit[]): string {
  if (results.length === 0) return "";
  return `${results
    .map((hit) => {
      const titles = hit.headings.map((heading) =>
        heading.page !== null && heading.page !== hit.page ? `p${heading.page}: ${heading.title}` : heading.title,
      );
      const heading = titles.length > 0 ? `  ${titles.join(" › ")}` : "";
      return `${hit.name}  p${hit.page}  ${hit.score.toFixed(3)}  ${hit.matchedBy.join("+")}${heading}\n    ${hit.snippet}`;
    })
    .join("\n")}\n`;
}

/** The document text a hit carries, which is what the content bound counts. */
function documentTextOf(hit: SemanticSearchResult): string {
  return hit.snippet + hit.headingPath.join("");
}

function libraryTextOf(hit: LibrarySearchHit): string {
  return documentTextOf(hit) + hit.name + (hit.path ?? "");
}

/** Progress for an exact-word backfill that a search has to finish first, on stderr. */
function backfillProgress(context: CommandContext): (indexed: number) => void {
  let total = 0;
  return (indexed) => {
    total += indexed;
    context.report.progress(`Adding older passages to the exact-word index: ${total}`);
  };
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

  // Decided before anything is looked up: a query this mode cannot run must not first cost a grant
  // prompt. The threshold goes in as the caller gave it, so the rule can tell an explicit one from
  // the setting's.
  const planned = planCommandSearch(context, query, options);
  if (!planned.ok) {
    context.report.problem({ code: EXIT_CODE.usage, message: planned.message });
    return EXIT_CODE.usage;
  }
  const plan = planned.plan;

  if (options.boolean("library")) return await runLibrarySearch(context, query, plan, options);

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
    mode: plan.mode,
    minScore: plan.minScore,
    signal: context.signal,
    onExactIndexProgress: backfillProgress(context),
  });

  // Nothing is printed after a cancel. `runCli` would return 130 either way, but a caller reading
  // stdout would already have taken an answer from a run it had stopped.
  if (context.signal.aborted) return EXIT_CODE.interrupted;

  const document = lookup.document;
  const { payload, kept } = boundSearchReply({
    hits: results,
    textOf: documentTextOf,
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    render: (hits, omission) => ({
      command: "search",
      mode: plan.mode,
      contentHash: document.contentHash,
      name: document.name,
      path: document.filePath,
      readFromDisk: lookup.usedFilesystem,
      ...omission,
      results: hits,
    }),
  });
  if (kept.length < results.length) context.report.note(`${results.length - kept.length} more passages did not fit in one answer.`);
  context.report.emit(payload, () => renderSearchResultsHuman(kept));
  return EXIT_CODE.success;
}

/**
 * Search every document this caller may discover.
 *
 * Index only: nothing is opened, so nothing needs a grant to run. The grants decide what is
 * discovered — documents the command indexed from a folder that is still granted — and how many were
 * left out is said on stderr, without naming any of them.
 */
async function runLibrarySearch(
  context: CommandContext,
  query: string,
  plan: SearchPlan,
  options: ParsedOptions,
): Promise<ExitCode> {
  const found = await searchLibrary(context.store(), context.embedder(), {
    query,
    chunkingProfile: context.settings.chunkingProfile,
    mode: plan.mode,
    minScore: plan.minScore,
    topK: options.number("top-k"),
    discover: agentDiscovery(context.allowlist()),
    signal: context.signal,
    onExactIndexProgress: backfillProgress(context),
  });
  if (context.signal.aborted) return EXIT_CODE.interrupted;

  const { payload, kept } = boundSearchReply({
    hits: found.hits,
    textOf: libraryTextOf,
    budget: DEFAULT_CONTENT_BUDGET,
    replyBudget: DEFAULT_REPLY_BUDGET,
    render: (hits, omission) => ({
      command: "search",
      scope: "library",
      mode: found.mode,
      documentsSearched: found.documentsSearched,
      documentsNotDiscoverable: found.documentsNotDiscoverable,
      documentsOutsideActiveScope: found.documentsOutsideActiveScope,
      candidatesTruncated: found.candidatesTruncated,
      ...omission,
      results: hits.map((hit) => ({
        contentHash: hit.contentHash,
        name: hit.name,
        path: hit.path,
        page: hit.page,
        score: hit.score,
        semanticScore: hit.semanticScore,
        matchedBy: hit.matchedBy,
        headingPath: hit.headingPath,
        headings: hit.headings,
        headingInherited: hit.headingInherited,
        snippet: hit.snippet,
        id: hit.id,
      })),
    }),
  });

  const hidden = found.documentsNotDiscoverable;
  if (hidden > 0) {
    context.report.note(
      `${hidden} indexed ${hidden === 1 ? "document is" : "documents are"} not included: outside your read grants, or not indexed by the markpdf command. ` +
        `Grant the folder with markpdf --allow-read <dir>, then run markpdf index <dir> --recursive.`,
    );
  }
  if (kept.length < found.hits.length) context.report.note(`${found.hits.length - kept.length} more passages did not fit in one answer.`);
  context.report.emit(payload, () => renderLibraryResultsHuman(kept));
  return EXIT_CODE.success;
}

/** The mode, the threshold and the exact expression this run uses, or why it cannot run. */
function planCommandSearch(
  context: CommandContext,
  query: string,
  options: ParsedOptions,
): { ok: true; plan: SearchPlan } | { ok: false; message: string } {
  const mode = options.text("mode");
  // The parser has already refused anything outside the table's choices; this narrows the type.
  if (!isSearchMode(mode)) return { ok: false, message: `--mode must be one of hybrid, semantic, exact.` };
  return planSearch({
    mode,
    query,
    // An explicit argument outranks the setting; absence falls back to it. The settings were read
    // for this run alone, so the fallback is whatever the application says right now.
    explicitMinScore: options.optionalNumber("min-score"),
    settingsMinScore: context.settings.minSemanticScore,
  });
}
