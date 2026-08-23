import { describe, expect, it } from "vitest";
import {
  isPointInsideDockStrip,
  resolveDockHoverStrip,
} from "./dockHover.js";
import {
  PAGE_TURN_AT_REST,
  PAGE_TURN_SETTINGS,
  advancePageTurn,
  createPageTurnRenderer,
  pageTurnFrameIndex,
} from "./dockPageTurn.js";

const settings = PAGE_TURN_SETTINGS;

function buildBookTile(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const across = (x + 0.5) / size;
      const down = (y + 0.5) / size;
      const rightPage =
        across > 0.52 && across < 0.75 && down > 0.28 && down < 0.62;
      const leftPage =
        across > 0.25 && across < 0.44 && down > 0.28 && down < 0.62;
      const offset = (y * size + x) * 4;
      const page = rightPage || leftPage;
      pixels[offset] = page ? 255 : 194;
      pixels[offset + 1] = page ? 255 : 36;
      pixels[offset + 2] = page ? 255 : 34;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

describe("advancePageTurn", () => {
  it("stays at rest while the pointer is away from the Dock", () => {
    const state = advancePageTurn(PAGE_TURN_AT_REST, {
      elapsedSeconds: 0.05,
      pointerOver: false,
      settings,
    });
    expect(state).toEqual(PAGE_TURN_AT_REST);
  });

  it("starts turning when the pointer reaches the Dock", () => {
    const state = advancePageTurn(PAGE_TURN_AT_REST, {
      elapsedSeconds: 0.05,
      pointerOver: true,
      settings,
    });
    expect(state.playing).toBe(true);
    expect(state.phase).toBeCloseTo(0.05 / settings.loopSeconds);
  });

  it("keeps turning pages while the pointer stays, wrapping at the seam", () => {
    const state = advancePageTurn(
      { playing: true, phase: 0.98 },
      { elapsedSeconds: settings.loopSeconds * 0.05, pointerOver: true, settings },
    );
    expect(state.playing).toBe(true);
    expect(state.phase).toBeCloseTo(0.03);
  });

  it("finishes the turn after the pointer leaves and stops on the resting icon", () => {
    const midTurn = { playing: true, phase: 0.5 };
    const settling = advancePageTurn(midTurn, {
      elapsedSeconds: 0.1,
      pointerOver: false,
      settings,
    });
    expect(settling.playing).toBe(true);
    expect(settling.phase).toBeGreaterThan(0.5);

    const settled = advancePageTurn(midTurn, {
      elapsedSeconds: settings.loopSeconds,
      pointerOver: false,
      settings,
    });
    expect(settled).toEqual(PAGE_TURN_AT_REST);
  });

  it("shows frame zero whenever playback is at rest", () => {
    expect(pageTurnFrameIndex(PAGE_TURN_AT_REST, 48)).toBe(0);
  });
});

describe("createPageTurnRenderer", () => {
  const size = 96;
  const source = buildBookTile(size);
  const renderer = createPageTurnRenderer({ source, size });

  it("leaves frame zero as the shipped icon so the loop closes", () => {
    expect(Array.from(renderer.renderFrame(0))).toEqual(Array.from(source));
  });

  it("carries a page across the spine into the left half", () => {
    const frame = renderer.renderFrame(Math.round(renderer.frameCount * 0.6));
    const row = Math.round(size * 0.45);
    // A column that is bare cover at rest, between the left page and the spine.
    const column = Math.round(size * 0.46);
    const offset = (row * size + column) * 4;
    expect(source[offset + 1]).toBe(36);
    expect(frame[offset + 1]).toBeGreaterThan(150);
  });

  it("shades the page while it is lifted and returns it to white on landing", () => {
    const row = Math.round(size * 0.45);
    const column = Math.round(size * 0.4);
    const offset = (row * size + column) * 4;
    const lifted = renderer.renderFrame(Math.round(renderer.frameCount * 0.7));
    const landed = renderer.renderFrame(renderer.frameCount - 1);
    expect(lifted[offset]).toBeLessThan(240);
    expect(landed[offset]).toBeGreaterThan(240);
  });

  it("reveals the cover behind the page as it lifts away", () => {
    const row = Math.round(size * 0.45);
    // Near the right page's outer edge, which the page clears early in its turn.
    const column = Math.round(size * 0.7);
    const offset = (row * size + column) * 4;
    expect(source[offset + 1]).toBe(255);

    const lifting = renderer.renderFrame(Math.round(renderer.frameCount * 0.35));
    expect(lifting[offset + 1]).toBeLessThan(80);

    // ...and the page underneath has settled back into it by the end.
    const settled = renderer.renderFrame(renderer.frameCount - 1);
    expect(settled[offset + 1]).toBeGreaterThan(200);
  });
});

describe("resolveDockHoverStrip", () => {
  const bounds = { x: 0, y: 0, width: 1440, height: 900 };

  it("finds the strip the Dock reserves along the bottom edge", () => {
    const strip = resolveDockHoverStrip({
      bounds,
      workArea: { x: 0, y: 25, width: 1440, height: 795 },
    });
    expect(strip).toEqual({ x: 0, y: 820, width: 1440, height: 80 });
    expect(isPointInsideDockStrip({ x: 700, y: 860 }, strip)).toBe(true);
    expect(isPointInsideDockStrip({ x: 700, y: 500 }, strip)).toBe(false);
  });

  it("finds the strip when the Dock sits on the left edge", () => {
    const strip = resolveDockHoverStrip({
      bounds,
      workArea: { x: 70, y: 25, width: 1370, height: 875 },
    });
    expect(strip).toEqual({ x: 0, y: 25, width: 70, height: 875 });
  });

  it("falls back to a thin bottom band when the Dock is hidden", () => {
    const strip = resolveDockHoverStrip({
      bounds,
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    });
    expect(strip.height).toBe(4);
    expect(isPointInsideDockStrip({ x: 700, y: 899 }, strip)).toBe(true);
  });
});
