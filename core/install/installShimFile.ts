import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMissingPathError } from "../consent/allowlist.js";
import { occupantForScript, type ShimOccupant } from "./cliShim.js";

export type InstallOutcome = { ok: true; path: string } | { ok: false; reason: string };

/** What is at this path, with enough detail to say why it was refused. */
type Occupant = ShimOccupant | { kind: "symlink" } | { kind: "not-a-file" };

function occupantOf(path: string): Occupant {
  let entry: ReturnType<typeof lstatSync>;
  try {
    // `lstat`, never `stat`. A link at the install path must be seen as a link, because the whole
    // question is whether writing here would write somewhere else — and because reading through
    // it would let a link to a real shim report the command as installed and current.
    entry = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "nothing" };
    throw error;
  }
  if (entry.isSymbolicLink()) return { kind: "symlink" };
  if (!entry.isFile()) return { kind: "not-a-file" };
  return occupantForScript(readFileSync(path, "utf8"));
}

/**
 * What is at the install path, for a caller that only needs the ownership question answered.
 *
 * Never follows a link: anything that is not a regular file this application would have written
 * is `foreign`, so a status screen cannot report a link as the installed command.
 */
export function classifyShimOccupant(path: string): ShimOccupant {
  const occupant = occupantOf(path);
  if (occupant.kind === "symlink" || occupant.kind === "not-a-file") return { kind: "foreign" };
  return occupant;
}

function refusal(path: string, occupant: Occupant): string | null {
  switch (occupant.kind) {
    case "symlink":
      return `${path} is a symbolic link. MarkPDF will not write through it, because that would change a file somewhere else.`;
    case "not-a-file":
      return `${path} is not a regular file, so MarkPDF has left it alone.`;
    case "foreign":
      return `${path} is not a command MarkPDF wrote, so it has been left alone. Remove it yourself if you want MarkPDF's command there.`;
    default:
      return null;
  }
}

/**
 * Write the command, or refuse and say why.
 *
 * **Never in place.** The script is written inside a directory this call created and is renamed
 * onto the target, so the command at that path is either the old one or the new one — an
 * interrupted write cannot leave a truncated script that a shell would happily run. The staging
 * directory is a sibling of the target, so the rename is within one filesystem and therefore
 * atomic, and it is created by `mkdtemp`, so nothing this call did not create is ever removed.
 * A fixed staging name would have been a file somebody else could own.
 *
 * **Never through a link, and never over anything that is not exactly ours.** A marker line is a
 * claim; the file has to be byte-for-byte what this application would write.
 */
export function installShimFile(path: string, script: string): InstallOutcome {
  const occupant = occupantOf(path);
  const reason = refusal(path, occupant);
  if (reason !== null) return { ok: false, reason };

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let staging: string | null = null;
  try {
    staging = mkdtempSync(join(directory, ".markpdf-install-"));
    const pending = join(staging, "markpdf");
    // `wx` is `O_CREAT | O_EXCL`: it creates or fails, and never follows a link. The directory
    // was made by `mkdtemp` a moment ago, so nothing should be there — this is what makes that a
    // checked fact rather than an assumption.
    writeFileSync(pending, script, { encoding: "utf8", mode: 0o755, flag: "wx" });
    chmodSync(pending, 0o755);
    renameSync(pending, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, reason: `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    // Only what this call created, and only ever the directory it made.
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
  }
}

/** Remove the command, and only ever a regular file exactly as this application wrote it. */
export function removeShimFile(path: string): InstallOutcome {
  const occupant = occupantOf(path);
  if (occupant.kind === "nothing") return { ok: true, path };
  const reason = refusal(path, occupant);
  if (reason !== null) return { ok: false, reason };

  try {
    rmSync(path, { force: true });
    return { ok: true, path };
  } catch (error) {
    return { ok: false, reason: `Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
