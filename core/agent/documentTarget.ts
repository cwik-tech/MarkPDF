import { AccessDeniedError, remedyFor, requireAccess, type Allowlist } from "../consent/allowlist.js";
import type { OpenDocumentEntry, OpenDocumentsView } from "../session/openDocuments.js";

/**
 * One document a command an agent runs has named, resolved to a file it may read.
 *
 * Three spellings, one answer. A `path` is the caller's own; an `id` becomes the path the index
 * recorded; a `ref` becomes the path the window recorded — and **having a document open supplies a
 * name, never an authority**. Every spelling ends in the same read-grant check, so a forged
 * open-document record buys nothing a forged path would not.
 *
 * What a refusal says depends on what the caller supplied. A caller that typed a path is shown it
 * back, with a remedy it can paste. A caller that named an open tab is never shown where the file
 * is: it did not know, and a refusal is not an excuse to tell it.
 */

/** The reserved reference for whichever document is at the front. */
export const ACTIVE_REFERENCE = "active";

export interface DocumentIdentity {
  path?: string | undefined;
  id?: string | undefined;
  ref?: string | undefined;
}

export interface TargetSources {
  allowlist: Allowlist;
  openDocuments: () => OpenDocumentsView;
  /** The path the index recorded for a content hash, or null when there is none. */
  indexedPath: (contentHash: string) => string | null;
}

export type ResolvedTarget =
  | {
      ok: true;
      /** The resolved, permitted file. Never part of a reply to a caller that named a `ref`. */
      path: string;
      name: string;
      /** The open tab it came from, when the caller named one. */
      open: OpenDocumentEntry | null;
    }
  | { ok: false; reason: "access_denied" | "not_found" | "stale_ref"; message: string };

const READ_REMEDY_FOR_OPEN = "Grant its folder with markpdf --allow-read, as a separate command.";

export function selectOpenEntry(view: OpenDocumentsView, ref: string): OpenDocumentEntry | null {
  const wanted = ref === ACTIVE_REFERENCE ? view.activeRef : ref;
  if (wanted === null) return null;
  return view.documents.find((entry) => entry.ref === wanted) ?? null;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function resolveReadableDocument(identity: DocumentIdentity, sources: TargetSources): ResolvedTarget {
  if (identity.ref !== undefined) {
    const entry = selectOpenEntry(sources.openDocuments(), identity.ref);
    if (entry === null) {
      return {
        ok: false,
        reason: "stale_ref",
        message:
          identity.ref === ACTIVE_REFERENCE
            ? "MarkPDF has no document open. Open one, or name a document by path."
            : `No open document has the reference ${identity.ref}. Call list_open_documents for current references.`,
      };
    }
    if (entry.path === null) {
      return {
        ok: false,
        reason: "access_denied",
        message: `${entry.name} is open in MarkPDF but has never been saved, so there is no file to read.`,
      };
    }
    try {
      return { ok: true, path: requireAccess(sources.allowlist, entry.path, "read"), name: entry.name, open: entry };
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) throw error;
      return {
        ok: false,
        reason: "access_denied",
        message: `MarkPDF has ${entry.name} open, but this tool is not permitted to read its file. ${READ_REMEDY_FOR_OPEN}`,
      };
    }
  }

  let path: string;
  if (identity.id !== undefined) {
    const recorded = sources.indexedPath(identity.id);
    if (recorded === null) {
      return {
        ok: false,
        reason: "not_found",
        message: `No indexed document has the id ${identity.id}, or the index recorded no file for it.`,
      };
    }
    path = recorded;
  } else if (identity.path !== undefined) {
    path = identity.path;
  } else {
    return { ok: false, reason: "not_found", message: "Name the document by path, id or ref." };
  }

  try {
    const permitted = requireAccess(sources.allowlist, path, "read");
    return { ok: true, path: permitted, name: baseName(permitted), open: null };
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
    return {
      ok: false,
      reason: "access_denied",
      message: `Not permitted to read ${path}. Grant it first, as a separate command: ${remedyFor(path, "read")}`,
    };
  }
}

export type IndexedTarget =
  | { ok: true; contentHash: string; name: string }
  | { ok: false; reason: "not_indexed" | "stale_ref"; message: string };

/**
 * The indexed identity of a document, for a link: no file is read and no grant is needed.
 *
 * A link names a document by its content hash. Making one reads only the index, as `search` does,
 * so it needs no permission; opening the document the link names needs a read grant when the link
 * is clicked, and the desktop checks that then.
 */
export function resolveIndexedDocument(
  identity: DocumentIdentity,
  sources: {
    openDocuments: () => OpenDocumentsView;
    documentByHash: (contentHash: string) => { contentHash: string; name: string } | null;
    documentByPath: (path: string) => { contentHash: string; name: string } | null;
  },
): IndexedTarget {
  const notIndexed: IndexedTarget = {
    ok: false,
    reason: "not_indexed",
    message: "This document is not in MarkPDF's index, so no link can name it. Prepare the document first.",
  };
  if (identity.ref !== undefined) {
    const entry = selectOpenEntry(sources.openDocuments(), identity.ref);
    if (entry === null) return { ok: false, reason: "stale_ref", message: `No open document has the reference ${identity.ref}.` };
    const stored = entry.contentHash === null ? null : sources.documentByHash(entry.contentHash);
    return stored === null ? notIndexed : { ok: true, contentHash: stored.contentHash, name: entry.name };
  }
  if (identity.id !== undefined) {
    const stored = sources.documentByHash(identity.id);
    return stored === null ? notIndexed : { ok: true, contentHash: stored.contentHash, name: stored.name };
  }
  if (identity.path !== undefined) {
    const stored = sources.documentByPath(identity.path);
    return stored === null ? notIndexed : { ok: true, contentHash: stored.contentHash, name: stored.name };
  }
  return notIndexed;
}
