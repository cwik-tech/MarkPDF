import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDocumentContentDir } from "../paths.js";
import {
  OPEN_DOCUMENT_SNAPSHOT_CEILING,
  readOpenDocumentContent,
  removeOpenDocumentContentForProcess,
  removeOpenDocumentContentForWindow,
  syncOpenDocumentContent,
} from "./openDocumentContent.js";

let dataDir: string;

function reapedPid(): number {
  const finished = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof finished.pid !== "number") throw new Error("could not start a child to reap");
  return finished.pid;
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-open-content-")));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the private content of an open Markdown tab", () => {
  it("is written on open, rewritten on edit and retained on save", () => {
    const opened = syncOpenDocumentContent(dataDir, process.pid, 7, [
      { tabId: "tab-notes", content: "# Notes\n" },
    ]);
    expect(opened).toEqual([
      {
        tabId: "tab-notes",
        hasContentSnapshot: true,
        contentChars: 8,
        contentBytes: 8,
        snapshotTruncated: false,
      },
    ]);
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-notes")).toBe("# Notes\n");

    syncOpenDocumentContent(dataDir, process.pid, 7, [
      { tabId: "tab-notes", content: "# Notes\n\nunsaved" },
    ]);
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-notes")).toBe("# Notes\n\nunsaved");

    // Saving changes metadata, not lifetime. The same open buffer is rewritten and remains readable.
    syncOpenDocumentContent(dataDir, process.pid, 7, [
      { tabId: "tab-notes", content: "# Notes\n\nunsaved" },
    ]);
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-notes")).toBe("# Notes\n\nunsaved");
  });

  it("removes a tab snapshot when the next report no longer includes it", () => {
    syncOpenDocumentContent(dataDir, process.pid, 7, [
      { tabId: "tab-a", content: "a" },
      { tabId: "tab-b", content: "b" },
    ]);

    syncOpenDocumentContent(dataDir, process.pid, 7, [{ tabId: "tab-b", content: "b" }]);

    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-a")).toBeNull();
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-b")).toBe("b");
  });

  it("removes every snapshot for a window reload and for process exit", () => {
    syncOpenDocumentContent(dataDir, process.pid, 7, [{ tabId: "tab-a", content: "a" }]);
    syncOpenDocumentContent(dataDir, process.pid, 8, [{ tabId: "tab-b", content: "b" }]);

    removeOpenDocumentContentForWindow(dataDir, process.pid, 7);
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "tab-a")).toBeNull();
    expect(readOpenDocumentContent(dataDir, process.pid, 8, "tab-b")).toBe("b");

    removeOpenDocumentContentForProcess(dataDir, process.pid);
    expect(readdirSync(openDocumentContentDir(dataDir))).toEqual([]);
  });

  it("uses private files and cannot escape the content directory through a tab id", () => {
    syncOpenDocumentContent(dataDir, process.pid, 7, [{ tabId: "../../notes", content: "private" }]);

    const files = readdirSync(openDocumentContentDir(dataDir));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(statSync(join(openDocumentContentDir(dataDir), files[0]!)).mode & 0o777).toBe(0o600);
    expect(readOpenDocumentContent(dataDir, process.pid, 7, "../../notes")).toBe("private");
  });

  it("stores at most five million UTF-8 bytes without splitting a character", () => {
    expect(OPEN_DOCUMENT_SNAPSHOT_CEILING).toBe(5_000_000);
    const source = `${"a".repeat(4_999_999)}𝔘tail`;

    const [state] = syncOpenDocumentContent(dataDir, process.pid, 7, [
      { tabId: "tab-large", content: source },
    ]);
    const stored = readOpenDocumentContent(dataDir, process.pid, 7, "tab-large");

    expect(state).toMatchObject({
      contentBytes: OPEN_DOCUMENT_SNAPSHOT_CEILING - 1,
      contentChars: OPEN_DOCUMENT_SNAPSHOT_CEILING - 1,
      snapshotTruncated: true,
    });
    expect(Buffer.byteLength(stored ?? "", "utf8")).toBeLessThanOrEqual(OPEN_DOCUMENT_SNAPSHOT_CEILING);
    expect(stored?.endsWith("a")).toBe(true);
  });

  it("ignores and deletes content whose owning process is gone", () => {
    const dead = reapedPid();
    syncOpenDocumentContent(dataDir, dead, 7, [{ tabId: "tab-stale", content: "stale" }]);

    expect(readOpenDocumentContent(dataDir, dead, 7, "tab-stale")).toBeNull();
    expect(readdirSync(openDocumentContentDir(dataDir))).toEqual([]);
  });
});
