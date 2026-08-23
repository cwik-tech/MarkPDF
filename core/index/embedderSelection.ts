/**
 * Whether to substitute the deterministic embedder for the real model.
 *
 * This exists because the Electron acceptance journey must exercise the whole cross-process
 * path — renderer extraction, the preload bridge, the main-process handler, core, and a real
 * SQLite file — without pulling a 133 MB model on every run. `AGENTS.md:123` puts a real
 * external model in an opt-in check excluded from the default suite; this is the seam that
 * makes that possible while keeping the journey itself a required test.
 *
 * The guard is deliberately conjunctive and deliberately strict about the flag's *value*
 * rather than its presence, because the failure mode being prevented is a shipped application
 * silently indexing with meaningless vectors. All three conditions must hold:
 *
 *   1. the application is not packaged — a released build can never take this path;
 *   2. the flag equals the exact opt-in token, so a stray truthy value cannot select it;
 *   3. a test user-data directory is set, so it cannot touch a real user's index.
 *
 * No renderer IPC channel and no persisted setting reaches this function. The only inputs are
 * the packaging state and the process environment, neither of which the renderer controls.
 */
export const DETERMINISTIC_EMBEDDER_TOKEN = "deterministic";

export interface EmbedderSelectionInput {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}

export function shouldUseDeterministicEmbedder(input: EmbedderSelectionInput): boolean {
  if (input.isPackaged) return false;
  if (input.env.MARKPDF_E2E_EMBEDDER !== DETERMINISTIC_EMBEDDER_TOKEN) return false;
  const testUserData = input.env.MARKPDF_TEST_USER_DATA;
  if (typeof testUserData !== "string" || testUserData.length === 0) return false;
  return true;
}
