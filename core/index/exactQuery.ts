/**
 * The only way a person's query reaches FTS5.
 *
 * FTS5 has its own query language: `AND`, `NEAR(…)`, `*`, `^`, column filters, and a syntax error
 * for anything it cannot parse. A query passed through raw would let a person's words change what
 * the search means, or make it throw. So every part of the query is written as an FTS5 string — in
 * double quotes, with an inner quote doubled — and the parts are joined with spaces, which FTS5
 * reads as "all of these must occur". Inside quotes nothing is an operator.
 *
 * Quoting alone is not enough. FTS5 cannot read a NUL even inside quotes ("unterminated string"),
 * so control characters are refused before anything is built. And a part made only of punctuation
 * holds no token, so it is dropped rather than sent: "()" would match nothing and say nothing.
 */

export const EXACT_QUERY_MAX_LENGTH = 1_000;
export const EXACT_QUERY_MAX_PARTS = 32;

export type ExactMatch =
  | { status: "ok"; expression: string }
  | { status: "no-words" }
  | { status: "refused"; message: string };

/**
 * Control characters other than tab, line feed and carriage return, which read as spaces.
 *
 * C0, DEL and C1. A query is typed or pasted text; none of these belongs in one, and NUL is the one
 * FTS5 demonstrably cannot read.
 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/**
 * Whether a part holds at least one token for the `unicode61` tokenizer.
 *
 * That tokenizer keeps letters, numbers and private-use characters, and treats everything else —
 * punctuation, symbols, separators, a combining mark on its own — as a separator. Measured against
 * the bundled SQLite 3.53.4: `©`, `€`, `_`, `♥` and a lone U+0301 produce no token, while `٣`, `中`,
 * `²`, `Ⅰ` and U+E000 each produce one.
 */
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{Co}]/u;

const WHITESPACE = /\s/u;

/** Quoted phrases and bare words, in order. An unmatched quote is an ordinary character. */
function splitParts(query: string): string[] {
  const parts: string[] = [];
  let word = "";
  const endWord = (): void => {
    if (word.length > 0) parts.push(word);
    word = "";
  };

  let index = 0;
  while (index < query.length) {
    const character = query.charAt(index);
    if (character === '"') {
      const close = query.indexOf('"', index + 1);
      if (close !== -1) {
        endWord();
        parts.push(query.slice(index + 1, close));
        index = close + 1;
        continue;
      }
      word += character;
      index += 1;
      continue;
    }
    if (WHITESPACE.test(character)) {
      endWord();
      index += 1;
      continue;
    }
    word += character;
    index += 1;
  }
  endWord();
  return parts;
}

function quoted(part: string): string {
  return `"${part.replaceAll('"', '""')}"`;
}

export function buildExactMatch(query: string): ExactMatch {
  if (CONTROL_CHARACTER.test(query)) {
    return { status: "refused", message: "The query contains a control character, which MarkPDF will not search for." };
  }
  if (query.length > EXACT_QUERY_MAX_LENGTH) {
    return { status: "refused", message: `The query is longer than ${EXACT_QUERY_MAX_LENGTH} characters.` };
  }

  const parts = splitParts(query);
  if (parts.length > EXACT_QUERY_MAX_PARTS) {
    return { status: "refused", message: `The query has more than ${EXACT_QUERY_MAX_PARTS} words or phrases.` };
  }

  const searchable = parts.filter((part) => TOKEN_CHARACTER.test(part));
  if (searchable.length === 0) return { status: "no-words" };
  return { status: "ok", expression: searchable.map(quoted).join(" ") };
}
