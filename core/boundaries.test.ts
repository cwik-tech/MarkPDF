import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Production sources only. Tests are deliberately allowed to import across the boundary, so
 * that a parity test can compare the two sides — which is what stops them drifting.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every way a module names another one.
 *
 * `from "x"` is the common shape, but `import "x"` for its side effects, `import("x")` for a lazy
 * one, and `require("x")` all reach the same module — and a boundary that only reads the common
 * shape is a boundary anything determined walks straight through.
 */
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/**
 * Strip comments before scanning for browser globals.
 *
 * Prose is not code: a comment ending a sentence with the word "document." should not read as
 * a DOM access. The compile-time guarantee is the omitted DOM lib in tsconfig.core.json; this
 * test is a second net and must not cry wolf.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Whether a source reads a browser global.
 *
 * A global is a name nothing produced, so it is never preceded by a `.` or by an identifier
 * character — `lookup.document.id` reads a property of a value in hand, and this repository is
 * full of values called `document` for the obvious reason. Matching those too would make the
 * second net unusable in a program about documents, which is how a tripwire ends up loosened for
 * real rather than made precise.
 */
export function readsBrowserGlobal(text: string): boolean {
  // `globalThis.document` and `self.document` are the same global reached through its container,
  // so the container is removed first and the one rule below decides both spellings.
  const code = withoutComments(text).replace(/(?<![.\w$])(globalThis|self)\s*\./g, "");
  return /(?<![.\w$])(window|document|localStorage|caches)\s*\./.test(code);
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT)].map((m) => m[1]!);
}

describe("the core boundary", () => {
  it("keeps Electron out of core, so core runs under plain node", () => {
    const offenders = sourceFiles("core")
      .filter((f) => importsOf(f).some((s) => s === "electron" || s.startsWith("electron/")));
    expect(offenders).toEqual([]);
  });

  it("keeps the renderer out of core, so core has no React or DOM dependency", () => {
    const offenders = sourceFiles("core")
      .filter((f) => importsOf(f).some((s) => s.includes("../src/") || s === "react" || s === "react-dom"));
    expect(offenders).toEqual([]);
  });

  it("keeps core out of the renderer, whether as sources or as build output", () => {
    const offenders = sourceFiles("src")
      .filter((f) =>
        importsOf(f).some((s) => /(^|\/)\.\.\/(dist-)?core\//.test(s) || /^\.\.\/\.\.\/(dist-)?core\//.test(s)),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps Electron and the renderer out of the MCP server, which runs as a plain process", () => {
    const offenders = sourceFiles("mcp").filter((f) =>
      importsOf(f).some((s) => s === "electron" || s.startsWith("electron/") || s === "react" || s.includes("../src/")),
    );
    expect(offenders).toEqual([]);
  });

  it("makes the MCP server reach core and the command table through their build output", () => {
    // The same rule every other surface follows: compiled declarations, never sources, so the
    // emitted specifiers resolve identically inside `app.asar`.
    const offenders = sourceFiles("mcp").filter((f) =>
      importsOf(f).some((s) => /(^|\/)\.\.\/(core|cli)\//.test(s)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the MCP server out of core, the command line and the renderer", () => {
    const offenders = [...sourceFiles("core"), ...sourceFiles("cli"), ...sourceFiles("src")].filter((f) =>
      importsOf(f).some((s) => /(^|\/)(dist-)?mcp\//.test(s)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps unbounded document text out of the MCP server's replies", () => {
    // Every tool result is bounded, and the bounding lives in core so neither surface can be the
    // sole keeper of it. `renderMarkdownForFile` is the one unbounded rendering an adapter may
    // reach for, named so that reaching for it is a visible decision about a file rather than a
    // reply.
    const offenders = sourceFiles("mcp").filter((f) =>
      withoutComments(readFileSync(f, "utf8")).includes("renderMarkdownDocument"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the window out of deciding what a page says", () => {
    // The window contributes a document to index. It does not contribute the document's text.
    //
    // It used to offer OCR it had produced for its own display, and reading preferred that over
    // doing the work itself — so a page the window skipped was a page nothing read, and a page it
    // did read entered the index in whatever shape its own engine produced. One document then read
    // differently depending on which surface indexed it.
    //
    // The field is gone from the request, which the compiler enforces. This is the second net: it
    // catches the shortcut being reintroduced under any name that still spells it out, including in
    // a type declaration the compiler would happily accept.
    const offenders = sourceFiles("src").filter((f) =>
      withoutComments(readFileSync(f, "utf8")).includes("ocrCandidates"),
    );
    expect(offenders).toEqual([]);
  });

  it("still recognises a browser global when it sees one", () => {
    // The rule above only means anything if it can fail, and its two exclusions — comments and
    // member access — are each one character away from excluding everything. These are the cases
    // it must keep catching, written out so that widening it to nothing is a red test.
    for (const offender of [
      'document.getElementById("root")',
      "window.addEventListener('resize', onResize)",
      "await caches.open('v1')",
      "localStorage.setItem(key, value)",
      "const el = document\n  .body;",
      "globalThis.document.title",
    ]) {
      expect(readsBrowserGlobal(offender)).toBe(true);
    }
  });

  it("does not mistake a value of our own for a browser global", () => {
    for (const innocent of [
      "store.getMarkdown(lookup.document.id)",
      "// the text is itself a rendered document.",
      "/** Empty for everything except a table window. */",
      "const documents = list.filter(Boolean);",
    ]) {
      expect(readsBrowserGlobal(innocent)).toBe(false);
    }
  });

  it("keeps browser globals out of core, which the omitted DOM lib also enforces at compile time", () => {
    const offenders = sourceFiles("core").filter((f) => readsBrowserGlobal(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
