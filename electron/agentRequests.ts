import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  removeExpiredDesktopFiles,
  takeDesktopRequest,
  writeDesktopAck,
  writeDesktopResult,
} from "../dist-core/agent/desktopChannel.js";
import {
  parseRevealOutcome,
  parseSuggestOutcome,
  type DesktopRequest,
  type DesktopResult,
  type RevealCommand,
  type RevealOutcome,
  type SuggestCommand,
  type SuggestOutcome,
} from "../dist-core/agent/desktopRequests.js";
import { randomUUID } from "node:crypto";
import { parseEvidenceLink, readOrCreateLinkKey } from "../dist-core/agent/evidenceLink.js";
import { requireAccess, resolveRealPath } from "../dist-core/consent/allowlist.js";
import { readAllowlist } from "../dist-core/consent/allowlistFile.js";
import { readOpenDocuments } from "../dist-core/session/openDocuments.js";
import { decideRequestTarget } from "./agentRequestTargets.js";

/**
 * The desktop's half of an agent's request: take it, decide where it goes, ask the window, answer.
 *
 * A request reaches this process as `--markpdf-request=<id>`, handed over by the single-instance
 * lock. The file is taken once and checked in core, the target is decided again against the
 * consent record in `agentRequestTargets.ts`, and only then does a window hear about it. The
 * window answers over IPC, and that answer is checked too before it becomes the answer file the
 * client reads.
 */

/** At most this many requests are being worked on at once. A further one is told it is busy. */
const MAX_IN_FLIGHT = 4;
/** Ids this run has already seen, so a replay inside one run is ignored. Bounded. */
const RECENT_LIMIT = 256;

const recent: string[] = [];
let inFlight = 0;
const waiting = new Map<string, { sender: WebContents; finish: (value: unknown) => void }>();

export interface DesktopRequestDependencies {
  dataDir: () => string;
  /** Open a document in the front window, or in a new one when there is none. */
  openDocument: (path: string) => Promise<WebContents>;
  /** The file the index recorded for a content hash, or null. */
  indexedPath: (contentHash: string) => string | null;
}

/** How long a reveal from a clicked link may take, including opening its document. */
const LINK_DEADLINE_MS = 30_000;

/** Say something short to the person in the front window. Nothing, when there is no window. */
function notify(text: string): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (window !== undefined && !window.webContents.isDestroyed()) window.webContents.send("agent:notice", text);
}

/**
 * A `markpdf://reveal` address the person clicked, somewhere.
 *
 * The operating system delivers these from any application, so a link is believed only when this
 * data directory signed it. A valid link reveals the passage in the tab that shows its document, or
 * opens the document from the path the index recorded — only with a read grant on that path,
 * checked now. Anything else changes nothing, and a running window says why.
 */
export async function handleEvidenceLink(url: string): Promise<void> {
  if (dependencies === null) return;
  const dataDir = dependencies.dataDir();
  const parsed = parseEvidenceLink(url, readOrCreateLinkKey(dataDir));
  if (!parsed.ok) {
    notify("MarkPDF ignored a link that it did not make.");
    return;
  }
  const requestId = randomUUID();
  const deadline = Date.now() + LINK_DEADLINE_MS;
  const command = { requestId, page: parsed.page, quote: parsed.quote, agent: "" };

  // The record of open tabs is written a moment after a tab changes, so it can still name a tab
  // that just closed. A window that answers "no such tab" sends the link on to the file instead.
  const askTab = async (entry: { window: number; tabId: string } | undefined): Promise<boolean> => {
    const window = entry === undefined ? null : BrowserWindow.fromId(entry.window);
    if (entry === undefined || window === null || window.isDestroyed()) return false;
    bringToFront(window);
    const outcome = await askWindow(window.webContents, { ...command, target: { tabId: entry.tabId } }, deadline);
    return outcome.reason !== "stale_ref";
  };

  const ownTabs = readOpenDocuments(dataDir).documents.filter((entry) => entry.process === process.pid && entry.kind === "pdf");
  if (await askTab(ownTabs.find((entry) => entry.contentHash === parsed.contentHash))) return;

  const path = dependencies.indexedPath(parsed.contentHash);
  if (path === null) {
    notify("MarkPDF has no record of the document this link names.");
    return;
  }
  let permitted: string;
  try {
    permitted = requireAccess(readAllowlist(dataDir), path, "read");
  } catch {
    notify("MarkPDF may not open the document this link names. Grant its folder with markpdf --allow-read.");
    return;
  }
  // The file may be open under another spelling of its path, or before its tab learned its
  // content hash. That tab shows the passage; a second copy of the document is not opened.
  if (await askTab(ownTabs.find((entry) => entry.path !== null && realPathOf(entry.path) === permitted))) return;
  const sender = await dependencies.openDocument(permitted);
  const opened = BrowserWindow.fromWebContents(sender);
  if (opened !== null) bringToFront(opened);
  await askWindow(sender, { ...command, target: { path: permitted } }, deadline);
}

function realPathOf(path: string): string {
  try {
    return resolveRealPath(path);
  } catch {
    return path;
  }
}

/** A link that started MarkPDF: a window opens only for a link that will be carried out. */
export async function handleColdStartLink(url: string): Promise<void> {
  await handleEvidenceLink(url).catch(() => undefined);
  if (BrowserWindow.getAllWindows().length === 0) app.quit();
}

let dependencies: DesktopRequestDependencies | null = null;

export function registerAgentRequests(input: DesktopRequestDependencies): void {
  dependencies = input;
  for (const channel of ["agent:revealed", "agent:suggested"]) {
    ipcMain.on(channel, (event, requestId: unknown, value: unknown) => {
      if (typeof requestId !== "string") return;
      const entry = waiting.get(requestId);
      // Only the window that was asked may answer.
      if (entry === undefined || entry.sender !== event.sender) return;
      entry.finish(value);
    });
  }
}

/** Called once when the desktop starts: clears request files left by a crash or a lost client. */
export function clearExpiredAgentRequests(): void {
  if (dependencies !== null) removeExpiredDesktopFiles(dependencies.dataDir(), Date.now());
}

function remember(id: string): boolean {
  if (recent.includes(id)) return false;
  recent.push(id);
  if (recent.length > RECENT_LIMIT) recent.shift();
  return true;
}

function bringToFront(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (process.env.MARKPDF_TEST_USER_DATA && process.env.MARKPDF_TEST_HIDE_WINDOWS === "1") return;
  window.show();
  window.focus();
  // The person asked an agent to show them something, so MarkPDF comes forward over the terminal.
  if (process.platform === "darwin") app.focus({ steal: true });
}

/**
 * Ask one window to do something, and wait for its checked answer until the request's deadline.
 *
 * The answer is parsed with core's parser for that message, so what the window says becomes an
 * answer file only in a shape the client can trust.
 */
function ask<Outcome>(
  sender: WebContents,
  channel: "agent:reveal" | "agent:suggest",
  requestId: string,
  command: unknown,
  deadline: number,
  parse: (value: unknown) => Outcome,
  failure: (reason: "window_closed" | "timeout", message: string) => Outcome,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let finished = false;
    const settle = (outcome: Outcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sender.removeListener("destroyed", destroyed);
      waiting.delete(requestId);
      resolve(outcome);
    };
    const destroyed = (): void => settle(failure("window_closed", "The window closed before it answered."));
    const timer = setTimeout(() => settle(failure("timeout", "The window did not answer in time.")), Math.max(0, deadline - Date.now()));
    waiting.set(requestId, { sender, finish: (value) => settle(parse(value)) });
    sender.once("destroyed", destroyed);
    sender.send(channel, requestId, command);
  });
}

/** Ask one window to show a passage. */
function askWindow(sender: WebContents, command: RevealCommand, deadline: number): Promise<RevealOutcome> {
  return ask(sender, "agent:reveal", command.requestId, command, deadline, parseRevealOutcome, (reason, message) => ({ status: "failed", reason, message }));
}

/** Ask one window to add an agent's suggestion to a tab. */
function askSuggestion(sender: WebContents, command: SuggestCommand, deadline: number): Promise<SuggestOutcome> {
  return ask(sender, "agent:suggest", command.requestId, command, deadline, parseSuggestOutcome, (reason, message) => ({ status: "failed", reason, message }));
}

async function handle(request: DesktopRequest, dataDir: string): Promise<DesktopResult> {
  const id = request.id;
  const decision = decideRequestTarget(request.target, request.kind, {
    pid: process.pid,
    view: readOpenDocuments(dataDir),
    allowlist: readAllowlist(dataDir),
  });
  if (decision.kind === "refuse") return { requestId: id, status: "refused", reason: decision.reason, message: decision.message };
  if (Date.now() >= request.deadline) return { requestId: id, status: "failed", reason: "expired", message: "The request expired." };

  if (request.kind === "suggest") {
    // `decideRequestTarget` never opens a document for a suggestion, so only an open tab is left.
    if (decision.kind !== "open-tab") return { requestId: id, status: "refused", reason: "not_open", message: "The document is not open in MarkPDF." };
    const window = BrowserWindow.fromId(decision.window);
    if (window === null || window.isDestroyed()) {
      return { requestId: id, status: "refused", reason: "stale_ref", message: "The window that had this document open is gone." };
    }
    const outcome = await askSuggestion(
      window.webContents,
      { requestId: id, tabId: decision.tabId, page: request.page, quote: request.quote, note: request.note, agent: request.agent },
      request.deadline,
    );
    return { requestId: id, ...outcome, ref: decision.ref, page: request.page };
  }

  if (decision.kind === "open-file") {
    // Within the grants, checked just now: the document opens the way the person opening it would.
    if (dependencies === null) throw new Error("Agent requests are not registered.");
    const sender = await dependencies.openDocument(decision.path);
    const window = BrowserWindow.fromWebContents(sender);
    if (window !== null) bringToFront(window);
    const outcome = await askWindow(
      sender,
      { requestId: id, target: { path: decision.path }, page: request.page, quote: request.quote, agent: request.agent },
      request.deadline,
    );
    return { requestId: id, ...outcome, page: request.page };
  }

  const window = BrowserWindow.fromId(decision.window);
  if (window === null || window.isDestroyed()) {
    return { requestId: id, status: "refused", reason: "stale_ref", message: "The window that had this document open is gone." };
  }

  bringToFront(window);
  const outcome = await askWindow(
    window.webContents,
    { requestId: id, target: { tabId: decision.tabId }, page: request.page, quote: request.quote, agent: request.agent },
    request.deadline,
  );
  return { requestId: id, ...outcome, ref: decision.ref, page: request.page };
}

/**
 * A request that started MarkPDF: answered before any window exists.
 *
 * A request that is refused, or one that never needed a window, ends the process without showing
 * anything. Only a reveal the desktop will carry out opens a window, with its document.
 */
export async function dispatchColdStartRequest(id: string): Promise<void> {
  await dispatchDesktopRequest(id);
  if (BrowserWindow.getAllWindows().length === 0) app.quit();
}

/** Take, act on and answer one request. Never throws: a failure is an answer. */
export async function dispatchDesktopRequest(id: string): Promise<void> {
  if (dependencies === null) return;
  const dataDir = dependencies.dataDir();
  const taken = takeDesktopRequest(dataDir, id, Date.now());
  if (!taken.ok) {
    // A request that was never written, or that another handler already took, has no one to answer.
    if (taken.message.startsWith("The request was already taken")) return;
    try {
      writeDesktopResult(dataDir, id, { requestId: id, status: "refused", reason: taken.reason, message: taken.message });
    } catch {
      // Nothing more can be said to a client whose id is not a request id.
    }
    return;
  }
  if (!remember(id)) return;
  writeDesktopAck(dataDir, id);

  if (inFlight >= MAX_IN_FLIGHT) {
    writeDesktopResult(dataDir, id, { requestId: id, status: "refused", reason: "busy", message: "MarkPDF is busy with other agent requests. Try again." });
    return;
  }
  inFlight += 1;
  try {
    writeDesktopResult(dataDir, id, await handle(taken.request, dataDir));
  } catch (error) {
    writeDesktopResult(dataDir, id, {
      requestId: id,
      status: "failed",
      reason: "invalid_request",
      message: error instanceof Error ? error.message.slice(0, 2_000) : "The request failed.",
    });
  } finally {
    inFlight -= 1;
  }
}
