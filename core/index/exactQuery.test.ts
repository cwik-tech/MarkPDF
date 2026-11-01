import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { buildExactMatch, EXACT_QUERY_MAX_LENGTH, EXACT_QUERY_MAX_PARTS } from "./exactQuery.js";

/**
 * The only way a person's query reaches FTS5.
 *
 * Expected expressions are written by hand from the FTS5 string rules: a part goes inside double
 * quotes, an inner quote is doubled, and parts joined by a space must all occur. Each expression is
 * then run against a real FTS5 table, because a string that looks right can still be a syntax error
 * to the engine that has to read it.
 */

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`);
  const insert = db.prepare("INSERT INTO t(rowid, text) VALUES (?, ?)");
  insert.run(1, "Clause 4.2(b) governs the renewal of the lease");
  insert.run(2, "Clause 2.4(b) governs the renewal of the lease");
  insert.run(3, "Net 30 payment terms apply to invoice INV-2024-0042");
  insert.run(4, "A café near the station");
});

afterAll(() => db.close());

function matching(expression: string): number[] {
  return db
    .prepare("SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid")
    .all(expression)
    .map((row) => Number(Reflect.get(Object(row), "rowid")));
}

function expressionOf(query: string): string {
  const built = buildExactMatch(query);
  if (built.status !== "ok") throw new Error(`Expected an expression for ${JSON.stringify(query)}, got ${built.status}`);
  return built.expression;
}

describe("turning a query into an FTS5 expression", () => {
  it.each([
    ["clause 4.2(b)", `"clause" "4.2(b)"`],
    [`"net 30" invoice`, `"net 30" "invoice"`],
    ["INV-2024-0042", `"INV-2024-0042"`],
    ["text:secret", `"text:secret"`],
    ["NEAR(a b)", `"NEAR(a" "b)"`],
    [`say "hi`, `"say" """hi"`],
    ["  spaced   out  ", `"spaced" "out"`],
  ])("writes %j as %s", (query, expected) => {
    expect(expressionOf(query)).toBe(expected);
  });

  it("finds the clause by its phrase and not the clause with the same words in another order", () => {
    expect(matching(expressionOf("clause 4.2(b)"))).toEqual([1]);
  });

  it("finds an identifier written with hyphens", () => {
    expect(matching(expressionOf("INV-2024-0042"))).toEqual([3]);
  });

  it("matches without diacritics and without case", () => {
    expect(matching(expressionOf("CAFE"))).toEqual([4]);
  });

  it.each(["text:secret", "NEAR(a b)", `say "hi`, "AND OR NOT", "lease*", "^clause", "{text}: lease", "a + b", `""""`, "-lease"])(
    "keeps operator spellings in %j as plain words, so FTS5 never reads them as syntax",
    (query) => {
      const built = buildExactMatch(query);
      if (built.status === "ok") expect(() => matching(built.expression)).not.toThrow();
      else expect(built.status).toBe("no-words");
    },
  );

  it("drops a part with no word in it, and keeps the words beside it", () => {
    expect(expressionOf("lease () -- !")).toBe(`"lease"`);
  });
});

describe("queries that cannot be matched exactly", () => {
  it.each(["()", "-- !", "   ", "© €", "́"])("says that %j has no words", (query) => {
    expect(buildExactMatch(query).status).toBe("no-words");
  });

  it("counts a digit, a letter of any script and a private-use character as a word", () => {
    expect(buildExactMatch("٣").status).toBe("ok");
    expect(buildExactMatch("中").status).toBe("ok");
    expect(buildExactMatch("").status).toBe("ok");
  });

  it("refuses a control character, which FTS5 cannot read even inside quotes", () => {
    const built = buildExactMatch("abc\u0000def");
    expect(built.status).toBe("refused");
    if (built.status === "refused") expect(built.message).toMatch(/control character/);
  });

  it("refuses a query longer than the limit", () => {
    expect(buildExactMatch("a".repeat(EXACT_QUERY_MAX_LENGTH + 1)).status).toBe("refused");
    expect(buildExactMatch("a".repeat(EXACT_QUERY_MAX_LENGTH)).status).toBe("ok");
  });

  it("refuses a query with more parts than the limit", () => {
    const words = Array.from({ length: EXACT_QUERY_MAX_PARTS + 1 }, (_unused, index) => `w${index}`);
    expect(buildExactMatch(words.join(" ")).status).toBe("refused");
    expect(buildExactMatch(words.slice(1).join(" ")).status).toBe("ok");
  });
});
