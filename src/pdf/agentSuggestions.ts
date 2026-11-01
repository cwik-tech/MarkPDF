/**
 * What an agent has suggested for one tab, and what the person decided.
 *
 * A suggestion is not an annotation of the document. It lives in this state, beside the tab's
 * overlays and never among them, until the person accepts it — so no code path that saves overlays
 * can ever save one, and the undo history, which holds overlays, cannot bring back one that was
 * rejected. Accepting turns it into an ordinary overlay the person owns, recorded as the agent's.
 *
 * Pending suggestions are bounded, and so is the record of decisions an agent can read back. That
 * record says what the person decided, not what the document now contains: an accepted suggestion
 * the person later deleted is still "accepted".
 */

import type { OverlayItem, OverlayRect } from "../types";

export const MAX_PENDING_SUGGESTIONS = 50;
export const MAX_SUGGESTION_LOG = 100;
/** Agent work in one colour across the page, the pane and the saved file. */
export const AGENT_COLOR = "#8b5cf6";
/** Where a note with no quote is pinned: the top-left margin of its page. */
const PAGE_NOTE_POSITION = { x: 36, y: 36, width: 24, height: 24 } as const;

export interface AgentSuggestion {
  id: string;
  page: number;
  quote: string | null;
  note: string | null;
  agent: string;
  /** The box around the anchored lines, or the page note's pin, in page space at zoom 1. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The anchored lines as offsets from `x`/`y`, as a text-anchored overlay stores them. */
  fragments?: OverlayRect[] | undefined;
  /** The tab's document revision the quote was anchored against. */
  revision: number;
  suggestedAt: string;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected" | "discarded";

export interface SuggestionState {
  pending: AgentSuggestion[];
  /** Newest first. */
  log: Array<{ id: string; status: SuggestionStatus }>;
}

export function emptySuggestions(): SuggestionState {
  return { pending: [], log: [] };
}

function withStatus(log: SuggestionState["log"], id: string, status: SuggestionStatus): SuggestionState["log"] {
  return log.map((entry) => (entry.id === id ? { id, status } : entry));
}

export function addSuggestion(
  state: SuggestionState,
  suggestion: AgentSuggestion,
): { ok: true; state: SuggestionState } | { ok: false; reason: "limit_reached" } {
  if (state.pending.length >= MAX_PENDING_SUGGESTIONS) return { ok: false, reason: "limit_reached" };
  return {
    ok: true,
    state: {
      pending: [...state.pending, suggestion],
      log: [{ id: suggestion.id, status: "pending" as const }, ...state.log.filter((entry) => entry.id !== suggestion.id)].slice(
        0,
        MAX_SUGGESTION_LOG,
      ),
    },
  };
}

/** Where a suggestion would sit on its page, for the page to draw it. */
export function pageNotePosition(): { x: number; y: number; width: number; height: number } {
  return { ...PAGE_NOTE_POSITION };
}

export function acceptSuggestion(
  state: SuggestionState,
  id: string,
  acceptedAt: string,
): { state: SuggestionState; overlay: OverlayItem } | null {
  const suggestion = state.pending.find((entry) => entry.id === id);
  if (suggestion === undefined) return null;

  const isHighlight = suggestion.note === null;
  const overlay: OverlayItem = {
    id: `comment-${id}`,
    kind: isHighlight ? "highlight" : "comment",
    page: suggestion.page,
    x: suggestion.x,
    y: suggestion.y,
    width: suggestion.width,
    height: suggestion.height,
    text: suggestion.note ?? undefined,
    fontSize: isHighlight ? undefined : 12,
    color: AGENT_COLOR,
    minimized: isHighlight ? undefined : true,
    fragments: suggestion.fragments,
    origin: {
      kind: "agent",
      agent: suggestion.agent,
      ...(suggestion.quote === null ? {} : { quote: suggestion.quote }),
      suggestedAt: suggestion.suggestedAt,
      acceptedAt,
    },
  };
  return {
    overlay,
    state: { pending: state.pending.filter((entry) => entry.id !== id), log: withStatus(state.log, id, "accepted") },
  };
}

export function rejectSuggestion(state: SuggestionState, id: string): SuggestionState {
  if (!state.pending.some((entry) => entry.id === id)) return state;
  return { pending: state.pending.filter((entry) => entry.id !== id), log: withStatus(state.log, id, "rejected") };
}

/** End every pending suggestion: the pages they were anchored to have changed. */
export function discardPending(state: SuggestionState): { state: SuggestionState; count: number } {
  const ids = new Set(state.pending.map((entry) => entry.id));
  return {
    count: ids.size,
    state: { pending: [], log: state.log.map((entry) => (ids.has(entry.id) ? { id: entry.id, status: "discarded" as const } : entry)) },
  };
}
