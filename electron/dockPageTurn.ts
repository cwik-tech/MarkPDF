/**
 * Page-turn animation for the Dock icon.
 *
 * The artwork is never redrawn. Each frame lifts the right-hand page out of the
 * shipped icon, sweeps it across the spine and lays it on the left-hand page, so
 * the Dock tile animates without shipping a second image.
 *
 * Two properties make the loop usable as an icon. The travelling page starts
 * exactly on top of the page it was copied from and ends exactly on top of the
 * left page, and it fades in and out across those two moments. Frame zero is
 * therefore the untouched icon, and the step from the last frame back to it
 * carries the same velocity as any other step, so the loop can start and stop
 * without a visible jump and never stalls at the seam.
 */

export interface PageTurnSettings {
  /** Seconds for one page to travel from the right side of the book to the left. */
  readonly loopSeconds: number;
  /** The spine, as a fraction of the tile. The page pivots about this line. */
  readonly spineX: number;
  /** Outer edge of the right-hand page, as a fraction of the tile. */
  readonly pageEdgeX: number;
  /** Top of the right-hand page, as a fraction of the tile. */
  readonly pageTopY: number;
  /** Bottom of the right-hand page, as a fraction of the tile. */
  readonly pageBottomY: number;
  /** Lift of the page's free edge at mid-turn, as a percentage of the tile. */
  readonly archPercent: number;
  /** How far the page darkens as it stands on edge, as a percentage. */
  readonly shadePercent: number;
}

/**
 * Measured off build/icon.png: the spine sits on the tile's centre line, and
 * the right-hand page runs from it out to 0.752 between 0.26 and 0.70 down.
 * The bounds are a little wider so antialiased edges travel with the page, and
 * the bottom stops short of the white cover strip underneath the pages.
 */
export const PAGE_TURN_SETTINGS: PageTurnSettings = {
  loopSeconds: 2.4,
  spineX: 0.5,
  pageEdgeX: 0.764,
  pageTopY: 0.235,
  pageBottomY: 0.668,
  archPercent: 3,
  shadePercent: 42,
};

/**
 * The Dock repaints through inter-process messages, which caps a Dock tile at
 * roughly twenty updates per second.
 */
export const PAGE_TURN_FRAMES_PER_SECOND = 20;

/** How much faster the turn finishes once the pointer leaves the Dock. */
export const PAGE_TURN_SETTLE_RATE = 2;

/** Share of the loop spent fading the page off its old and onto its new stack. */
const SETTLE_FADE = 0.12;
/** Extra darkening towards the page's free edge while it is lifted. */
const EDGE_SHADE = 0.18;
/** A darker band along the free edge, so the page keeps an outline over the stack it lands on. */
const FREE_EDGE_LINE = 0.34;
const FREE_EDGE_LINE_START = 0.86;
/**
 * Where the cover shows through once the page has lifted off it, and when the
 * page underneath rises to take its place. The gap opens as the page peels away
 * and closes again while the page is settling on the left, which is what lets a
 * one-way movement loop back to the icon it started from.
 */
const COVER_RESTORE_START = 0.62;
const COVER_RESTORE_END = 1;
/** Width in pixels over which the lifted edge hands the cover its colour. */
const LIFTED_EDGE_SOFTNESS = 0.75;
/** Fraction of the tile over which the page's bottom bound fades out. */
const BOTTOM_FEATHER = 0.045;
/** Luminance band that separates the white pages from the red cover. */
const PAGE_WHITE_LOW = 0.25;
const PAGE_WHITE_HIGH = 0.8;
/** Below this width the page stands on edge and there is nothing left to draw. */
const MINIMUM_PAGE_PIXELS = 0.5;
/** Cap on the samples taken per pixel while the page is steeply foreshortened. */
const MAXIMUM_SAMPLES = 8;

export interface PageTurnPlaybackState {
  readonly playing: boolean;
  /** Position within the loop, from zero up to but not including one. */
  readonly phase: number;
}

export const PAGE_TURN_AT_REST: PageTurnPlaybackState = {
  playing: false,
  phase: 0,
};

export interface PageTurnAdvance {
  readonly elapsedSeconds: number;
  readonly pointerOver: boolean;
  readonly settings: PageTurnSettings;
}

export function pageTurnFrameCount(settings: PageTurnSettings): number {
  return Math.max(
    1,
    Math.round(settings.loopSeconds * PAGE_TURN_FRAMES_PER_SECOND),
  );
}

export function pageTurnFrameIndex(
  state: PageTurnPlaybackState,
  frameCount: number,
): number {
  if (!state.playing || frameCount <= 0) return 0;
  const index = Math.floor(state.phase * frameCount);
  return ((index % frameCount) + frameCount) % frameCount;
}

/**
 * Moves playback forward. While the pointer is over the Dock the page turns at
 * its natural rate. Once the pointer leaves, the page finishes its turn at
 * `PAGE_TURN_SETTLE_RATE` and stops the moment it reaches frame zero, which is
 * the resting icon, so the animation never freezes mid-turn.
 */
export function advancePageTurn(
  state: PageTurnPlaybackState,
  advance: PageTurnAdvance,
): PageTurnPlaybackState {
  const { elapsedSeconds, pointerOver, settings } = advance;
  if (!state.playing && !pointerOver) return PAGE_TURN_AT_REST;
  if (settings.loopSeconds <= 0) return PAGE_TURN_AT_REST;

  const rate = pointerOver ? 1 : PAGE_TURN_SETTLE_RATE;
  const phase = state.phase + (elapsedSeconds / settings.loopSeconds) * rate;
  if (phase >= 1 && !pointerOver) return PAGE_TURN_AT_REST;
  return { playing: true, phase: phase - Math.floor(phase) };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function readChannel(
  pixels: Uint8Array | Uint8ClampedArray,
  index: number,
): number {
  return pixels[index] ?? 0;
}

/**
 * Builds the page mask: how much of each source pixel belongs to the right-hand
 * page. The pages are the only white artwork in the icon, so their own colour
 * carries the outline, including the notch under the folded corner. Reading it
 * once keeps every frame down to a lookup.
 */
function buildPageMask(
  source: Uint8Array | Uint8ClampedArray,
  size: number,
  settings: PageTurnSettings,
): Float32Array {
  const mask = new Float32Array(size * size);
  const left = Math.max(0, Math.floor(settings.spineX * size));
  const right = Math.min(size - 1, Math.ceil(settings.pageEdgeX * size));
  const top = Math.max(0, Math.floor(settings.pageTopY * size));
  const bottom = Math.min(size - 1, Math.ceil(settings.pageBottomY * size));

  for (let y = top; y <= bottom; y += 1) {
    const down = (y + 0.5) / size;
    const bottomFade =
      1 -
      smoothstep(
        settings.pageBottomY - BOTTOM_FEATHER,
        settings.pageBottomY,
        down,
      );
    if (bottomFade <= 0) continue;

    for (let x = left; x <= right; x += 1) {
      const offset = (y * size + x) * 4;
      const alpha = readChannel(source, offset + 3) / 255;
      if (alpha <= 0) continue;
      const darkest =
        Math.min(
          readChannel(source, offset),
          readChannel(source, offset + 1),
          readChannel(source, offset + 2),
        ) / 255;
      const white = smoothstep(PAGE_WHITE_LOW, PAGE_WHITE_HIGH, darkest);
      mask[y * size + x] = white * alpha * bottomFade;
    }
  }

  return mask;
}

function samplePageMask(
  mask: Float32Array,
  size: number,
  sourceX: number,
  sourceY: number,
): number {
  if (sourceX < 0 || sourceY < 0 || sourceX > size - 1 || sourceY > size - 1) {
    return 0;
  }

  const left = Math.floor(sourceX);
  const top = Math.floor(sourceY);
  const right = Math.min(left + 1, size - 1);
  const bottom = Math.min(top + 1, size - 1);
  const fractionX = sourceX - left;
  const fractionY = sourceY - top;

  return (
    (mask[top * size + left] ?? 0) * (1 - fractionX) * (1 - fractionY) +
    (mask[top * size + right] ?? 0) * fractionX * (1 - fractionY) +
    (mask[bottom * size + left] ?? 0) * (1 - fractionX) * fractionY +
    (mask[bottom * size + right] ?? 0) * fractionX * fractionY
  );
}

/**
 * Reads the cover colour that sits behind the pages, one row at a time, out of
 * the gutter beside the spine. The icon's cover carries a vertical gradient, so
 * a single sampled colour would band against it.
 */
function buildCoverColumn(
  source: Uint8Array | Uint8ClampedArray,
  size: number,
  settings: PageTurnSettings,
): Uint8Array {
  const cover = new Uint8Array(size * 3);
  const from = Math.max(0, Math.round((settings.spineX - 0.008) * size));
  const to = Math.min(size - 1, Math.round((settings.spineX + 0.012) * size));

  for (let y = 0; y < size; y += 1) {
    for (let x = from; x <= to; x += 1) {
      const offset = (y * size + x) * 4;
      if (readChannel(source, offset + 3) < 255) continue;
      const darkest =
        Math.min(
          readChannel(source, offset),
          readChannel(source, offset + 1),
          readChannel(source, offset + 2),
        ) / 255;
      if (darkest > PAGE_WHITE_LOW) continue;
      cover[y * 3] = readChannel(source, offset);
      cover[y * 3 + 1] = readChannel(source, offset + 1);
      cover[y * 3 + 2] = readChannel(source, offset + 2);
      break;
    }
  }

  return cover;
}

export interface PageTurnRenderer {
  readonly frameCount: number;
  readonly size: number;
  renderFrame(frameIndex: number): Uint8ClampedArray;
}

export interface PageTurnRendererOptions {
  /** Square RGBA or BGRA pixels. Only the alpha channel's position matters. */
  readonly source: Uint8Array | Uint8ClampedArray;
  /** Width of the square source, which is also the width of every frame. */
  readonly size: number;
  readonly settings?: PageTurnSettings;
}

/**
 * Builds a renderer that reads the page out of the source once and reuses it
 * for every frame.
 *
 * The source should already be the size the frames are wanted at; resize it
 * with whatever the host platform provides rather than here.
 */
export function createPageTurnRenderer(
  options: PageTurnRendererOptions,
): PageTurnRenderer {
  const { source, size } = options;
  const settings = options.settings ?? PAGE_TURN_SETTINGS;
  const frameCount = pageTurnFrameCount(settings);
  const usable = size > 0 && source.length >= size * size * 4;
  const mask = usable
    ? buildPageMask(source, size, settings)
    : new Float32Array(0);
  const cover = usable
    ? buildCoverColumn(source, size, settings)
    : new Uint8Array(0);

  const spine = settings.spineX * size;
  const pageWidth = (settings.pageEdgeX - settings.spineX) * size;
  const arch = (settings.archPercent / 100) * size;
  const shadeDepth = settings.shadePercent / 100;
  const bandTop = Math.max(0, Math.floor(settings.pageTopY * size - arch - 1));
  const bandBottom = Math.min(
    size - 1,
    Math.ceil(settings.pageBottomY * size + 1),
  );
  const footprintLeft = Math.max(0, Math.floor(spine));
  const footprintRight = Math.min(size - 1, Math.ceil(spine + pageWidth));

  function renderFrame(frameIndex: number): Uint8ClampedArray {
    const output = new Uint8ClampedArray(
      Math.max(0, size) * Math.max(0, size) * 4,
    );
    if (!usable) return output;
    output.set(source.subarray(0, output.length));

    const position =
      (((frameIndex % frameCount) + frameCount) % frameCount) / frameCount;
    // Half a turn over the loop: the page leaves the right side flat, stands on
    // edge at the spine halfway through and arrives flat on the left.
    const turn = Math.PI * position;
    const flatness = Math.abs(Math.cos(turn));
    const lift = arch * Math.sin(turn);
    const swept = pageWidth * Math.cos(turn);

    // The cover shows through from the page's lifted edge outwards. The gap
    // closes again from the spine out, as the page underneath settles flat into
    // the space the turning page left.
    const settled =
      pageWidth * smoothstep(COVER_RESTORE_START, COVER_RESTORE_END, position);
    const liftedEdge = spine + Math.max(swept, settled);
    if (liftedEdge < spine + pageWidth) {
      for (let y = bandTop; y <= bandBottom; y += 1) {
        const coverRed = cover[y * 3] ?? 0;
        const coverGreen = cover[y * 3 + 1] ?? 0;
        const coverBlue = cover[y * 3 + 2] ?? 0;
        for (let x = footprintLeft; x <= footprintRight; x += 1) {
          const lifted = smoothstep(
            liftedEdge - LIFTED_EDGE_SOFTNESS,
            liftedEdge + LIFTED_EDGE_SOFTNESS,
            x + 0.5,
          );
          const amount = (mask[y * size + x] ?? 0) * lifted;
          if (amount <= 0) continue;
          const target = (y * size + x) * 4;
          output[target] =
            (output[target] ?? 0) * (1 - amount) + coverRed * amount;
          output[target + 1] =
            (output[target + 1] ?? 0) * (1 - amount) + coverGreen * amount;
          output[target + 2] =
            (output[target + 2] ?? 0) * (1 - amount) + coverBlue * amount;
        }
      }
    }

    // Subtracting the settled page at both ends is what closes the loop: at
    // position zero the page is still on its old stack, and at position one it
    // has already merged with the new one.
    const presence =
      smoothstep(0, SETTLE_FADE, position) *
      (1 - smoothstep(1 - SETTLE_FADE, 1, position));
    if (presence <= 0) return output;
    if (Math.abs(swept) < MINIMUM_PAGE_PIXELS) return output;

    const samples = Math.min(
      MAXIMUM_SAMPLES,
      Math.max(1, Math.ceil(1 / Math.max(flatness, 1e-6))),
    );
    const bandLeft = Math.max(0, Math.floor(Math.min(spine, spine + swept)));
    const bandRight = Math.min(
      size - 1,
      Math.ceil(Math.max(spine, spine + swept)),
    );

    for (let y = bandTop; y <= bandBottom; y += 1) {
      for (let x = bandLeft; x <= bandRight; x += 1) {
        const across = (x + 0.5 - spine) / swept;
        if (across < 0 || across > 1) continue;

        const sourceY = y + lift * across;
        let coverage = 0;
        for (let sample = 0; sample < samples; sample += 1) {
          const offset = (sample + 0.5) / samples - 0.5;
          const sampledAcross = (x + 0.5 + offset - spine) / swept;
          if (sampledAcross < 0 || sampledAcross > 1) continue;
          coverage += samplePageMask(
            mask,
            size,
            spine + sampledAcross * pageWidth,
            sourceY,
          );
        }

        const alpha = (coverage / samples) * presence;
        if (alpha <= 0) continue;

        const tilt = 1 - flatness;
        const shade =
          (1 - shadeDepth * tilt) *
          (1 - EDGE_SHADE * tilt * across) *
          (1 -
            FREE_EDGE_LINE * tilt * smoothstep(FREE_EDGE_LINE_START, 1, across));
        const value = 255 * shade;
        const target = (y * size + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          output[target + channel] =
            (output[target + channel] ?? 0) * (1 - alpha) + value * alpha;
        }
        output[target + 3] = Math.max(output[target + 3] ?? 0, 255 * alpha);
      }
    }

    return output;
  }

  return { frameCount, size, renderFrame };
}
