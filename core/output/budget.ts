/**
 * How much text a tool may return, and what it says when there is more.
 *
 * Documents are large and an agent's context is not. Output is bounded **explicitly**: a caller is
 * told how much was left out rather than handed a quietly shortened document that reads as a
 * complete one.
 *
 * This lives in core, not in a transport. A budget enforced in one adapter is a budget the other
 * adapter does not have, and the safety constraints of this system are supposed to be things
 * neither surface can be the sole keeper of.
 *
 * **There are two bounds, and they measure different things.**
 *
 * - A *content* bound limits how much document text an operation gathers, cut where a reader would
 *   cut: whole pages, whole headings, whole lines. It is about the document.
 * - A *reply* bound limits the finished JSON an operation hands to its transport — the text an
 *   agent actually reads in a tool result. It is measured on that exact string, so unlike the
 *   content bound it accounts for JSON escaping, per-item keys and indentation.
 *
 * Both are needed and neither substitutes for the other. Serialization is **not** fixed overhead:
 * JSON escaping is content dependent — a newline, a quote and a backslash each become two bytes,
 * a control character becomes six — and every item in a list repeats its own keys. A thousand
 * two-word headings are a few hundred bytes of document text and tens of thousands of bytes of
 * JSON. So content bounding alone cannot state a true limit on what is sent, and response bounding
 * alone would cut in the middle of a heading. The content bound runs first and cuts sensibly; the
 * reply bound runs last and is what a caller is promised.
 *
 * **What the reply bound is not.** It is not a count of bytes on the wire. A transport takes the
 * reply text and puts it inside its own envelope — for MCP, a `CallToolResult` inside a JSON-RPC
 * frame — which escapes the whole string a second time. The frame is therefore larger than this
 * number, by an amount that again depends on the content: up to roughly twice it in the worst
 * case, plus a small envelope. Bounding the frame itself would mean reaching into the SDK's
 * serializer, and the number that matters to the caller — how much text lands in an agent's
 * context — is this one.
 *
 * **The brand is the enforcement.** A budget can only be made by `outputBudget`, which refuses
 * anything that would mean no limit — so "unbounded" is not a value this API can be handed. A
 * caller that wants the whole document uses the unbounded renderer directly and says so in its
 * own code; it cannot reach that behaviour by passing a large or clever number here.
 */
export type OutputBudget = number & { readonly __brand: "OutputBudgetUtf8Bytes" };

/**
 * How much **document text** an operation gathers, in UTF-8 bytes.
 *
 * Bytes rather than characters, because that is what a transport and a context window actually
 * spend: twenty thousand CJK characters or emoji are sixty to eighty thousand bytes, so a
 * character count would overrun the promised bound by three or four times for exactly the
 * documents least able to afford it.
 *
 * Roughly five thousand tokens of English: comfortably several pages of prose, and far short of a
 * document that would fill a context window on its own. A caller that needs more asks for specific
 * pages.
 *
 * This is a bound on the *document*, not on the reply. What the reply costs is
 * `DEFAULT_REPLY_BUDGET`.
 */
export const DEFAULT_CONTENT_BUDGET: OutputBudget = 20_000 as OutputBudget;

/**
 * How many bytes of **reply text** an operation may hand to its transport, per call.
 *
 * Larger than the content budget because it has more to cover: the same text again after JSON
 * escaping, the keys around it, the per-item metadata, and the indentation. How much larger is not
 * a constant that can be reasoned about in advance — it depends entirely on what the document
 * contains — which is exactly why this is enforced by measuring the finished string rather than by
 * adding an allowance to the content budget.
 *
 * The number is what twenty thousand bytes of ordinary prose costs once it is a JSON document,
 * with room for a document that escapes badly. Anything beyond it is dropped and reported.
 */
export const DEFAULT_REPLY_BUDGET: OutputBudget = 48_000 as OutputBudget;

/**
 * Turn a reply into the text a caller will read.
 *
 * One function, used both to measure a reply and to produce it, because a budget checked against a
 * different serialization from the one that is handed over is not a budget. Indented, because
 * these replies are read by people as often as by programs — and the indentation is counted, since
 * it is bytes like any other.
 */
export function renderReply(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/** What a reply's text costs, rendered exactly as it will be handed over. */
export function replyTextBytes(payload: unknown): number {
  return Buffer.byteLength(renderReply(payload), "utf8");
}

export interface FittedReply {
  payload: Record<string, unknown>;
  /** How much of what was on offer the reply carries, in the caller's own unit. */
  keep: number;
  /** The size of the reply text being handed over. */
  bytes: number;
  truncated: boolean;
}

/**
 * The largest reply that fits, measured on the finished reply text.
 *
 * `render` builds the whole reply from a number — how many items to include, or how many bytes of
 * text to keep — and this finds the largest such number whose serialized form is within budget.
 * The unit is the caller's, so one primitive covers a list of search hits, a list of pages, and a
 * single long piece of Markdown.
 *
 * `render` is asked to build the reply several times, so it must be cheap and must depend on
 * nothing but its argument. It is also asked to state its own shortfall, which is why the reply is
 * rebuilt rather than edited: a truncation notice added afterwards would not be measured.
 *
 * A binary search assumes the reply grows with `keep`, which is very nearly true — the shortfall
 * it reports shrinks by a digit or two as `keep` rises. So the answer is checked afterwards and
 * walked down until it genuinely fits, and only `keep` of zero is returned without fitting, which
 * means the fixed part of the reply is alone over budget.
 */
export function fitReply(
  available: number,
  budget: OutputBudget,
  render: (keep: number) => Record<string, unknown>,
): FittedReply {
  const whole = render(available);
  const wholeBytes = replyTextBytes(whole);
  if (wholeBytes <= budget) {
    return { payload: whole, keep: available, bytes: wholeBytes, truncated: false };
  }

  let low = 0;
  let high = available;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (replyTextBytes(render(mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let keep = low;
  while (keep > 0 && replyTextBytes(render(keep)) > budget) keep -= 1;

  const payload = render(keep);
  return { payload, keep, bytes: replyTextBytes(payload), truncated: true };
}

export function outputBudget(bytes: number): OutputBudget {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error(`An output budget is a whole number of UTF-8 bytes greater than zero; received ${bytes}.`);
  }
  // The only place the brand is applied, and every path into it has just checked what the brand
  // stands for.
  return bytes as OutputBudget;
}

/** Says a summary was cut, so nobody reads a shortened range as the whole of one. */
const ELLIPSIS = "\u2026";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

/** What this text costs as document bytes. Not what it costs once escaped into JSON. */
function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface BoundedText {
  text: string;
  truncated: boolean;
  /** UTF-8 bytes the caller did not receive. Zero exactly when `truncated` is false. */
  omittedBytes: number;
  /** UTF-8 bytes the text occupied before bounding, so a caller can judge what it is missing. */
  totalBytes: number;
}

/**
 * How much of `text` fits the budget, measured in UTF-8 bytes and cut where a reader would cut.
 *
 * Returns a length in UTF-16 code units, because that is what `slice` takes — but every decision
 * along the way is about bytes. The walk is over **code points**, so a cut never lands between the
 * halves of a surrogate pair and emits a character the document never contained, and never inside
 * a multi-byte sequence.
 *
 * A line ending inside the budget is preferred, so the last line returned is a whole one.
 */
function fittingLength(text: string, budget: OutputBudget): number {
  if (utf8Length(text) <= budget) return text.length;

  let units = 0;
  let bytes = 0;
  let lastLineEnd = -1;
  for (const character of text) {
    const cost = utf8Length(character);
    if (bytes + cost > budget) break;
    bytes += cost;
    units += character.length;
    if (character === "\n") lastLineEnd = units - 1;
  }
  return lastLineEnd > 0 ? lastLineEnd : units;
}

export function boundText(text: string, budget: OutputBudget): BoundedText {
  const totalBytes = utf8Length(text);
  const kept = text.slice(0, fittingLength(text, budget));
  const keptBytes = utf8Length(kept);
  return {
    text: kept,
    truncated: keptBytes < totalBytes,
    omittedBytes: totalBytes - keptBytes,
    totalBytes,
  };
}

export interface BoundedTextRange {
  text: string;
  /** Actual UTF-16 offset used after clamping to the text and a code-point boundary. */
  offset: number;
  /** UTF-16 offset for the next call, or null when this page reached the end. */
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
  /** UTF-8 bytes after this page. Bytes before offset were already requested, not omitted. */
  omittedBytes: number;
  totalBytes: number;
}

function codePointBoundaryAtOrBefore(text: string, requested: number): number {
  const clamped = Math.min(requested, text.length);
  if (clamped === 0 || clamped === text.length) return clamped;
  const code = text.charCodeAt(clamped);
  return code >= 0xdc00 && code <= 0xdfff ? clamped - 1 : clamped;
}

/** Return one exact, repeatable page of text, addressed by UTF-16 code-unit offset. */
export function boundTextFrom(text: string, offset: number, budget: OutputBudget): BoundedTextRange {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`A text offset must be a whole number at least zero; received ${offset}.`);
  }
  const start = codePointBoundaryAtOrBefore(text, offset);
  const remaining = text.slice(start);
  const kept = remaining.slice(0, fittingLength(remaining, budget));
  const end = start + kept.length;
  const trailing = text.slice(end);
  const truncated = end < text.length;
  return {
    text: kept,
    offset: start,
    nextOffset: truncated ? end : null,
    totalChars: text.length,
    truncated,
    omittedBytes: utf8Length(trailing),
    totalBytes: utf8Length(text),
  };
}

export interface BoundedPage {
  page: number;
  markdown: string;
}

export interface BoundedPages {
  pages: BoundedPage[];
  truncated: boolean;
  /** UTF-8 bytes of document text the caller did not receive. */
  omittedBytes: number;
  /** UTF-8 bytes the document's text occupied in full. */
  totalBytes: number;
}

/**
 * As much of a document as the budget allows, page by page.
 *
 * Whole pages where they fit; the page that straddles the budget is shortened rather than dropped,
 * because a page cut short is still a page a reader can cite and a page silently missing is not.
 * The first page is always returned, however small the budget — an empty answer would say nothing
 * at all about the document.
 */
export function boundPages(pages: readonly BoundedPage[], budget: OutputBudget): BoundedPages {
  const totalBytes = pages.reduce((total, page) => total + utf8Length(page.markdown), 0);
  const kept: BoundedPage[] = [];
  let spent = 0;

  for (const page of pages) {
    const remaining = budget - spent;
    if (remaining <= 0) break;
    const cost = utf8Length(page.markdown);
    if (cost <= remaining) {
      kept.push(page);
      spent += cost;
      continue;
    }
    const shortened = page.markdown.slice(0, fittingLength(page.markdown, outputBudget(remaining)));
    // A page that could not fit even one character still appears when it is the first: an empty
    // answer would say nothing about the document at all.
    if (shortened.length > 0 || kept.length === 0) {
      kept.push({ page: page.page, markdown: shortened });
      spent += utf8Length(shortened);
    }
    break;
  }

  const returned = kept.reduce((total, page) => total + utf8Length(page.markdown), 0);
  return {
    pages: kept,
    truncated: returned < totalBytes,
    omittedBytes: totalBytes - returned,
    totalBytes,
  };
}

export interface BoundedItems<T> {
  items: T[];
  truncated: boolean;
  /** UTF-8 bytes of variable text the caller did not receive. */
  omittedBytes: number;
  /** UTF-8 bytes the variable text occupied in full. */
  totalBytes: number;
}

/**
 * As many items as the budget allows, whole.
 *
 * Unlike a document's pages, a half-present search hit or outline entry is worse than an absent
 * one: a truncated heading is a heading that says something else. So items are kept whole and the
 * list stops, with the shortfall reported.
 *
 * **The cap is hard.** An item too large to fit is not returned — not even the first one. Letting
 * one through "so the answer is not empty" would mean the single case most likely to blow a
 * caller's budget is the case the budget does not apply to, and for a one-item list it would
 * report nothing was omitted while returning more than was allowed. An empty list with a byte
 * count is a truthful answer; an oversized one is not.
 *
 * `textOf` names the part of an item that came from the document — a snippet, a heading, a title.
 * That is **all** this measures. Page numbers, scores, chunk identifiers, the keys around them and
 * the JSON escaping of the text itself are not counted here, and they are not a fixed cost that
 * could be: a list of a thousand two-word headings is a few hundred bytes by this measure and tens
 * of thousands of bytes once serialized. Bounding the finished reply is `fitReply`'s job, and
 * every caller that puts these items in a reply owes it that second step.
 */
export function boundItems<T>(
  items: readonly T[],
  budget: OutputBudget,
  textOf: (item: T) => string,
): BoundedItems<T> {
  const totalBytes = items.reduce((total, item) => total + utf8Length(textOf(item)), 0);
  const kept: T[] = [];
  let spent = 0;

  for (const item of items) {
    const cost = utf8Length(textOf(item));
    if (spent + cost > budget) break;
    kept.push(item);
    spent += cost;
  }

  return { items: kept, truncated: kept.length < items.length, omittedBytes: totalBytes - spent, totalBytes };
}

/**
 * A list of page numbers, written the way a caller could type it back: `1-3,7,10-12`.
 *
 * A reply that named every page individually would carry a piece of metadata whose size is the
 * length of the document — six bytes a page, so a thousand-page selection is six kilobytes of
 * page numbers before any text. This is the same vocabulary `parsePageSelection` reads, so the
 * summary is not merely shorter: it is an answer a caller can act on.
 *
 * Bounded like everything else, because a selection of alternate pages has as many runs as pages.
 * A summary that had to be cut ends with an ellipsis, so nobody reads a shortened range as the
 * whole of one.
 */
export function pageRangeSummary(pages: readonly number[], budget: OutputBudget): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let first: number | null = null;
  let last = 0;
  const closeRun = (): void => {
    if (first === null) return;
    runs.push(first === last ? `${first}` : `${first}-${last}`);
  };
  for (const page of sorted) {
    if (first !== null && page === last + 1) {
      last = page;
      continue;
    }
    closeRun();
    first = page;
    last = page;
  }
  closeRun();

  const whole = runs.join(",");
  if (utf8Length(whole) <= budget) return whole;

  // The marker's own bytes come out of the budget before anything is fitted. Appending it
  // afterwards would return a summary three bytes over the number it was given, which is a small
  // amount and exactly the kind of small amount a bound is supposed not to have.
  const room = budget - ELLIPSIS_BYTES;
  if (room < 0) return "";
  // Exactly enough for the marker and nothing else. Saying the summary was cut is a truthful use
  // of a budget that accommodates precisely that; returning nothing would leave three bytes of
  // room unspent and read as a document with no pages.
  if (room === 0) return ELLIPSIS;

  const kept = boundText(whole, outputBudget(room)).text;
  const lastSeparator = kept.lastIndexOf(",");
  // Only whole runs. A cut inside a number would name a page the selection never contained, which
  // is worse than saying nothing about the tail at all.
  const complete = lastSeparator > 0 ? kept.slice(0, lastSeparator) : "";
  return complete.length === 0 ? ELLIPSIS : `${complete}${ELLIPSIS}`;
}
