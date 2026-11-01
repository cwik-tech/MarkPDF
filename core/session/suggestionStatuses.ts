/**
 * What a window may say about an agent's suggestions: an id and a decision, nothing more.
 *
 * The open-documents record carries no document text, and a suggestion's note and quote are text
 * an agent wrote about the document. So the record names each suggestion and the person's decision
 * about it, and a list that carries anything else is refused rather than trimmed.
 */

export const suggestionStatuses = ["pending", "accepted", "rejected", "discarded"] as const;
export type SuggestionStatusValue = (typeof suggestionStatuses)[number];

export interface SuggestionStatusEntry {
  id: string;
  status: SuggestionStatusValue;
}

/** The most decisions one tab reports, newest first. */
export const MAX_REPORTED_SUGGESTIONS = 100;
const SUGGESTION_ID = /^suggestion-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The list as reported, or null when any part of it is not what a window writes. */
export function readSuggestionStatuses(value: unknown): SuggestionStatusEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_SUGGESTIONS) return null;
  const entries: SuggestionStatusEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("status")) return null;
    const { id, status } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !SUGGESTION_ID.test(id)) return null;
    if (!suggestionStatuses.some((candidate) => candidate === status)) return null;
    entries.push({ id, status: status as SuggestionStatusValue });
  }
  return entries;
}
