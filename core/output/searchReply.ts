import { boundItems, fitReply, type OutputBudget } from "./budget.js";

/**
 * Bound a list of search hits for a reply, with both of the bounds `budget.ts` defines.
 *
 * The content bound runs first, over the document text of each hit — the snippet, the headings, and
 * the document's name and path, which came from the filesystem and are as variable as the rest. Hits
 * are kept whole. The reply bound runs last, on the finished JSON, because escaping and per-hit keys
 * are not a cost anyone can add up in advance. `render` builds the whole reply from the kept hits and
 * the omission it is told about, so the notice of what was left out is itself measured.
 */
export interface SearchOmission {
  truncated: boolean;
  /** Hits on offer that the reply does not carry. */
  omittedResults: number;
  /** UTF-8 bytes of document text in the hits left out. */
  omittedBytes: number;
  /** UTF-8 bytes of document text in every hit on offer. */
  totalBytes: number;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function boundSearchReply<T>(input: {
  hits: readonly T[];
  textOf: (hit: T) => string;
  budget: OutputBudget;
  replyBudget: OutputBudget;
  render: (kept: readonly T[], omission: SearchOmission) => Record<string, unknown>;
}): { payload: Record<string, unknown>; kept: T[] } {
  const bounded = boundItems(input.hits, input.budget, input.textOf);
  const omissionFor = (keep: number): SearchOmission => {
    const left = bounded.items.slice(keep).reduce((total, hit) => total + bytesOf(input.textOf(hit)), 0);
    return {
      truncated: keep < input.hits.length,
      omittedResults: input.hits.length - keep,
      omittedBytes: bounded.omittedBytes + left,
      totalBytes: bounded.totalBytes,
    };
  };
  const fitted = fitReply(bounded.items.length, input.replyBudget, (keep) =>
    input.render(bounded.items.slice(0, keep), omissionFor(keep)),
  );
  return { payload: fitted.payload, kept: bounded.items.slice(0, fitted.keep) };
}
