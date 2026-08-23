import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { shellQuote } from "../shellQuote.js";

/**
 * Which paths this process may touch, and for what.
 *
 * In core rather than in the command line surface, because the MCP server has to inherit exactly
 * the same enforcement. A second copy of a security rule is a second chance to get one of them
 * wrong, and the two would drift the moment either was changed alone.
 *
 * The default is empty: a tool that reads someone's filesystem on their behalf starts with no
 * permission and is given some, rather than starting with all of it and having some taken away.
 *
 * **Roots are canonical absolute paths, and the checks below treat them as such.** Every link is
 * resolved once, when the grant is made (`applyGrants`), and never again. Resolving a stored root
 * at check time would make an old grant follow whatever its name later points at: delete the
 * granted directory, put a link to somewhere else at the same name, and the grant moves with it
 * without anybody granting anything. The target of a request is still resolved on every check —
 * that is the request, not the boundary — and a root that arrives uncanonicalised simply fails to
 * match, which is the safe direction to be wrong in.
 */
export interface Allowlist {
  readRoots: readonly string[];
  writeRoots: readonly string[];
}

export type AccessKind = "read" | "write";

/**
 * Which directory a grant for this path should cover.
 *
 * `parent` is the rule for a named file: granting the file alone would have to be repeated for
 * every document beside it, and the containing folder is what a person actually thinks they are
 * opening up.
 *
 * `self` is for a path the caller named *as* the thing to work on — `index --recursive ~/Papers`.
 * Taking the parent there would grant every sibling of `Papers`, which nobody asked for. It is
 * safe even when the path turns out to be a file: a root equal to the target contains the target
 * and nothing else.
 */
export type GrantScope = "parent" | "self";

export class AccessDeniedError extends Error {
  readonly path: string;
  readonly kind: AccessKind;
  /** Carried so that whoever renders the remedy offers the same root the prompt would have. */
  readonly scope: GrantScope;

  constructor(path: string, kind: AccessKind, scope: GrantScope = "parent") {
    super(`Access denied: not permitted to ${kind} ${path}.`);
    this.name = "AccessDeniedError";
    this.path = path;
    this.kind = kind;
    this.scope = scope;
  }
}

/**
 * Does this error mean the path is not there, as opposed to unreadable?
 *
 * Only a missing path justifies walking up to an ancestor. A permission or I/O failure means we
 * could not look, and treating that as "it is not there" would silently reclassify ignorance as
 * absence — leaving the containment decision resting on a guess about a path nobody could read.
 */
export function isMissingPathError(error: unknown): boolean {
  // `in` narrows without an assertion: after it the compiler knows the property is there, and it
  // stays `unknown`, which is exactly what an error from a third party should be.
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * The real path of `target`, resolving every symbolic link along the way.
 *
 * A path that does not exist yet — `convert --out` names one — is resolved through its deepest
 * existing ancestor instead, with the remaining segments appended. Refusing every such path would
 * make writing impossible; resolving the ancestor keeps the symbolic-link guarantee, because a
 * link anywhere in the existing part is still followed.
 *
 * Anything other than a missing path is re-raised with the path it happened on, because a
 * containment decision must not be made on a filesystem we were unable to read.
 */
export function resolveRealPath(target: string): string {
  const absolute = resolve(target);
  let existing = absolute;
  const missing: string[] = [];

  for (;;) {
    try {
      return resolve(realpathSync(existing), ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot resolve ${existing} while checking access to ${target}: ${reason}`, { cause: error });
      }
      const parent = dirname(existing);
      // The filesystem root does not exist and is not a link: nothing left to resolve.
      if (parent === existing) return absolute;
      missing.push(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

/**
 * Is `target` inside `root`?
 *
 * Purely lexical, on two paths that have already been resolved. `path.relative`, never
 * `startsWith`. `/Users/t/Papers2` begins with `/Users/t/Papers` as a string and is a different
 * directory, so a string prefix test would grant access to a sibling nobody granted. The relative
 * path from a containing root is neither absolute nor `..`-prefixed.
 */
export function containsPath(root: string, target: string): boolean {
  const step = relative(root, target);
  if (step === "") return true;
  return !step.startsWith("..") && !isAbsolute(step);
}

function rootsFor(allowlist: Allowlist, kind: AccessKind): readonly string[] {
  // Read roots never imply write roots, and write roots never imply read roots. The asymmetry is
  // the point: an agent granted a library to search must not be able to overwrite it.
  return kind === "read" ? allowlist.readRoots : allowlist.writeRoots;
}

export function isAllowed(allowlist: Allowlist, target: string, kind: AccessKind): boolean {
  const resolved = resolveRealPath(target);
  // The target is resolved; the root is not. See the note on `Allowlist` — resolving the stored
  // boundary is what would let a replaced directory carry an old grant somewhere new.
  return rootsFor(allowlist, kind).some((root) => containsPath(root, resolved));
}

/**
 * The resolved path, or a refusal.
 *
 * Returning the *resolved* path is not a convenience. A caller that checked one path and then
 * opened another by its original spelling would re-run link resolution at open time and could
 * open something else entirely; handing back exactly what was checked removes that, provided
 * callers use the return value and nothing else.
 *
 * It **narrows** the time-of-check to time-of-use window rather than closing it. A component of
 * the resolved path can still be replaced between this call and the open, and nothing short of
 * holding an open descriptor across both would prevent that. The claim here is the smaller one.
 */
export function requireAccess(
  allowlist: Allowlist,
  target: string,
  kind: AccessKind,
  scope: GrantScope = "parent",
): string {
  const resolved = resolveRealPath(target);
  for (const root of rootsFor(allowlist, kind)) {
    if (containsPath(root, resolved)) return resolved;
  }
  // The scope travels with the refusal so the remedy printed for it names the same directory the
  // interactive offer would have, whichever of the two the caller ends up showing.
  throw new AccessDeniedError(target, kind, scope);
}

/**
 * The directory a grant must name for `target` to become reachable.
 *
 * One function, used by the printed remedy and by the interactive offer, so the two cannot
 * disagree about what is being granted.
 *
 * Scoped to the containing directory rather than the file, because this ends up inside a
 * permission prompt somebody reads: they should see the directory they are opening up, not a
 * single path that hides how wide the grant really is. `self` is the exception, for a path the
 * caller named *as* the thing to work on.
 *
 * The **resolved** directory, not the typed one. Access is decided after link resolution, so
 * granting the directory a link happens to sit in would not make the same command succeed — and
 * this is also the path `applyGrants` would store, so what somebody is shown and what is
 * recorded are the same thing.
 */
export function grantableRootFor(target: string, scope: GrantScope = "parent"): string {
  const resolved = resolveRealPath(target);
  return scope === "self" ? resolved : dirname(resolved);
}

export function remedyFor(target: string, kind: AccessKind, scope: GrantScope = "parent"): string {
  const flag = kind === "read" ? "--allow-read" : "--allow-write";
  // Quoted, because "runnable" is the claim. An unquoted `/Users/me/My Papers` becomes two
  // arguments and grants something nobody asked for, or fails outright.
  return `markpdf ${flag} ${shellQuote(grantableRootFor(target, scope))}`;
}
