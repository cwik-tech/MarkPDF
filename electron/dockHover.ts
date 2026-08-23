/**
 * Dock hover detection and playback for the page-turn icon.
 *
 * macOS never tells an application that the pointer is over its own Dock tile,
 * and reading the tile's position means going through the accessibility API,
 * which needs a permission grant. The trigger used here is coarser and free:
 * the pointer is somewhere inside the Dock strip. The strip is the gap between
 * a display's full bounds and its work area, which the Dock creates by
 * reserving space along one edge.
 *
 * The host is injected rather than imported so this file stays free of the
 * `electron` module. dockIcon.ts supplies the real screen and Dock.
 */
import {
  PAGE_TURN_AT_REST,
  PAGE_TURN_SETTINGS,
  advancePageTurn,
  pageTurnFrameIndex,
  type PageTurnPlaybackState,
  type PageTurnSettings,
} from "./dockPageTurn.js";

export type DockRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DockPoint = {
  x: number;
  y: number;
};

export type DockDisplayMetrics = {
  bounds: DockRectangle;
  workArea: DockRectangle;
};

/**
 * An auto-hidden Dock reserves no space, so there is no gap to measure. A thin
 * band along the bottom edge stands in for it, which is also where the pointer
 * has to go to reveal it.
 */
export const HIDDEN_DOCK_BAND_POINTS = 4;

/**
 * Returns the region of the display that the Dock occupies. The top edge is
 * ignored because that gap is the menu bar, not the Dock.
 */
export function resolveDockHoverStrip(
  metrics: DockDisplayMetrics,
): DockRectangle {
  const { bounds, workArea } = metrics;
  const left = workArea.x - bounds.x;
  const right = bounds.x + bounds.width - (workArea.x + workArea.width);
  const bottom = bounds.y + bounds.height - (workArea.y + workArea.height);
  const widest = Math.max(left, right, bottom);

  if (widest <= 0) {
    return {
      x: bounds.x,
      y: bounds.y + bounds.height - HIDDEN_DOCK_BAND_POINTS,
      width: bounds.width,
      height: HIDDEN_DOCK_BAND_POINTS,
    };
  }

  if (widest === bottom) {
    return {
      x: bounds.x,
      y: workArea.y + workArea.height,
      width: bounds.width,
      height: bottom,
    };
  }

  if (widest === left) {
    return { x: bounds.x, y: workArea.y, width: left, height: workArea.height };
  }

  return {
    x: workArea.x + workArea.width,
    y: workArea.y,
    width: right,
    height: workArea.height,
  };
}

export function isPointInsideDockStrip(
  point: DockPoint,
  strip: DockRectangle,
): boolean {
  return (
    point.x >= strip.x &&
    point.x < strip.x + strip.width &&
    point.y >= strip.y &&
    point.y < strip.y + strip.height
  );
}

export type DockPageTurnHost = {
  getCursorPoint: () => DockPoint;
  getDisplayMetrics: (point: DockPoint) => DockDisplayMetrics;
  showFrame: (frameIndex: number) => void;
  showRestingIcon: () => void;
};

export type DockPageTurnControllerOptions = {
  host: DockPageTurnHost;
  frameCount: number;
  settings?: PageTurnSettings;
};

export type DockPageTurnController = {
  readonly state: PageTurnPlaybackState;
  tick: (elapsedSeconds: number) => void;
};

/**
 * Drives the Dock tile from the page-turn loop while the pointer sits inside
 * the Dock strip, and hands the tile back to the resting artwork the moment the
 * turn finishes after the pointer leaves.
 */
export function createDockPageTurnController(
  options: DockPageTurnControllerOptions,
): DockPageTurnController {
  const settings = options.settings ?? PAGE_TURN_SETTINGS;
  const { host, frameCount } = options;
  let state = PAGE_TURN_AT_REST;
  let shownFrame: number | undefined;

  return {
    get state() {
      return state;
    },
    tick(elapsedSeconds: number) {
      const point = host.getCursorPoint();
      const strip = resolveDockHoverStrip(host.getDisplayMetrics(point));
      const pointerOver = isPointInsideDockStrip(point, strip);

      const wasPlaying = state.playing;
      state = advancePageTurn(state, { elapsedSeconds, pointerOver, settings });

      if (!state.playing) {
        // Only reclaim the tile if this controller was the one animating it.
        if (wasPlaying) {
          shownFrame = undefined;
          host.showRestingIcon();
        }
        return;
      }

      const frameIndex = pageTurnFrameIndex(state, frameCount);
      if (frameIndex === shownFrame) return;
      shownFrame = frameIndex;
      host.showFrame(frameIndex);
    },
  };
}
