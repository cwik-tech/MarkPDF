import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  addSuggestion,
  discardPending,
  emptySuggestions,
  MAX_PENDING_SUGGESTIONS,
  MAX_SUGGESTION_LOG,
  rejectSuggestion,
  type AgentSuggestion,
} from "./agentSuggestions";

function suggestion(index: number, overrides: Partial<AgentSuggestion> = {}): AgentSuggestion {
  return {
    id: `suggestion-${String(index)}`,
    page: 1,
    quote: "Termination requires notice",
    note: "Ask for 60 days.",
    agent: "claude-code",
    x: 72,
    y: 90,
    width: 200,
    height: 14,
    fragments: [{ x: 0, y: 0, width: 200, height: 14 }],
    revision: 0,
    suggestedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  };
}

describe("agent suggestions", () => {
  it("holds up to the limit of pending suggestions and refuses one more", () => {
    let state = emptySuggestions();
    for (let index = 0; index < MAX_PENDING_SUGGESTIONS; index += 1) {
      const added = addSuggestion(state, suggestion(index));
      if (!added.ok) throw new Error("refused too early");
      state = added.state;
    }
    expect(addSuggestion(state, suggestion(99))).toEqual({ ok: false, reason: "limit_reached" });
    expect(state.log.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("turns an accepted comment into an annotation the person owns, recorded as the agent's", () => {
    const added = addSuggestion(emptySuggestions(), suggestion(1));
    if (!added.ok) throw new Error("refused");
    const accepted = acceptSuggestion(added.state, "suggestion-1", "2026-10-31T10:05:00.000Z");

    expect(accepted?.overlay).toMatchObject({
      kind: "comment",
      page: 1,
      text: "Ask for 60 days.",
      minimized: true,
      fragments: [{ x: 0, y: 0, width: 200, height: 14 }],
      origin: {
        kind: "agent",
        agent: "claude-code",
        quote: "Termination requires notice",
        suggestedAt: "2026-10-31T10:00:00.000Z",
        acceptedAt: "2026-10-31T10:05:00.000Z",
      },
    });
    expect(accepted?.overlay.source).toBeUndefined();
    expect(accepted?.state.pending).toEqual([]);
    expect(accepted?.state.log).toEqual([{ id: "suggestion-1", status: "accepted" }]);
  });

  it("accepts a quote without a note as a highlight, and a note without a quote as a page note", () => {
    let state = emptySuggestions();
    for (const entry of [suggestion(1, { note: null }), suggestion(2, { quote: null, fragments: undefined })]) {
      const added = addSuggestion(state, entry);
      if (!added.ok) throw new Error("refused");
      state = added.state;
    }
    expect(acceptSuggestion(state, "suggestion-1", "t")?.overlay).toMatchObject({ kind: "highlight", text: undefined });
    expect(acceptSuggestion(state, "suggestion-2", "t")?.overlay).toMatchObject({ kind: "comment", minimized: true, fragments: undefined });
  });

  it("rejects without making anything, and cannot accept what it rejected", () => {
    const added = addSuggestion(emptySuggestions(), suggestion(1));
    if (!added.ok) throw new Error("refused");
    const rejected = rejectSuggestion(added.state, "suggestion-1");
    expect(rejected.pending).toEqual([]);
    expect(rejected.log).toEqual([{ id: "suggestion-1", status: "rejected" }]);
    expect(acceptSuggestion(rejected, "suggestion-1", "t")).toBeNull();
  });

  it("discards every pending suggestion when the pages change, and says how many", () => {
    let state = emptySuggestions();
    for (const index of [1, 2]) {
      const added = addSuggestion(state, suggestion(index));
      if (!added.ok) throw new Error("refused");
      state = added.state;
    }
    const discarded = discardPending(state);
    expect(discarded.count).toBe(2);
    expect(discarded.state.pending).toEqual([]);
    expect(discarded.state.log.map((entry) => entry.status)).toEqual(["discarded", "discarded"]);
  });

  it("keeps a bounded record of decisions, newest first", () => {
    let state = emptySuggestions();
    for (let index = 0; index < MAX_SUGGESTION_LOG + 20; index += 1) {
      const added = addSuggestion(state, suggestion(index));
      if (!added.ok) throw new Error("refused");
      state = rejectSuggestion(added.state, `suggestion-${String(index)}`);
    }
    expect(state.log).toHaveLength(MAX_SUGGESTION_LOG);
    expect(state.log[0]?.id).toBe(`suggestion-${String(MAX_SUGGESTION_LOG + 19)}`);
  });
});
