import { Bot } from "lucide-react";
import type { AgentSuggestion } from "../pdf/agentSuggestions";
import type { OverlayOrigin } from "../types";

/**
 * How an AI agent's work looks, on the page and in the comments pane.
 *
 * One vocabulary: violet, a robot, and the words "AI agent" with the agent's name. A pending
 * suggestion is dashed and asks a question; an accepted annotation is solid. The words are always
 * there, so the difference never rests on colour alone — and they are part of every accessible
 * name, so it does not rest on sight either.
 */

/** "AI agent · claude-code", with the person's own edit said after it. */
export function agentLabel(origin: Pick<OverlayOrigin, "agent" | "editedByPerson">): string {
  return `AI agent · ${origin.agent}${origin.editedByPerson === true ? ", edited by you" : ""}`;
}

export function AgentBadge({ origin }: { origin: Pick<OverlayOrigin, "agent" | "editedByPerson"> }) {
  return (
    <span className="agent-badge">
      <Bot size={12} aria-hidden="true" />
      {agentLabel(origin)}
    </span>
  );
}

/** The pending suggestions of one page, drawn in the overlay layer like anchored annotations. */
export function SuggestionMarks({
  suggestions,
  zoom,
  onOpen,
}: {
  suggestions: readonly AgentSuggestion[];
  zoom: number;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {suggestions.map((suggestion) => {
        const label = `Suggestion by AI agent ${suggestion.agent}, not accepted`;
        return (
          <div
            key={suggestion.id}
            className="suggestion-mark"
            style={{
              left: suggestion.x * zoom,
              top: suggestion.y * zoom,
              width: suggestion.width * zoom,
              height: suggestion.height * zoom,
            }}
          >
            {(suggestion.fragments ?? []).map((fragment, index) => (
              <span
                key={`${suggestion.id}-${String(index)}`}
                className="suggestion-fragment"
                style={{ left: fragment.x * zoom, top: fragment.y * zoom, width: fragment.width * zoom, height: fragment.height * zoom }}
              />
            ))}
            <button
              type="button"
              className="agent-pin suggestion-pin"
              title={label}
              aria-label={label}
              style={{ left: -(suggestion.x * zoom + 34) }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(suggestion.id);
              }}
            >
              <Bot size={15} aria-hidden="true" />
              <span className="suggestion-pin-question" aria-hidden="true">
                ?
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
}

/** The group at the top of the comments pane: what the agents proposed, and the two decisions. */
export function SuggestionGroup({
  suggestions,
  selectedId,
  onSelectPage,
  onAccept,
  onReject,
}: {
  suggestions: readonly AgentSuggestion[];
  selectedId: string | null;
  onSelectPage: (page: number) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <section className="suggestion-group">
      <div className="sidebar-section-heading">
        <Bot size={15} aria-hidden="true" />
        <h3>Suggested by agents ({suggestions.length})</h3>
        {suggestions.length > 1 && (
          <button type="button" className="suggestion-reject-all" onClick={() => suggestions.forEach((entry) => onReject(entry.id))}>
            Reject all
          </button>
        )}
      </div>
      <div className="stack">
        {[...suggestions]
          .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
          .map((suggestion) => (
            <div
              key={suggestion.id}
              role="group"
              aria-label={`Suggestion by AI agent ${suggestion.agent} on page ${String(suggestion.page)}: ${suggestion.note ?? suggestion.quote ?? ""}`}
              className={`suggestion-card ${selectedId === suggestion.id ? "active" : ""}`}
            >
              <button type="button" className="comment-row" onClick={() => onSelectPage(suggestion.page)}>
                <strong>
                  Page {suggestion.page} · {suggestion.note === null ? "Highlight" : suggestion.quote === null ? "Note" : "Comment"}
                </strong>
                <AgentBadge origin={{ agent: suggestion.agent }} />
                {suggestion.quote !== null && <q>{suggestion.quote}</q>}
                {suggestion.note !== null && <span>{suggestion.note}</span>}
              </button>
              <div className="comment-card-actions">
                <button type="button" onClick={() => onAccept(suggestion.id)}>
                  Accept
                </button>
                <button type="button" onClick={() => onReject(suggestion.id)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
