import { contentHash } from "../hash.js";
import { boundItems, boundText, fitReply, outputBudget, type OutputBudget } from "../output/budget.js";
import { readDocumentAnnotations, type AnnotationOrigin } from "./readAnnotations.js";
import { quotesUnderMarks } from "./textUnderMarks.js";

/**
 * The answer to "what did people write on this document, and where", bounded for any surface.
 *
 * One builder for the command line and for MCP, so both promise the same thing: the reply is cut
 * on whole comments, it says how many there are and where the next call starts, and it never
 * exceeds the reply bound once serialized. Pagination is by position in reading order rather than
 * by page, because one page can carry more comments than one reply holds, and a page range could
 * never get past it.
 *
 * Each note and each quote is cut at a fixed size first. That is what guarantees progress: one
 * comment can then never be larger than a whole reply, so every call returns at least one and the
 * next offset always moves forward — also when somebody else's application stored a novel in a
 * sticky note.
 */

export interface CommentEntry {
  id: string;
  page: number;
  type: string;
  origin: AnnotationOrigin;
  author: string | null;
  note: string | null;
  quote: string | null;
  quoteSource: "text_under_marks" | null;
  modified: string | null;
  replyTo: string | null;
}

/** The most of one note or one quote a reply carries, in UTF-8 bytes. */
export const COMMENT_FIELD_BUDGET: OutputBudget = outputBudget(4_000);

export interface CommentsReplyInput {
  name: string;
  /** SHA-256 of the saved file that was read. A different value on the next page means it changed. */
  documentHash: string;
  entries: readonly CommentEntry[];
  /** Position of the first comment to return, in reading order. */
  offset: number;
  contentBudget: OutputBudget;
  replyBudget: OutputBudget;
  /** Fixed facts the caller adds, such as whether the open tab has unsaved changes. */
  extra?: Record<string, unknown>;
}

function cut(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const bounded = boundText(value, COMMENT_FIELD_BUDGET);
  return { text: bounded.text, truncated: bounded.truncated };
}

export function buildCommentsReply(input: CommentsReplyInput): Record<string, unknown> {
  const total = input.entries.length;
  const offset = Math.min(Math.max(0, input.offset), total);

  const items = input.entries.slice(offset).map((entry) => {
    const note = cut(entry.note);
    const quote = cut(entry.quote);
    return {
      id: entry.id,
      page: entry.page,
      type: entry.type,
      origin: entry.origin,
      author: entry.author,
      note: note.text,
      noteTruncated: note.truncated,
      quote: quote.text,
      quoteTruncated: quote.truncated,
      quoteSource: entry.quoteSource,
      modified: entry.modified,
      replyTo: entry.replyTo,
    };
  });

  // Document text first: notes, quotes and the names of their authors.
  const gathered = boundItems(items, input.contentBudget, (item) => `${item.note ?? ""}${item.quote ?? ""}${item.author ?? ""}`);
  const kept = gathered.items;

  // Then the finished reply, measured on the exact string a transport is handed.
  const fitted = fitReply(kept.length, input.replyBudget, (keep) => {
    const end = offset + keep;
    const remaining = end < total;
    return {
      name: input.name,
      documentHash: input.documentHash,
      ...(input.extra ?? {}),
      totalComments: total,
      offset,
      comments: kept.slice(0, keep),
      truncated: remaining,
      nextOffset: remaining ? end : null,
      omittedComments: total - end,
    };
  });
  return fitted.payload;
}

export interface ReadCommentsOptions {
  pages?: readonly number[];
}

/** Every comment and highlight of a saved file, with the words each one marks. */
export async function readComments(
  bytes: Uint8Array,
  options: ReadCommentsOptions = {},
): Promise<{ documentHash: string; entries: CommentEntry[] }> {
  const annotations = await readDocumentAnnotations(bytes, options.pages === undefined ? {} : { pages: options.pages });
  const quotes = await quotesUnderMarks(bytes, annotations);
  return {
    documentHash: contentHash(bytes),
    entries: annotations.map((annotation) => {
      const quote = quotes.get(annotation.id) ?? null;
      return {
        id: annotation.id,
        page: annotation.page,
        type: annotation.type,
        origin: annotation.origin,
        author: annotation.author,
        note: annotation.note,
        quote,
        quoteSource: quote === null ? null : "text_under_marks",
        modified: annotation.modified,
        replyTo: annotation.replyTo,
      };
    }),
  };
}
