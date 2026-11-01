import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { MessageBoxOptions, OpenDialogOptions } from "electron";
import { allowlistFilePath, readAllowlist, updateAllowlist, writeAllowlist } from "../dist-core/consent/allowlistFile.js";
import { isApplicationSender, registerFolderAccess, type FolderAccessReply } from "./folderAccess.js";

function frame(url: string) { return { url, detached: false, isDestroyed: () => false }; }
function event(url = "http://127.0.0.1:5173/") {
  const mainFrame = frame(url);
  return { senderFrame: mainFrame, sender: { mainFrame, isDestroyed: () => false } };
}
type Event = ReturnType<typeof event>;
let dir: string; let dataDir: string; let root: string; let child: string;
let handlers: Map<string, (event: Event, input?: unknown) => Promise<FolderAccessReply>>;
let questions: MessageBoxOptions[];
let pickerOptions: OpenDialogOptions[];
let answer: number; let selected: string[];
const window = { isDestroyed: () => false };
const entryUrl = "http://127.0.0.1:5173/";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-folder-main-")));
  dataDir = join(dir, "data"); root = join(dir, "root"); child = join(root, "child");
  mkdirSync(child, { recursive: true }); writeAllowlist(dataDir, { readRoots: [root], writeRoots: [] });
  handlers = new Map(); questions = []; pickerOptions = []; answer = 1; selected = [];
  registerFolderAccess({ dataDir: () => dataDir, entryUrl,
    ipc: { handle: (channel: string, handler: (event: Event, input?: unknown) => Promise<FolderAccessReply>) => { handlers.set(channel, handler); } },
    windowFor: () => window,
    // Native OS modal interaction is unavailable in Vitest; the real filesystem and transaction remain intact.
    dialog: {
      showMessageBox: async (_window: typeof window, options: MessageBoxOptions) => { questions.push(options); return { response: answer, checkboxChecked: false }; },
      showOpenDialog: async (_window: typeof window, options: OpenDialogOptions) => { pickerOptions.push(options); return { canceled: selected.length === 0, filePaths: selected }; },
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function call(channel: string, input?: unknown, sender = event()) {
  const handler = handlers.get(`folder-access:${channel}`);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler(sender, input);
}
function bytes() { return readFileSync(allowlistFilePath(dataDir), "utf8"); }

describe("application sender", () => {
  it("accepts encoded packaged URLs and normalized development URLs with hashes", () => {
    const packaged = pathToFileURL("/Applications/Mark PDF.app/dist/index.html").href;
    expect(isApplicationSender(event(packaged), packaged, window)).toBe(true);
    expect(isApplicationSender(event(`${new URL("http://127.0.0.1:5173").href}#general`), entryUrl, window)).toBe(true);
  });
  it.each(["file:///other/index.html", "http://127.0.0.1:51730/", `${entryUrl}?page=general`, "data:text/html,hi"])("refuses a different page %s", url => {
    expect(isApplicationSender(event(url), entryUrl, window)).toBe(false);
  });
  it("refuses subframes, null frames, destroyed senders, detached frames and absent windows", () => {
    const subframe = event(); subframe.senderFrame = frame(entryUrl);
    const detached = event(); detached.senderFrame.detached = true;
    const destroyed = event(); destroyed.senderFrame.isDestroyed = () => true;
    const senderDestroyed = event(); senderDestroyed.sender.isDestroyed = () => true;
    expect(isApplicationSender(subframe, entryUrl, window)).toBe(false);
    expect(isApplicationSender({ ...event(), senderFrame: null }, entryUrl, window)).toBe(false);
    expect(isApplicationSender(detached, entryUrl, window)).toBe(false);
    expect(isApplicationSender(destroyed, entryUrl, window)).toBe(false);
    expect(isApplicationSender(senderDestroyed, entryUrl, window)).toBe(false);
    expect(isApplicationSender(event(), entryUrl, null)).toBe(false);
    expect(isApplicationSender(event(), entryUrl, { isDestroyed: () => true })).toBe(false);
  });
});

describe("folder access handlers", () => {
  it.each(["list", "set-level", "add", "remove"])("refuses untrusted %s before reading input or the record", async channel => {
    const before = bytes();
    const input = { get path(): never { throw new Error("Untrusted input was read"); } };
    expect(await call(channel, input, event("data:text/html,evil"))).toMatchObject({ ok: false, reason: "untrusted" });
    expect(bytes()).toBe(before); expect(questions).toEqual([]); expect(pickerOptions).toEqual([]);
  });
  it.each([null, "root", { path: 12 }, { path: "root", level: "write" }])("refuses invalid set-level input %j", async input => {
    const before = bytes();
    expect(await call("set-level", input)).toMatchObject({ ok: false, reason: "invalid" }); expect(bytes()).toBe(before);
  });
  it.each([null, "root", { path: 12 }])("refuses invalid removal input %j", async input => {
    const before = bytes();
    expect(await call("remove", input)).toMatchObject({ ok: false, reason: "invalid" }); expect(bytes()).toBe(before);
  });
  it("cancels removal without changing bytes and removes only after confirmation", async () => {
    const before = bytes();
    expect(await call("remove", { path: root })).toMatchObject({ ok: true, cancelled: true }); expect(bytes()).toBe(before);
    expect(questions[0]?.detail).toContain(root); expect(questions[0]?.detail).toContain("indexed");
    answer = 0;
    expect(await call("remove", { path: root })).toMatchObject({ ok: true, changed: true, folders: [] });
    expect(readAllowlist(dataDir)).toEqual({ readRoots: [], writeRoots: [] });
  });
  it("asks before withdrawing nested write roots and names those roots", async () => {
    writeAllowlist(dataDir, { readRoots: [root], writeRoots: [root, child] }); const before = bytes();
    expect(await call("set-level", { path: root, level: "read" })).toMatchObject({ ok: true, cancelled: true });
    expect(questions[0]?.detail).toContain(child); expect(bytes()).toBe(before);
    answer = 0;
    expect(await call("set-level", { path: root, level: "read" })).toMatchObject({ ok: true, changed: true });
    expect(readAllowlist(dataDir)).toEqual({ readRoots: [root], writeRoots: [] });
  });
  it("narrows without a dialog when no other root loses access", async () => {
    writeAllowlist(dataDir, { readRoots: [root], writeRoots: [root] });
    expect(await call("set-level", { path: root, level: "read" })).toMatchObject({ ok: true, changed: true });
    expect(questions).toEqual([]); expect(readAllowlist(dataDir).writeRoots).toEqual([]);
  });
  it("refuses a change when a CLI edit during confirmation changes the withdrawal set", async () => {
    writeAllowlist(dataDir, { readRoots: [root], writeRoots: [root, child] });
    answer = 0;
    // A live CLI edit while the native dialog is open changes the affected set.
    registerFolderAccess({ dataDir: () => dataDir, entryUrl, windowFor: () => window,
      ipc: { handle: (channel: string, handler: (event: Event, input?: unknown) => Promise<FolderAccessReply>) => { handlers.set(channel, handler); } },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => { updateAllowlist(dataDir, [{ change: "revoke", access: "write", path: child }]); return { response: 0, checkboxChecked: false }; },
      },
    });
    expect(await call("set-level", { path: root, level: "read" })).toMatchObject({ ok: false, reason: "changed" });
    expect(readAllowlist(dataDir).writeRoots).toEqual([root]);
  });
  it("cancels the picker without changing the record", async () => {
    const before = bytes();
    expect(await call("add")).toMatchObject({ ok: true, cancelled: true }); expect(bytes()).toBe(before);
    expect(pickerOptions[0]?.properties).toEqual(["openDirectory", "createDirectory"]);
  });
  it("adds the picked folder with read access", async () => {
    selected = [child];
    expect(await call("add")).toMatchObject({ ok: true, changed: true });
    expect(readAllowlist(dataDir)).toEqual({ readRoots: [root, child], writeRoots: [] });
  });
  it("returns unreadable when the picked folder cannot be resolved", async () => {
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    selected = [loop];
    const before = bytes();

    expect(await call("add")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(bytes()).toBe(before);
  });
  it("shows a damaged record as an error without folders", async () => {
    writeFileSync(allowlistFilePath(dataDir), "broken"); const before = bytes();
    expect(await call("list")).toMatchObject({ ok: false, reason: "damaged" });
    expect(await call("list")).not.toHaveProperty("folders"); expect(bytes()).toBe(before);
  });
  it("leaves an abandoned lock and returns its recovery command", async () => {
    const lock = `${allowlistFilePath(dataDir)}.lock`; writeFileSync(lock, "unknown owner"); const before = bytes();
    expect(await call("set-level", { path: root, level: "read-write" })).toMatchObject({ ok: false, reason: "lock-abandoned", recoverCommand: expect.stringContaining(lock) });
    expect(existsSync(lock)).toBe(true); expect(bytes()).toBe(before);
  });
});
