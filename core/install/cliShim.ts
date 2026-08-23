import { shellQuote } from "../shellQuote.js";

/**
 * Everything the installed `markpdf` command needs to know, baked into it.
 *
 * Baked rather than looked up, because the command has to work when the application is not
 * running and must not go searching for a copy of MarkPDF — the wrong copy would be a different
 * version reading the same index.
 */
export interface ShimIdentity {
  /** The application version this shim was written by. */
  version: string;
  /** The bundle it belongs to, which is what makes "pointing elsewhere" detectable. */
  appPath: string;
  /** The Electron binary inside that bundle, run as a plain Node process. */
  electronPath: string;
  /** The command line's entry point inside the bundle. */
  entryPoint: string;
  /** The index and model cache, so the command and the application share one of each. */
  dataDir: string;
}

/** The line that says a script is ours. Everything after it on that line is JSON. */
export const SHIM_MARKER_PREFIX = "# markpdf-shim ";

/**
 * A path a shell can actually test to decide whether the entry point is reachable.
 *
 * A packaged entry point lives inside `app.asar`, which is a *file*: nothing can stat
 * `…/app.asar/dist-cli/main.js`, so testing the entry point directly would report every packaged
 * installation as broken. The archive is what exists on the filesystem, so that is what is tested;
 * outside an archive the entry point itself is.
 */
function reachabilityProbe(entryPoint: string): string {
  const segments = entryPoint.split("/");
  const archive = segments.findIndex((segment) => segment.endsWith(".asar"));
  return archive === -1 ? entryPoint : segments.slice(0, archive + 1).join("/");
}

/**
 * The shim, as a POSIX shell script.
 *
 * `ELECTRON_RUN_AS_NODE=1` against the bundled binary rather than a second Node: one fewer
 * signing target, about 55 MB smaller, and no dependence on whichever version manager wins on
 * someone's PATH.
 *
 * `:=` on the data directory assigns only when it is unset, so somebody can still point one run
 * at a different index without editing the file.
 */
export function renderShim(identity: ShimIdentity): string {
  return [
    "#!/bin/sh",
    "# The markpdf command line, installed by MarkPDF. Rewritten on update; do not edit.",
    `${SHIM_MARKER_PREFIX}${JSON.stringify(identity)}`,
    // A plain assignment inside an `if`, not `${VAR:=word}`. Inside `"${VAR:=word}"` the word is
    // not re-parsed as shell syntax, so single quotes there survive as literal bytes and a path
    // with a space would be assigned complete with its quotation marks. An assignment is parsed,
    // so the quoting works and the value is one word however it is spelled.
    'if [ -z "${MARKPDF_DATA_DIR:-}" ]; then',
    `  MARKPDF_DATA_DIR=${shellQuote(identity.dataDir)}`,
    "fi",
    "export MARKPDF_DATA_DIR",
    "ELECTRON_RUN_AS_NODE=1",
    "export ELECTRON_RUN_AS_NODE",
    // Looked at before `exec`, so a moved or deleted application produces the documented "the
    // application is unavailable" code and a sentence naming it, rather than the shell's own 126
    // or 127 — which say nothing about which application is missing.
    `if [ ! -x ${shellQuote(identity.electronPath)} ]; then`,
    `  printf 'markpdf: MarkPDF is no longer at %s. Reinstall the command from MarkPDF settings.\\n' ${shellQuote(identity.appPath)} >&2`,
    "  exit 69",
    "fi",
    `if [ ! -e ${shellQuote(reachabilityProbe(identity.entryPoint))} ]; then`,
    `  printf 'markpdf: MarkPDF at %s is missing its command line. Reinstall the command from MarkPDF settings.\\n' ${shellQuote(identity.appPath)} >&2`,
    "  exit 69",
    "fi",
    `exec ${shellQuote(identity.electronPath)} ${shellQuote(identity.entryPoint)} "$@"`,
    "",
  ].join("\n");
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a script's marker, or decide it is not ours.
 *
 * Everything here treats the file as somebody else's: a missing marker, unreadable JSON, or a
 * marker that does not carry the fields status depends on all mean "not ours", because the
 * consequence of guessing wrong is overwriting a command somebody else installed.
 */
export function parseShimIdentity(script: string): ShimIdentity | null {
  const line = script.split("\n").find((candidate) => candidate.startsWith(SHIM_MARKER_PREFIX));
  if (line === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(SHIM_MARKER_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record: Record<string, unknown> = { ...parsed };
  const version = stringField(record, "version");
  const appPath = stringField(record, "appPath");
  const electronPath = stringField(record, "electronPath");
  const entryPoint = stringField(record, "entryPoint");
  const dataDir = stringField(record, "dataDir");
  if (version === null || appPath === null || electronPath === null || entryPoint === null || dataDir === null) {
    return null;
  }
  return { version, appPath, electronPath, entryPoint, dataDir };
}

/** Which parts of a shim disagree with what this application would write now. */
export type ShimDifference = "version" | "electronPath" | "entryPoint" | "dataDir";

/**
 * What is at the install path, as far as ownership is concerned.
 *
 * `ours` means the file is byte-for-byte what this application would write for the identity its
 * own marker declares. A marker alone is not enough: it is one line, and anything that copied it
 * — or any edit somebody made afterwards — would otherwise be treated as ours and overwritten or
 * deleted. Everything else is `foreign`, including a link or a directory, and `foreign` is never
 * written to and never removed.
 */
export type ShimOccupant =
  | { kind: "nothing" }
  | { kind: "foreign" }
  | { kind: "ours"; identity: ShimIdentity };

/** Classify a script's text. Pure; the filesystem side lives in `installShimFile.ts`. */
export function occupantForScript(script: string): ShimOccupant {
  const identity = parseShimIdentity(script);
  if (identity === null) return { kind: "foreign" };
  // Re-rendered and compared, not merely parsed. This is the whole ownership claim.
  return renderShim(identity) === script ? { kind: "ours", identity } : { kind: "foreign" };
}

export type CliInstallState =
  | { state: "not-installed"; path: string }
  | { state: "current"; path: string }
  | { state: "stale"; path: string; installedVersion: string; differences: ShimDifference[] }
  | { state: "points-elsewhere"; path: string; installedAppPath: string }
  | { state: "foreign"; path: string }
  | { state: "shadowed"; path: string; shadowedBy: string }
  | { state: "not-on-path"; path: string }
  | { state: "not-executable"; path: string }
  | { state: "path-unknown"; path: string };

export interface InstallationSurvey {
  /** Where this application installs its shim. */
  installPath: string;
  /** What is at that path. */
  occupant: ShimOccupant;
  /** Every `markpdf` found on `PATH`, in the order the shell would find them. */
  onPath: readonly string[];
  /** Whether the install directory is itself on `PATH`. */
  directoryOnPath: boolean;
  /**
   * Whether the file at the install path can actually be executed.
   *
   * Measured directly rather than inferred from a `PATH` search. It is a fact about the file, and
   * a mode that was changed is invisible to anything that only reads it — so making the answer
   * wait on a `PATH` lookup would hide the one broken state that has a button to fix it.
   */
  installedIsExecutable: boolean;
  /**
   * Whether the `PATH` above is the one the person's shell actually uses.
   *
   * A Finder-launched application inherits `launchd`'s minimal `PATH`, not the login shell's, so
   * a survey built from `process.env.PATH` cannot say which `markpdf` would run. When this is
   * false the answer is `path-unknown` rather than a confident claim about shadowing.
   */
  pathKnown: boolean;
  expected: ShimIdentity;
}

/**
 * What to tell somebody about the `markpdf` on their machine.
 *
 * Pure: the caller does the looking, this does the deciding, and every case can be written down
 * without installing anything.
 *
 * The order matters. A file we did not write is reported before anything else, because it is the
 * one case where the answer is "this needs a person" rather than "press the button again" — and
 * because overwriting it is refused, the rest of the diagnosis would be moot.
 */
export function describeInstallation(survey: InstallationSurvey): CliInstallState {
  const path = survey.installPath;
  if (survey.occupant.kind === "nothing") return { state: "not-installed", path };
  if (survey.occupant.kind === "foreign") return { state: "foreign", path };

  const identity = survey.occupant.identity;
  if (identity.appPath !== survey.expected.appPath) {
    return { state: "points-elsewhere", path, installedAppPath: identity.appPath };
  }

  // **Every field, not just the version.** A shim carrying the right version and the wrong entry
  // point runs the wrong file; one carrying the wrong data directory quietly writes to a second
  // index. Both would report as current if only the version were compared, and both are fixed by
  // exactly the same action, so both are stale.
  const fields: ShimDifference[] = ["version", "electronPath", "entryPoint", "dataDir"];
  const differences = fields.filter((field) => identity[field] !== survey.expected[field]);
  if (differences.length > 0) {
    return { state: "stale", path, installedVersion: identity.version, differences };
  }

  // Ours, and current. Whether typing `markpdf` actually reaches it is a separate question, and
  // one this cannot answer without knowing the shell's own `PATH`.
  // Before any question about `PATH`. Whether the file can run is known directly and is the only
  // remaining problem with a button attached; the `PATH` diagnostics below all assume a command
  // that would work if it were found, and none of their advice helps a file that would not.
  if (!survey.installedIsExecutable) return { state: "not-executable", path };

  if (!survey.pathKnown) return { state: "path-unknown", path };
  const first = survey.onPath[0];
  if (first !== undefined && first !== path) return { state: "shadowed", path, shadowedBy: first };
  if (!survey.directoryOnPath) return { state: "not-on-path", path };
  return { state: "current", path };
}
