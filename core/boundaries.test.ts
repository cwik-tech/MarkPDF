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

const IMPORT = /\bfrom\s+["']([^"']+)["']/g;

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

  it("keeps browser globals out of core, which the omitted DOM lib also enforces at compile time", () => {
    const offenders = sourceFiles("core")
      .filter((f) => /\b(window|document|localStorage|caches)\s*\./.test(withoutComments(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });
});
