# An annotation made from a text selection stores the lines, not the box around them

## Status

Accepted.

## Context

MarkPDF gave a reader two ways to make a highlight or a comment. One is to place it: pick the tool
and drop a rectangle on the page. The other is to select text and take the action the popover
offers. Both produced the same record — an `OverlayItem` with `x`, `y`, `width` and `height` — and
that is where the defect lived.

`PdfPage`'s `mouseup` handler asked the browser for the selection's rectangles, which is one per
line the selection crosses, and immediately reduced them to the smallest box containing all of them.
A selection over two lines therefore became a single rectangle tall enough to include the blank band
between them, and everything downstream painted that band: the window's overlay layer, the flattened
and printed page, and the `Highlight` annotation's single `QuadPoints` quadrilateral, which is what
another PDF application draws from. The reported case was recognised text, where the overlay's line
spans sit even further apart than a native text layer's.

The geometry was correct at the moment it was measured. It was thrown away one line later, and no
layer below could recover it.

## Decision

Model the two shapes as different things, and decide which one an overlay has in exactly one place.

`src/pdf/overlayGeometry.ts` defines a discriminated `OverlayGeometry`: a `box` carrying only its
bounds, or a `textSelection` carrying bounds plus one `fragment` per rectangle the browser reported.
`overlayGeometry(overlay)` is the single function that sorts a stored overlay into one of them, and
`paintedPageRects(geometry)` is the single function every painter, baker and exporter asks for the
area to cover. Nothing else reads the distinction, and nothing reaches for the enclosing box by
habit.

Fragments are stored as offsets from the overlay's own corner rather than as page positions, so
dragging the annotation moves its lines with it and a resize scales them by the same factors as the
bounds. The enclosing box keeps exactly two jobs: placing the selection popover, and carrying the
group's own interactions — selection outline, drag, resize, delete.

`OverlayItem` gains one optional field, `fragments`. Its absence is meaningful: an overlay that has
none is the single box it has always been, which is what every overlay written before this change
is, and what every hand-placed overlay still is. `src/pdf/overlayMetadata.ts` validates the
persisted JSON field by field rather than casting it, and treats a fragment list that is damaged in
part as no fragment list at all, because half a selection painted is an annotation the reader never
made.

In an exported PDF a text-anchored annotation is text markup: one `Rect` for the enclosing box and
one `QuadPoints` quadrilateral per line. A comment made from a selection is markup too — the same
quadrilaterals, with the note as its `Contents` — because it is about that text. A comment dropped
on the page is still a `Text` note pinned to a point.

> **Learning note:** `Range.getClientRects` already answers the question correctly. The browser
> returns one rectangle per line precisely because a selection is not a rectangle, and the fix was
> to stop discarding that answer rather than to reconstruct it later.

## Consequences

- A highlight or comment made by selecting text covers each selected line and leaves the page
  between lines untouched, in the window, in a flattened or printed page, and in another PDF
  reader.
- Manually placed highlights, free-position comments, text boxes and signatures are unchanged: they
  carry no fragments and take the same path they always did.
- A document saved by an earlier version opens with its annotations exactly where they were.
- A document saved by this version is read by an earlier version as the enclosing box, because the
  older reader ignores the field it does not know. That is the previous behaviour, not a new
  failure.
- A comment anchored to text is no longer painted as a filled note box over the sentence it
  annotates when a page is flattened or printed. Its lines are highlighted and its text travels as
  the annotation's contents. Covering the annotated sentence with prose was the defect; the
  flattened page no longer shows the note's words.
- A bookmark made from a selection keeps no fragments. It is a pin beside the line rather than a
  shape over it.

## Alternatives considered

- **Keep one rectangle and clip it to the text underneath at paint time.** Rejected: it needs the
  rendered text layer, so a flattened export and another application's reader — neither of which
  has one — would still paint the band.
- **Store one overlay per selected line.** Rejected: the reader made one annotation, and splitting
  it would give one comment several pins, several undo entries and several things to delete.
- **Store fragments as absolute page positions.** Rejected: every drag would have to rewrite every
  fragment, and any path that moved the bounds without knowing about fragments would leave the
  paint behind.
- **Replace `x`, `y`, `width` and `height` with the geometry union on `OverlayItem`.** Rejected for
  this change: it rewrites every persisted record and every unrelated caller, for no behaviour the
  optional field does not already give.

## Verification

- `tests/e2e/text-selection-annotations.spec.ts` drives the real application twice — once over
  native text, once over recognised text on a page that is only a picture — and requires that every
  selected line is painted and the band between lines is not.
- `src/pdf/overlayGeometry.test.ts` covers the arithmetic the journeys cannot vary: clipping to the
  page, zoom independence, rotation, duplicate and zero-area rectangles, and the enclosing bounds.
- `src/pdf/overlayMetadata.test.ts` covers the persisted boundary, including an annotation saved
  before this field existed and a fragment list that cannot be trusted.
- `src/pdf/document.test.ts` covers the exported document: one quadrilateral per line, a
  selection-anchored comment as text markup carrying its note, a placed comment as a `Text` note, a
  flattened page that draws the lines and not the band, and a save-and-reopen round trip for both
  the old and the new metadata shape.
- Mutation proof: collapsing `textSelectionGeometry` back to a single bounds-sized fragment failed
  both Electron journeys; returning the enclosing box from `paintedPageRects` failed the multi-quad
  and flattening tests; restoring the unchecked metadata cast failed the validation tests. All three
  passed again once the implementation was restored.
