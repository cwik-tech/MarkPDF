import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettingsError, readSemanticSettings } from "./appSettings.js";
import { defaultSemanticSearchSettings } from "../ipc/settings.js";

/**
 * The settings the application already wrote, read by anything else that shares its index.
 *
 * Verified against the live install on 2026-08-23: electron-store keeps them in
 * `<userData>/config.json` under `semanticSearch`, alongside `recentFiles`, `aiProviders`,
 * `localAgentEnabled` and `markdownExport`.
 *
 * This exists so the command line indexes into the *same* scope the application does. Chunk
 * identity includes the chunking profile and the vectors are keyed by model, so a command line
 * that assumed its own defaults would re-chunk and re-embed every document the application had
 * already done, and the application would then undo it.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-settings-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(value));
}

describe("reading the application's own settings", () => {
  it("uses the profile and model the application is configured with", () => {
    writeConfig({ semanticSearch: { chunkingProfile: "precise", activeModelId: "Xenova/all-MiniLM-L6-v2" } });

    const settings = readSemanticSettings(dataDir);

    expect(settings.chunkingProfile).toBe("precise");
    expect(settings.activeModelId).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("falls back to the defaults when the application has never been run", () => {
    expect(readSemanticSettings(dataDir)).toEqual(defaultSemanticSearchSettings);
  });

  it("falls back to the defaults rather than failing when the file is damaged", () => {
    writeFileSync(join(dataDir, "config.json"), "{ not json");

    expect(readSemanticSettings(dataDir)).toEqual(defaultSemanticSearchSettings);
  });

  it("ignores a value the application would itself reject", () => {
    writeConfig({ semanticSearch: { activeModelId: "some/model-nobody-curated" } });

    expect(readSemanticSettings(dataDir).activeModelId).toBe(defaultSemanticSearchSettings.activeModelId);
  });

  it("refuses to guess when the file is there and cannot be read", () => {
    // Damaged *content* is a reason to fall back: there is nothing to honour. A file the process
    // is not allowed to open is not — the settings exist, they say something, and indexing under
    // different ones would put every document in a scope the application then re-does.
    writeConfig({ semanticSearch: { chunkingProfile: "precise" } });
    chmodSync(join(dataDir, "config.json"), 0o000);

    try {
      expect(() => readSemanticSettings(dataDir)).toThrow(AppSettingsError);
      expect(() => readSemanticSettings(dataDir)).toThrow(join(dataDir, "config.json"));
    } finally {
      chmodSync(join(dataDir, "config.json"), 0o600);
    }
  });

  it("leaves the rest of the file alone, because it belongs to other features", () => {
    writeConfig({ recentFiles: ["/a.pdf"], semanticSearch: { chunkingProfile: "contextual" } });

    expect(readSemanticSettings(dataDir).chunkingProfile).toBe("contextual");
  });
});
