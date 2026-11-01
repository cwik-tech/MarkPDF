import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Allowlist } from "./allowlist.js";
import { AllowlistFileError, AllowlistLockedError, allowlistFilePath, readAllowlist, updateAllowlist, withAllowlistLock, writeAllowlist } from "./allowlistFile.js";
import { changeFolderAccess, defaultInspect, FolderMissingError, FolderMovedError, FolderNotListedError, FolderUnreadableError, listFolders, planFolderChange, previewFolderChange } from "./folderAccess.js";

let dir: string;
let data: string;
let parent: string;
let child: string;
let outside: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-folder-core-")));
  data = join(dir, "data"); parent = join(dir, "parent"); child = join(parent, "child"); outside = join(dir, "outside");
  mkdirSync(child, { recursive: true }); mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function seed(readRoots: string[], writeRoots: string[] = []) { writeAllowlist(data, { readRoots, writeRoots }); }
function bytes() { return readFileSync(allowlistFilePath(data), "utf8"); }
const present = { status: "present", kind: "folder" } satisfies ReturnType<typeof defaultInspect>;

describe("folder access rules", () => {
  it("shows explicit grants once and inherited access separately", () => {
    const rows = listFolders({ readRoots: [parent, child], writeRoots: [parent, outside] });
    expect(rows.find(row => row.path === parent)).toMatchObject({ level: "read-write", status: "present" });
    expect(rows.find(row => row.path === child)).toMatchObject({ level: "read", writeThrough: parent });
    expect(rows.find(row => row.path === outside)).toMatchObject({ level: "write" });
    expect(rows).toHaveLength(3);
    expect(listFolders({ readRoots: [parent], writeRoots: [child] }).find(row => row.path === child)).toMatchObject({ level: "write", readThrough: parent });
  });
  it.each(["read", "write"] satisfies Array<"read" | "write">)("does not claim inherited %s for a moved child outside its parent", access => {
    rmSync(child, { recursive: true });
    symlinkSync(outside, child);
    const allowlist: Allowlist = access === "read"
      ? { readRoots: [parent], writeRoots: [child] }
      : { readRoots: [child], writeRoots: [parent] };

    const row = listFolders(allowlist).find(entry => entry.path === child);
    expect(row).toMatchObject({ path: child, status: "moved" });
    expect(row).not.toHaveProperty("readThrough");
    expect(row).not.toHaveProperty("writeThrough");
  });
  it("keeps file roots as files and sorts the stored paths", () => {
    const file = join(parent, "file.pdf"); writeFileSync(file, "pdf");
    expect(listFolders({ readRoots: [file, outside], writeRoots: [file] })).toEqual([
      { path: outside, kind: "folder", level: "read", status: "present" },
      { path: file, kind: "file", level: "read-write", status: "present" },
    ]);
  });
  it("distinguishes missing, moved ancestors and unreadable links", () => {
    rmSync(child, { recursive: true });
    expect(defaultInspect(child).status).toBe("missing");
    symlinkSync(outside, child);
    expect(defaultInspect(child).status).toBe("moved");
    const self = join(parent, "self"); symlinkSync(self, self);
    expect(defaultInspect(self).status).toBe("unreadable");
    rmSync(parent, { recursive: true }); symlinkSync(outside, parent);
    expect(defaultInspect(parent).status).toBe("moved");
    mkdirSync(join(outside, "child"));
    expect(defaultInspect(child).status).toBe("moved");
  });
  it.each([
    { from: "read", to: "read-write", adds: { read: false, write: true }, withdraws: { read: false, write: false }, reads: true, writes: true },
    { from: "read-write", to: "read", adds: { read: false, write: false }, withdraws: { read: false, write: true }, reads: true, writes: false },
    { from: "write", to: "read", adds: { read: true, write: false }, withdraws: { read: false, write: true }, reads: true, writes: false },
    { from: "write", to: "read-write", adds: { read: true, write: false }, withdraws: { read: false, write: false }, reads: true, writes: true },
    { from: "read", to: "read", adds: { read: false, write: false }, withdraws: { read: false, write: false }, reads: true, writes: false },
  ] satisfies Array<{ from: string; to: "read" | "read-write"; adds: { read: boolean; write: boolean }; withdraws: { read: boolean; write: boolean }; reads: boolean; writes: boolean }>) ("replaces $from with $to according to the access table", ({ from, to, adds, withdraws, reads, writes }) => {
    const allowlist: Allowlist = { readRoots: from === "write" ? [] : [parent], writeRoots: from === "read" ? [] : [parent] };
    const result = planFolderChange(allowlist, { kind: "set-level", path: parent, level: to }, present);
    expect(result).toMatchObject({ next: { readRoots: reads ? [parent] : [], writeRoots: writes ? [parent] : [] }, preview: { adds, withdraws, withdrawn: [] } });
  });
  it.each(["set-level", "remove"] satisfies Array<"set-level" | "remove">)("refuses %s for a path that is not an exact stored root", kind => {
    seed([parent]); const before = bytes();
    expect(planFolderChange(readAllowlist(data), { kind, path: child, level: "read-write" }, present)).toEqual({ reason: "not-listed" });
    expect(() => changeFolderAccess(data, { kind, path: child, level: "read-write" }, [])).toThrow(FolderNotListedError);
    expect(bytes()).toBe(before);
  });
  it("resolves an added path only once and stores that first target", () => {
    seed([]); let calls = 0;
    const resolve = () => { calls += 1; return calls === 1 ? parent : outside; };
    changeFolderAccess(data, { kind: "add", path: "alias" }, [], { resolve });
    expect(readAllowlist(data)).toEqual({ readRoots: [parent], writeRoots: [] }); expect(calls).toBe(1);
  });
  it("inspects a stored root once even when returning the refreshed rows", () => {
    seed([parent]); let calls = 0;
    const inspect: typeof defaultInspect = () => { calls += 1; return calls === 1 ? present : { status: "moved", kind: "folder", target: outside }; };
    changeFolderAccess(data, { kind: "set-level", path: parent, level: "read-write" }, [], { inspect });
    expect(readAllowlist(data)).toEqual({ readRoots: [parent], writeRoots: [parent] }); expect(calls).toBe(1);
  });
  it("refuses widening a moved root but removes its stored name", () => {
    seed([child]); rmSync(child, { recursive: true }); symlinkSync(outside, child); const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "set-level", path: child, level: "read-write" }, [])).toThrow(FolderMovedError);
    expect(bytes()).toBe(before);
    changeFolderAccess(data, { kind: "remove", path: child }, []);
    expect(readAllowlist(data)).toEqual({ readRoots: [], writeRoots: [] });
  });
  it("allows narrowing and removing an unreadable root but never widening it", () => {
    const self = join(parent, "self"); symlinkSync(self, self); seed([self], [self]);
    changeFolderAccess(data, { kind: "set-level", path: self, level: "read" }, []);
    const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "set-level", path: self, level: "read-write" }, [])).toThrow(FolderUnreadableError);
    expect(bytes()).toBe(before);
    changeFolderAccess(data, { kind: "remove", path: self }, []);
    expect(readAllowlist(data)).toEqual({ readRoots: [], writeRoots: [] });
  });
  it("refuses adding read to a missing write-only root", () => {
    seed([], [child]); rmSync(child, { recursive: true }); const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "set-level", path: child, level: "read" }, [])).toThrow(FolderMissingError);
    expect(bytes()).toBe(before);
  });
  it("refuses an unresolvable picked folder as unreadable without changing consent", () => {
    seed([]);
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    const before = bytes();

    expect(() => changeFolderAccess(data, { kind: "add", path: loop }, [])).toThrow(FolderUnreadableError);
    expect(bytes()).toBe(before);
  });
  it("keeps an existing added root's level and adds a nested folder as read only", () => {
    seed([], [parent]); const before = bytes();
    expect(changeFolderAccess(data, { kind: "add", path: parent }, []).changed).toBe(false);
    expect(bytes()).toBe(before);
    changeFolderAccess(data, { kind: "add", path: child }, []);
    expect(readAllowlist(data)).toEqual({ readRoots: [child], writeRoots: [parent] });
  });
  it("previews and withdraws every nested root for removal", () => {
    seed([parent, child], [child]);
    expect(previewFolderChange(data, { kind: "remove", path: parent })).toMatchObject({ withdrawn: [child], withdraws: { read: true, write: true } });
    expect(changeFolderAccess(data, { kind: "remove", path: parent }, [child]).withdrawn).toEqual([child]);
    expect(readAllowlist(data)).toEqual({ readRoots: [], writeRoots: [] });
  });
  it("refuses write-only to read when the nested withdrawal set changed", () => {
    seed([], [parent, child]); const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "set-level", path: parent, level: "read" }, [])).toThrow(FolderNotListedError);
    expect(bytes()).toBe(before);
  });
  it("refuses a former read no-op when write was granted before the lock", () => {
    seed([parent, child]);
    expect(previewFolderChange(data, { kind: "set-level", path: parent, level: "read" })).toMatchObject({ withdrawn: [] });
    updateAllowlist(data, [{ change: "allow", access: "write", path: parent }, { change: "allow", access: "write", path: child }]); const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "set-level", path: parent, level: "read" }, [])).toThrow(FolderNotListedError);
    expect(bytes()).toBe(before);
  });
  it.each(["set-level", "remove"] satisfies Array<"set-level" | "remove">)("requires an expected withdrawal set even for %s with no nested roots", kind => {
    seed([parent], [parent]); const before = bytes();
    expect(() => Reflect.apply(changeFolderAccess, undefined, [data, { kind, path: parent, level: "read" }])).toThrow(FolderNotListedError);
    expect(bytes()).toBe(before);
  });
  it("names the nearest remaining read parent after removal", () => {
    seed([parent, child, dir]);
    expect(changeFolderAccess(data, { kind: "remove", path: child }, []).stillReachable).toEqual({ read: parent });
  });
  it("does not claim inherited read for a child replaced by a link outside the parent", () => {
    seed([parent, child]); rmSync(child, { recursive: true }); symlinkSync(outside, child);
    expect(changeFolderAccess(data, { kind: "remove", path: child }, []).stillReachable).toEqual({});
  });
  it("reports write separately from read and reports uncertainty for unreadable targets", () => {
    seed([child], [parent]);
    expect(changeFolderAccess(data, { kind: "remove", path: child }, []).stillReachable).toEqual({ write: parent });
    rmSync(child, { recursive: true }); symlinkSync(child, child); seed([child], [parent]);
    expect(changeFolderAccess(data, { kind: "remove", path: child }, []).stillReachable).toEqual({ unknown: true });
  });
  it("checks the row under the lock after a CLI withdrawal and never restores it", () => {
    seed([parent]);
    const withLock: typeof withAllowlistLock = (dataDir, body) => {
      updateAllowlist(dataDir, [{ change: "revoke", access: "read", path: parent }]);
      return withAllowlistLock(dataDir, body);
    };
    expect(() => changeFolderAccess(data, { kind: "set-level", path: parent, level: "read-write" }, [], { withLock })).toThrow(FolderNotListedError);
    expect(readAllowlist(data)).toEqual({ readRoots: [], writeRoots: [] });
  });
  it("never overwrites a damaged consent record", () => {
    seed([]); writeFileSync(allowlistFilePath(data), "broken"); const before = bytes();
    expect(() => changeFolderAccess(data, { kind: "add", path: parent }, [])).toThrow(AllowlistFileError);
    expect(bytes()).toBe(before);
  });
  it("refuses a lock held by a separate process without changing the record", async () => {
    seed([parent]); const before = bytes();
    const holder = fileURLToPath(new URL("./holdAllowlistLock.test-support.mjs", import.meta.url));
    const processHolder = spawn(process.execPath, [holder, data], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => processHolder.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        processHolder.stdout.setEncoding("utf8");
        processHolder.stdout.on("data", (chunk: string) => { if (chunk.includes("held")) resolve(); });
        processHolder.once("error", reject); processHolder.once("close", () => reject(new Error("Lock holder exited before readiness")));
      });
      expect(() => changeFolderAccess(data, { kind: "remove", path: parent }, [])).toThrow(AllowlistLockedError);
      expect(bytes()).toBe(before);
    } finally { processHolder.stdin.end(); await exited; }
  });
});
