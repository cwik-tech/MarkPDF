import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDocumentContentDir, openDocumentsDir } from "../paths.js";
import { syncOpenDocumentContent } from "./openDocumentContent.js";
import {
  openDocumentReference,
  readOpenDocuments,
  removeOpenDocuments,
  removeOpenDocumentsForProcess,
  writeOpenDocuments,
  type OpenDocumentRecord,
  type WindowSnapshot,
} from "./openDocuments.js";

/**
 * What one process can learn about the documents another has open.
 *
 * The application writes one file per window and the MCP server reads the directory. Everything
 * below is about the two halves of that agreeing: which window's tab is the active document, what
 * happens to a window whose process is gone, and what a damaged file must not do to the rest.
 */

let dataDir: string;

/** A process identifier that is genuinely gone: one this test started, waited for, and reaped. */
function reapedPid(): number {
  const finished = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof finished.pid !== "number") throw new Error("could not start a child to reap");
  return finished.pid;
}

function makeRecord(overrides: Partial<OpenDocumentRecord> = {}): OpenDocumentRecord {
  return {
    tabId: "tab-a",
    kind: "pdf",
    name: "annual-report.pdf",
    path: "/library/annual-report.pdf",
    pageCount: 3,
    currentPage: 1,
    contentHash: "a".repeat(64),
    hasContentSnapshot: false,
    contentChars: 0,
    contentBytes: 0,
    snapshotTruncated: false,
    unsavedChanges: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    version: 2,
    pid: process.pid,
    windowId: 1,
    focusedAt: 1,
    writtenAt: "2026-08-23T10:00:00.000Z",
    activeTabId: "tab-a",
    documents: [makeRecord()],
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-open-docs-")));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the record of what a window has open", () => {
  it("reads back nothing at all when the application has never run", () => {
    const view = readOpenDocuments(dataDir);

    expect(view).toEqual({ windows: 0, activeRef: null, documents: [], unreadableWindows: 0 });
  });

  it("carries one window's documents through the file to a reader", () => {
    writeOpenDocuments(dataDir, makeSnapshot());

    const view = readOpenDocuments(dataDir);

    expect(view.windows).toBe(1);
    expect(view.documents).toHaveLength(1);
    expect(view.documents[0]).toMatchObject({
      name: "annual-report.pdf",
      kind: "pdf",
      pageCount: 3,
      contentHash: "a".repeat(64),
      path: "/library/annual-report.pdf",
      active: true,
      activeInWindow: true,
      window: 1,
    });
    expect(view.activeRef).toBe(view.documents[0]?.ref);
  });

  it("keeps the record private to this account", () => {
    writeOpenDocuments(dataDir, makeSnapshot());

    const directory = openDocumentsDir(dataDir);
    const file = join(directory, readdirSync(directory)[0]!);

    // Which documents somebody has open is nobody else's business on a shared machine.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(typeof raw === "object" && raw !== null ? Reflect.get(raw, "version") : null).toBe(2);
  });

  it("gives each open document a reference that names its window and its tab", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 7 }));

    expect(readOpenDocuments(dataDir).documents[0]?.ref).toBe(openDocumentReference(process.pid, 7, "tab-a"));
    // Never the literal the read tool reserves for "whichever is active now".
    expect(readOpenDocuments(dataDir).documents[0]?.ref).not.toBe("active");
  });

  it("replaces a window's own record rather than accumulating copies of it", () => {
    writeOpenDocuments(dataDir, makeSnapshot());
    writeOpenDocuments(dataDir, makeSnapshot({ documents: [], activeTabId: null }));

    expect(readOpenDocuments(dataDir).documents).toEqual([]);
    expect(readdirSync(openDocumentsDir(dataDir))).toHaveLength(1);
  });

  it("merges two windows without either overwriting the other", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 1, focusedAt: 1 }));
    writeOpenDocuments(
      dataDir,
      makeSnapshot({
        windowId: 2,
        focusedAt: 2,
        activeTabId: "tab-b",
        documents: [makeRecord({ tabId: "tab-b", name: "notes.pdf", path: null, pageCount: 1, contentHash: null, unsavedChanges: true })],
      }),
    );

    const view = readOpenDocuments(dataDir);

    expect(view.windows).toBe(2);
    expect(view.documents.map((entry) => entry.name)).toEqual(["notes.pdf", "annual-report.pdf"]);
  });

  it("makes the most recently focused window's own active tab the active document", () => {
    // Both windows have an active tab of their own. Only one of them is the document a person
    // would point at and call "the one I have open".
    //
    // The later-focused window is deliberately the *higher-numbered* one, written second, so that
    // focus order and the order the files happen to be listed in disagree. With them agreeing, an
    // implementation that ignored focus entirely would still pass this.
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 1, focusedAt: 4 }));
    writeOpenDocuments(
      dataDir,
      makeSnapshot({
        windowId: 2,
        focusedAt: 9,
        activeTabId: "tab-b",
        documents: [makeRecord({ tabId: "tab-b", name: "notes.pdf", path: null, pageCount: 1, contentHash: null })],
      }),
    );

    const view = readOpenDocuments(dataDir);

    expect(view.documents.filter((entry) => entry.active).map((entry) => entry.name)).toEqual(["notes.pdf"]);
    // Each window still reports its own front tab, which is what makes two windows legible.
    expect(view.documents.filter((entry) => entry.activeInWindow).map((entry) => entry.name).sort()).toEqual([
      "annual-report.pdf",
      "notes.pdf",
    ]);
    expect(view.activeRef).toBe(openDocumentReference(process.pid, 2, "tab-b"));
  });

  it("puts the active document first, so a shortened list never loses it", () => {
    writeOpenDocuments(
      dataDir,
      makeSnapshot({
        activeTabId: "tab-c",
        documents: [
          makeRecord({ tabId: "tab-a", name: "first.pdf", path: null, pageCount: 1, contentHash: null }),
          makeRecord({ tabId: "tab-b", name: "second.pdf", path: null, pageCount: 1, contentHash: null }),
          makeRecord({ tabId: "tab-c", name: "third.pdf", path: null, pageCount: 1, contentHash: null }),
        ],
      }),
    );

    expect(readOpenDocuments(dataDir).documents.map((entry) => entry.name)).toEqual([
      "third.pdf",
      "first.pdf",
      "second.pdf",
    ]);
  });

  it("reports a window with no active tab without claiming one is active", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ activeTabId: null, documents: [] }));

    const view = readOpenDocuments(dataDir);

    expect(view.activeRef).toBeNull();
    expect(view.windows).toBe(1);
  });

  it("ignores a window whose process is gone, and clears it away", () => {
    // The application was killed. Its file is still on disk and says a document is open.
    const dead = reapedPid();
    writeOpenDocuments(dataDir, makeSnapshot({ pid: dead, windowId: 3 }));
    syncOpenDocumentContent(dataDir, dead, 3, [{ tabId: "tab-notes", content: "private notes" }]);

    const view = readOpenDocuments(dataDir);

    expect(view).toEqual({ windows: 0, activeRef: null, documents: [], unreadableWindows: 0 });
    expect(readdirSync(openDocumentsDir(dataDir))).toEqual(["content"]);
    expect(readdirSync(openDocumentContentDir(dataDir))).toEqual([]);
  });

  it("ignores a window whose process is gone even when its file cannot be removed", () => {
    // Clearing the residue of a crash is a courtesy, not the answer. A data directory somebody has
    // locked down — or one owned by another account — still has to be readable, and a listing that
    // threw because a tidy-up was refused would take every live window down with it.
    if (process.getuid?.() === 0) {
      // Documented environmental prerequisite: the superuser is not refused, so the failure this
      // test needs cannot be produced.
      return;
    }
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 4, focusedAt: 2 }));
    writeOpenDocuments(dataDir, makeSnapshot({ pid: reapedPid(), windowId: 3 }));
    const directory = openDocumentsDir(dataDir);
    // Readable and listable, but nothing in it may be unlinked.
    chmodSync(directory, 0o500);

    try {
      const view = readOpenDocuments(dataDir);

      expect(view.windows).toBe(1);
      expect(view.documents.map((entry) => entry.window)).toEqual([4]);
      // The file it could not delete is still there, and was still disregarded.
      expect(readdirSync(directory)).toHaveLength(2);
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it("keeps a live window's documents when a dead one's file sits beside it", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ pid: reapedPid(), windowId: 3 }));
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 4, focusedAt: 2 }));

    const view = readOpenDocuments(dataDir);

    expect(view.windows).toBe(1);
    expect(view.documents.map((entry) => entry.window)).toEqual([4]);
  });

  it("skips a damaged file and says so, rather than losing the windows around it", () => {
    // Advisory metadata, not the consent record: one unreadable file must not make the whole
    // question unanswerable, and it must not pass unmentioned either.
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 5 }));
    writeFileSync(join(openDocumentsDir(dataDir), `${process.pid}-6.json`), "{ this is not json", "utf8");

    const view = readOpenDocuments(dataDir);

    expect(view.documents.map((entry) => entry.name)).toEqual(["annual-report.pdf"]);
    expect(view.unreadableWindows).toBe(1);
  });

  it("skips a file whose contents are the wrong shape", () => {
    mkdirSync(openDocumentsDir(dataDir), { recursive: true });
    writeFileSync(join(openDocumentsDir(dataDir), `${process.pid}-7.json`), JSON.stringify({ version: 1, documents: "no" }), "utf8");

    expect(readOpenDocuments(dataDir)).toMatchObject({ windows: 0, documents: [], unreadableWindows: 1 });
  });

  it("forgets one window when it closes", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 1 }));
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 2, focusedAt: 2 }));

    removeOpenDocuments(dataDir, process.pid, 1);

    expect(readOpenDocuments(dataDir).documents.map((entry) => entry.window)).toEqual([2]);
  });

  it("forgets every window of one process when it quits, and leaves other processes alone", () => {
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 1 }));
    writeOpenDocuments(dataDir, makeSnapshot({ windowId: 2, focusedAt: 2 }));
    writeOpenDocuments(dataDir, makeSnapshot({ pid: 1, windowId: 1, focusedAt: 3 }));

    removeOpenDocumentsForProcess(dataDir, process.pid);

    expect(readOpenDocuments(dataDir).documents.map((entry) => entry.name)).toEqual(["annual-report.pdf"]);
    expect(readdirSync(openDocumentsDir(dataDir))).toEqual(["1-1.json"]);
  });

  it("removes a window that was never recorded without complaining", () => {
    expect(() => removeOpenDocuments(dataDir, process.pid, 99)).not.toThrow();
    expect(() => removeOpenDocumentsForProcess(dataDir, process.pid)).not.toThrow();
  });

  it("leaves nothing behind when a write is interrupted", () => {
    writeOpenDocuments(dataDir, makeSnapshot());
    const before = readdirSync(openDocumentsDir(dataDir));

    // A staging directory is created and renamed onto the target; nothing else survives a write.
    writeOpenDocuments(dataDir, makeSnapshot({ focusedAt: 2 }));

    expect(readdirSync(openDocumentsDir(dataDir))).toEqual(before);
  });

  it("does not mind a directory that exists but holds something unrelated", () => {
    mkdirSync(openDocumentsDir(dataDir), { recursive: true });
    writeFileSync(join(openDocumentsDir(dataDir), "README"), "not a snapshot", "utf8");
    writeOpenDocuments(dataDir, makeSnapshot());

    expect(readOpenDocuments(dataDir).documents).toHaveLength(1);
  });
});
