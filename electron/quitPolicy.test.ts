import { describe, expect, it } from "vitest";
import {
  createQuitState,
  recordQuitCancellation,
  recordQuitRequest,
  shouldQuitAfterLastWindow,
} from "./quitPolicy.js";

describe("closing the final Electron window", () => {
  it("finishes an explicit macOS quit after asynchronous window confirmation", () => {
    const state = recordQuitRequest(createQuitState());

    expect(shouldQuitAfterLastWindow("darwin", state)).toBe(true);
  });

  it("restores ordinary macOS window behavior when the user cancels Quit", () => {
    const requested = recordQuitRequest(createQuitState());
    const cancelled = recordQuitCancellation(requested);

    expect(shouldQuitAfterLastWindow("darwin", cancelled)).toBe(false);
  });

  it("keeps the existing quit-on-last-window behavior on other platforms", () => {
    const state = createQuitState();

    expect(shouldQuitAfterLastWindow("linux", state)).toBe(true);
    expect(shouldQuitAfterLastWindow("win32", state)).toBe(true);
  });
});
