/**
 * Wires the page-turn loop to the real macOS Dock tile.
 *
 * Frames are rendered on demand and cached, so the first pass over the Dock
 * pays for the frames it uses instead of stalling launch. The timer polls the
 * cursor slowly while the icon rests and at the loop's frame rate while a page
 * is turning.
 */
import { app, nativeImage, screen, type NativeImage } from "electron";
import { existsSync } from "node:fs";
import { createDockPageTurnController } from "./dockHover.js";
import {
  PAGE_TURN_FRAMES_PER_SECOND,
  PAGE_TURN_SETTINGS,
  createPageTurnRenderer,
} from "./dockPageTurn.js";

/** 128pt at 2x, the largest tile macOS draws at full magnification. */
const DOCK_TILE_PIXELS = 256;
const DOCK_TILE_SCALE_FACTOR = 2;
const FRAME_INTERVAL_MS = Math.round(1000 / PAGE_TURN_FRAMES_PER_SECOND);
const RESTING_POLL_INTERVAL_MS = 150;
/** A tick delayed past this (a sleeping machine, a busy main process) restarts the clock. */
const MAXIMUM_TICK_SECONDS = 0.25;

export function startDockPageTurn(iconPath: string): () => void {
  const dock = app.dock;
  if (process.platform !== "darwin" || !dock) return () => {};
  if (!existsSync(iconPath)) return () => {};

  const resting = nativeImage.createFromPath(iconPath);
  if (resting.isEmpty()) return () => {};

  // Shrink first: the renderer resamples with a bilinear filter, which is a
  // poor way to reduce a 1024px icon on its own.
  const tile = resting.resize({
    width: DOCK_TILE_PIXELS,
    height: DOCK_TILE_PIXELS,
    quality: "best",
  });
  const renderer = createPageTurnRenderer({
    source: tile.toBitmap(),
    size: DOCK_TILE_PIXELS,
    settings: PAGE_TURN_SETTINGS,
  });

  const cache = new Map<number, NativeImage>();
  const frameImage = (frameIndex: number): NativeImage => {
    const cached = cache.get(frameIndex);
    if (cached) return cached;
    const pixels = renderer.renderFrame(frameIndex);
    // createFromBuffer would try to decode PNG or JPEG first; createFromBitmap
    // is the documented counterpart to toBitmap().
    const image = nativeImage.createFromBitmap(Buffer.from(pixels.buffer), {
      width: DOCK_TILE_PIXELS,
      height: DOCK_TILE_PIXELS,
      scaleFactor: DOCK_TILE_SCALE_FACTOR,
    });
    cache.set(frameIndex, image);
    return image;
  };

  const controller = createDockPageTurnController({
    frameCount: renderer.frameCount,
    settings: PAGE_TURN_SETTINGS,
    host: {
      getCursorPoint: () => screen.getCursorScreenPoint(),
      getDisplayMetrics: (point) => {
        const display = screen.getDisplayNearestPoint(point);
        return { bounds: display.bounds, workArea: display.workArea };
      },
      showFrame: (frameIndex) => dock.setIcon(frameImage(frameIndex)),
      showRestingIcon: () => dock.setIcon(resting),
    },
  });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastTickAt = Date.now();

  const schedule = () => {
    if (stopped) return;
    const delay = controller.state.playing
      ? FRAME_INTERVAL_MS
      : RESTING_POLL_INTERVAL_MS;
    timer = setTimeout(() => {
      const now = Date.now();
      const elapsedSeconds = Math.min(
        (now - lastTickAt) / 1000,
        MAXIMUM_TICK_SECONDS,
      );
      lastTickAt = now;
      try {
        controller.tick(elapsedSeconds);
      } catch (error) {
        // A decorative animation must never take the main process down with it.
        console.error("Dock page-turn animation stopped", error);
        stopped = true;
        return;
      }
      schedule();
    }, delay);
  };

  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    dock.setIcon(resting);
  };
}
