import { safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import type { ConfirmGrant } from "./context.js";

export type TerminalEvent = "data" | "end" | "error";

export interface TerminalInput {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
  resume(): unknown;
  pause(): unknown;
  on(event: TerminalEvent, listener: (payload?: unknown) => void): unknown;
  off(event: TerminalEvent, listener: (payload?: unknown) => void): unknown;
}

/** Ctrl-C. In raw mode the terminal stops making this a signal and delivers the byte instead. */
const END_OF_TEXT = 0x03;

function asText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload).toString("utf8");
  return "";
}

function isInterrupt(payload: unknown): boolean {
  if (payload instanceof Uint8Array) return payload[0] === END_OF_TEXT;
  return typeof payload === "string" && payload.charCodeAt(0) === END_OF_TEXT;
}

/**
 * The one-keystroke grant.
 *
 * A single key rather than a typed line, because this appears in the middle of somebody's
 * terminal session and the alternative to answering it is a refused command. The question goes
 * to stderr, like every other thing that is not a result — a caller piping stdout into a parser
 * must not receive a prompt.
 *
 * Anything other than `y` is no. There is no default-yes and no empty-line-means-yes: this
 * widens what a program may read from someone's disk, and a stray newline should not do that.
 *
 * **Ctrl-C is an interruption, not a refusal.** Raw mode is what makes that a distinction worth
 * drawing: with it on, the terminal no longer turns Ctrl-C into SIGINT, so the process never sees
 * the signal and the byte arrives on the stream like any other. Treating it as "not y" would
 * report a refused path — exit 5, with a remedy suggesting the person grant something — when what
 * they actually did was cancel. `onInterrupt` raises the run's own cancellation instead, and the
 * run ends at 130.
 *
 * A stream that ends or fails answers no rather than leaving the promise pending. Without that,
 * a closed terminal would hang the command rather than end it.
 */
export function createTerminalConfirm(
  input: TerminalInput,
  ask: (text: string) => void,
  onInterrupt: () => void,
): ConfirmGrant {
  return async (request) => {
    // The directory is somebody else's text. A newline in it would let the question appear to be
    // asking about something else, which is the one prompt in this program that must not be
    // capable of that.
    ask(`\nmarkpdf needs ${request.kind} access to ${safeForTerminal(request.path)}\nGrant it and remember? [y/N] `);

    const outcome = await new Promise<"yes" | "no" | "interrupted">((resolve) => {
      // Declared before use so each handler can remove all three; whichever fires first restores
      // the terminal exactly once.
      const finish = (result: "yes" | "no" | "interrupted"): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onEnd);
        input.setRawMode?.(false);
        input.pause();
        resolve(result);
      };
      const onData = (payload?: unknown): void => {
        if (isInterrupt(payload)) return finish("interrupted");
        finish(asText(payload).trim().toLowerCase() === "y" ? "yes" : "no");
      };
      const onEnd = (): void => finish("no");

      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onEnd);
    });

    if (outcome === "interrupted") {
      ask("^C\n");
      onInterrupt();
      return false;
    }
    ask(outcome === "yes" ? "y\n" : "n\n");
    if (outcome === "no") ask(`Not granted. To grant it later: ${safeForTerminal(request.remedy)}\n`);
    return outcome === "yes";
  };
}
