import { describe, expect, it } from "vitest";
import { ModelProgressHub } from "./modelProgress.js";

describe("routing embedding-model download progress", () => {
  it("delivers to a listener that subscribed after the download had already been arranged", () => {
    // The regression this replaces: the embedder was built once with whichever progress
    // callback the first caller happened to pass, and that callback was frozen into it. A
    // later download request — the settings dialog, or an index job waiting on a cold model —
    // subscribed to nothing and showed a motionless bar for the length of a 133 MB fetch.
    const hub = new ModelProgressHub();
    const seen: Array<{ loaded: number; total: number }> = [];

    hub.subscribe("model-a", (progress) => seen.push(progress));
    hub.publish("model-a", { loaded: 10, total: 100 });

    expect(seen).toEqual([{ loaded: 10, total: 100 }]);
  });

  it("delivers to every current listener, so the banner and the dialog can both follow one download", () => {
    const hub = new ModelProgressHub();
    const banner: number[] = [];
    const dialog: number[] = [];

    hub.subscribe("model-a", (progress) => banner.push(progress.loaded));
    hub.subscribe("model-a", (progress) => dialog.push(progress.loaded));
    hub.publish("model-a", { loaded: 5, total: 10 });

    expect(banner).toEqual([5]);
    expect(dialog).toEqual([5]);
  });

  it("stops delivering to a listener that unsubscribed, without disturbing the others", () => {
    const hub = new ModelProgressHub();
    const staying: number[] = [];
    const leaving: number[] = [];

    hub.subscribe("model-a", (progress) => staying.push(progress.loaded));
    const unsubscribe = hub.subscribe("model-a", (progress) => leaving.push(progress.loaded));

    hub.publish("model-a", { loaded: 1, total: 10 });
    unsubscribe();
    hub.publish("model-a", { loaded: 2, total: 10 });

    expect(staying).toEqual([1, 2]);
    expect(leaving).toEqual([1]);
  });

  it("keeps each model's listeners to that model", () => {
    const hub = new ModelProgressHub();
    const a: number[] = [];
    const b: number[] = [];

    hub.subscribe("model-a", (progress) => a.push(progress.loaded));
    hub.subscribe("model-b", (progress) => b.push(progress.loaded));
    hub.publish("model-a", { loaded: 7, total: 10 });

    expect(a).toEqual([7]);
    expect(b).toEqual([]);
  });

  it("ignores progress for a model nobody is watching", () => {
    const hub = new ModelProgressHub();
    expect(() => hub.publish("model-a", { loaded: 1, total: 2 })).not.toThrow();
  });

  it("keeps delivering after one listener throws, because progress must not break a download", () => {
    // The publisher is Transformers' own progress callback, running inside the download. A
    // listener that throws there would surface as a failed model load.
    const hub = new ModelProgressHub();
    const survived: number[] = [];

    hub.subscribe("model-a", () => {
      throw new Error("listener blew up");
    });
    hub.subscribe("model-a", (progress) => survived.push(progress.loaded));

    expect(() => hub.publish("model-a", { loaded: 3, total: 4 })).not.toThrow();
    expect(survived).toEqual([3]);
  });

  it("releases the last listener's bookkeeping, so a long session does not accumulate models", () => {
    const hub = new ModelProgressHub();
    const off = hub.subscribe("model-a", () => undefined);
    expect(hub.watchedModelCount).toBe(1);
    off();
    expect(hub.watchedModelCount).toBe(0);
  });
});
