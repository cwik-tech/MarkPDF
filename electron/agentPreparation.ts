import type { SemanticSearchSettings } from "../dist-core/ipc/settings.js";
import { access, readFile, rename, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { preparationConcurrency, preparationDirectory, preparationDeadlineMs } from "../dist-core/agent/desktopClient.js";
import { openDocumentReference, readOpenDocuments } from "../dist-core/session/openDocuments.js";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { requirePreparationPath, parsePreparationReply, type PreparationReply } from "../dist-core/agent/preparation.js";
import { readAllowlist } from "../dist-core/consent/allowlistFile.js";
import { requireAccess, resolveRealPath } from "../dist-core/consent/allowlist.js";
import { savePreparation } from "./preparationSave.js";

const pending = new Map<string, { sender: WebContents; resolve: (value: PreparationReply) => void }>();
const saving = new Set<string>();
let getSettings: (() => SemanticSearchSettings) | undefined;
const scopes = new Map<WebContents, SemanticSearchSettings>();
export function preparationAbortSignal(sender: WebContents): AbortSignal | undefined { return controllers.get(sender)?.signal; }
export function preparationSettings(sender: WebContents): SemanticSearchSettings | undefined { return scopes.get(sender); }
const controllers = new Map<WebContents, AbortController>();
export function cancelPreparation(sender: WebContents): void { controllers.get(sender)?.abort(); if (!sender.isDestroyed()) sender.send("agent:cancel"); }
export async function withDocumentSave<T>(path: string, write: () => Promise<T>): Promise<T> {
  const target = resolveRealPath(path);
  if (saving.has(target)) throw new Error("Another save owns this document");
  saving.add(target);
  try { return await write(); } finally { saving.delete(target); }
}
export function prepareInWindow(sender: WebContents, path?: string): Promise<PreparationReply> {
  if (pending.size >= preparationConcurrency) return Promise.resolve({ status: "needs_user_action", save: "blocked", reason: "Preparation already running" });
  const id = randomUUID();
  const scope = getSettings?.();
  if (scope?.enabled === false) return Promise.resolve({ status: "needs_user_action", save: "blocked", reason: "Enable semantic indexing in Settings" });
  if (scope !== undefined) scopes.set(sender, scope);
  controllers.set(sender, new AbortController());
  return new Promise((resolve) => {
    const finish = (value: PreparationReply): void => { clearTimeout(timer); pending.delete(id); controllers.delete(sender); scopes.delete(sender); sender.removeListener("destroyed", destroyed); resolve(value); };
    const destroyed = (): void => { cancelPreparation(sender); finish({ status: "failed", save: "unknown", reason: "Window closed before preparation finished; save outcome unknown" }); };
    const timer = setTimeout(() => { cancelPreparation(sender); finish({ status: "failed", save: "unknown", reason: "Preparation deadline exceeded; save outcome is unknown" }); }, preparationDeadlineMs);
    pending.set(id, { sender, resolve: finish });
    sender.once("destroyed", destroyed);
    sender.send("agent:prepare", id, path);
  });
}
export function registerAgentPreparation(dataDir: () => string, settings: () => SemanticSearchSettings): void {
  getSettings = settings;
  ipcMain.on("agent:cancel-current", (event) => cancelPreparation(event.sender));
  ipcMain.handle("agent:check-source", async (_event, path: unknown, bytes: unknown) => {
    if (typeof path !== "string" || !(bytes instanceof Uint8Array)) throw new Error("Invalid source check");
    const target = requireAccess(readAllowlist(dataDir()), path, "read");
    if (!Buffer.from(await readFile(target)).equals(bytes)) throw new Error("Source changed outside MarkPDF; reopen it before preparation");
  });
  ipcMain.handle("agent:prepare-active", async (event) => await prepareInWindow(event.sender));
  ipcMain.on("agent:prepared", (event, id: unknown, value: unknown) => {
    if (typeof id !== "string") return;
    const entry = pending.get(id);
    if (entry?.sender !== event.sender) return;
    try {
      const reply = parsePreparationReply(value);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && reply.tabId) reply.ref = openDocumentReference(process.pid, window.id, reply.tabId);
      reply.requestId = id;
      entry.resolve(reply);
    }
    catch (error) { entry.resolve({ status: "failed", save: "unknown", reason: error instanceof Error ? error.message : "Invalid reply" }); }
  });
  ipcMain.handle("agent:save", async (event, path: unknown, source: unknown, bytes: unknown) => {
    if (typeof path !== "string" || !(source instanceof Uint8Array) || !(bytes instanceof Uint8Array)) throw new Error("Invalid preparation save");
    const grants = readAllowlist(dataDir());
    const target = requireAccess(grants, path, "write");
    requireAccess(grants, target, "read");
    const controller = controllers.get(event.sender);
    if (controller === undefined) throw new Error("No preparation owns this save");
    await withDocumentSave(target, async () => await savePreparation(target, source, bytes, controller.signal));
  });
}

const external = new Map<string, { path: string; sender?: WebContents }>();
export async function queueExternalPreparation(id: string, dataDir: string, open: (path: string, created: (sender: WebContents) => void) => Promise<void>): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id) || external.has(id)) return;
  const directory = preparationDirectory(dataDir);
  let finished = false;
  const writeResult = async (reply: PreparationReply): Promise<void> => {
    if (finished) return;
    finished = true;
    const target = join(directory, `${id}.result.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...reply, stage: reply.stage ?? "transport", remedy: reply.remedy ?? (reply.status === "needs_user_action" ? "Resolve the reported permission or document conflict, then request preparation again" : "Inspect missing pages or fall back to the ordinary PDF parser"), requestId: id, fallback: reply.fallback ?? (reply.status === "needs_user_action" ? "user_action" : reply.status === "failed" ? "traditional_parser" : "none") }), { mode: 0o600 });
    await rename(temporary, target);
  };
  let raw: unknown;
  try {
    const file = join(directory, `${id}.request.json`);
    if ((await stat(file)).size > 16_384) throw new Error("Oversized preparation request");
    raw = JSON.parse(await readFile(file, "utf8"));
  }
  catch { return; }
  try {
    if (typeof raw !== "object" || raw === null || !("path" in raw) || typeof raw.path !== "string") throw new Error("Invalid preparation request");
    const path = requireAccess(readAllowlist(dataDir), requirePreparationPath(raw.path), "read");
    const matches = readOpenDocuments(dataDir).documents.filter((item) => item.path === path);
    if (external.size >= preparationConcurrency || pending.size >= preparationConcurrency || matches.length > 1 || [...external.values()].some((item) => item.path === path)) {
      await writeResult({ status: "needs_user_action", save: "blocked", reason: "Multiple tabs or another preparation own this document" }); return;
    }
    const entry: { path: string; sender?: WebContents } = { path };
    external.set(id, entry);
    let started = false;
    const cleanup = (): void => {
      clearTimeout(deadline); watcher.close(); ipcMain.removeListener("agent:ready", listener);
      entry.sender?.removeListener("destroyed", destroyed); external.delete(id);
    };
    const fail = async (reason: string): Promise<void> => { if (entry.sender) cancelPreparation(entry.sender); cleanup(); await writeResult({ status: "failed", save: "unknown", reason }); };
    const destroyed = (): void => { void fail("Window closed; save outcome unknown"); };
    const cancelled = async (): Promise<boolean> => {
      try { await access(join(directory, `${id}.cancel`)); return true; } catch { return false; }
    };
    const start = async (): Promise<void> => {
      if (started || finished || entry.sender === undefined) return;
      started = true;
      if (await cancelled()) { cleanup(); await writeResult({ status: "cancelled", save: "not_needed" }); return; }
      try {
        const operation = prepareInWindow(entry.sender, path);
        if (await cancelled()) cancelPreparation(entry.sender);
        await writeResult(await operation);
      } finally { cleanup(); }
    };
    const listener = (event: Electron.IpcMainEvent, readyPath: unknown): void => {
      if (event.sender === entry.sender && readyPath === path) void start().catch((error: unknown) => fail(error instanceof Error ? error.message.slice(0, 2048) : "Preparation failed"));
    };
    const watcher = watch(directory, () => { void cancelled().then((yes) => { if (yes && entry.sender) cancelPreparation(entry.sender); }); });
    watcher.on("error", () => { void fail("Preparation watcher failed; save outcome unknown"); });
    const deadline = setTimeout(() => { void fail("Preparation deadline exceeded; save outcome unknown"); }, preparationDeadlineMs);
    ipcMain.on("agent:ready", listener);
    const bind = (sender: WebContents): void => { entry.sender = sender; sender.once("destroyed", destroyed); };
    const existing = matches[0];
    if (existing !== undefined && existing.process === process.pid) {
      const window = BrowserWindow.fromId(existing.window);
      if (window === null) { await fail("The owning window is unavailable"); return; }
      bind(window.webContents); await start();
    } else {
      try { await open(path, bind); } catch (error) { cleanup(); throw error; }
    }
  } catch (error) {
    await writeResult({ status: "needs_user_action", save: "blocked", reason: error instanceof Error ? error.message.slice(0, 2048) : "Preparation refused" });
  }
}
