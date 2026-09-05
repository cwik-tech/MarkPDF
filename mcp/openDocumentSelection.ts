import type { OpenDocumentEntry, OpenDocumentsView } from "../dist-core/session/openDocuments.js";
import { ACTIVE_DOCUMENT } from "./toolSchemas.js";

export type OpenDocumentSelection =
  | { ok: true; document: OpenDocumentEntry }
  | { ok: false; message: string };

/** Resolve an opaque live-tab reference without exposing or interpreting its private path. */
export function selectOpenDocument(view: OpenDocumentsView, ref: string): OpenDocumentSelection {
  if (ref === ACTIVE_DOCUMENT) {
    if (view.activeRef === null) {
      return { ok: false, message: "MarkPDF has no document open. Open one, or name a document by path with read_pages." };
    }
    const active = view.documents.find((entry) => entry.ref === view.activeRef);
    return active === undefined
      ? { ok: false, message: "MarkPDF reported an active document it did not list. Call list_open_documents and name one." }
      : { ok: true, document: active };
  }

  const named = view.documents.find((entry) => entry.ref === ref);
  return named === undefined
    ? {
        ok: false,
        message: `No open document has the reference ${ref}. Call list_open_documents for current references; a document that has been closed no longer has one.`,
      }
    : { ok: true, document: named };
}
