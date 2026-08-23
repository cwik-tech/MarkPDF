import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isMissingPathError } from "../consent/allowlist.js";
import { shellQuote } from "../shellQuote.js";

const BLOCK_START = "# >>> MarkPDF command >>>";
const BLOCK_END = "# <<< MarkPDF command <<<";

export interface ShellPathInput {
  env: Readonly<{ SHELL?: string | undefined; ZDOTDIR?: string | undefined }>;
  homeDirectory: string;
  installDirectory: string;
}

export type ShellPathOutcome =
  | { ok: true; changed: boolean; profilePath: string }
  | { ok: false; reason: string };

type ProfileFile = { requestedPath: string; writePath: string; contents: string; mode: number };

function selectedProfile(input: ShellPathInput): { ok: true; path: string } | { ok: false; reason: string } {
  const shell = input.env.SHELL;
  if (shell === undefined || !isAbsolute(shell)) {
    return { ok: false, reason: "MarkPDF could not identify an absolute path to your shell." };
  }
  if (!isAbsolute(input.homeDirectory)) {
    return { ok: false, reason: "MarkPDF could not identify an absolute path to your home directory." };
  }

  const shellName = basename(shell);
  if (shellName === "zsh") {
    const configDirectory = input.env.ZDOTDIR ?? input.homeDirectory;
    if (!isAbsolute(configDirectory)) {
      return { ok: false, reason: "MarkPDF will not edit a relative ZDOTDIR shell profile path." };
    }
    return { ok: true, path: join(configDirectory, ".zshrc") };
  }

  if (shellName === "bash") {
    const fallback = join(input.homeDirectory, ".bash_profile");
    const candidates = [fallback, join(input.homeDirectory, ".bash_login"), join(input.homeDirectory, ".profile")];
    return { ok: true, path: candidates.find((path) => existsSync(path)) ?? fallback };
  }

  if (shellName === "sh") return { ok: true, path: join(input.homeDirectory, ".profile") };
  return { ok: false, reason: `MarkPDF cannot safely update ${shellName}'s shell profile yet.` };
}

function readProfile(requestedPath: string): { ok: true; profile: ProfileFile } | { ok: false; reason: string } {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(requestedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        ok: true,
        profile: { requestedPath, writePath: requestedPath, contents: "", mode: 0o644 },
      };
    }
    return { ok: false, reason: `Could not inspect ${requestedPath}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let writePath = requestedPath;
  if (entry.isSymbolicLink()) {
    try {
      writePath = realpathSync(requestedPath);
      entry = lstatSync(writePath);
    } catch (error) {
      return {
        ok: false,
        reason: `Could not resolve the shell profile link at ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!entry.isFile()) return { ok: false, reason: `${requestedPath} is not a regular shell profile file.` };

  try {
    return {
      ok: true,
      profile: {
        requestedPath,
        writePath,
        contents: readFileSync(writePath, "utf8"),
        mode: entry.mode & 0o777,
      },
    };
  } catch (error) {
    return { ok: false, reason: `Could not read ${requestedPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function managedBlock(installDirectory: string): string {
  return `${BLOCK_START}\nexport PATH=${shellQuote(installDirectory)}:"$PATH"\n${BLOCK_END}\n`;
}

function withManagedBlock(contents: string, installDirectory: string): { ok: true; contents: string } | { ok: false; reason: string } {
  const block = managedBlock(installDirectory);
  if (contents.endsWith(block)) return { ok: true, contents };
  if (contents.includes(BLOCK_START) || contents.includes(BLOCK_END)) {
    return { ok: false, reason: "The existing MarkPDF shell profile block has been changed, so MarkPDF left it alone." };
  }
  return { ok: true, contents: `${contents}${contents.length === 0 ? "" : "\n"}${block}` };
}

function withoutManagedBlock(contents: string, installDirectory: string): { ok: true; contents: string } | { ok: false; reason: string } {
  const block = managedBlock(installDirectory);
  if (!contents.includes(BLOCK_START) && !contents.includes(BLOCK_END)) return { ok: true, contents };
  if (contents === block) return { ok: true, contents: "" };
  if (contents.endsWith(block)) {
    const prefix = contents.slice(0, -block.length);
    if (prefix.endsWith("\n")) return { ok: true, contents: prefix.slice(0, -1) };
  }
  return { ok: false, reason: "The MarkPDF shell profile block has been changed, so MarkPDF left it alone." };
}

function replaceProfile(profile: ProfileFile, contents: string): { ok: true } | { ok: false; reason: string } {
  const directory = dirname(profile.writePath);
  let staging: string | null = null;
  try {
    mkdirSync(directory, { recursive: true });
    staging = mkdtempSync(join(directory, ".markpdf-profile-"));
    const pending = join(staging, "profile");
    writeFileSync(pending, contents, { encoding: "utf8", mode: profile.mode, flag: "wx" });
    chmodSync(pending, profile.mode);
    renameSync(pending, profile.writePath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not update ${profile.requestedPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
  }
}

function updateShellPath(input: ShellPathInput, remove: boolean): ShellPathOutcome {
  const selection = selectedProfile(input);
  if (!selection.ok) return selection;
  const loaded = readProfile(selection.path);
  if (!loaded.ok) return loaded;
  const changedContents = remove
    ? withoutManagedBlock(loaded.profile.contents, input.installDirectory)
    : withManagedBlock(loaded.profile.contents, input.installDirectory);
  if (!changedContents.ok) return changedContents;
  if (changedContents.contents === loaded.profile.contents) {
    return { ok: true, changed: false, profilePath: selection.path };
  }
  const write = replaceProfile(loaded.profile, changedContents.contents);
  if (!write.ok) return write;
  return { ok: true, changed: true, profilePath: selection.path };
}

/** Add MarkPDF's command directory through a small block that the application can later identify. */
export function installShellPath(input: ShellPathInput): ShellPathOutcome {
  return updateShellPath(input, false);
}

/** Remove only the exact block MarkPDF generated, preserving every other profile byte. */
export function removeShellPath(input: ShellPathInput): ShellPathOutcome {
  return updateShellPath(input, true);
}
