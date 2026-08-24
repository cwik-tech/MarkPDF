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

/**
 * The consent record: which directories may be read, and which written.
 *
 * Beside the index rather than inside it, so that withdrawing consent by deleting the index does
 * not also silently withdraw the grants that made it possible — and so that a corrupt database
 * cannot take the record of what someone permitted down with it.
 */
export function allowlistPath(dataDir: string): string {
  return join(dataDir, "consent", "allowlist.json");
}

/**
 * Where each open window records the documents it is showing.
 *
 * A directory rather than a file, because every window writes its own and nothing arbitrates
 * between them: one writer per file means there is no lost update to prevent and no lock to take.
 *
 * Beside the index and the consent record rather than inside either. This is the most volatile
 * state the application shares — it changes when somebody clicks a tab — and neither the durable
 * index nor the record of what a person has permitted should be rewritten at that rate, or be
 * emptied when this is.
 */
export function openDocumentsDir(dataDir: string): string {
  return join(dataDir, "session", "open-documents");
}

/** Private, bounded Markdown buffers kept separately from open-tab metadata. */
export function openDocumentContentDir(dataDir: string): string {
  return join(openDocumentsDir(dataDir), "content");
}

/** Transformers.js `env.cacheDir`. One download serves both the app and the CLI. */
export function modelCacheDir(dataDir: string): string {
  return join(dataDir, "models");
}
