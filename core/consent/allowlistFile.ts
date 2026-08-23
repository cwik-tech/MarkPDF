import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { allowlistPath } from "../paths.js";
import { containsPath, isMissingPathError, resolveRealPath, type AccessKind, type Allowlist } from "./allowlist.js";
import { shellQuote } from "../shellQuote.js";

export { allowlistPath as allowlistFilePath };

export class AllowlistFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super(`Cannot use the consent record at ${path}: ${reason}`, cause === undefined ? {} : { cause });
    this.name = "AllowlistFileError";
    this.path = path;
  }
}

/**
 * Somebody else is changing the consent record.
 *
 * A separate type from `AllowlistFileError` because the two need opposite advice. A damaged record
 * has to be looked at; a held one only has to be waited for, and telling somebody to remove the
 * consent record would throw away every grant they had made *and* leave the lock exactly where it
 * was.
 *
 * `recoverCommand` is a runnable command that removes the **lock file** and only the lock file,
 * and it exists only when nobody can be shown to own it — a lock whose owner is running is not
 * something a person should be invited to delete, and for that case there is nothing to offer but
 * waiting. It is a command rather than a sentence because that is what the surrounding contract
 * promises a remedy is: something that can be pasted and will work.
 */
export class AllowlistLockedError extends Error {
  readonly lockPath: string;
  /** A command that clears an abandoned lock, when there is one. Never touches the record. */
  readonly recoverCommand?: string;

  constructor(lockPath: string, reason: string, options: { recoverable: boolean; cause?: unknown }) {
    super(reason, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "AllowlistLockedError";
    this.lockPath = lockPath;
    // `--` first, so a lock path that began with a dash could not be read as an option.
    if (options.recoverable) this.recoverCommand = `rm -- ${shellQuote(lockPath)}`;
  }
}

export type GrantChange = "allow" | "revoke";

export interface Grant {
  change: GrantChange;
  access: AccessKind;
  path: string;
}

/**
 * What one grant actually did, so a run can say so instead of implying success.
 *
 * `covered-by-ancestor` is the case worth spelling out. Roots are a union with no deny rule, so a
 * subdirectory of a granted folder cannot be withdrawn on its own — and calling that
 * `not-granted` would tell somebody auditing their own exposure that a folder was unreachable
 * when it is not. The operation still changes nothing; only the sentence is different, and the
 * sentence is the whole point.
 */
export type GrantEffect = "added" | "already-granted" | "withdrawn" | "not-granted" | "covered-by-ancestor";

export interface GrantRecord extends Grant {
  /** The path as it was stored or matched: resolved, not as typed. */
  resolvedPath: string;
  effect: GrantEffect;
  /** The broader root that still reaches this path. Present only for `covered-by-ancestor`. */
  coveredBy?: string;
}

const EMPTY: Allowlist = { readRoots: [], writeRoots: [] };

function rootsFor(allowlist: Allowlist, access: AccessKind): readonly string[] {
  return access === "read" ? allowlist.readRoots : allowlist.writeRoots;
}

function withRoots(allowlist: Allowlist, access: AccessKind, roots: readonly string[]): Allowlist {
  return access === "read" ? { ...allowlist, readRoots: roots } : { ...allowlist, writeRoots: roots };
}

/**
 * Apply grants and withdrawals in order, and report what each one did.
 *
 * Pure, so the same function serves the command line, the interactive prompt and — later — the
 * MCP server, and so the rules below are testable without a filesystem write.
 *
 * **Paths are stored resolved.** Someone granting `/tmp/papers` on macOS is granting
 * `/private/tmp/papers`, and recording the spelling rather than the directory would make the
 * record disagree with the check. It also makes two spellings of one directory one grant.
 *
 * **Withdrawal reaches downwards.** Revoking a directory removes every root inside it, not only
 * an exact match. Consent withdrawn from a library that is still granted three levels down has
 * not been withdrawn, and the person doing it would have no way to know.
 *
 * **Withdrawal compares against the stored root as written, from three possible boundaries.** The
 * stored roots are never re-resolved: doing so would mean a granted directory since replaced by a
 * link resolves somewhere else and escapes the withdrawal. The path being revoked is matched as
 * it resolves *now*, which is what makes an alias work; as its plain absolute spelling; and as its
 * real parent plus its own last segment — resolving everything above the named directory but not
 * the directory itself. The third is what makes a grant withdrawable by exactly the name it was
 * granted under after something replaced it, which the other two miss whenever any parent is
 * itself a link (`/var` on macOS, for one). Matching more boundaries only ever removes more, and
 * removing more is the safe direction for a withdrawal.
 */
export function applyGrants(current: Allowlist, grants: readonly Grant[]): { allowlist: Allowlist; records: GrantRecord[] } {
  let allowlist = current;
  const records: GrantRecord[] = [];

  for (const grant of grants) {
    const resolvedPath = resolveRealPath(grant.path);
    const roots = rootsFor(allowlist, grant.access);

    if (grant.change === "allow") {
      const held = roots.some((root) => root === resolvedPath);
      if (!held) allowlist = withRoots(allowlist, grant.access, [...roots, resolvedPath]);
      records.push({ ...grant, resolvedPath, effect: held ? "already-granted" : "added" });
      continue;
    }

    const absolute = resolve(grant.path);
    const boundaries = [resolvedPath, absolute, join(resolveRealPath(dirname(absolute)), basename(absolute))];
    const kept = roots.filter((root) => !boundaries.some((boundary) => containsPath(boundary, root)));
    const withdrew = kept.length !== roots.length;
    if (withdrew) {
      allowlist = withRoots(allowlist, grant.access, kept);
      records.push({ ...grant, resolvedPath, effect: "withdrawn" });
      continue;
    }

    // Nothing was removed. Before saying nothing was held, check whether something broader still
    // reaches it — the difference between "you cannot read that" and "you still can, through the
    // folder above it".
    const ancestor = kept.find((root) => boundaries.some((boundary) => containsPath(root, boundary)));
    records.push(
      ancestor === undefined
        ? { ...grant, resolvedPath, effect: "not-granted" }
        : { ...grant, resolvedPath, effect: "covered-by-ancestor", coveredBy: ancestor },
    );
  }

  return { allowlist, records };
}

function requireRootList(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AllowlistFileError(path, `${field} must be a list of paths.`);
  }
  const roots = value.filter((entry): entry is string => typeof entry === "string");
  // Absolute only. A relative root would mean whatever directory the process happened to be
  // launched from, so one record would grant different things to different runs — and the
  // containment check treats roots as canonical boundaries, which a relative path is not.
  const relative = roots.filter((root) => !isAbsolute(root));
  if (relative.length > 0) {
    throw new AllowlistFileError(path, `${field} must contain absolute paths; found ${JSON.stringify(relative[0])}.`);
  }
  return roots;
}

/**
 * The consent record, or nothing when there is none.
 *
 * A missing file is the empty allowlist: nobody has granted anything yet, which is the correct
 * starting position for a tool that reads other people's files. **A damaged file is not.**
 * Treating unreadable as empty would silently discard grants and then overwrite them on the next
 * write, so the person would be asked again for something they had already decided — and worse,
 * a later `--allow` would replace their whole record with one entry.
 */
export function readAllowlist(dataDir: string): Allowlist {
  const path = allowlistPath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return EMPTY;
    const reason = error instanceof Error ? error.message : String(error);
    throw new AllowlistFileError(path, reason, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AllowlistFileError(path, "it is not valid JSON.", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AllowlistFileError(path, "it is not an object.");
  }

  const record: Record<string, unknown> = { ...parsed };
  return {
    readRoots: requireRootList(record.readRoots, "readRoots", path),
    writeRoots: requireRootList(record.writeRoots, "writeRoots", path),
  };
}

/**
 * Replace the consent record, atomically and privately.
 *
 * Written inside a directory this call creates and renamed onto the record, so an interrupted
 * write leaves the previous record intact rather than a truncated one that would fail to parse
 * and block the next run. The staging directory is a sibling of the record, so the rename is
 * within one filesystem and therefore atomic.
 *
 * **`mkdtemp`, not a fixed name.** A predictable sibling is a path this application did not
 * create: an unrelated file there would be overwritten, and a symbolic link there would be
 * written *through*, truncating whatever it pointed at. This is the security boundary, so it is
 * the last place that should be able to damage a file nobody named.
 *
 * Mode `0600` because another account on the machine has no business reading which of this
 * person's directories a tool may open.
 */
export function writeAllowlist(dataDir: string, allowlist: Allowlist): void {
  const path = allowlistPath(dataDir);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let staging: string | null = null;
  try {
    staging = mkdtempSync(join(directory, ".writing-"));
    const pending = join(staging, "allowlist.json");
    // `wx` is `O_CREAT | O_EXCL`: it creates or fails, and never follows a link. The directory was
    // made by `mkdtemp` a moment ago, so nothing should be there — this makes that a checked fact.
    writeFileSync(pending, `${JSON.stringify(allowlist, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(pending, 0o600);
    renameSync(pending, path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AllowlistFileError(path, reason, error);
  } finally {
    // Only what this call created, and only ever the directory it made.
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
  }
}

/** The only shape a lock file may have. Anything else is a lock of unknown ownership. */
const LOCK_CONTENTS = /^markpdf-lock (\d+)\n$/;

function lockPathFor(dataDir: string): string {
  return `${allowlistPath(dataDir)}.lock`;
}

/**
 * Is the process that took this lock still running?
 *
 * Used only to decide what to *say*. `true` means waiting will work; anything else means a person
 * has to look. Never used to decide whether to delete the lock — see `acquireLock`.
 *
 * A wall-clock guess was written first and removed: it takes a lock away from a process that was
 * merely paused, at a breakpoint or by the scheduler, which is the lost update the lock exists to
 * prevent. Process ids are reused, so `true` can be a different process entirely — which only
 * ever produces the more cautious of the two messages.
 */
function lockOwnerIsRunning(contents: string): boolean | null {
  const owner = LOCK_CONTENTS.exec(contents)?.[1];
  if (owner === undefined) return null;
  const pid = Number(owner);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // Signal 0 performs the permission and existence checks without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return false;
    // `EPERM` means it exists and belongs to somebody else; anything else is unexplained. Neither
    // is evidence that the owner is gone.
    return null;
  }
}

/**
 * Take exclusive hold of the consent record, or refuse.
 *
 * `O_CREAT | O_EXCL` is the whole mechanism: creating the lock either succeeds, in which case
 * nobody else holds it, or fails, in which case somebody does. There is no window between the
 * check and the claim, which is what distinguishes this from re-reading before writing —
 * re-reading narrows the race and cannot remove it, and the change that gets lost to a race can
 * be a *withdrawal*.
 *
 * **An existing lock is never taken over, whatever it says.** Removing one and creating another
 * is two operations, not one: two processes can both read the same abandoned lock, and each can
 * then delete the *other's* fresh lock and proceed — so an automatic takeover reintroduces
 * exactly the overlap the lock exists to prevent, however carefully the owner is identified.
 * Process liveness is used to choose the *message*, not to decide whether to delete anything.
 *
 * The cost is that a process which died between claiming and releasing leaves a lock a person has
 * to remove. That is a rare, visible, one-line repair, and the message names the file. The
 * alternative is a silent lost withdrawal, which is neither rare enough nor visible at all.
 */
function acquireLock(dataDir: string): number {
  const path = lockPathFor(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const busy = (reason: string, recoverable: boolean, cause?: unknown): AllowlistLockedError =>
    new AllowlistLockedError(path, reason, { recoverable, ...(cause === undefined ? {} : { cause }) });

  let handle: number;
  try {
    handle = openSync(path, "wx", 0o600);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw busy("The consent record could not be locked. Try again.", false, error);

    let contents = "";
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      // It went away between the failed create and this look. Still a refusal: whoever removed it
      // may be mid-claim, and this call is not going to race them for it.
    }
    // Liveness chooses the wording, and nothing else. A running owner will finish and release, so
    // the answer is to wait. Anything else needs a person, and the only file they are pointed at
    // is the lock — never the record, whose removal would discard every grant and free nothing.
    if (lockOwnerIsRunning(contents) === true) {
      throw busy("Another process is changing the consent record. Try again.", false, error);
    }
    throw busy(
      "The consent record is locked by a process that does not appear to be running. MarkPDF will not take a lock it did not make.",
      true,
      error,
    );
  }
  try {
    writeFileSync(handle, `markpdf-lock ${process.pid}\n`);
  } catch (error) {
    // This call created the file a moment ago and nothing else can have it, so removing it here
    // is not the takeover refused above — it is undoing a claim that never completed. Leaving it
    // would strand an empty lock nobody owns and leak the descriptor with it.
    closeSync(handle);
    rmSync(path, { force: true });
    throw busy("The consent record could not be locked. Try again.", false, error);
  }
  return handle;
}

/**
 * Read, change and write the consent record as one indivisible operation.
 *
 * **Every path that changes consent goes through here.** A read followed by a write is two
 * operations, and two processes doing that can interleave so that one of them writes a record
 * built from a view that is already out of date — putting back a root the other had just
 * withdrawn. Nothing about consent may be undone by accident, so contention fails closed: the
 * caller is told to try again and the record is left exactly as it was.
 */
export function updateAllowlist(
  dataDir: string,
  grants: readonly Grant[],
): { allowlist: Allowlist; records: GrantRecord[] } {
  return withAllowlistLock(dataDir, () => {
    const applied = applyGrants(readAllowlist(dataDir), grants);
    writeAllowlist(dataDir, applied.allowlist);
    return applied;
  });
}

/**
 * Hold the consent record for the duration of `body`, or refuse.
 *
 * The primitive `updateAllowlist` is built on, exported so that anything else needing to change
 * consent — the MCP server, later — takes the same lock rather than inventing a second one. It is
 * also what lets a test hold the record from a genuinely separate process.
 */
export function withAllowlistLock<T>(dataDir: string, body: () => T): T {
  const handle = acquireLock(dataDir);
  try {
    return body();
  } finally {
    closeSync(handle);
    rmSync(lockPathFor(dataDir), { force: true });
  }
}
