import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./parse.js";
import { commandSpecs, globalOptions } from "./spec.js";

/**
 * Argument validation, driven entirely by the command table.
 *
 * The table is the specification. Every rule below is a rule about what the table says, not
 * about a hand-written branch, which is what makes the same data able to generate `--help` and,
 * later, the MCP tools' JSON Schemas.
 */

function runOutcome(argv: string[]) {
  return parseCliArgs(argv);
}

function expectRun(argv: string[]) {
  const outcome = parseCliArgs(argv);
  if (outcome.status !== "run") throw new Error(`Expected a run, got ${outcome.status}: ${JSON.stringify(outcome)}`);
  return outcome;
}

function expectUsageError(argv: string[]): string {
  const outcome = parseCliArgs(argv);
  if (outcome.status !== "usage-error") throw new Error(`Expected a usage error, got ${outcome.status}`);
  return outcome.message;
}

describe("choosing a command", () => {
  it("names the unrecognised command rather than printing generic usage", () => {
    expect(expectUsageError(["summarise", "a.pdf"])).toContain("summarise");
  });

  it("treats no arguments at all as a usage error, because there is nothing to do", () => {
    expect(runOutcome([]).status).toBe("usage-error");
  });

  it("answers --help without needing a command", () => {
    expect(runOutcome(["--help"]).status).toBe("help");
  });

  it("answers --version without needing a command", () => {
    expect(runOutcome(["--version"]).status).toBe("version");
  });

  it("answers --help for one command with that command's own help", () => {
    const outcome = runOutcome(["search", "--help"]);
    if (outcome.status !== "help") throw new Error(`Expected help, got ${outcome.status}`);
    expect(outcome.text).toContain("--min-score");
    expect(outcome.text).not.toContain("--recursive");
  });
});

describe("reading an option whose fallback lives in the application settings", () => {
  it("reports absence when the option was not given and the table declares no default", () => {
    // The fallback for --min-score is the application's setting, read where the command runs —
    // so the parser must say "not given", not fill in a constant that could disagree with it.
    const { options } = expectRun(["search", "revenue", "--path", "a.pdf"]);
    expect(options.optionalNumber("min-score")).toBeUndefined();
  });

  it("returns the value when the option was given", () => {
    const { options } = expectRun(["search", "revenue", "--path", "a.pdf", "--min-score", "0.2"]);
    expect(options.optionalNumber("min-score")).toBe(0.2);
  });

  it("still refuses an out-of-range value", () => {
    expect(expectUsageError(["search", "revenue", "--path", "a.pdf", "--min-score", "3"])).toContain("--min-score");
  });

  it("keeps the strict accessor strict: absent and no default is an error, not a silent value", () => {
    const { options } = expectRun(["search", "revenue", "--path", "a.pdf"]);
    expect(() => options.number("min-score")).toThrow(/min-score/);
  });
});

describe("positionals", () => {
  it("refuses a command that requires a path when none is given", () => {
    expect(expectUsageError(["index"])).toContain("<path>");
  });

  it("accepts several paths where the command takes a list", () => {
    expect(expectRun(["index", "a.pdf", "b.pdf"]).positionals).toEqual(["a.pdf", "b.pdf"]);
  });

  it("refuses a second positional where the command takes exactly one", () => {
    expect(expectUsageError(["outline", "a.pdf", "b.pdf"])).toContain("one");
  });

  it("takes a path that begins with a dash after the -- terminator", () => {
    expect(expectRun(["index", "--", "-weird-name.pdf"]).positionals).toEqual(["-weird-name.pdf"]);
  });
});

describe("options", () => {
  it("names an option the command does not have", () => {
    expect(expectUsageError(["outline", "a.pdf", "--recursive"])).toContain("--recursive");
  });

  it("applies the declared default when the option is absent", () => {
    expect(expectRun(["search", "q", "--path", "a.pdf"]).options.number("top-k")).toBe(12);
  });

  it("refuses a whole-number option given a fraction", () => {
    expect(expectUsageError(["search", "q", "--path", "a.pdf", "--top-k", "2.5"])).toContain("--top-k");
  });

  it("refuses a whole-number option outside its declared range", () => {
    expect(expectUsageError(["search", "q", "--path", "a.pdf", "--top-k", "0"])).toContain("--top-k");
  });

  it("refuses a fractional option outside its declared range", () => {
    expect(expectUsageError(["search", "q", "--path", "a.pdf", "--min-score", "1.5"])).toContain("--min-score");
  });

  it("lists the allowed values when a choice is not one of them", () => {
    const message = expectUsageError(["convert", "a.pdf", "--mode", "pretty"]);
    expect(message).toContain("page-preserving");
    expect(message).toContain("clean");
  });

  it("refuses a value that is not a number at all", () => {
    expect(expectUsageError(["search", "q", "--path", "a.pdf", "--min-score", "high"])).toContain("--min-score");
  });
});

describe("options that constrain each other", () => {
  it("refuses a search that names neither a document nor a hash", () => {
    const message = expectUsageError(["search", "revenue"]);
    expect(message).toContain("--path");
    expect(message).toContain("--id");
  });

  it("refuses a search that names both", () => {
    expect(expectUsageError(["search", "revenue", "--path", "a.pdf", "--id", "a".repeat(64)])).toContain("one of");
  });

  it("refuses one output file for several input documents, because it could hold only the last", () => {
    expect(expectUsageError(["convert", "a.pdf", "b.pdf", "--out", "combined.md"])).toContain("--out");
  });
});

describe("grants", () => {
  it("collects a grant given on its own, with no command to run", () => {
    const outcome = runOutcome(["--allow-read", "/Users/me/Papers"]);
    if (outcome.status !== "grants-only") throw new Error(`Expected grants-only, got ${outcome.status}`);
    expect(outcome.global.grants).toEqual([{ change: "allow", access: "read", path: "/Users/me/Papers" }]);
  });

  it("collects every repetition rather than keeping only the last", () => {
    const outcome = runOutcome(["--allow-read", "/one", "--allow-read", "/two", "--allow-write", "/three"]);
    if (outcome.status !== "grants-only") throw new Error(`Expected grants-only, got ${outcome.status}`);
    expect(outcome.global.grants).toEqual([
      { change: "allow", access: "read", path: "/one" },
      { change: "allow", access: "read", path: "/two" },
      { change: "allow", access: "write", path: "/three" },
    ]);
  });

  it("carries a withdrawal, so consent can be taken back the same way it was given", () => {
    const outcome = runOutcome(["--revoke-read", "/one"]);
    if (outcome.status !== "grants-only") throw new Error(`Expected grants-only, got ${outcome.status}`);
    expect(outcome.global.grants).toEqual([{ change: "revoke", access: "read", path: "/one" }]);
  });

  it("keeps the order they were written in, across different options", () => {
    // `parseArgs` groups values by option name, which loses the interleaving of two different
    // options — and `applyGrants` folds them in order, so a revoke that moved to the end would
    // wipe a grant the person typed after it.
    const outcome = runOutcome(["--allow-read", "/a/2026", "--revoke-read", "/a", "--allow-read", "/a/2027"]);
    if (outcome.status !== "grants-only") throw new Error(`Expected grants-only, got ${outcome.status}`);

    expect(outcome.global.grants).toEqual([
      { change: "allow", access: "read", path: "/a/2026" },
      { change: "revoke", access: "read", path: "/a" },
      { change: "allow", access: "read", path: "/a/2027" },
    ]);
  });

  it("keeps the order when the values are written with equals signs", () => {
    const outcome = runOutcome(["--revoke-write=/b", "--allow-write=/a"]);
    if (outcome.status !== "grants-only") throw new Error(`Expected grants-only, got ${outcome.status}`);

    expect(outcome.global.grants).toEqual([
      { change: "revoke", access: "write", path: "/b" },
      { change: "allow", access: "write", path: "/a" },
    ]);
  });

  it("accepts a grant alongside a command, so the remedy can be pasted in front of the failed run", () => {
    const outcome = expectRun(["--allow-read", "/one", "index", "a.pdf"]);
    expect(outcome.global.grants).toHaveLength(1);
    expect(outcome.positionals).toEqual(["a.pdf"]);
  });
});

describe("reading a parsed option", () => {
  it("refuses to answer for an option the command never declared", () => {
    const outcome = expectRun(["index", "a.pdf"]);
    expect(() => outcome.options.text("min-score")).toThrow(/min-score/);
  });

  it("answers every option the table declares for that command", () => {
    for (const command of commandSpecs) {
      const argv = [command.name, ...command.positionals.map(() => "a.pdf")];
      if (command.name === "search") argv.push("--path", "a.pdf");
      const outcome = expectRun(argv);
      for (const option of command.options) {
        expect(() => outcome.options.declared(option.name)).not.toThrow();
      }
      for (const option of globalOptions) {
        expect(() => outcome.options.declared(option.name)).toThrow();
      }
    }
  });
});
