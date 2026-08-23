import { describe, expect, it } from "vitest";
import { createTerminalConfirm, type TerminalInput } from "./prompt.js";

/**
 * The one-keystroke grant, and the ways a terminal can end the conversation.
 *
 * Raw mode is the reason this needs its own tests. With it on, the terminal stops turning
 * Ctrl-C into SIGINT and delivers byte 3 on the stream instead — so the process never sees the
 * signal, and a prompt that treated the byte as "not y" would report a refused path (5) when
 * what actually happened was an interruption (130).
 */

interface FakeTerminal extends TerminalInput {
  send(event: "data" | "end" | "error", payload?: unknown): void;
  rawModeCalls: boolean[];
  listenerCount(): number;
}

function fakeTerminal(): FakeTerminal {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const rawModeCalls: boolean[] = [];
  return {
    isTTY: true,
    rawModeCalls,
    setRawMode: (mode: boolean) => rawModeCalls.push(mode),
    resume: () => undefined,
    pause: () => undefined,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    send(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

const request = { path: "/Users/me/Papers", kind: "read" as const, remedy: "markpdf --allow-read '/Users/me/Papers'" };

function ask(terminal: FakeTerminal, onInterrupt: () => void) {
  const written: string[] = [];
  const confirm = createTerminalConfirm(terminal, (text) => written.push(text), onInterrupt);
  return { written, answer: confirm(request) };
}

describe("answering the prompt", () => {
  it("grants on y", async () => {
    const terminal = fakeTerminal();
    const { answer } = ask(terminal, () => undefined);
    terminal.send("data", Buffer.from("y"));

    expect(await answer).toBe(true);
  });

  it("declines on anything else, and says how to grant it later", async () => {
    const terminal = fakeTerminal();
    const { written, answer } = ask(terminal, () => undefined);
    terminal.send("data", Buffer.from("n"));

    expect(await answer).toBe(false);
    expect(written.join("")).toContain(request.remedy);
  });

  it("asks on the stream that is not the result, so a piped caller never sees it", async () => {
    const terminal = fakeTerminal();
    const { written, answer } = ask(terminal, () => undefined);
    terminal.send("data", Buffer.from("y"));
    await answer;

    expect(written.join("")).toContain("/Users/me/Papers");
  });
});

describe("Ctrl-C while the prompt is up", () => {
  it("is an interruption, not a refusal", async () => {
    const terminal = fakeTerminal();
    let interrupted = false;
    const { answer } = ask(terminal, () => (interrupted = true));

    terminal.send("data", Buffer.from([0x03]));

    expect(await answer).toBe(false);
    expect(interrupted).toBe(true);
  });

  it("does not print a remedy, because nothing was refused", async () => {
    const terminal = fakeTerminal();
    const { written, answer } = ask(terminal, () => undefined);
    terminal.send("data", Buffer.from([0x03]));
    await answer;

    expect(written.join("")).not.toContain(request.remedy);
  });
});

describe("a terminal that goes away", () => {
  it("answers rather than waiting forever when the stream ends", async () => {
    const terminal = fakeTerminal();
    const { answer } = ask(terminal, () => undefined);

    terminal.send("end");

    expect(await answer).toBe(false);
  });

  it("answers rather than waiting forever when the stream fails", async () => {
    const terminal = fakeTerminal();
    const { answer } = ask(terminal, () => undefined);

    terminal.send("error", new Error("stdin closed"));

    expect(await answer).toBe(false);
  });
});

describe("leaving the terminal as it was found", () => {
  it("turns raw mode back off and removes every listener, however it ended", async () => {
    for (const ending of ["y", "n", "\u0003"]) {
      const terminal = fakeTerminal();
      const { answer } = ask(terminal, () => undefined);
      terminal.send("data", Buffer.from(ending));
      await answer;

      expect(terminal.rawModeCalls).toEqual([true, false]);
      expect(terminal.listenerCount()).toBe(0);
    }
  });

  it("turns raw mode back off when the stream ends instead", async () => {
    const terminal = fakeTerminal();
    const { answer } = ask(terminal, () => undefined);
    terminal.send("end");
    await answer;

    expect(terminal.rawModeCalls).toEqual([true, false]);
    expect(terminal.listenerCount()).toBe(0);
  });
});
