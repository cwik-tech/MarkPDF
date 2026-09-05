import { AccessDeniedError, remedyFor, requireAccess, type Allowlist } from "../dist-core/consent/allowlist.js";
import { renderBoundedMarkdown, renderMarkdownForFile, type MarkdownRenderMode } from "../dist-core/convert/renderMarkdown.js";
import { resolveDocumentPages, type DocumentPages } from "../dist-core/documents/documentPages.js";
import { parsePageSelection } from "../dist-core/documents/pageSelection.js";
import { findIndexedDocument } from "../dist-core/index/documentLookup.js";
import type { Embedder } from "../dist-core/index/embeddings.js";
import { searchChunkScope, searchDocument } from "../dist-core/index/search.js";
import type { BoundedScheduler } from "../dist-core/index/boundedScheduler.js";
import { outlineFromPages } from "../dist-core/outline/documentOutline.js";
import {
  boundItems,
  boundPages,
  boundText,
  fitReply,
  outputBudget,
  pageRangeSummary,
  type OutputBudget,
} from "../dist-core/output/budget.js";
import type { SemanticSearchSettings } from "../dist-core/ipc/settings.js";
import type { OpenDocumentEntry, OpenDocumentsView } from "../dist-core/session/openDocuments.js";
import type { SemanticStore } from "../dist-core/store/index.js";
import type { ArgumentValue } from "./arguments.js";
import { selectOpenDocument } from "./openDocumentSelection.js";
import type { ToolProgress } from "./progress.js";

/**
 * What a tool needs to answer, gathered once per process.
 *
 * The store and the embedder are functions because neither should be created for a session that
 * only lists tools — and because a server that opened an index just to be asked what it can do
 * would create one for a user who never used it.
 */
export interface ToolContext {
  store: () => SemanticStore;
  /** The embedder for one model id. Held per model, capped, so a change of model does not strand the old runtime nor pile up new ones without limit. */
  embedder: (modelId: string, onProgress?: (progress: { loaded: number; total: number }) => void) => Embedder;
  /** Progress for this call, present only when the client supplied an MCP progress token. */
  progress?: (update: ToolProgress) => void;
  allowlist: () => Allowlist;
  /**
   * What the application has open, read fresh on every call.
   *
   * A function for the same reason the consent record is one: a session lasts as long as the
   * client does, and which document somebody is looking at changes far faster than that. Reading
   * it once at startup would answer every question for the rest of the day with whatever happened
   * to be on screen when the client launched.
   */
  openDocuments: () => OpenDocumentsView;
  /** Read the separate private Markdown snapshot for one live open tab. */
  readOpenDocumentContent: (entry: OpenDocumentEntry) => string | null;
  /**
   * The application's semantic settings, read when asked.
   *
   * A function for the same reason the consent record is one — a session lasts hours, and the
   * person can change the model, the profile or the threshold in the application at any moment.
   * A call reads them once, and everything inside that call works from that one read, so the
   * profile and the model a search runs under cannot come from two different readings. A read
   * that fails refuses that one call; the next call tries again.
   */
  settings: () => SemanticSearchSettings;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, text: string) => Promise<void>;
  /** How much document text an operation gathers, cut on whole pages and whole headings. */
  budget: OutputBudget;
  /**
   * How many bytes of rendered reply text a call may hand to the transport.
   *
   * A separate number from `budget`, and the one that can actually be promised. JSON escaping is
   * content dependent and per-item keys repeat, so what a bounded amount of document text costs
   * once it is a reply is not knowable in advance — it is measured on the finished string.
   *
   * Scope, precisely: this is the text an agent reads in the tool result. The transport wraps it
   * in a `CallToolResult` inside a JSON-RPC frame and escapes it a second time, so the frame is
   * larger than this and is not what this bounds.
   */
  replyBudget: OutputBudget;
  /**
   * How many tool calls may be doing work at once.
   *
   * The SDK starts every request handler as soon as the frame arrives and never waits for an
   * earlier one, so without this a client that sends twenty calls gets twenty concurrent
   * extractions against one store and one embedder.
   */
  scheduler: BoundedScheduler;
  /**
   * Reading a scanned page, the same way the command line does.
   *
   * Injected so a document with no text layer answers with its text rather than with blank pages —
   * and injected rather than imported, so a session that only ever touches indexed documents never
   * loads a rasteriser or a recognition engine.
   */
  resolveOcr?: Parameters<typeof resolveDocumentPages>[2]["resolveOcr"];
}

export type ToolOutcome = { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

function text(args: Record<string, ArgumentValue>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * A number argument, which validation has already supplied the table's default for.
 *
 * No fallback is written here on purpose. `parseToolArguments` fills a missing argument from the
 * `default` the schema published, which came from the command table — so a number written here
 * too would be a second copy of a value that has one home, and the copy would be the one that
 * went stale. Absent means these operations were called without validating first, which is a
 * programming error and not a client's doing.
 */
function count(args: Record<string, ArgumentValue>, name: string): number {
  const value = args[name];
  if (typeof value !== "number") {
    throw new Error(`${name} reached an operation without the default its schema declares.`);
  }
  return value;
}

/**
 * A number argument that may genuinely be absent: the schema declares no default for it,
 * because the fallback lives in the application's settings and is read per call, not published.
 */
function optionalCount(args: Record<string, ArgumentValue>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

/**
 * How much of a reply a page summary may take.
 *
 * Page numbers are metadata this program produced, not document text, and they are still bytes: a
 * thousand-page selection listed one page at a time is six kilobytes before a word of the document
 * appears. A small fixed share, so the answer to "which pages is this about" can never crowd out
 * the pages themselves.
 */
const PAGE_SUMMARY_BUDGET = outputBudget(1_000);

/** Document bytes a list of items carries, for reporting what a second cut took away. */
export function bytesOfText<T>(items: readonly T[], textOf: (item: T) => string): number {
  return items.reduce((total, item) => total + Buffer.byteLength(textOf(item), "utf8"), 0);
}

/** The document a tool was asked about, in the terms `core` already speaks. */
function identity(args: Record<string, ArgumentValue>): { path?: string; contentHash?: string } {
  const path = text(args, "path");
  const id = text(args, "id");
  return { ...(path === undefined ? {} : { path }), ...(id === undefined ? {} : { contentHash: id }) };
}

/** One sentence for each way a document cannot be reached, in the caller's terms rather than ours. */
function explain(outcome: Exclude<DocumentPages, { status: "found" }>, indexOnly: boolean): string {
  switch (outcome.status) {
    case "denied":
      return `Not permitted to read ${outcome.path}. Grant it first: ${remedyFor(outcome.path, "read")}`;
    case "no-stored-text":
      return "That document is indexed, but its text was not stored. Index it again to make its pages readable.";
    case "no-recorded-path":
      return "That document is indexed without a path on disk, so read permission for it cannot be established. Name it by path instead.";
    case "cancelled":
      return "The request was cancelled.";
    case "not-indexed":
      return indexOnly
        ? "That document is not in the index. This tool reads the index only; index the document first."
        : "That document could not be found.";
  }
}

/** What every tool passes to the shared resolver, differing only in its access class. */
function resolving(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  access: "index-only" | "index-first" | "filesystem",
  signal?: AbortSignal,
): Parameters<typeof resolveDocumentPages>[2] {
  const resolveOcr = resolveOcrWithProgress(context);
  return {
    ...identity(args),
    access,
    readFile: context.readFile,
    ...(resolveOcr === undefined ? {} : { resolveOcr }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Add this call's MCP progress listener without replacing a resolver's own listener. */
export function resolveOcrWithProgress(context: ToolContext): ToolContext["resolveOcr"] {
  const resolveOcr = context.resolveOcr;
  if (resolveOcr === undefined) return undefined;
  return async (request) => await resolveOcr({
    ...request,
    onProgress: (page) => {
      request.onProgress?.(page);
      // The progress bar describes the document rather than the smaller OCR target list. The
      // target position remains on the resolver event for callers that need scheduling detail.
      context.progress?.({ progress: page.page, total: page.totalPages, message: page.message });
    },
  });
}

export async function runOutline(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const resolved = await resolveDocumentPages(
    context.store(),
    context.allowlist(),
    resolving(context, args, "index-first", signal),
  );
  if (resolved.status !== "found") return { ok: false, message: explain(resolved, false) };

  // Two cuts, in order. The first keeps whole headings and bounds the document text gathered; the
  // second bounds what is actually sent, which for a document of many short headings is a
  // different and much larger number — the titles are a few bytes each and their JSON is not.
  const all = outlineFromPages(resolved.pages, count(args, "depth"));
  const bounded = boundItems(all, context.budget, (entry) => entry.title);
  const scanned = resolved.pages.some((page) => page.source === "ocr");
  const fitted = fitReply(bounded.items.length, context.replyBudget, (keep) => ({
    contentHash: resolved.contentHash,
    name: resolved.document?.name ?? null,
    pageCount: resolved.document?.pageCount ?? resolved.pages.length,
    indexed: resolved.document !== null,
    readFromIndex: resolved.fromIndex,
    textSource: resolved.document?.textSource ?? (scanned ? "ocr" : "pdf"),
    entries: bounded.items.slice(0, keep),
    truncated: keep < all.length,
    omittedEntries: all.length - keep,
    omittedBytes: bounded.omittedBytes + bytesOfText(bounded.items.slice(keep), (entry) => entry.title),
    totalBytes: bounded.totalBytes,
  }));
  return { ok: true, payload: fitted.payload };
}

export async function runSearch(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Index only, always. A path the index does not hold is reported as such rather than read and
  // hashed, so this tool needs no filesystem permission under any circumstances.
  const store = context.store();
  let requestedIdentity = identity(args);
  const ref = text(args, "ref");
  if (ref !== undefined) {
    let selected;
    try {
      selected = selectOpenDocument(context.openDocuments(), ref);
    } catch {
      return {
        ok: false,
        message: "MarkPDF's record of which documents are open could not be read. This does not mean nothing is open; try again.",
      };
    }
    if (!selected.ok) return selected;
    if (selected.document.kind !== "pdf" || selected.document.contentHash === null) {
      return { ok: false, message: "That open document is not an indexed PDF. Index the PDF first, then try again." };
    }
    // The record's path is private. Search needs only the index identity and never receives it.
    requestedIdentity = { contentHash: selected.document.contentHash };
  }
  const lookup = await findIndexedDocument(store, context.allowlist(), {
    ...requestedIdentity,
    filesystemFallback: false,
    readFile: context.readFile,
  });
  if (lookup.status !== "found") {
    return { ok: false, message: "That document is not in the index. This tool reads the index only; index the document first." };
  }

  // One read of the settings for the whole call, so the profile, the model and the threshold
  // the search runs under all come from the same reading — and a settings file rewritten a
  // moment ago takes effect on this call, not the session after a restart.
  const settings = context.settings();
  const embedder = context.embedder(
    settings.activeModelId,
    context.progress === undefined
      ? undefined
      : ({ loaded, total }) => context.progress?.({
          progress: loaded,
          total,
          message: "Downloading embedding model",
        }),
  );
  const results = await searchDocument(store, embedder, {
    contentHash: lookup.document.contentHash,
    query: text(args, "query") ?? "",
    chunkingProfile: settings.chunkingProfile,
    topK: count(args, "top_k"),
    // An explicit argument outranks the setting; absence falls back to it.
    minScore: optionalCount(args, "min_score") ?? settings.minSemanticScore,
    ...(signal === undefined ? {} : { signal }),
  });
  const snapshotRecordedAt = store.chunksWrittenAt(
    searchChunkScope(lookup.document.id, embedder, settings.chunkingProfile),
  );

  // Both the snippet and the headings above it came from the document, so both are measured for
  // the content bound; the page, the score and the chunk identifier did not. They are still bytes
  // of reply text, though, which is what the second cut below is for.
  const documentTextOf = (hit: (typeof results)[number]): string => hit.snippet + hit.headingPath.join("");
  const bounded = boundItems(results, context.budget, documentTextOf);
  const rendered = bounded.items.map((hit) => ({
    page: hit.page,
    heading_path: hit.headingPath,
    // The same breadcrumb with each heading's page — `null` for rows indexed before provenance
    // existed — and whether the passage's nearest heading stands on an earlier page, so a
    // passage no longer appears to claim a heading it merely follows.
    headings: hit.headings.map((heading) => ({ title: heading.title, page: heading.page })),
    heading_inherited: hit.headingInherited,
    snippet: hit.snippet,
    score: hit.score,
    chunk_id: hit.id,
  }));

  const fitted = fitReply(rendered.length, context.replyBudget, (keep) => ({
    contentHash: lookup.document.contentHash,
    name: lookup.document.name,
    indexSnapshot: true,
    snapshotRecordedAt,
    truncated: keep < results.length,
    omittedResults: results.length - keep,
    omittedBytes: bounded.omittedBytes + bytesOfText(bounded.items.slice(keep), documentTextOf),
    totalBytes: bounded.totalBytes,
    results: rendered.slice(0, keep),
  }));

  return { ok: true, payload: fitted.payload };
}

/** The pages a caller asked for, or a sentence saying why that selection cannot be honoured. */
export function selectPages(
  args: Record<string, ArgumentValue>,
  pages: readonly { page: number; markdown: string }[],
): { ok: true; pages: { page: number; markdown: string }[] } | { ok: false; message: string } {
  const requested = text(args, "pages");
  if (requested === undefined) return { ok: true, pages: [...pages] };

  const selection = parsePageSelection(requested);
  if (!selection.ok) return { ok: false, message: selection.message };

  const beyond = selection.pages.filter((page) => page > pages.length);
  if (beyond.length > 0) {
    return { ok: false, message: `pages names page ${beyond.join(", ")}, but the document has ${pages.length}.` };
  }
  const wanted = new Set(selection.pages);
  return { ok: true, pages: pages.filter((page) => wanted.has(page.page)) };
}

export async function runReadPages(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Index only. This is what makes going from a search hit to its surrounding text cost no
  // filesystem permission at all.
  const resolved = await resolveDocumentPages(
    context.store(),
    context.allowlist(),
    resolving(context, args, "index-only", signal),
  );
  if (resolved.status !== "found") return { ok: false, message: explain(resolved, true) };

  const chosen = selectPages(args, resolved.pages);
  if (!chosen.ok) return { ok: false, message: chosen.message };

  const bounded = boundPages(chosen.pages, context.budget);
  // Only the gaps inside what was asked for. A document's other unread pages are not this reply's
  // business, and listing them would make a two-page request answer about the whole document.
  const selected = new Set(chosen.pages.map((page) => page.page));
  const unresolvedPages = resolved.unresolvedPages.filter((page) => selected.has(page));
  const fitted = fitReply(bounded.pages.length, context.replyBudget, (keep) => ({
    contentHash: resolved.contentHash,
    indexSnapshot: true,
    snapshotRecordedAt: resolved.snapshotRecordedAt,
    pages: bounded.pages.slice(0, keep),
    // Always present, never omitted when empty. An agent that cannot tell "no gaps" from "gaps not
    // reported" has to assume the second, and would distrust every page it is given.
    unresolvedPages,
    truncated: bounded.truncated || keep < bounded.pages.length,
    omittedBytes: bounded.omittedBytes + bytesOfText(bounded.pages.slice(keep), (page) => page.markdown),
    totalBytes: bounded.totalBytes,
  }));
  return { ok: true, payload: fitted.payload };
}

export async function runToMarkdown(
  context: ToolContext,
  args: Record<string, ArgumentValue>,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Classed as reading the file, so read permission is proved before anything is answered — even
  // when the text is sitting in the index. A cached copy is a convenience, not a second route
  // around a grant somebody withdrew.
  const resolved = await resolveDocumentPages(
    context.store(),
    context.allowlist(),
    resolving(context, args, "filesystem", signal),
  );
  if (resolved.status !== "found") return { ok: false, message: explain(resolved, false) };

  const chosen = selectPages(args, resolved.pages);
  if (!chosen.ok) return { ok: false, message: chosen.message };

  const mode: MarkdownRenderMode = text(args, "mode") === "clean" ? "clean" : "page-preserving";
  const outputPath = text(args, "output_path");

  if (outputPath !== undefined) {
    // A separate grant. Permission to read a library is not permission to write into it, and this
    // is the one tool where that distinction does any work.
    let target: string;
    try {
      target = requireAccess(context.allowlist(), outputPath, "write");
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      return { ok: false, message: `Not permitted to write ${outputPath}. Grant it first: ${remedyFor(outputPath, "write")}` };
    }
    // Written whole: the budget bounds a reply, and a file is not a reply. Somebody who asked for
    // a document on disk asked for the document, and a truncated file is not one. The operation is
    // named for that, so the boundary check can tell this apart from an adapter reaching for
    // unbounded text to put in a reply.
    const whole = renderMarkdownForFile(chosen.pages, mode);
    await context.writeFile(target, whole);
    return {
      ok: true,
      payload: {
        contentHash: resolved.contentHash,
        indexSnapshot: false,
        snapshotRecordedAt: null,
        outputPath: target,
        // Summarised, not listed. This reply carries no document text at all, so without this the
        // one thing that could make it large is the page numbers — and a bound that a whole branch
        // of a tool sidesteps is not a bound.
        pages: pageRangeSummary(chosen.pages.map((page) => page.page), PAGE_SUMMARY_BUDGET),
        pageCount: chosen.pages.length,
        bytesWritten: Buffer.byteLength(whole, "utf8"),
      },
    };
  }

  // The unit here is bytes of Markdown rather than a count of items, which is the same search over
  // a different quantity: how much of one long piece of text the reply can carry once escaped.
  const bounded = renderBoundedMarkdown(chosen.pages, mode, context.budget);
  // Computed once and bounded on its own, so the fixed part of this reply has a size that does not
  // depend on how many pages were asked for.
  const pages = pageRangeSummary(chosen.pages.map((page) => page.page), PAGE_SUMMARY_BUDGET);
  const fitted = fitReply(bounded.text.length === 0 ? 0 : context.budget, context.replyBudget, (keep) => {
    // `kept.omittedBytes` counts what was dropped from the already-content-bounded text, and
    // `bounded.omittedBytes` counts what the content bound dropped before that. The two are
    // disjoint, so they add — which is why the empty case reports the length of what it was
    // given rather than the length of the whole document, and does not count the same bytes twice.
    const kept =
      keep <= 0
        ? { text: "", omittedBytes: Buffer.byteLength(bounded.text, "utf8") }
        : boundText(bounded.text, outputBudget(keep));
    const omitted = bounded.omittedBytes + kept.omittedBytes;
    return {
      contentHash: resolved.contentHash,
      indexSnapshot: false,
      snapshotRecordedAt: null,
      pages,
      pageCount: chosen.pages.length,
      mode,
      markdown: kept.text,
      truncated: omitted > 0,
      omittedBytes: omitted,
      totalBytes: bounded.totalBytes,
    };
  });
  return { ok: true, payload: fitted.payload };
}
