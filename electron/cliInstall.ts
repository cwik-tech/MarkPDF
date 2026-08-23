import { app } from "electron";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  describeInstallation,
  renderShim,
  type CliInstallState,
  type ShimIdentity,
} from "../dist-core/install/cliShim.js";
import { classifyShimOccupant, installShimFile, removeShimFile } from "../dist-core/install/installShimFile.js";
import { loginShellPath, LOGIN_SHELL_ARGS } from "../dist-core/install/loginShellPath.js";
import { testInstallDirectory } from "../dist-core/install/installDirectorySelection.js";
import { directoryIsOnPath, findOnPath, isExecutableFile } from "../dist-core/install/pathLookup.js";
import { resolveDataDir } from "../dist-core/paths.js";
import { shellQuote } from "../dist-core/shellQuote.js";

export type { CliInstallState };

export const CLI_COMMAND_NAME = "markpdf";

export interface CliInstallStatus {
  /** False where a POSIX shell shim is meaningless. Everything else is then advisory. */
  supported: boolean;
  reason?: string;
  command: string;
  installDirectory: string;
  installPath: string;
  /** The application version, which is what a stale shim is stale against. */
  version: string;
  state: CliInstallState;
  /** A line somebody can paste into their shell profile when the directory is not on PATH. */
  pathHint: string;
  /** True when the directory is one every shell already looks in without any change. */
  onDefaultPath: boolean;
}

export interface CliInstallResult {
  ok: boolean;
  /** Why it was refused. Present exactly when `ok` is false. */
  reason?: string;
  status: CliInstallStatus;
}

/**
 * `/usr/local/bin` is on macOS's default `PATH` — it is the first line of `/etc/paths` — so a
 * command installed there works in a new terminal with nothing else to do. On this machine it is
 * `root:wheel`, mode 755, and not writable by the logged-in user.
 */
const STANDARD_DIRECTORY = "/usr/local/bin";

function isWritableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to put the command.
 *
 * `/usr/local/bin` when this user can already write there, because it is on the default `PATH`
 * and the command then simply works. Otherwise `~/.local/bin`, which needs no elevation but is
 * usually not on `PATH` yet.
 *
 * **Elevation is deliberately not implemented**, and that is a departure from the plan rather
 * than an omission: writing to a root-owned directory from a document reader means an
 * administrator password prompt and a privileged shell command, which is a security surface worth
 * designing on its own rather than adding at the end of a phase. The consequence is visible
 * instead of hidden — a person who lands in `~/.local/bin` is told the directory is not on their
 * `PATH` and given the line to add. Recorded in the CLI packaging ADR with this evidence.
 */
export function cliInstallDirectory(): string {
  // Only reachable from an unpackaged build that has opted in by exact token and is already
  // pointed at a test profile — see `testInstallDirectory`. It exists so the Electron journey can
  // click the real button without writing into a real `bin` directory.
  const forTest = testInstallDirectory({ isPackaged: app.isPackaged, env: process.env });
  if (forTest !== null) return forTest;
  return isWritableDirectory(STANDARD_DIRECTORY) ? STANDARD_DIRECTORY : join(homedir(), ".local", "bin");
}

export function cliInstallPath(): string {
  return join(cliInstallDirectory(), CLI_COMMAND_NAME);
}

/**
 * `<bundle>.app/Contents/MacOS/<binary>` walks back to the bundle; anything else is left alone.
 */
function bundlePathFor(executable: string): string {
  const bundle = dirname(dirname(dirname(executable)));
  return bundle.endsWith(".app") ? bundle : dirname(executable);
}

/**
 * Where this application's compiled output lives, found from this file rather than asked for.
 *
 * **Not `app.getAppPath()`.** That returns the directory Electron resolved the entry script from,
 * which in a packaged build is `app.asar` but in a development launch is `dist-electron/` — so a
 * shim built from it baked in `dist-electron/dist-cli/main.js`, a path that does not exist. The
 * install journey caught it by running the command it had just installed. This module compiles to
 * `<root>/dist-electron/cliInstall.js`, and `dist-cli/` is that root's sibling directory in both
 * layouts, so walking up from here is correct in both.
 */
function applicationRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * The application's own version, from the manifest beside its compiled output.
 *
 * `app.getVersion()` returns Electron's version in a development launch, for the same reason as
 * above — it reads the manifest at `app.getAppPath()`. Staleness is decided by comparing this
 * against what a shim recorded, so a version that changes meaning between builds would make every
 * development shim look stale and every packaged one look current for the wrong reason.
 */
function applicationVersion(): string {
  try {
    const manifest: unknown = createRequire(import.meta.url)(join(applicationRoot(), "package.json"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = manifest.version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through to Electron's answer, which is right in a packaged build.
  }
  return app.getVersion();
}

const runCommand = promisify(execFile);

/** How long a shell profile may take before the question is abandoned. */
const SHELL_TIMEOUT_MS = 3000;

/**
 * Run the login shell and hand back what it printed.
 *
 * The subprocess lives here because `electron/` owns privileged input and output; `core/` gets an
 * injected runner and decides what the answer means. The argument list is a constant from there,
 * so nothing on this side is built from user input, and the timeout is hard — a profile that never
 * returns must not leave the question open for ever.
 *
 * **Asynchronous, and that is the point.** The settings screen asks for this the moment it opens,
 * from the process that draws the window. `execFileSync` stopped everything — the interface
 * included — for as long as somebody's shell profile took, and plenty take a second.
 * `electron/defaultApp.ts` reached the same conclusion about `osascript`.
 */
async function runLoginShell(shell: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runCommand(shell, [...args], {
    encoding: "utf8",
    timeout: SHELL_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

export function shimIdentity(): ShimIdentity {
  return {
    version: applicationVersion(),
    appPath: bundlePathFor(process.execPath),
    electronPath: process.execPath,
    entryPoint: join(applicationRoot(), "dist-cli", "main.js"),
    dataDir: resolveDataDir(app.getPath("userData")),
  };
}

export async function getCliInstallStatus(): Promise<CliInstallStatus> {
  const installPath = cliInstallPath();
  const installDirectory = cliInstallDirectory();
  const expected = shimIdentity();
  const supported = process.platform !== "win32";
  // Awaited, not blocked on. The settings screen asks for this as soon as it opens, and this is
  // the process that draws the window.
  const shellPath = await loginShellPath(process.env, runLoginShell);

  const state = describeInstallation({
    installPath,
    // `classifyShimOccupant` never follows a link, so a link at the install path is reported as a
    // conflict rather than read through — which would otherwise let a link to a real shim show as
    // installed and current while install and remove both refuse it.
    occupant: classifyShimOccupant(installPath),
    onPath: shellPath === null ? [] : findOnPath(shellPath, CLI_COMMAND_NAME, isExecutableFile),
    directoryOnPath: shellPath !== null && directoryIsOnPath(shellPath, installDirectory),
    pathKnown: shellPath !== null,
    // Asked of the file itself, not of the `PATH` search above, which cannot answer it when the
    // shell's `PATH` is unknown or the directory is not on it.
    installedIsExecutable: isExecutableFile(installPath),
    expected,
  });

  return {
    supported,
    ...(supported ? {} : { reason: "The command line is installed as a POSIX shell script, which Windows does not run." }),
    command: CLI_COMMAND_NAME,
    installDirectory,
    installPath,
    version: expected.version,
    state,
    pathHint: `export PATH=${shellQuote(installDirectory)}:"$PATH"`,
    onDefaultPath: installDirectory === STANDARD_DIRECTORY,
  };
}

/**
 * Write the shim, unless something else is already there.
 *
 * The refusals and the atomic write live in `core/install/installShimFile.ts`, which is tested
 * against real directories: a link at the install path is never written through, and an
 * interrupted write cannot leave a truncated command where a working one was.
 */
export async function installCli(): Promise<CliInstallResult> {
  const before = await getCliInstallStatus();
  if (!before.supported) return { ok: false, reason: before.reason ?? "Not supported here.", status: before };

  const outcome = installShimFile(before.installPath, renderShim(shimIdentity()));
  if (!outcome.ok) return { ok: false, reason: outcome.reason, status: await getCliInstallStatus() };
  return { ok: true, status: await getCliInstallStatus() };
}

/** Remove the shim, and only ever the shim. */
export async function uninstallCli(): Promise<CliInstallResult> {
  const outcome = removeShimFile(cliInstallPath());
  if (!outcome.ok) return { ok: false, reason: outcome.reason, status: await getCliInstallStatus() };
  return { ok: true, status: await getCliInstallStatus() };
}
