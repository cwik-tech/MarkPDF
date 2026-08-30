export interface QuitState {
  readonly explicitQuitRequested: boolean;
}

export function createQuitState(): QuitState {
  return { explicitQuitRequested: false };
}

export function recordQuitRequest(_state: QuitState): QuitState {
  return { explicitQuitRequested: true };
}

export function recordQuitCancellation(_state: QuitState): QuitState {
  return { explicitQuitRequested: false };
}

/** Decide whether the last closed window should complete process shutdown. */
export function shouldQuitAfterLastWindow(
  platform: NodeJS.Platform,
  state: QuitState,
): boolean {
  return platform !== "darwin" || state.explicitQuitRequested;
}
