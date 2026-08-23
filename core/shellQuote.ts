/**
 * Quote one argument for a POSIX shell.
 *
 * Single quotes, because inside them every character except the quote itself is literal — so a
 * path with spaces, semicolons, `$`, backticks or `$(…)` is one argument and none of it is
 * syntax. An embedded quote is closed, escaped and reopened, which is the only way out of single
 * quotes.
 *
 * It lives on its own because more than one place prints a command for a person to paste, and a
 * second implementation would be a second chance for one of them to use double quotes — which
 * expand `$VAR`, backticks and command substitutions, turning a suggestion into an execution.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
