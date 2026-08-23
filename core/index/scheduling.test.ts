import { describe, expect, it } from "vitest";
import { BoundedScheduler } from "./boundedScheduler.js";
import { JobRegistry } from "./jobRegistry.js";
import { scheduleIndexJob } from "./scheduleIndexJob.js";
import { deferred } from "./deferred.test-support.js";
import type { IndexDocumentResult } from "./indexDocument.js";

/** A result shaped like a finished index, so the tests observe scheduling rather than indexing. */
function indexed(contentHash: string): IndexDocumentResult {
  return {
    status: "ready",
    contentHash,
    documentId: 1,
    pageCount: 1,
    chunkCount: 1,
    textSource: "pdf",
    unresolvedPages: [],
  };
}

/**
 * Records how many pieces of work are inside the scheduler at the same moment.
 *
 * The peak is measured by the work itself rather than read from the scheduler, so the assertion
 * cannot be satisfied by a counter the implementation maintains incorrectly.
 */
function concurrencyMeter() {
  let active = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async track<T>(work: () => Promise<T>): Promise<T> {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await work();
      } finally {
        active -= 1;
      }
    },
  };
}

describe("bounding how much indexing runs at once", () => {
  it("never runs more work concurrently than its limit, however many documents are queued", async () => {
    // Ten tabs opening at once is ordinary. ONNX inference is synchronous native work on this
    // thread, so overlapping jobs cannot actually run in parallel — they only multiply peak
    // memory and lengthen the stall. The bound is what keeps that from happening.
    const scheduler = new BoundedScheduler(1);
    const meter = concurrencyMeter();

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        scheduler.run(() =>
          meter.track(async () => {
            await Promise.resolve();
            await Promise.resolve();
            return index;
          }),
        ),
      ),
    );

    expect(meter.peak).toBe(1);
  });

  it("honours a limit above one when configured with one", async () => {
    const scheduler = new BoundedScheduler(3);
    const meter = concurrencyMeter();
    const gate = deferred();
    let entered = 0;

    const runs = Array.from({ length: 6 }, () =>
      scheduler.run(() =>
        meter.track(async () => {
          entered += 1;
          await gate.promise;
        }),
      ),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(3);

    gate.resolve();
    await Promise.all(runs);
    expect(meter.peak).toBe(3);
  });

  it("releases its permit when work throws, so one failure does not wedge the queue", async () => {
    const scheduler = new BoundedScheduler(1);
    await expect(scheduler.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(scheduler.run(async () => "after")).resolves.toBe("after");
  });

  it("starts queued work in the order it was requested", async () => {
    const scheduler = new BoundedScheduler(1);
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        scheduler.run(async () => {
          order.push(name);
        }),
      ),
    );
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("scheduling one index job", () => {
  it("cancels a job that was cancelled while it waited for a permit, without running it", async () => {
    // The whole reason the job registers before it queues. A cancel arriving while the job is
    // still waiting has to reach it, and the wait must end without reading the file, loading
    // the model, or writing a row.
    const registry = new JobRegistry();
    const scheduler = new BoundedScheduler(1);
    const blocker = deferred();
    let secondRan = false;

    const first = scheduleIndexJob({ registry, scheduler, jobId: "tab-1" }, async () => {
      await blocker.promise;
      return indexed("h1");
    });

    // Queued behind the first, then cancelled before it can acquire a permit.
    const second = scheduleIndexJob({ registry, scheduler, jobId: "tab-2" }, async () => {
      secondRan = true;
      return indexed("h2");
    });
    await Promise.resolve();
    expect(registry.cancel("tab-2")).toBe(true);

    blocker.resolve();
    await first;

    expect(await second).toEqual({ status: "cancelled" });
    expect(secondRan).toBe(false);
  });

  it("reports a job refused by a draining clear as cancelled, with no invented identifiers", async () => {
    // A cancelled job has no content hash and no document id, because it never produced one.
    // Returning "" and 0 makes a caller that trusts the declared type store a document keyed to
    // a hash of nothing.
    const registry = new JobRegistry();
    const scheduler = new BoundedScheduler(1);

    // A latch, not a sleep. `drain` raises its refusal counter synchronously, so the refusal
    // below is already in force when this call returns its promise; the gate then holds the
    // clear open for as long as the assertion needs, with no timing to get wrong.
    const gate = deferred();
    const clearing = registry.drain(() => gate.promise);

    const refused = await scheduleIndexJob({ registry, scheduler, jobId: "tab-1" }, async () =>
      indexed("h1"),
    );

    gate.resolve();
    await clearing;

    expect(refused).toEqual({ status: "cancelled" });
    expect(Object.keys(refused)).toEqual(["status"]);
  });

  it("releases its registry entry when the work throws, so a later clear is not blocked", async () => {
    const registry = new JobRegistry();
    const scheduler = new BoundedScheduler(1);

    await expect(
      scheduleIndexJob({ registry, scheduler, jobId: "tab-1" }, async () => {
        throw new Error("index failed");
      }),
    ).rejects.toThrow("index failed");

    expect(registry.size).toBe(0);
    await expect(registry.whenIdle()).resolves.toBeUndefined();
  });

  it("passes the running job's token through, so the work can watch for a later cancel", async () => {
    const registry = new JobRegistry();
    const scheduler = new BoundedScheduler(1);

    const result = await scheduleIndexJob({ registry, scheduler, jobId: "tab-1" }, async (token) => {
      expect(token.jobId).toBe("tab-1");
      expect(token.signal.aborted).toBe(false);
      return indexed("h1");
    });

    expect(result.status).toBe("ready");
  });
});
