import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";

/** Asked about one candidate path. Injected so the rules below need no filesystem. */
export type IsExecutable = (path: string) => boolean;

/**
 * Would a shell run this?
 *
 * A regular file that the current user may execute — following links, because a shell does. It
 * lives here rather than beside its caller so it can be checked against real files: the case that
 * matters is a command that is installed, is exactly ours, and has had its mode changed, which is
 * indistinguishable from a working command to anything that only reads the file.
 */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function entriesOf(pathVariable: string | undefined): string[] {
  if (pathVariable === undefined || pathVariable.length === 0) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of pathVariable.split(":")) {
    // An empty entry means the current directory to a POSIX shell. Skipped deliberately: a
    // `markpdf` in whatever directory the application happened to launch from is not a fact
    // worth reporting, and treating it as one would make the status flap.
    if (entry.length === 0) continue;
    const normalised = resolve(entry);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    entries.push(normalised);
  }
  return entries;
}

/**
 * Every place on `PATH` where this command exists, in the order a shell would find them.
 *
 * The order is what makes shadowing detectable: an installed shim sitting behind somebody else's
 * copy is not the command that runs when the name is typed.
 */
export function findOnPath(pathVariable: string | undefined, command: string, isExecutable: IsExecutable): string[] {
  return entriesOf(pathVariable)
    .map((directory) => resolve(directory, command))
    .filter((candidate) => isExecutable(candidate));
}

/** Is this directory somewhere the shell would look? Compared as paths, never as strings. */
export function directoryIsOnPath(pathVariable: string | undefined, directory: string): boolean {
  const target = resolve(directory);
  return entriesOf(pathVariable).includes(target);
}
