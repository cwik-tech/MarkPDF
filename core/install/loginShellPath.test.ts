import { describe, expect, it } from "vitest";
import { loginShellPath, LOGIN_SHELL_ARGS, type ShellRunner } from "./loginShellPath.js";

/**
 * Asking the login shell what its `PATH` is, without stopping everything else.
 *
 * The settings screen asks for this the moment it opens, from the process that draws the window.
 * A shell profile that takes a second — and plenty do — must not take the interface with it.
 *
 * The runner is injected: starting a subprocess belongs to `electron/`, and what its answer means
 * belongs here. So these check the rules, and the one thing that matters about the shape — that
 * the answer is awaited rather than waited for.
 */

const answering = (printed: unknown): ShellRunner => async () => printed;
const PATH_START = "__MARKPDF_PATH_START__";
const PATH_END = "__MARKPDF_PATH_END__";
const pathAnswer = (path: string, before = "", after = ""): ShellRunner =>
  answering(`${before}${PATH_START}${path}${PATH_END}${after}`);

/** Resolves only when the test says so, standing in for a shell profile that takes its time. */
function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve: (value: string) => void = () => undefined;
  const promise = new Promise<string>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** A pending promise, decided in microtasks alone — no timers, no scheduler assumptions. */
const STILL_PENDING = Symbol("still pending");
async function pendingness(promise: Promise<unknown>): Promise<unknown> {
  return await Promise.race([promise, Promise.resolve(STILL_PENDING)]);
}

describe("while the shell is answering", () => {
  it("hands back a promise and lets the caller carry on", async () => {
    // A synchronous implementation finishes the subprocess before it returns at all, so there is
    // no moment at which the answer is outstanding and the caller is still free. This checks that
    // such a moment exists, and does it in microtasks — nothing here waits on a clock.
    const shell = deferred();
    const done: string[] = [];

    const pending = loginShellPath({ SHELL: "/bin/zsh" }, () => shell.promise);

    expect(await pendingness(pending)).toBe(STILL_PENDING);
    // Something else happens while the shell has not answered, which is the whole point.
    done.push("the caller kept going");
    expect(done).toEqual(["the caller kept going"]);

    shell.resolve(`${PATH_START}/a:/b${PATH_END}`);

    expect(await pending).toBe("/a:/b");
  });

  it("is settled once the shell has answered", async () => {
    const shell = deferred();
    const pending = loginShellPath({ SHELL: "/bin/zsh" }, () => shell.promise);
    shell.resolve(`${PATH_START}/a${PATH_END}`);

    await pending;

    expect(await pendingness(pending)).toBe("/a");
  });
});

describe("what it asks", () => {
  it("loads the interactive profile used by a fresh terminal", () => {
    expect(LOGIN_SHELL_ARGS).toEqual([
      "-i",
      "-l",
      "-c",
      'printf "\\n__MARKPDF_PATH_START__%s__MARKPDF_PATH_END__\\n" "$PATH"',
    ]);
  });

  it("always asks the same fixed question", async () => {
    let asked: readonly string[] = [];
    await loginShellPath({ SHELL: "/bin/zsh" }, async (_shell, args) => {
      asked = args;
      return `${PATH_START}/a${PATH_END}`;
    });

    expect(asked).toEqual(LOGIN_SHELL_ARGS);
  });

  it("asks the shell the environment names", async () => {
    let asked = "";
    await loginShellPath({ SHELL: "/opt/homebrew/bin/fish" }, async (shell) => {
      asked = shell;
      return `${PATH_START}/a${PATH_END}`;
    });

    expect(asked).toBe("/opt/homebrew/bin/fish");
  });
});

describe("what it answers", () => {
  it("returns the PATH the shell printed, byte for byte", async () => {
    expect(await loginShellPath({ SHELL: "/bin/zsh" }, pathAnswer("/opt/bin:/usr/bin"))).toBe("/opt/bin:/usr/bin");
  });

  it("keeps whitespace at the very edges of the answer, which belongs to a directory name", async () => {
    // `printf %s "$PATH"` emits the variable and nothing else, so every character is part of it —
    // including the first and last. A first entry that is relative and begins with a space, and a
    // last entry that ends with one, are unusual rather than invalid, and trimming would hand back
    // a different PATH from the one the shell has. Interior spaces would survive trimming, so the
    // whitespace has to be at the edges for this to test anything.
    const withEdgeSpaces = " relative/dir:/usr/bin:/Users/me/staging ";
    expect(await loginShellPath({ SHELL: "/bin/zsh" }, pathAnswer(withEdgeSpaces))).toBe(withEdgeSpaces);
  });

  it("extracts PATH from terminal and plugin chatter", async () => {
    const answer = pathAnswer("/opt/bin:/usr/bin", "^D\b\b\r\nforge ready\r\n", "\r\n% ");

    expect(await loginShellPath({ SHELL: "/bin/zsh" }, answer)).toBe("/opt/bin:/usr/bin");
  });

  it("refuses output without one complete framed PATH", async () => {
    for (const malformed of [
      "",
      "/usr/bin",
      `${PATH_START}/usr/bin`,
      `/usr/bin${PATH_END}`,
      `${PATH_END}/usr/bin${PATH_START}`,
    ]) {
      expect(await loginShellPath({ SHELL: "/bin/zsh" }, answering(malformed))).toBeNull();
    }
  });

  it("refuses an answer that is not text at all", async () => {
    for (const odd of [undefined, null, 42, Buffer.from("/usr/bin"), { stdout: "/usr/bin" }]) {
      expect(await loginShellPath({ SHELL: "/bin/zsh" }, answering(odd))).toBeNull();
    }
  });

  it("answers nothing when there is no shell to ask", async () => {
    expect(await loginShellPath({}, pathAnswer("/a"))).toBeNull();
  });

  it("refuses a relative shell name without running anything", async () => {
    // A relative `SHELL` would be resolved against whatever directory this happens to be in.
    let ran = false;
    const answer = await loginShellPath({ SHELL: "sh" }, async () => {
      ran = true;
      return `${PATH_START}/a${PATH_END}`;
    });

    expect(answer).toBeNull();
    expect(ran).toBe(false);
  });

  it("answers nothing when the shell fails", async () => {
    const failing: ShellRunner = async () => {
      throw new Error("Command failed: exit 1");
    };

    expect(await loginShellPath({ SHELL: "/bin/zsh" }, failing)).toBeNull();
  });

  it("answers nothing when the shell prints nothing", async () => {
    expect(await loginShellPath({ SHELL: "/bin/zsh" }, answering(""))).toBeNull();
  });
});
