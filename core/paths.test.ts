import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { appDirectoryName, resolveDataDir, semanticIndexPath, modelCacheDir } from "./paths.js";

describe("core data directory resolution", () => {
  it("names the application directory exactly as Electron does, in lower case", () => {
    // electron-builder strips `build` from the packaged package.json without injecting
    // productName, so app.getName() returns package.json "name". Verified on disk: the
    // canonical directory is lower-case `markpdf`. A wrong guess silently produces an
    // empty index on a case-sensitive volume.
    expect(appDirectoryName).toBe("markpdf");
  });

  it("prefers an explicit directory over the environment and the platform default", () => {
    expect(resolveDataDir("/tmp/explicit", { MARKPDF_DATA_DIR: "/tmp/from-env" })).toBe("/tmp/explicit");
  });

  it("falls back to MARKPDF_DATA_DIR when no explicit directory is given", () => {
    expect(resolveDataDir(undefined, { MARKPDF_DATA_DIR: "/tmp/from-env" })).toBe("/tmp/from-env");
  });

  it("keeps the index at the path the sql.js build already uses, so migration is in place", () => {
    expect(semanticIndexPath("/data")).toBe(join("/data", "semantic-search", "semantic-index.sqlite"));
  });

  it("places the model cache beside the index so the app and the CLI share one download", () => {
    expect(modelCacheDir("/data")).toBe(join("/data", "models"));
  });
});
