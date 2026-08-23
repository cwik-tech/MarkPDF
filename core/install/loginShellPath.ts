/**
 * Running a command belongs to `electron/`; deciding what its answer means belongs here.
 *
 * The caller supplies the runner, so this module imports no `node:child_process` and starts
 * nothing. That keeps subprocess ownership where the repository puts it, and still lets the rules
 * below — which spellings are worth asking about, what an empty or failed answer means — be
 * checked without a real shell.
 */
export type ShellRunner = (shell: string, args: readonly string[]) => Promise<unknown>;

const PATH_START = "__MARKPDF_PATH_START__";
const PATH_END = "__MARKPDF_PATH_END__";

/**
 * What the login shell is asked, verbatim and always.
 *
 * A constant rather than a parameter: nothing about this question is ever built from user input,
 * and putting it here means the one place that could vary it is the one place that cannot.
 */
export const LOGIN_SHELL_ARGS: readonly string[] = [
  "-i",
  "-l",
  "-c",
  `printf "\\n${PATH_START}%s${PATH_END}\\n" "$PATH"`,
];

/**
 * The `PATH` the person's shell actually uses, or nothing.
 *
 * An application launched from Finder inherits `launchd`'s minimal environment, not the login
 * shell's, so `process.env.PATH` says nothing about which `markpdf` a terminal would run. An
 * interactive login shell is asked instead, matching a fresh Terminal session and loading zsh's
 * `.zshrc` as well as its login files. It is asked asynchronously because the settings screen
 * asks for this the moment it opens, from the process that draws the window.
 *
 * `null` means the question could not be answered: no shell named, a relative name that would
 * resolve against whatever directory this happens to be in, a failure, a timeout, an empty answer,
 * or an answer that is not a bare `PATH`. Every one of those is reported as unknown rather than
 * guessed at, and a relative name is refused *without running anything*.
 *
 * The fixed command frames `PATH` between two markers. Interactive shell plugins and the
 * pseudo-terminal may print their own text, so unframed output is ignored. The bytes between the
 * markers are kept exactly, including whitespace and line breaks that legally belong to a path.
 */
export async function loginShellPath(env: NodeJS.ProcessEnv, run: ShellRunner): Promise<string | null> {
  const shell = env.SHELL;
  if (shell === undefined || !shell.startsWith("/")) return null;
  try {
    const printed: unknown = await run(shell, LOGIN_SHELL_ARGS);
    // The runner's output is somebody else's, and its type is nobody's promise: a shell profile
    // can print anything at all, and the capability that carried it is injected.
    if (typeof printed !== "string") return null;
    const start = printed.lastIndexOf(PATH_START);
    if (start < 0) return null;
    const valueStart = start + PATH_START.length;
    const end = printed.indexOf(PATH_END, valueStart);
    if (end < 0) return null;
    return printed.slice(valueStart, end);
  } catch {
    return null;
  }
}
