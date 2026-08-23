import { safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import type { CliFailure } from "./errors.js";

export interface CliStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Results on stdout, everything else on stderr.
 *
 * The split is the contract, not a style: a caller pipes stdout into something that parses it,
 * and one stray progress line would break that. Nothing in this file writes progress or
 * diagnostics to stdout, and `emit` is the only thing that writes to it at all.
 *
 * Everything bound for stderr passes through `safeForTerminal` first. These lines carry file
 * names, which are somebody else's text: one containing a newline would end the line and write
 * another, and a refusal could be made to read as its own opposite. `emit` needs no such thing —
 * JSON escapes control characters itself, and the human rendering is a document, not a report.
 */
export interface Reporter {
  readonly json: boolean;
  /** Something happening, for a person watching. Never part of the result. */
  progress(text: string): void;
  /** Something the caller should know that is not a failure. */
  note(text: string): void;
  /** Something that went wrong, with its remedy when there is one. */
  problem(failure: CliFailure): void;
  /** The result. JSON when asked for, otherwise the human rendering. */
  emit(payload: unknown, human: () => string): void;
}

/**
 * How a failure reads on stderr: the sentence, and the command that would fix it.
 *
 * Exported because the crash backstop in `cli/main.ts` has to render a failure too, and it must
 * render it the same way. Writing the fields directly there would leave one path on which a
 * dependency's error text reached the terminal unsanitised — which is exactly the path a
 * dependency error takes.
 */
export function failureLines(failure: CliFailure): string {
  const lines = [`${safeForTerminal(failure.message)}\n`];
  if (failure.remedy !== undefined) lines.push(`Try: ${safeForTerminal(failure.remedy)}\n`);
  return lines.join("");
}

export function createReporter(streams: CliStreams, json: boolean): Reporter {
  return {
    json,
    progress(text) {
      streams.stderr(`${safeForTerminal(text)}\n`);
    },
    note(text) {
      streams.stderr(`${safeForTerminal(text)}\n`);
    },
    problem(failure) {
      streams.stderr(failureLines(failure));
    },
    emit(payload, human) {
      streams.stdout(json ? `${JSON.stringify(payload, null, 2)}\n` : human());
    },
  };
}
