/**
 * Whether to install the command somewhere other than where it belongs.
 *
 * This exists for one reason: an Electron journey has to click the real Install button, through
 * the real preload bridge and the real IPC handler, and see a real file appear — without writing
 * into the machine's `/usr/local/bin` or the developer's `~/.local/bin`.
 *
 * The guard is the same shape as `shouldUseDeterministicEmbedder`, and deliberately strict about
 * the flag's *value* rather than its presence, because the failure being prevented is a shipped
 * application quietly installing its command somewhere nobody asked for. All three must hold:
 *
 *   1. the application is not packaged — a released build can never take this path;
 *   2. the flag equals the exact opt-in token, so a stray truthy value cannot select it;
 *   3. a test user-data directory is set, so the run is already isolated from a real profile.
 *
 * And the directory itself must be absolute, so an empty or relative value cannot resolve against
 * whatever the process happened to be launched from. No IPC channel and no persisted setting
 * reaches this function.
 */
export const TEST_INSTALL_DIRECTORY_TOKEN = "test-install-directory";

export interface InstallDirectoryInput {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}

export function testInstallDirectory(input: InstallDirectoryInput): string | null {
  if (input.isPackaged) return null;
  if (input.env.MARKPDF_E2E_CLI_INSTALL !== TEST_INSTALL_DIRECTORY_TOKEN) return null;
  const testUserData = input.env.MARKPDF_TEST_USER_DATA;
  if (typeof testUserData !== "string" || testUserData.length === 0) return null;
  const directory = input.env.MARKPDF_TEST_CLI_INSTALL_DIR;
  if (typeof directory !== "string" || !directory.startsWith("/")) return null;
  return directory;
}
