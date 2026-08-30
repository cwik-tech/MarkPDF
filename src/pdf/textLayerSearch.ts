/**
 * Finding a phrase in a rendered PDF.js text layer, and measuring where it is.
 *
 * Two halves, kept apart on purpose. The arithmetic — joining a page's drawn runs into one
 * searchable string, deciding which occurrence the reader meant, and splitting that occurrence back
 * across the runs it crosses — is pure and is covered by `textLayerSearch.test.ts`. The measuring
 * half asks the browser for the rectangles of a real DOM range, which no unit test can answer
 * without a rendered page; it is covered by `tests/e2e/pdf-native-navigation.spec.ts`.
 *
 * **Why leaf runs rather than every span.** In a tagged PDF, PDF.js nests each drawn run inside a
 * `.markedContent` wrapper that carries no glyphs of its own but repeats its children's text. Taking
 * every `span` therefore indexes the same words twice and can address a wrapper that has no position
 * of its own, which is how a highlight ends up at the page's top-left corner.
 */

/** Which drawn run a character came from, and where inside that run it sits. */
export interface LeafPosition {
  leaf: number;
  offset: number;
}

/**
 * A page's text as one string, with a per-character map back to the run that drew it.
 *
 * `positions[i]` is `null` for a character this index inserted itself — the separator between two
 * runs — because such a character belongs to no run and must never be measured.
 */
export interface LeafSearchIndex {
  text: string;
  positions: (LeafPosition | null)[];
}

/** A box in the highlight layer's own coordinates: pixels from its top-left corner. */
export interface LayerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The part of one drawn run a match covers, as offsets into that run's text. */
export interface LeafMatchRange {
  leaf: number;
  start: number;
  end: number;
}

/**
 * Build the searchable string for a page's drawn runs.
 *
 * `separateLeaves` produces the reading a human sees, with a space between runs. Omitting it
 * produces the reading needed when the drawing operators split a single word across two runs, which
 * a space between them would hide. Callers try both, in that order.
 *
 * Whitespace is normalised as it is appended: a run of spaces, tabs and newlines becomes one space,
 * so a phrase broken over a line break still matches the phrase a reader typed.
 */
export function buildLeafSearchIndex(
  leaves: readonly string[],
  separateLeaves: boolean,
): LeafSearchIndex {
  const characters: string[] = [];
  const positions: (LeafPosition | null)[] = [];

  const append = (character: string, position: LeafPosition | null): void => {
    if (/\s/.test(character)) {
      if (characters.length > 0 && characters[characters.length - 1] !== " ") {
        characters.push(" ");
        positions.push(position);
      }
      return;
    }
    characters.push(character);
    positions.push(position);
  };

  leaves.forEach((text, leaf) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      // `charAt` rather than an index: it is typed as a string at every position, so the loop needs
      // no assertion about a bound it has already checked.
      append(text.charAt(offset), { leaf, offset });
    }
    if (separateLeaves && leaf < leaves.length - 1) append(" ", null);
  });

  while (characters[characters.length - 1] === " ") {
    characters.pop();
    positions.pop();
  }

  return { text: characters.join(""), positions };
}

/** Where the `ordinal`-th non-overlapping occurrence starts, or -1 when there are fewer. */
export function findNthOccurrence(text: string, query: string, ordinal: number): number {
  if (query.length === 0 || ordinal < 0) return -1;
  let index = -1;
  let from = 0;
  for (let count = 0; count <= ordinal; count += 1) {
    index = text.indexOf(query, from);
    if (index < 0) return -1;
    from = index + query.length;
  }
  return index;
}

/**
 * Which occurrence in this layer the reader is looking at.
 *
 * The page search and the text layer come from two different PDF.js calls over the same page, so an
 * offset measured in one can be a character or two out in the other. The reported offset is
 * therefore trusted only while it still spells the query; after that the ordinal — which occurrence
 * on this page the reader stepped to — is the durable identity, and the first occurrence is the last
 * resort.
 */
export function locateMatch(
  index: LeafSearchIndex,
  normalizedQuery: string,
  preferredStart: number,
  ordinal: number,
): { start: number } | null {
  if (normalizedQuery.length === 0) return null;
  const lower = index.text.toLowerCase();

  if (lower.slice(preferredStart, preferredStart + normalizedQuery.length) === normalizedQuery) {
    return { start: preferredStart };
  }

  const byOrdinal = findNthOccurrence(lower, normalizedQuery, ordinal);
  if (byOrdinal >= 0) return { start: byOrdinal };

  const first = lower.indexOf(normalizedQuery);
  return first >= 0 ? { start: first } : null;
}

/**
 * Split a match into the parts of each run it covers, in run order.
 *
 * Separator characters are skipped: they were inserted between runs and have no glyphs, so asking
 * the browser to measure one would produce a rectangle over nothing.
 */
export function matchRangesByLeaf(
  index: LeafSearchIndex,
  start: number,
  end: number,
): LeafMatchRange[] {
  // Accumulated in place, in the order the runs are first met, so nothing has to be looked back up
  // afterwards. A map from run to range would need an assertion to read its own keys back.
  const ranges: LeafMatchRange[] = [];

  for (let position = start; position < end; position += 1) {
    const mapped = index.positions[position];
    if (mapped === null || mapped === undefined) continue;
    const existing = ranges.find((range) => range.leaf === mapped.leaf);
    if (existing === undefined) {
      ranges.push({ leaf: mapped.leaf, start: mapped.offset, end: mapped.offset + 1 });
      continue;
    }
    existing.start = Math.min(existing.start, mapped.offset);
    existing.end = Math.max(existing.end, mapped.offset + 1);
  }

  return ranges;
}

/**
 * Keep a measured box inside the page it belongs to.
 *
 * A rectangle that reached past the page edge would paint over the next page in a scrolling view.
 * A rectangle entirely outside is discarded rather than clamped to a sliver on the border, because
 * a sliver at the edge is indistinguishable from a real match there.
 */
export function clipRectToLayer(
  rect: LayerRect,
  layerWidth: number,
  layerHeight: number,
): LayerRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(layerWidth, rect.left + rect.width);
  const bottom = Math.min(layerHeight, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/* ------------------------------------------------------------------ *
 * The measuring half: what only a rendered page can answer.          *
 * ------------------------------------------------------------------ */

/**
 * The spans that actually carry glyphs.
 *
 * `.markedContent` wrappers are excluded: they exist to group a tagged document's structure and
 * generate no box of their own, so their text is their children's text said a second time. Spans the
 * recognition overlay adds carry no class and are kept, which is what lets a scanned page still be
 * searched.
 */
export function leafTextSpans(textLayer: Element): HTMLSpanElement[] {
  return Array.from(textLayer.querySelectorAll<HTMLSpanElement>("span:not(.markedContent)"));
}

/** The text nodes of one run, in order, so an offset can be turned into a DOM position. */
function textNodesOf(span: Element): Text[] {
  const nodes: Text[] = [];
  for (const child of Array.from(span.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) nodes.push(child as Text);
  }
  return nodes;
}

/**
 * The rectangles the browser draws for part of one run's text.
 *
 * This is the whole point of the module. Estimating a partial match as a proportion of the run's
 * width assumes every glyph is the same width, which is false for every proportional font, and gets
 * worse the longer the run. `Range.getClientRects` is what the browser itself uses to paint a
 * selection, so it is the same geometry the reader would get by dragging over the word.
 */
function rangeRects(span: Element, start: number, end: number): DOMRect[] {
  const nodes = textNodesOf(span);
  if (nodes.length === 0) return [];

  const range = document.createRange();
  let consumed = 0;
  let startSet = false;

  for (const node of nodes) {
    const length = node.data.length;
    if (!startSet && start <= consumed + length) {
      range.setStart(node, Math.max(0, Math.min(length, start - consumed)));
      startSet = true;
    }
    if (startSet && end <= consumed + length) {
      range.setEnd(node, Math.max(0, Math.min(length, end - consumed)));
      return Array.from(range.getClientRects());
    }
    consumed += length;
  }

  if (!startSet) return [];
  const last = nodes.at(-1);
  if (last === undefined) return [];
  range.setEnd(last, last.data.length);
  return Array.from(range.getClientRects());
}

/**
 * Turn a located match into highlight-layer boxes.
 *
 * One box per line the match occupies, because a match that wraps is two rectangles on screen and
 * one box spanning both would cover the text between them.
 */
export function rectsForMatch(
  spans: readonly HTMLSpanElement[],
  ranges: readonly LeafMatchRange[],
  layerRect: DOMRect,
): LayerRect[] {
  const rects: LayerRect[] = [];
  for (const range of ranges) {
    const span = spans[range.leaf];
    if (span === undefined) continue;
    for (const rect of rangeRects(span, range.start, range.end)) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const clipped = clipRectToLayer(
        {
          left: rect.left - layerRect.left,
          top: rect.top - layerRect.top,
          width: rect.width,
          height: rect.height,
        },
        layerRect.width,
        layerRect.height,
      );
      if (clipped !== null) rects.push(clipped);
    }
  }
  return rects;
}
