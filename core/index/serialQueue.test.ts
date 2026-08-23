import { describe, expect, it } from "vitest";
import { runExclusive } from "./serialQueue.js";
import { deferred } from "./deferred.test-support.js";

describe("running work exclusively per key", () => {
  it("never overlaps two jobs that share a key", async () => {
    const events: string[] = [];
    const releaseFirst = deferred();
    const firstStarted = deferred();

    const jobA = runExclusive("same", async () => {
      events.push("a:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("a:end");
    });

    await firstStarted.promise;
    const jobB = runExclusive("same", async () => {
      events.push("b:start");
      events.push("b:end");
    });

    // B must not have started while A is still held open.
    expect(events).toEqual(["a:start"]);
    releaseFirst.resolve();
    await Promise.all([jobA, jobB]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("lets different keys run at the same time", async () => {
    const aStarted = deferred();
    const releaseA = deferred();
    let bFinished = false;

    const jobA = runExclusive("one", async () => {
      aStarted.resolve();
      await releaseA.promise;
    });
    await aStarted.promise;

    // A different key must not be blocked by A still being open.
    await runExclusive("two", async () => {
      bFinished = true;
    });
    expect(bFinished).toBe(true);

    releaseA.resolve();
    await jobA;
  });

  it("keeps the queue moving when a job fails, and still reports that failure to its caller", async () => {
    await expect(
      runExclusive("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(runExclusive("k", async () => "second ran")).resolves.toBe("second ran");
  });

  it("does not queue a new job behind a settled one", async () => {
    // Observable form of "the key was released": a later job for the same key runs immediately
    // rather than waiting on a stale entry. Asserted through behaviour rather than by exposing
    // internal state on the production module.
    await runExclusive("transient", async () => undefined);

    let ran = false;
    const second = runExclusive("transient", async () => {
      ran = true;
    });
    await second;
    expect(ran).toBe(true);
  });
});
