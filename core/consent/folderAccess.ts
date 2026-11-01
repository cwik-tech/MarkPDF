import { statSync } from "node:fs";
import {
  containsPath,
  isMissingPathError,
  resolveRealPath,
  type Allowlist,
} from "./allowlist.js";
import { readAllowlist, withAllowlistLock, writeAllowlist } from "./allowlistFile.js";

export type FolderLevel = "read" | "write" | "read-write";
export type SettableLevel = "read" | "read-write";
export type RootStatus = "present" | "missing" | "moved" | "unreadable";
export interface Inspection {
  status: RootStatus;
  kind: "folder" | "file" | "unknown";
  /** The single resolution, reused for remaining access after removal. */
  target?: string;
}
export interface FolderRow {
  path: string;
  kind: Inspection["kind"];
  level: FolderLevel;
  status: RootStatus;
  readThrough?: string;
  writeThrough?: string;
}
export type FolderChange =
  | { kind: "add"; path: string }
  | { kind: "set-level"; path: string; level: SettableLevel }
  | { kind: "remove"; path: string };
export interface FolderPreview {
  adds: { read: boolean; write: boolean };
  withdraws: { read: boolean; write: boolean };
  withdrawn: string[];
}
export interface StillReachable {
  read?: string;
  write?: string;
  unknown?: true;
}
export interface FolderChangeResult {
  folders: FolderRow[];
  changed: boolean;
  withdrawn: string[];
  stillReachable?: StillReachable;
}
type Refusal = { reason: "not-listed" | "missing" | "moved" | "unreadable" };
type Plan = { next: Allowlist; preview: FolderPreview } | Refusal;

export class FolderNotListedError extends Error {
  constructor(readonly folders: FolderRow[]) {
    super("This folder changed. The list is refreshed.");
  }
}
export class FolderMissingError extends Error {
  constructor() {
    super("This folder was not found. Remove it and add it again before granting access.");
  }
}
export class FolderMovedError extends Error {
  constructor() {
    super("This folder moved or was replaced. Remove it and add it again before granting access.");
  }
}
export class FolderUnreadableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Cannot check this folder. Remove it and add it again before granting access.",
      cause === undefined ? {} : { cause },
    );
  }
}

export function defaultInspect(path: string): Inspection {
  let target: string;
  try {
    target = resolveRealPath(path);
  } catch {
    return { status: "unreadable", kind: "unknown" };
  }
  return inspectResolved(path, target);
}

function inspectResolved(path: string, target: string): Inspection {
  try {
    const stat = statSync(target);
    return {
      target,
      status: target === path ? "present" : "moved",
      kind: stat.isDirectory() ? "folder" : stat.isFile() ? "file" : "unknown",
    };
  } catch (error) {
    return {
      target,
      status: isMissingPathError(error) ? "missing" : "unreadable",
      kind: "unknown",
    };
  }
}

function roots(allowlist: Allowlist): string[] {
  return [...new Set([...allowlist.readRoots, ...allowlist.writeRoots])].sort();
}

function coveringRoot(paths: readonly string[], target: string): string | undefined {
  return paths
    .filter(root => containsPath(root, target))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

export function listFolders(allowlist: Allowlist, inspect = defaultInspect): FolderRow[] {
  return roots(allowlist).map(path => {
    const read = allowlist.readRoots.includes(path);
    const write = allowlist.writeRoots.includes(path);
    const inspection = inspect(path);
    const target = inspection.target ?? (inspection.status === "present" ? path : undefined);
    const readThrough = read || target === undefined
      ? undefined : coveringRoot(allowlist.readRoots, target);
    const writeThrough = write || target === undefined
      ? undefined : coveringRoot(allowlist.writeRoots, target);
    return {
      path,
      kind: inspection.kind,
      status: inspection.status,
      level: read ? write ? "read-write" : "read" : "write",
      ...(readThrough === undefined ? {} : { readThrough }),
      ...(writeThrough === undefined ? {} : { writeThrough }),
    };
  });
}

/**
 * Withdraw by the stored root's spelling, including its nested roots. Re-resolving
 * that boundary would let a replacement symlink escape withdrawal. Only widening
 * depends on the shell's inspection; this planner never touches the filesystem.
 */
export function planFolderChange(
  current: Allowlist,
  change: FolderChange,
  inspection: Inspection,
): Plan {
  const listed = roots(current).includes(change.path);
  if (change.kind !== "add" && !listed) return { reason: "not-listed" };
  const read = current.readRoots.includes(change.path);
  const write = current.writeRoots.includes(change.path);
  const adds = {
    read: change.kind === "add" ? !listed : change.kind === "set-level" && !read,
    write: change.kind === "set-level" && change.level === "read-write" && !write,
  };
  const withdraws = {
    read: change.kind === "remove",
    write: change.kind === "remove" ||
      (change.kind === "set-level" && change.level === "read" && write),
  };
  if ((adds.read || adds.write) && inspection.status !== "present") return { reason: inspection.status };
  const removedRead = withdraws.read
    ? current.readRoots.filter(root => containsPath(change.path, root)) : [];
  const removedWrite = withdraws.write
    ? current.writeRoots.filter(root => containsPath(change.path, root)) : [];
  const withdrawn = [...new Set([...removedRead, ...removedWrite])]
    .filter(root => root !== change.path)
    .sort();
  const readRoots = current.readRoots.filter(root => !removedRead.includes(root));
  const writeRoots = current.writeRoots.filter(root => !removedWrite.includes(root));
  if (adds.read) readRoots.push(change.path);
  if (adds.write) writeRoots.push(change.path);
  return { next: { readRoots, writeRoots }, preview: { adds, withdraws, withdrawn } };
}

function refuse(result: Refusal, folders: () => FolderRow[]): never {
  switch (result.reason) {
    case "not-listed":
      throw new FolderNotListedError(folders());
    case "missing":
      throw new FolderMissingError();
    case "moved":
      throw new FolderMovedError();
    case "unreadable":
      throw new FolderUnreadableError();
  }
}

export function previewFolderChange(
  dataDir: string,
  change: FolderChange,
  inspect = defaultInspect,
): FolderPreview {
  const current = readAllowlist(dataDir);
  const result = planFolderChange(current, change, inspect(change.path));
  if ("reason" in result) return refuse(result, () => listFolders(current, inspect));
  return result.preview;
}
interface Dependencies {
  withLock: typeof withAllowlistLock;
  inspect: typeof defaultInspect;
  resolve: typeof resolveRealPath;
}

function equalPaths(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function unchanged(current: Allowlist, next: Allowlist): boolean {
  return equalPaths(current.readRoots, next.readRoots) && equalPaths(current.writeRoots, next.writeRoots);
}
/**
 * Read, check the exact stored root, plan and write under one consent lock.
 * Inspect/resolve each path once and reuse that result for both the write and
 * reply; the lock protects the record, not directory identity on disk.
 *
 * The caller must supply the confirmed affected set, even when it is empty.
 * A CLI edit can turn a no-op into a withdrawal while a dialog is open. Comparing
 * again under the lock prevents withdrawing roots that were never confirmed.
 */
export function changeFolderAccess(
  dataDir: string,
  change: FolderChange,
  expectedWithdrawn: readonly string[],
  dependencies: Partial<Dependencies> = {},
): FolderChangeResult {
  const deps: Dependencies = {
    withLock: withAllowlistLock,
    inspect: defaultInspect,
    resolve: resolveRealPath,
    ...dependencies,
  };
  return deps.withLock(dataDir, () => {
    const current = readAllowlist(dataDir);
    // Cache also covers list construction: never re-inspect the changed root for the reply.
    const inspections = new Map<string, Inspection>();
    const inspect = (path: string): Inspection => {
      const cached = inspections.get(path);
      if (cached !== undefined) return cached;
      const result = deps.inspect(path);
      inspections.set(path, result);
      return result;
    };
    let resolvedChange = change;
    let inspection: Inspection;
    if (change.kind === "add") {
      let path: string;
      try {
        path = deps.resolve(change.path);
      } catch (error) {
        throw new FolderUnreadableError(error);
      }
      resolvedChange = { kind: "add", path };
      // Check the resolved target without following the original picked spelling again.
      inspection = inspectResolved(path, path);
      inspections.set(path, inspection);
    } else {
      inspection = inspect(change.path);
    }
    const result = planFolderChange(current, resolvedChange, inspection);
    const folders = () => listFolders(current, inspect);
    if ("reason" in result) return refuse(result, folders);
    if (change.kind !== "add" && (
      !Array.isArray(expectedWithdrawn) ||
      !equalPaths(result.preview.withdrawn, expectedWithdrawn)
    )) {
      throw new FolderNotListedError(folders());
    }
    const changed = !unchanged(current, result.next);
    if (changed) writeAllowlist(dataDir, result.next);
    let stillReachable: StillReachable | undefined;
    if (change.kind === "remove") {
      // Inspection already resolved the request once, including missing paths via their ancestor.
      if (inspection.target === undefined) {
        stillReachable = { unknown: true };
      } else {
        const read = coveringRoot(result.next.readRoots, inspection.target);
        const write = coveringRoot(result.next.writeRoots, inspection.target);
        stillReachable = {
          ...(read === undefined ? {} : { read }),
          ...(write === undefined ? {} : { write }),
        };
      }
    }
    return {
      folders: listFolders(result.next, inspect),
      changed,
      withdrawn: result.preview.withdrawn,
      ...(stillReachable === undefined ? {} : { stillReachable }),
    };
  });
}
