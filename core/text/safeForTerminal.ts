/**
 * Make somebody else's text safe to print on one line of a terminal.
 *
 * A file name is external input, and paths reach the terminal in refusals, remedies and prompts.
 * Printed raw, a name containing a newline ends the line and writes another — so a refusal can be
 * made to look as though it said the opposite, or as though it came from a different program.
 * An escape sequence can repaint or hide what is already there.
 *
 * Every C0 control, DEL and every C1 control is replaced by a visible `\xNN` escape. Nothing else
 * is touched: this is about what a terminal *does* with the characters, not about what they mean,
 * so accented letters, other scripts and emoji all pass through unchanged.
 *
 * It is a display transform only. Anything that has to round-trip — a path written to the consent
 * record, a path compared against an allowlist — uses the original.
 */
export function safeForTerminal(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control ? `\\x${code.toString(16).padStart(2, "0")}` : character;
  }
  return out;
}

/**
 * Does this text carry a character that can act on a terminal?
 *
 * Tab is allowed: it moves the cursor along one line and cannot forge a new one, and a tab in a
 * file name is odd rather than hostile. Everything else in C0, DEL and C1 can end a line, return
 * the cursor, repaint, or hide what is already there.
 *
 * This is the question the command line asks about its own arguments. `safeForTerminal` makes such
 * text *safe to look at*; it cannot make a path *runnable*, because the escaped spelling names a
 * different file. So a path that would need escaping is refused at the boundary instead, and every
 * path that reaches a refusal is one whose remedy can be pasted and will work.
 */
export function hasTerminalControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09) continue;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}
