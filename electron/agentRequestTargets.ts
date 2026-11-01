import { AccessDeniedError, requireAccess, resolveRealPath, type Allowlist } from "../dist-core/consent/allowlist.js";
import type { DesktopReason, DesktopTarget } from "../dist-core/agent/desktopRequests.js";
import type { OpenDocumentEntry, OpenDocumentsView } from "../dist-core/session/openDocuments.js";

/**
 * Where the desktop sends an agent's request, decided here and not only by the client.
 *
 * Any process of the same user can write a request file, so the client's own checks are a
 * courtesy. Every rule that protects the person's documents is applied again here, against the
 * consent record as it is when the request arrives:
 *
 * - A request reaches a window only for a document whose file may be read. That holds for a tab
 *   that is already open too: a reveal or a suggestion matches a quote against the live document,
 *   and the answer would otherwise tell the agent about text it is not allowed to read.
 * - A reference must name a tab of this process. Another MarkPDF's tab is not this one's to drive.
 * - A path open in more than one tab is refused. The desktop cannot know which one the agent means,
 *   and guessing would put the reveal or the suggestion in front of the wrong tab.
 * - A suggestion never opens a document. A reveal opens one only within the grants.
 *
 * No Electron import, so the rules are tested as plain functions.
 */

export type RequestTargetDecision =
  | { kind: "open-tab"; window: number; tabId: string; ref: string }
  | { kind: "open-file"; path: string }
  | { kind: "refuse"; reason: DesktopReason; message: string };

export interface TargetContext {
  /** This desktop process. A reference naming any other process is not ours. */
  pid: number;
  view: OpenDocumentsView;
  allowlist: Allowlist;
}

function readable(allowlist: Allowlist, path: string): string | null {
  try {
    return requireAccess(allowlist, path, "read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return null;
    // A file that is gone cannot be granted either; the caller says what it says for a denial.
    return null;
  }
}

function realPathOf(path: string): string {
  try {
    return resolveRealPath(path);
  } catch {
    return path;
  }
}

const DENIED = "MarkPDF may not read this document for an agent. Grant its folder with markpdf --allow-read, as a separate command.";

function openTab(entry: OpenDocumentEntry): RequestTargetDecision {
  return { kind: "open-tab", window: entry.window, tabId: entry.tabId, ref: entry.ref };
}

export function decideRequestTarget(
  target: DesktopTarget,
  kind: "reveal" | "suggest",
  context: TargetContext,
): RequestTargetDecision {
  const own = context.view.documents.filter((entry) => entry.process === context.pid && entry.kind === "pdf");

  if ("ref" in target) {
    const entry = own.find((candidate) => candidate.ref === target.ref);
    if (entry === undefined) {
      return { kind: "refuse", reason: "stale_ref", message: "No tab of this MarkPDF has that reference. Call list_open_documents again." };
    }
    if (entry.path === null || readable(context.allowlist, entry.path) === null) {
      return { kind: "refuse", reason: "access_denied", message: `${entry.name}: ${DENIED}` };
    }
    return openTab(entry);
  }

  const permitted = readable(context.allowlist, target.path);
  if (permitted === null) return { kind: "refuse", reason: "access_denied", message: DENIED };

  const matches = own.filter((entry) => entry.path !== null && realPathOf(entry.path) === permitted);
  if (matches.length > 1) {
    return { kind: "refuse", reason: "ambiguous", message: "This document is open in more than one tab. Name the tab with a ref from list_open_documents." };
  }
  const [only] = matches;
  if (only !== undefined) return openTab(only);
  if (kind === "suggest") {
    return { kind: "refuse", reason: "not_open", message: "Suggestions go to a document that is open in MarkPDF. Ask the person to open it first." };
  }
  return { kind: "open-file", path: permitted };
}
