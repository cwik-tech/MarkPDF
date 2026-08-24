import { app, BrowserWindow } from "electron";
import { resolveDataDir } from "../dist-core/paths.js";
import {
  removeOpenDocuments,
  removeOpenDocumentsForProcess,
  writeOpenDocuments,
  type OpenDocumentRecord,
} from "../dist-core/session/openDocuments.js";
import {
  removeOpenDocumentContentForProcess,
  removeOpenDocumentContentForWindow,
  syncOpenDocumentContent,
  type OpenDocumentContentState,
} from "../dist-core/session/openDocumentContent.js";
import { parseOpenDocumentsPayload, type OpenDocumentsPayload } from "../dist-core/session/openDocumentsRequest.js";

/**
 * Telling other processes on this machine which documents are open, and which one is in front.
 *
 * The window knows what it is showing and nothing else; the main process knows about *other*
 * windows. So the split is deliberate: a window reports its own tabs and its own front tab, and
 * **focus order is stamped here**, because no window can know whether it is the one a person is
 * looking at. A renderer that decided its own focus would leave two windows each certain they were
 * the active one.
 *
 * Every write replaces one window's file. Nothing is shared between windows, so nothing has to be
 * locked and no update can be lost — which is why this does not reuse the consent record's lock,
 * whose whole design is to refuse under contention. Refusing is right for a grant and wrong for
 * something that changes when somebody clicks a tab.
 */

/** The last thing each window said about itself, so a focus change can be restamped without it. */
const lastReport = new WeakMap<BrowserWindow, OpenDocumentsPayload>();
/** Avoid rewriting every open Markdown buffer when only a PDF page changes. */
const lastContentSignature = new WeakMap<BrowserWindow, string>();
const lastContentStates = new WeakMap<BrowserWindow, readonly OpenDocumentContentState[]>();
/** When each window was last focused, as an order rather than a clock. */
const focusOrder = new WeakMap<BrowserWindow, number>();
let focusCounter = 0;

function dataDir(): string {
  return resolveDataDir(app.getPath("userData"));
}

/**
 * Say something went wrong without letting it reach the window.
 *
 * A window that cannot write this file is still a window somebody is reading a document in. The
 * cost of the failure is that agents cannot see what is open; it is not a reason to interrupt.
 */
function report(error: unknown): void {
  process.stderr.write(`markpdf: could not record the open documents (${String(error)})\n`);
}

function write(window: BrowserWindow, payload: OpenDocumentsPayload): void {
  try {
    const contents = payload.documents.flatMap((document) =>
      document.kind === "markdown" && document.contentSnapshot !== null
        ? [{ tabId: document.tabId, content: document.contentSnapshot }]
        : [],
    );
    const contentSignature = JSON.stringify(contents);
    let contentStates = lastContentStates.get(window);
    if (contentStates === undefined || contentSignature !== lastContentSignature.get(window)) {
      contentStates = syncOpenDocumentContent(dataDir(), process.pid, window.id, contents);
      lastContentSignature.set(window, contentSignature);
      lastContentStates.set(window, contentStates);
    }
    const contentByTab = new Map(contentStates.map((state) => [state.tabId, state]));
    const documents: OpenDocumentRecord[] = payload.documents.map((document) => {
      const content = contentByTab.get(document.tabId);
      return {
        tabId: document.tabId,
        kind: document.kind,
        name: document.name,
        path: document.path,
        pageCount: document.pageCount,
        currentPage: document.currentPage,
        contentHash: document.contentHash,
        hasContentSnapshot: content !== undefined,
        contentChars: content?.contentChars ?? 0,
        contentBytes: content?.contentBytes ?? 0,
        snapshotTruncated: content?.snapshotTruncated ?? false,
        unsavedChanges: document.unsavedChanges,
      };
    });
    writeOpenDocuments(dataDir(), {
      version: 2,
      pid: process.pid,
      windowId: window.id,
      focusedAt: focusOrder.get(window) ?? 0,
      writtenAt: new Date().toISOString(),
      activeTabId: payload.activeTabId,
      documents,
    });
  } catch (error) {
    report(error);
  }
}

/**
 * Record what one window has open.
 *
 * `raw` crossed the preload bridge from a renderer, so it is external input and is validated
 * before it can reach a file another process reads. A validation failure is thrown back at the
 * window rather than swallowed: it means this application sent something it should not have, and
 * a silent write of a repaired value would hide the bug while making the file wrong.
 */
export function publishOpenDocuments(window: BrowserWindow, raw: unknown): void {
  const payload = parseOpenDocumentsPayload(raw);
  lastReport.set(window, payload);
  write(window, payload);
}

/**
 * Note that a window came to the front.
 *
 * The file is rewritten rather than patched, because a reader takes the whole file or none of it.
 * A window that has not reported anything yet has nothing to rewrite; its first report will carry
 * the order recorded here.
 *
 * Called both when the operating system says a window was focused and when one is created, because
 * MarkPDF shows and focuses every window it opens. Recording only the former would leave every
 * window at the same order whenever the application is not the frontmost one — and the answer to
 * "which document is open" would then fall to an unstated tie-break rather than to anything
 * meaning focus.
 */
export function noteWindowFocused(window: BrowserWindow): void {
  focusCounter += 1;
  focusOrder.set(window, focusCounter);
  const payload = lastReport.get(window);
  if (payload !== undefined) write(window, payload);
}

/**
 * Attach a window's lifetime to its record.
 *
 * Two events, for two different ways a window stops describing what it did. Closing ends it, so
 * the file goes. Reloading empties it — the tabs the old renderer had are gone, and leaving them
 * on disk would show an agent documents that no longer exist in a window that still does.
 */
export function registerOpenDocumentWindow(window: BrowserWindow): void {
  // Captured now: after `closed` the window object is destroyed, and its identifier is the one
  // thing needed to find the file it wrote.
  const windowId = window.id;

  // A new window is shown and focused as it opens, so it starts at the front.
  noteWindowFocused(window);

  window.webContents.on("did-start-loading", () => {
    lastReport.delete(window);
    lastContentSignature.delete(window);
    lastContentStates.delete(window);
    try {
      removeOpenDocumentContentForWindow(dataDir(), process.pid, windowId);
      writeOpenDocuments(dataDir(), {
        version: 2,
        pid: process.pid,
        windowId,
        focusedAt: focusOrder.get(window) ?? 0,
        writtenAt: new Date().toISOString(),
        activeTabId: null,
        documents: [],
      });
    } catch (error) {
      report(error);
    }
  });

  window.on("closed", () => {
    lastReport.delete(window);
    lastContentSignature.delete(window);
    lastContentStates.delete(window);
    try {
      removeOpenDocuments(dataDir(), process.pid, windowId);
      removeOpenDocumentContentForWindow(dataDir(), process.pid, windowId);
    } catch (error) {
      report(error);
    }
  });
}

/**
 * Leave nothing behind on the way out.
 *
 * A clean exit removes its own files, so anything a reader later finds from this process is the
 * residue of a crash — which is exactly what makes checking the owning process a useful test. Only
 * this process's files: another running instance's windows are not ours to clear.
 */
export function forgetAllOpenDocuments(): void {
  try {
    removeOpenDocumentsForProcess(dataDir(), process.pid);
    removeOpenDocumentContentForProcess(dataDir(), process.pid);
  } catch (error) {
    report(error);
  }
}
