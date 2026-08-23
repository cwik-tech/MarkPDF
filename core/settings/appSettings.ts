import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingPathError } from "../consent/allowlist.js";
import { defaultSemanticSearchSettings, parseSemanticSettings, type SemanticSearchSettings } from "../ipc/settings.js";

export class AppSettingsError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, cause: unknown) {
    super(`Cannot read the application settings at ${path}: ${reason}`, { cause });
    this.name = "AppSettingsError";
    this.path = path;
  }
}

/**
 * Where electron-store keeps the application's settings.
 *
 * Its default is `<userData>/config.json`, and `resolveDataDir` returns that same directory.
 * Verified against the live install rather than inferred from the library's documentation.
 */
export function appSettingsPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

/**
 * The semantic settings the application is using, or the defaults.
 *
 * Read rather than assumed so that a document indexed from the command line lands in the same
 * scope the application would put it in. Chunk identity carries the chunking profile and the
 * stored vectors are keyed by model, so two different answers here mean each side re-doing the
 * other's work on every open.
 *
 * **A missing file, or one whose content is damaged, falls back to the defaults.** There is
 * nothing to honour in either case, and guessing widens nothing.
 *
 * **A file that exists and cannot be opened does not.** The settings are there and say
 * something; carrying on under different ones would index every document into a scope the
 * application then re-does, and the person would see nothing but repeated work.
 */
export function readSemanticSettings(dataDir: string): SemanticSearchSettings {
  const path = appSettingsPath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return defaultSemanticSearchSettings;
    throw new AppSettingsError(path, error instanceof Error ? error.message : String(error), error);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaultSemanticSearchSettings;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaultSemanticSearchSettings;
  const record: Record<string, unknown> = { ...raw };
  return parseSemanticSettings(record.semanticSearch);
}
