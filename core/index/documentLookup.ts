import { resolve } from "node:path";
import { contentHash as hashBytes } from "../hash.js";
import { AccessDeniedError, requireAccess, type Allowlist } from "../consent/allowlist.js";
import type { SemanticStore, StoredDocument } from "../store/index.js";

export type DocumentLookup =
  | { status: "found"; document: StoredDocument; usedFilesystem: boolean }
  | { status: "not-indexed" }
  | { status: "denied"; path: string };

export interface LookupInput {
  path?: string;
  contentHash?: string;
  /** Injected so the tests can prove which branches touch the filesystem and which do not. */
  readFile: (path: string) => Promise<Uint8Array>;
  /**
   * Whether a path the index does not know may be read from disk to identify it by content.
   *
   * `true` by default, which is what `search --path` and the command line want. Callers that are
   * index-only by contract — the MCP `read_pages` tool is one — pass `false`, and a miss is
   * reported as not indexed rather than turning a tool that needs no permission into one that
   * does.
   */
  filesystemFallback?: boolean;
}

/**
 * Find an already-indexed document from what a person typed.
 *
 * **The order is the security property, not an optimisation.** A path already recorded in the
 * index is answered by a database query alone — no `stat`, no `open`, no `realpath` — so
 * searching a library you have already indexed needs no filesystem permission at all. The
 * allowlist only comes into it on the fallback branch, which is the only one that reads
 * anything.
 *
 * The path match is **lexical**: the argument as given, and its `path.resolve` normalisation, are
 * both tried. Both are string arithmetic — no `stat`, no `realpath` — so `./report.pdf` and
 * `2026/../report.pdf` stay on the branch that needs no permission. Resolving symbolic links is
 * deliberately not done, because that is a filesystem call and it is exactly what this branch
 * exists to avoid; a spelling that differs only by a link falls through to the fallback, where
 * permission is required and the bytes decide.
 */
export async function findIndexedDocument(
  store: SemanticStore,
  allowlist: Allowlist,
  input: LookupInput,
): Promise<DocumentLookup> {
  if (input.contentHash !== undefined) {
    // A hash names a document directly. There is no file to reach for and nothing to permit.
    const byHash = store.getDocument(input.contentHash);
    return byHash === null ? { status: "not-indexed" } : { status: "found", document: byHash, usedFilesystem: false };
  }

  if (input.path === undefined) return { status: "not-indexed" };

  for (const spelling of new Set([input.path, resolve(input.path)])) {
    const byPath = store.getDocumentByPath(spelling);
    if (byPath !== null) return { status: "found", document: byPath, usedFilesystem: false };
  }

  if (input.filesystemFallback === false) return { status: "not-indexed" };

  // Only now does the filesystem enter, and only now does permission.
  let resolved: string;
  try {
    resolved = requireAccess(allowlist, input.path, "read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return { status: "denied", path: input.path };
    throw error;
  }

  const bytes = await input.readFile(resolved);
  const byHash = store.getDocument(hashBytes(bytes));
  return byHash === null ? { status: "not-indexed" } : { status: "found", document: byHash, usedFilesystem: true };
}
