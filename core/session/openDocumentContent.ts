import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { openDocumentContentDir } from "../paths.js";
import { processIsRunning } from "./processLiveness.js";

export const OPEN_DOCUMENT_SNAPSHOT_CEILING = 5_000_000;

export interface OpenDocumentContentInput {
  tabId: string;
  content: string;
}

export interface OpenDocumentContentState {
  tabId: string;
  hasContentSnapshot: true;
  contentChars: number;
  contentBytes: number;
  snapshotTruncated: boolean;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function encodedTabId(tabId: string): string {
  return encodeURIComponent(tabId);
}

function fileNameFor(pid: number, windowId: number, tabId: string): string {
  return `${pid}-${windowId}-${encodedTabId(tabId)}.md`;
}

function contentFile(dataDir: string, pid: number, windowId: number, tabId: string): string {
  return join(openDocumentContentDir(dataDir), fileNameFor(pid, windowId, tabId));
}

function prefixFor(pid: number, windowId?: number): string {
  return windowId === undefined ? `${pid}-` : `${pid}-${windowId}-`;
}

function listFiles(dataDir: string): string[] {
  const directory = openDocumentContentDir(dataDir);
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function boundedContent(content: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= OPEN_DOCUMENT_SNAPSHOT_CEILING) {
    return { text: content, truncated: false };
  }

  let bytes = 0;
  let units = 0;
  for (const character of content) {
    const cost = Buffer.byteLength(character, "utf8");
    if (bytes + cost > OPEN_DOCUMENT_SNAPSHOT_CEILING) break;
    bytes += cost;
    units += character.length;
  }
  return { text: content.slice(0, units), truncated: true };
}

function writePrivateFile(target: string, text: string): void {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  let staging: string | null = null;
  try {
    staging = mkdtempSync(join(parent, ".writing-"));
    const pending = join(staging, "snapshot.md");
    writeFileSync(pending, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(pending, 0o600);
    renameSync(pending, target);
  } finally {
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
  }
}

/** Replace all Markdown snapshots owned by one window and remove snapshots for tabs it closed. */
export function syncOpenDocumentContent(
  dataDir: string,
  pid: number,
  windowId: number,
  documents: readonly OpenDocumentContentInput[],
): OpenDocumentContentState[] {
  const directory = openDocumentContentDir(dataDir);
  mkdirSync(directory, { recursive: true });
  const keep = new Set<string>();
  const states = documents.map((item) => {
    const fileName = fileNameFor(pid, windowId, item.tabId);
    keep.add(fileName);
    const bounded = boundedContent(item.content);
    writePrivateFile(join(directory, fileName), bounded.text);
    return {
      tabId: item.tabId,
      hasContentSnapshot: true as const,
      contentChars: bounded.text.length,
      contentBytes: Buffer.byteLength(bounded.text, "utf8"),
      snapshotTruncated: bounded.truncated,
    };
  });

  for (const name of listFiles(dataDir)) {
    if (name.startsWith(prefixFor(pid, windowId)) && !keep.has(name)) {
      rmSync(join(directory, name), { force: true });
    }
  }
  return states;
}

export function readOpenDocumentContent(
  dataDir: string,
  pid: number,
  windowId: number,
  tabId: string,
): string | null {
  const file = contentFile(dataDir, pid, windowId, tabId);
  if (!processIsRunning(pid)) {
    try {
      rmSync(file, { force: true });
    } catch {
      // The stale file is still ignored. Removal is only cleanup.
    }
    return null;
  }
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function removeOpenDocumentContentForWindow(dataDir: string, pid: number, windowId: number): void {
  const directory = openDocumentContentDir(dataDir);
  for (const name of listFiles(dataDir)) {
    if (name.startsWith(prefixFor(pid, windowId))) rmSync(join(directory, name), { force: true });
  }
}

export function removeOpenDocumentContentForProcess(dataDir: string, pid: number): void {
  const directory = openDocumentContentDir(dataDir);
  for (const name of listFiles(dataDir)) {
    if (name.startsWith(prefixFor(pid))) rmSync(join(directory, name), { force: true });
  }
}
