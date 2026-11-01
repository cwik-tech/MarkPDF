import { isAbsolute } from "node:path";

/**
 * The requests an agent sends to the running window, and the answers it gets back.
 *
 * A request crosses from one process to another through a private file, so everything in it is
 * checked here as untrusted input — by the desktop when it reads a request, and by the client when
 * it reads an answer. Any process of the same user can write one of these files. What protects the
 * person's documents is that the desktop applies the consent record again, not anything here.
 */

export const DESKTOP_REQUEST_VERSION = 1;
/** A version 4 UUID, which is all a request id may be. Every path is built from it. */
export const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_DESKTOP_FILE_BYTES = 16_384;
export const MAX_QUOTE_CHARACTERS = 500;
export const MAX_NOTE_CHARACTERS = 2_000;
export const MAX_AGENT_CHARACTERS = 64;
export const MAX_PAGE = 100_000;
const MAX_REF_CHARACTERS = 1_200;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_MESSAGE_CHARACTERS = 2_048;

/** What a person sees when an agent did not say who it is. */
export const UNNAMED_AGENT = "AI agent";

export type DesktopTarget = { ref: string } | { path: string };

interface RequestCommon {
  version: typeof DESKTOP_REQUEST_VERSION;
  id: string;
  /** Milliseconds since the epoch. The desktop does nothing visible for a request past this. */
  deadline: number;
  target: DesktopTarget;
  page: number;
  quote: string | null;
  agent: string;
}

export interface RevealRequest extends RequestCommon {
  kind: "reveal";
}

export interface SuggestRequest extends RequestCommon {
  kind: "suggest";
  note: string | null;
}

export type DesktopRequest = RevealRequest | SuggestRequest;

export const desktopReasons = [
  "access_denied",
  "stale_ref",
  "ambiguous",
  "not_open",
  "not_indexed",
  "expired",
  "busy",
  "invalid_request",
  "invalid_page",
  "quote_not_found",
  "document_changed",
  "limit_reached",
  "window_closed",
  "timeout",
  "no_answer",
  "cancelled",
] as const;
export type DesktopReason = (typeof desktopReasons)[number];

export const desktopStatuses = ["shown", "page_only", "added", "refused", "failed"] as const;
export type DesktopStatus = (typeof desktopStatuses)[number];

export interface DesktopResult {
  requestId: string;
  status: DesktopStatus;
  reason?: DesktopReason;
  message?: string;
  /** The open-document reference of the tab that answered. */
  ref?: string;
  page?: number;
  occurrences?: number;
  suggestionId?: string;
}

export class DesktopRequestError extends Error {
  constructor(
    readonly reason: DesktopReason,
    message: string,
  ) {
    super(message);
    this.name = "DesktopRequestError";
  }
}

function refuse(message: string, reason: DesktopReason = "invalid_request"): never {
  throw new DesktopRequestError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(text: string): boolean {
  // Line breaks are allowed in a note, which is prose; nothing else below U+0020 is, anywhere.
  return /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text);
}

function requireOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`A request may not carry ${key}.`);
}

function optionalText(value: unknown, name: string, maximum: number, allowLineBreaks: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") refuse(`${name} must be text.`);
  if ([...value].length > maximum) refuse(`${name} must be at most ${String(maximum)} characters long.`);
  if (hasControlCharacter(value) || (!allowLineBreaks && /[\n\r]/.test(value))) refuse(`${name} contains a control character.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTarget(value: unknown): DesktopTarget {
  if (!isRecord(value)) refuse("A request must name a document to act on.");
  const keys = Object.keys(value);
  if (keys.length !== 1) refuse("A request must name its document exactly once.");
  if (typeof value.ref === "string") {
    if (value.ref.length === 0 || value.ref.length > MAX_REF_CHARACTERS || hasControlCharacter(value.ref)) refuse("The document reference is not valid.");
    return { ref: value.ref };
  }
  if (typeof value.path === "string") {
    if (value.path.length > MAX_PATH_CHARACTERS || hasControlCharacter(value.path) || !isAbsolute(value.path)) refuse("The document path must be absolute.");
    return { path: value.path };
  }
  return refuse("A request must name its document by ref or path.");
}

/**
 * One request file, checked field by field.
 *
 * `expectedId` is the id the file was found under. A request whose content names another one is
 * refused, so a file cannot be copied into another request's place and answered as that one.
 */
export function parseDesktopRequest(value: unknown, expectedId: string, now: number): DesktopRequest {
  if (!isRecord(value)) refuse("A request must be an object.");
  if (value.version !== DESKTOP_REQUEST_VERSION) refuse("This MarkPDF does not understand the request version.");
  if (value.id !== expectedId || !REQUEST_ID_PATTERN.test(expectedId)) refuse("The request names another request.");
  const kind = value.kind;
  if (kind !== "reveal" && kind !== "suggest") refuse("This MarkPDF does not know that kind of request.");
  requireOnly(value, kind === "reveal"
    ? ["version", "id", "kind", "deadline", "target", "page", "quote", "agent"]
    : ["version", "id", "kind", "deadline", "target", "page", "quote", "note", "agent"]);

  const deadline = value.deadline;
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline)) refuse("The request has no deadline.");
  if (deadline <= now) refuse("The request expired before MarkPDF could act on it.", "expired");

  const page = value.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) refuse("The page must be a whole number from 1.", "invalid_page");

  const target = readTarget(value.target);
  const quote = optionalText(value.quote, "The quote", MAX_QUOTE_CHARACTERS, false);
  if (typeof value.agent !== "string") refuse("The request must say which agent sent it.");
  // The client cleans the name before it sends it, so a longer one is not a request this client made.
  if ([...value.agent].length > MAX_AGENT_CHARACTERS) refuse("The agent name is too long.");
  const agent = cleanAgentName(value.agent);

  if (kind === "reveal") return { version: DESKTOP_REQUEST_VERSION, id: expectedId, kind, deadline, target, page, quote, agent };

  const note = optionalText(value.note, "The note", MAX_NOTE_CHARACTERS, true);
  if (quote === null && note === null) refuse("A suggestion needs a quote, a note, or both.");
  return { version: DESKTOP_REQUEST_VERSION, id: expectedId, kind, deadline, target, page, quote, note, agent };
}

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return values.some((entry) => entry === value);
}

/** One answer file, checked field by field, for the request it must answer. */
export function parseDesktopResult(value: unknown, expectedId: string): DesktopResult {
  if (!isRecord(value)) throw new Error("A desktop answer must be an object.");
  if (value.requestId !== expectedId) throw new Error("The desktop answered another request.");
  if (!isMember(desktopStatuses, value.status)) throw new Error("The desktop answer has no valid status.");
  const result: DesktopResult = { requestId: expectedId, status: value.status };
  if (value.reason !== undefined) {
    if (!isMember(desktopReasons, value.reason)) throw new Error("The desktop answer has an unknown reason.");
    result.reason = value.reason;
  }
  for (const name of ["message", "ref", "suggestionId"] as const) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== "string" || field.length > MAX_MESSAGE_CHARACTERS || hasControlCharacter(field)) throw new Error(`The desktop answer has an invalid ${name}.`);
    result[name] = field;
  }
  for (const name of ["page", "occurrences"] as const) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`The desktop answer has an invalid ${name}.`);
    result[name] = field;
  }
  return result;
}

/**
 * The name an agent gave itself, as a label a person can trust to read as written.
 *
 * It is the client's own claim, not an identity. What it may not do is disguise itself: control
 * characters and the bidirectional controls that reorder text on screen become spaces, so a name
 * cannot be made to display as something it does not spell. The result is short, and never empty.
 */
export function cleanAgentName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limited = [...cleaned].slice(0, MAX_AGENT_CHARACTERS).join("").trim();
  return limited.length > 0 ? limited : UNNAMED_AGENT;
}

// ---------------------------------------------------------------------------------------------
// Between the desktop and its window
// ---------------------------------------------------------------------------------------------

/** What the desktop asks a window to show. Main sends it; the preload checks it before the window sees it. */
export interface RevealCommand {
  requestId: string;
  target: { tabId: string } | { path: string };
  page: number;
  quote: string | null;
  /** The cleaned agent name, or empty for a reveal from a link, which carries none. */
  agent: string;
}

/** What the window did. The desktop checks it before it becomes an answer file. */
export interface RevealOutcome {
  status: "shown" | "page_only" | "refused" | "failed";
  reason?: DesktopReason;
  message?: string;
  occurrences?: number;
}

function windowTarget(value: unknown): RevealCommand["target"] | null {
  if (!isRecord(value)) return null;
  if (typeof value.tabId === "string" && value.tabId.length > 0 && value.tabId.length <= 1_024 && value.path === undefined) {
    return { tabId: value.tabId };
  }
  if (typeof value.path === "string" && isAbsolute(value.path) && value.path.length <= MAX_PATH_CHARACTERS && value.tabId === undefined) {
    return { path: value.path };
  }
  return null;
}

export function parseRevealCommand(value: unknown): RevealCommand | null {
  if (!isRecord(value)) return null;
  const { requestId, page, quote, agent } = value;
  const target = windowTarget(value.target);
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId) || target === null) return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) return null;
  if (quote !== null && (typeof quote !== "string" || [...quote].length > MAX_QUOTE_CHARACTERS)) return null;
  if (typeof agent !== "string" || [...agent].length > MAX_AGENT_CHARACTERS) return null;
  return { requestId, target, page, quote, agent };
}

export function parseRevealOutcome(value: unknown): RevealOutcome {
  const invalid: RevealOutcome = { status: "failed", reason: "invalid_request", message: "The window sent an answer MarkPDF cannot use." };
  if (!isRecord(value)) return invalid;
  const status = value.status;
  if (status !== "shown" && status !== "page_only" && status !== "refused" && status !== "failed") return invalid;
  const outcome: RevealOutcome = { status };
  if (value.reason !== undefined) {
    if (!isMember(desktopReasons, value.reason)) return invalid;
    outcome.reason = value.reason;
  }
  if (value.message !== undefined) {
    if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_CHARACTERS) return invalid;
    outcome.message = value.message;
  }
  if (value.occurrences !== undefined) {
    if (typeof value.occurrences !== "number" || !Number.isSafeInteger(value.occurrences) || value.occurrences < 0) return invalid;
    outcome.occurrences = value.occurrences;
  }
  return outcome;
}

/** What the desktop asks a window to add as a suggestion. */
export interface SuggestCommand {
  requestId: string;
  tabId: string;
  page: number;
  quote: string | null;
  note: string | null;
  agent: string;
}

export interface SuggestOutcome {
  status: "added" | "refused" | "failed";
  reason?: DesktopReason;
  message?: string;
  suggestionId?: string;
  occurrences?: number;
}

export function parseSuggestCommand(value: unknown): SuggestCommand | null {
  if (!isRecord(value)) return null;
  const { requestId, tabId, page, quote, note, agent } = value;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return null;
  if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 1_024) return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) return null;
  if (quote !== null && (typeof quote !== "string" || [...quote].length > MAX_QUOTE_CHARACTERS)) return null;
  if (note !== null && (typeof note !== "string" || [...note].length > MAX_NOTE_CHARACTERS)) return null;
  if (quote === null && note === null) return null;
  if (typeof agent !== "string" || agent.length === 0 || [...agent].length > MAX_AGENT_CHARACTERS) return null;
  return { requestId, tabId, page, quote, note, agent };
}

export function parseSuggestOutcome(value: unknown): SuggestOutcome {
  const invalid: SuggestOutcome = { status: "failed", reason: "invalid_request", message: "The window sent an answer MarkPDF cannot use." };
  if (!isRecord(value)) return invalid;
  const status = value.status;
  if (status !== "added" && status !== "refused" && status !== "failed") return invalid;
  const outcome: SuggestOutcome = { status };
  if (value.reason !== undefined) {
    if (!isMember(desktopReasons, value.reason)) return invalid;
    outcome.reason = value.reason;
  }
  for (const name of ["message", "suggestionId"] as const) {
    const field = value[name];
    if (field === undefined) continue;
    if (typeof field !== "string" || field.length > MAX_MESSAGE_CHARACTERS) return invalid;
    outcome[name] = field;
  }
  if (value.occurrences !== undefined) {
    if (typeof value.occurrences !== "number" || !Number.isSafeInteger(value.occurrences) || value.occurrences < 0) return invalid;
    outcome.occurrences = value.occurrences;
  }
  return outcome;
}
