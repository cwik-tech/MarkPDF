import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The application data directory name.
 *
 * electron-builder strips the `build` block from the packaged package.json without injecting
 * `productName`, so `app.getName()` returns the package.json `name` field. Verified against
 * the live install: the canonical directory is lower-case `markpdf`. Both spellings appear to
 * work on macOS only because APFS is case-insensitive; on a case-sensitive volume a wrong
 * guess silently produces an empty index rather than an error.
 */
export const appDirectoryName = "markpdf";

/**
 * Resolve the directory holding the index and the model cache.
 *
 * `electron/` always passes `app.getPath("userData")` explicitly, so the app and the platform
 * fallback below cannot drift apart. The fallback exists for plain-Node callers, which have no
 * Electron to ask.
 */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return explicit;
  const fromEnv = env.MARKPDF_DATA_DIR;
  if (fromEnv) return fromEnv;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", appDirectoryName);
  }
  if (process.platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), appDirectoryName);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), appDirectoryName);
}

/**
 * The index file. This path is byte-identical to the one the sql.js build already writes
 * (electron/semantic.ts), which is what makes the schema migration an in-place upgrade of the
 * user's existing database rather than a new file beside an abandoned one.
 */
export function semanticIndexPath(dataDir: string): string {
  return join(dataDir, "semantic-search", "semantic-index.sqlite");
}

/** Transformers.js `env.cacheDir`. One download serves both the app and the CLI. */
export function modelCacheDir(dataDir: string): string {
  return join(dataDir, "models");
}
