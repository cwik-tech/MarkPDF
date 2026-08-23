import { describe, expect, it } from "vitest";
import { parseSemanticSettings, parseSemanticSettingsPatch, parseCuratedModelId } from "./settings.js";
import { SemanticRequestError } from "./requests.js";

const VALID = {
  enabled: true,
  activeModelId: "Xenova/bge-small-en-v1.5",
  chunkingProfile: "balanced",
  minSemanticScore: 0.3,
  downloadedModelIds: ["Xenova/bge-small-en-v1.5"],
};

describe("reading persisted semantic settings", () => {
  it("accepts a well-formed record", () => {
    expect(parseSemanticSettings(VALID).activeModelId).toBe("Xenova/bge-small-en-v1.5");
  });

  it("falls back to defaults when the store holds something that is not a record", () => {
    // electron-store contents are external input: a corrupt or hand-edited config must not
    // crash the app, but it must not be trusted either.
    for (const bad of [null, undefined, "settings", 7, []]) {
      expect(parseSemanticSettings(bad).activeModelId).toBe("Xenova/bge-small-en-v1.5");
    }
  });

  it("replaces an active model that is not curated, rather than letting it reach the catalogue fallback", () => {
    // getCuratedEmbeddingModel silently returns the default for an unknown id, so an invalid
    // value would survive indefinitely while appearing to work.
    const parsed = parseSemanticSettings({ ...VALID, activeModelId: "evil/not-a-model" });
    expect(parsed.activeModelId).toBe("Xenova/bge-small-en-v1.5");
  });

  it("replaces an unknown chunking profile", () => {
    expect(parseSemanticSettings({ ...VALID, chunkingProfile: "gigantic" }).chunkingProfile).toBe("balanced");
  });

  it("clamps a score outside the supported range and rejects one that is not a number", () => {
    expect(parseSemanticSettings({ ...VALID, minSemanticScore: 5 }).minSemanticScore).toBe(0.95);
    expect(parseSemanticSettings({ ...VALID, minSemanticScore: -1 }).minSemanticScore).toBe(0);
    expect(parseSemanticSettings({ ...VALID, minSemanticScore: Number.NaN }).minSemanticScore).toBe(0.3);
    expect(parseSemanticSettings({ ...VALID, minSemanticScore: "0.5" }).minSemanticScore).toBe(0.3);
  });

  it("drops downloaded model entries that are not curated", () => {
    const parsed = parseSemanticSettings({
      ...VALID,
      downloadedModelIds: ["Xenova/bge-small-en-v1.5", "evil/not-a-model", 7, null],
    });
    expect(parsed.downloadedModelIds).toEqual(["Xenova/bge-small-en-v1.5"]);
  });

  it("requires enabled to be a boolean rather than any truthy value", () => {
    expect(parseSemanticSettings({ ...VALID, enabled: "yes" }).enabled).toBe(true);
    expect(parseSemanticSettings({ ...VALID, enabled: 0 }).enabled).toBe(true);
  });
});

describe("applying a settings patch from the renderer", () => {
  it("rejects a patch that is not an object", () => {
    expect(() => parseSemanticSettingsPatch("nope")).toThrow(/must be an object/);
  });

  it("rejects an unknown model rather than quietly ignoring it", () => {
    // Silently dropping it would leave the interface showing a selection that never took.
    expect(() => parseSemanticSettingsPatch({ activeModelId: "evil/not-a-model" })).toThrow(
      /not a curated embedding model/,
    );
  });

  it("rejects an unknown chunking profile", () => {
    expect(() => parseSemanticSettingsPatch({ chunkingProfile: "gigantic" })).toThrow(/precise, balanced/);
  });

  it("rejects a field it does not recognise, rather than silently dropping it", () => {
    // A dropped field is the worst outcome: the call succeeds, the renderer shows the setting
    // as applied, and nothing took effect. Misspelling a known key has the same shape, so the
    // message names the offender.
    expect(() => parseSemanticSettingsPatch({ chunkingProfle: "precise" })).toThrow(
      /chunkingProfle/,
    );
  });

  it("rejects an unrecognised field even alongside valid ones", () => {
    expect(() => parseSemanticSettingsPatch({ enabled: false, minScore: 0.4 })).toThrow(
      SemanticRequestError,
    );
  });

  it("accepts an empty patch, which changes nothing", () => {
    expect(parseSemanticSettingsPatch({})).toEqual({});
  });

  it("passes through the fields it recognises", () => {
    const patch = parseSemanticSettingsPatch({ enabled: false, minSemanticScore: 0.24 });
    expect(patch).toEqual({ enabled: false, minSemanticScore: 0.24 });
  });
});

describe("validating a model identifier from the renderer", () => {
  it("accepts a curated model", () => {
    expect(parseCuratedModelId("Xenova/all-MiniLM-L6-v2")).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("rejects anything else", () => {
    for (const bad of ["evil/not-a-model", "", null, 7]) {
      expect(() => parseCuratedModelId(bad)).toThrow();
    }
  });
});
