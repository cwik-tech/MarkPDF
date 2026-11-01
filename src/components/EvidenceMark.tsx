import { useEffect, useRef } from "react";
import type { EvidenceReveal } from "../types";

/**
 * The passage an agent asked the window to show, marked over the page for a few seconds.
 *
 * Drawn in the overlay layer, so it sits on the same lines the text does at any zoom and rotation,
 * but it is not an overlay: it cannot be selected, it is never saved, and it takes no clicks — the
 * reader can select the very words it marks. The label names the agent, because a mark that
 * appeared from nowhere would read as something the document itself contains.
 *
 * The first rectangle is brought into the document pane's own view. Only the pane scrolls, so the
 * window around it stays where the reader left it.
 */
export function EvidenceMark({ reveal, zoom }: { reveal: EvidenceReveal; zoom: number }) {
  const firstRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const first = firstRef.current;
    if (first === null) return;
    const frame = window.requestAnimationFrame(() => {
      const pane = first.closest(".document-scroll");
      if (!(pane instanceof HTMLElement)) return;
      const markBox = first.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      if (markBox.top >= paneBox.top && markBox.bottom <= paneBox.bottom) return;
      pane.scrollBy({ top: markBox.top - paneBox.top - paneBox.height / 3, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reveal.id]);

  return (
    <div className="evidence-marks" aria-hidden="true">
      {reveal.rects.map((rect, index) => (
        <div
          key={`${reveal.id}-${String(index)}`}
          ref={index === 0 ? firstRef : undefined}
          className="evidence-mark"
          data-testid="evidence-mark"
          style={{ left: rect.x * zoom, top: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }}
        />
      ))}
      {reveal.rects[0] !== undefined && (
        <span
          className="evidence-label"
          style={{ left: reveal.rects[0].x * zoom, top: Math.max(0, reveal.rects[0].y * zoom - 22) }}
        >
          {reveal.label}
        </span>
      )}
    </div>
  );
}
