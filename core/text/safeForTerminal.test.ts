import { describe, expect, it } from "vitest";
import { hasTerminalControlCharacter, safeForTerminal } from "./safeForTerminal.js";

/**
 * What a terminal is allowed to do with a file name.
 *
 * The rule is narrow on purpose: it stops a name from *acting* on the terminal, and changes
 * nothing about what a name means. A person whose documents are named in Japanese should see them
 * named in Japanese.
 *
 * Control characters are built from their code points rather than typed, so this file carries
 * none of them — a test about text that hijacks a display should not hijack one to say so.
 */
const control = (code: number): string => String.fromCharCode(code);
const NEWLINE = control(0x0a);
const CARRIAGE_RETURN = control(0x0d);
const ESCAPE = control(0x1b);
const CONTROL_SEQUENCE_INTRODUCER = control(0x9b);
const BACKSPACE = control(0x08);
const DELETE = control(0x7f);

describe("text that would act on the terminal", () => {
  it("cannot end the line and start another", () => {
    expect(safeForTerminal(`a${NEWLINE}markpdf: access granted`)).toBe("a\\x0amarkpdf: access granted");
  });

  it("cannot return the cursor to the start of the line and overwrite it", () => {
    expect(safeForTerminal(`safe${CARRIAGE_RETURN}forged`)).toBe("safe\\x0dforged");
  });

  it("cannot begin an escape sequence", () => {
    expect(safeForTerminal(`${ESCAPE}[31mred`)).toBe("\\x1b[31mred");
  });

  it("cannot use the eight-bit escapes either", () => {
    expect(safeForTerminal(`${CONTROL_SEQUENCE_INTRODUCER}31m`)).toBe("\\x9b31m");
  });

  it("cannot hide itself with a backspace or a delete", () => {
    expect(safeForTerminal(`ab${BACKSPACE}${DELETE}`)).toBe("ab\\x08\\x7f");
  });
});

describe("text that merely says something", () => {
  it("leaves an ordinary path exactly as it is", () => {
    expect(safeForTerminal("/Users/me/My Papers/report (final).pdf")).toBe("/Users/me/My Papers/report (final).pdf");
  });

  it("leaves other scripts and emoji alone, because they are names and not commands", () => {
    for (const text of ["/Users/me/論文/第一章.pdf", "/Users/me/Résumé.pdf", "/Users/me/📚/notes.pdf"]) {
      expect(safeForTerminal(text)).toBe(text);
    }
  });

  it("leaves shell metacharacters alone, which quoting deals with and a terminal does not", () => {
    expect(safeForTerminal("a b;$(id)`x`$HOME'q'")).toBe("a b;$(id)`x`$HOME'q'");
  });

  it("passes an empty string through", () => {
    expect(safeForTerminal("")).toBe("");
  });
});

describe("deciding whether an argument may be used at all", () => {
  it("refuses anything that could forge a line or drive the display", () => {
    for (const code of [0x00, 0x07, 0x08, 0x0a, 0x0d, 0x1b, 0x7f, 0x9b]) {
      expect(hasTerminalControlCharacter(`a${control(code)}b`)).toBe(true);
    }
  });

  it("allows a tab, which moves along one line and cannot start another", () => {
    expect(hasTerminalControlCharacter(`a${control(0x09)}b`)).toBe(false);
  });

  it("allows every ordinary path", () => {
    for (const text of ["/Users/me/My Papers/a.pdf", "/Users/me/論文/第一章.pdf", "a b;$(id)`x`'q'", ""]) {
      expect(hasTerminalControlCharacter(text)).toBe(false);
    }
  });
});
