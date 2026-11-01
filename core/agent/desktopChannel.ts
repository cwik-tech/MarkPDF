import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopRequestsDir } from "../paths.js";
import {
  DesktopRequestError,
  MAX_DESKTOP_FILE_BYTES,
  parseDesktopRequest,
  parseDesktopResult,
  REQUEST_ID_PATTERN,
  type DesktopReason,
  type DesktopRequest,
  type DesktopResult,
} from "./desktopRequests.js";

/**
 * The private channel an agent's request travels to the running window on.
 *
 * The same shape the preparation channel uses — a request file, a second launch of the binary that
 * the single-instance lock hands to the running app, and an answer file — with the rules that
 * channel did not have, because these requests make the window do something visible:
 *
 * - A request id is a UUID and nothing else, and every path is built from the fixed directory and
 *   that id. The directory is private, and refused when it is a link or belongs to someone else.
 * - A file is read through one descriptor opened with `O_NOFOLLOW`, checked with `fstat` to be a
 *   regular file, and read only up to the limit — so a link, a device or a file that grows while
 *   it is read is refused rather than followed.
 * - The desktop takes a request by renaming it before it reads it. A second delivery of the same
 *   id finds nothing, so a request cannot be acted on twice.
 * - An answer is written under a random temporary name and renamed into place, and it names the
 *   request it answers.
 * - The desktop acknowledges first. A client that hears nothing within a few seconds says so at
 *   once: the usual cause is an older MarkPDF that does not know this request, which treats it as
 *   "bring the window forward" and never answers.
 * - Old files are cleared away when the desktop starts.
 *
 * None of this authenticates the agent. Any process of the same user can write these files; the
 * desktop applies the consent record to every request again, and that is what protects documents.
 */

export const ACK_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const EXPIRED_FILE_AGE_MS = 3_600_000;
const FILE_SUFFIXES = ["request.json", "taken", "ack", "result.json"] as const;

const NO_ANSWER =
  "MarkPDF did not answer. An older MarkPDF can be running. Restart MarkPDF and try again.";

function fileOf(directory: string, id: string, suffix: (typeof FILE_SUFFIXES)[number]): string {
  return join(directory, `${id}.${suffix}`);
}

/** The private directory, made when absent, refused when it is not what this program made. */
export function ensureRequestDirectory(dataDir: string): string {
  const directory = desktopRequestsDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("The request directory is not a directory.");
  const uid = process.getuid?.();
  if (uid !== undefined && status.uid !== uid) throw new Error("The request directory belongs to another user.");
  if ((status.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
  return directory;
}

/** At most the limit, from one descriptor that was not reached through a link. */
function readBounded(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error("Not a regular file.");
    if (status.size > MAX_DESKTOP_FILE_BYTES) throw new Error("The file is larger than the limit.");
    const buffer = Buffer.alloc(MAX_DESKTOP_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_DESKTOP_FILE_BYTES) throw new Error("The file grew past the limit while it was read.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup only. The desktop clears old files when it starts.
  }
}

// ---------------------------------------------------------------------------------------------
// The client: the MCP server or the command line
// ---------------------------------------------------------------------------------------------

export interface SendDesktopRequestInput {
  dataDir: string;
  request: DesktopRequest;
  signal: AbortSignal;
  ackTimeoutMs?: number;
  /** Starts the binary that hands the request to the running app. Replaced only by tests. */
  startDesktop?: (id: string) => void;
}

function failed(id: string, reason: DesktopReason, message: string): DesktopResult {
  return { requestId: id, status: "failed", reason, message };
}

/** The same launch preparation uses: the installed binary, or the development entry point. */
export function launchDesktop(dataDir: string, argument: string): void {
  const args = process.execPath.includes("node_modules/electron/")
    ? [fileURLToPath(new URL("../../dist-electron/bootstrap.js", import.meta.url))]
    : [];
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...environment } = process.env;
  const child = spawn(process.execPath, [...args, argument], {
    env: { ...environment, MARKPDF_DATA_DIR: dataDir },
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => undefined);
  child.unref();
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sendDesktopRequest(input: SendDesktopRequestInput): Promise<DesktopResult> {
  const { request, signal } = input;
  const id = request.id;
  const directory = ensureRequestDirectory(input.dataDir);
  const requestFile = fileOf(directory, id, "request.json");
  const ackFile = fileOf(directory, id, "ack");
  const resultFile = fileOf(directory, id, "result.json");
  const cleanUp = (): void => {
    for (const file of [requestFile, ackFile, resultFile]) removeQuietly(file);
  };

  writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600, flag: "wx" });
  try {
    (input.startDesktop ?? ((requestId) => launchDesktop(input.dataDir, `--markpdf-request=${requestId}`)))(id);
  } catch {
    cleanUp();
    return failed(id, "no_answer", "MarkPDF could not be started.");
  }

  const ackBy = Date.now() + (input.ackTimeoutMs ?? ACK_TIMEOUT_MS);
  while (!existsSync(ackFile) && !existsSync(resultFile)) {
    if (signal.aborted) {
      cleanUp();
      return failed(id, "cancelled", "The request was cancelled.");
    }
    if (Date.now() >= ackBy) {
      cleanUp();
      return failed(id, "no_answer", NO_ANSWER);
    }
    await pause(POLL_INTERVAL_MS);
  }

  while (!existsSync(resultFile)) {
    if (signal.aborted) {
      cleanUp();
      return failed(id, "cancelled", "The request was cancelled.");
    }
    if (Date.now() >= request.deadline) {
      cleanUp();
      return failed(id, "timeout", "MarkPDF did not finish in time. The window may still show the request.");
    }
    await pause(POLL_INTERVAL_MS);
  }

  try {
    return parseDesktopResult(JSON.parse(readBounded(resultFile)), id);
  } catch (error) {
    return failed(id, "no_answer", `MarkPDF sent an answer this command cannot use (${error instanceof Error ? error.message : "invalid"}).`);
  } finally {
    cleanUp();
  }
}

// ---------------------------------------------------------------------------------------------
// The desktop
// ---------------------------------------------------------------------------------------------

export type TakenRequest =
  | { ok: true; request: DesktopRequest }
  | { ok: false; reason: DesktopReason; message: string };

/** Take one request: once, from a regular file, within the limit, and checked field by field. */
export function takeDesktopRequest(dataDir: string, id: string, now: number): TakenRequest {
  if (!REQUEST_ID_PATTERN.test(id)) return { ok: false, reason: "invalid_request", message: "That is not a request id." };
  let directory: string;
  try {
    directory = ensureRequestDirectory(dataDir);
  } catch (error) {
    return { ok: false, reason: "invalid_request", message: error instanceof Error ? error.message : "No request directory." };
  }
  const taken = fileOf(directory, id, "taken");
  try {
    renameSync(fileOf(directory, id, "request.json"), taken);
  } catch {
    return { ok: false, reason: "invalid_request", message: "The request was already taken, or never written." };
  }

  let text: string;
  try {
    text = readBounded(taken);
  } catch (error) {
    return { ok: false, reason: "invalid_request", message: error instanceof Error ? error.message : "The request could not be read." };
  } finally {
    removeQuietly(taken);
  }

  try {
    return { ok: true, request: parseDesktopRequest(JSON.parse(text), id, now) };
  } catch (error) {
    if (error instanceof DesktopRequestError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: "invalid_request", message: "The request is not valid JSON." };
  }
}

export function writeDesktopAck(dataDir: string, id: string): void {
  if (!REQUEST_ID_PATTERN.test(id)) return;
  try {
    writeFileSync(fileOf(ensureRequestDirectory(dataDir), id, "ack"), "", { mode: 0o600, flag: "wx" });
  } catch {
    // Already acknowledged, or the client gave up and removed the directory's files.
  }
}

/** Publish one answer: written under a random name that no one else can have made, then renamed. */
export function writeDesktopResult(dataDir: string, id: string, result: DesktopResult): void {
  if (!REQUEST_ID_PATTERN.test(id)) return;
  const directory = ensureRequestDirectory(dataDir);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...result, requestId: id }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, fileOf(directory, id, "result.json"));
}

const OWN_FILE = new RegExp(
  `^(?:${REQUEST_ID_PATTERN.source.slice(1, -1)}\\.(?:${FILE_SUFFIXES.map((suffix) => suffix.replace(".", "\\.")).join("|")})|\\.${REQUEST_ID_PATTERN.source.slice(1, -1)}\\.tmp)$`,
);

/** Clear away request files older than an hour. Only names this program writes are touched. */
export function removeExpiredDesktopFiles(dataDir: string, now: number, maximumAgeMs = EXPIRED_FILE_AGE_MS): void {
  const directory = desktopRequestsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!OWN_FILE.test(name)) continue;
    const path = join(directory, name);
    try {
      if (now - statSync(path).mtimeMs > maximumAgeMs) rmSync(path, { force: true });
    } catch {
      // Gone already, or not ours to remove after all.
    }
  }
}
