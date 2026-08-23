/**
 * Running a command belongs to `electron/`; deciding what its answer means belongs here.
 *
 * The caller supplies the runner, so this module imports no `node:child_process` and starts
 * nothing. That keeps subprocess ownership where the repository puts it, and still lets the rules
 * below — which spellings are worth asking about, what an empty or failed answer means — be
 * checked without a real shell.
 */
export type ShellRunner = (shell: string, args: readonly string[]) => Promise<unknown>;

/**
 * What the login shell is asked, verbatim and always.
 *
 * A constant rather than a parameter: nothing about this question is ever built from user input,
 * and putting it here means the one place that could vary it is the one place that cannot.
 */
export const LOGIN_SHELL_ARGS: readonly string[] = ["-l", "-c", 'printf %s "$PATH"'];

/**
 * The `PATH` the person's shell actually uses, or nothing.
 *
 * An application launched from Finder inherits `launchd`'s minimal environment, not the login
 * shell's, so `process.env.PATH` says nothing about which `markpdf` a terminal would run. The
 * login shell is asked instead — and asked asynchronously, because the settings screen asks for
 * this the moment it opens, from the process that draws the window.
 *
 * `null` means the question could not be answered: no shell named, a relative name that would
 * resolve against whatever directory this happens to be in, a failure, a timeout, an empty answer,
 * or an answer that is not a bare `PATH`. Every one of those is reported as unknown rather than
 * guessed at, and a relative name is refused *without running anything*.
 *
 * **A non-empty answer is kept byte for byte.** `printf %s "$PATH"` emits the variable and nothing
 * else, so every character belongs to it — including leading and trailing spaces, which are
 * perfectly legal in a directory name. Trimming would quietly hand back a different `PATH` from
 * the one the shell has. An answer carrying a line break is a profile that printed something of
 * its own, and since its output cannot be separated from the variable's, the answer is refused
 * rather than cleaned up.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv, run: ShellRunner): Promise<string | null> {
  const shell = env.SHELL;
  if (shell === undefined || !shell.startsWith("/")) return null;
  try {
    const printed: unknown = await run(shell, LOGIN_SHELL_ARGS);
    // The runner's output is somebody else's, and its type is nobody's promise: a shell profile
    // can print anything at all, and the capability that carried it is injected.
    if (typeof printed !== "string" || printed.length === 0) return null;
    if (printed.includes("\n") || printed.includes("\r")) return null;
    return printed;
  } catch {
    return null;
  }
}
