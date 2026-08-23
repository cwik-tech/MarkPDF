import { describe, expect, it } from "vitest";
import { JobRegistry } from "./jobRegistry.js";

describe("tracking live index jobs", () => {
  it("cancels a job that is running", () => {
    const registry = new JobRegistry();
    const token = registry.start("tab-1");
    expect(registry.cancel("tab-1")).toBe(true);
    expect(token.signal.aborted).toBe(true);
  });

  it("ignores an identifier that is not running, rather than remembering it forever", () => {
    // The previous implementation added any string to a set that nothing ever emptied, so a
    // renderer sending cancels for closed tabs leaked memory for the life of the process.
    const registry = new JobRegistry();
    expect(registry.cancel("never-started")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("cancels every live job at once, which is what clearing the index requires", () => {
    // Clearing has to stop every writer before it empties the store. Cancelling afterwards
    // cannot protect it: an in-flight job would repopulate what was just deleted.
    const registry = new JobRegistry();
    const first = registry.start("tab-1");
    const second = registry.start("tab-2");

    expect(registry.cancelAll()).toBe(2);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("releases a job's entry when it finishes", () => {
    const registry = new JobRegistry();
    const token = registry.start("tab-1");
    expect(registry.size).toBe(1);
    registry.finish(token);
    expect(registry.size).toBe(0);
  });

  it("cancels and retires an older job when the same identifier starts again", () => {
    // A tab that re-indexes — after a settings change, say — reuses its identifier. Leaving the
    // older job running but untracked would make it uncancellable and let it keep writing.
    const registry = new JobRegistry();
    const older = registry.start("tab-1");
    const newer = registry.start("tab-1");

    expect(older.signal.aborted).toBe(true);
    expect(newer.signal.aborted).toBe(false);
    // The retired job is still counted as live until it actually finishes. A drain has to wait
    // for it: it is cancelled, but it has not necessarily reached its cancellation check yet.
    expect(registry.size).toBe(2);

    registry.finish(older);
    expect(registry.size).toBe(1);
  });

  it("stays busy until a retired duplicate has actually finished", async () => {
    const registry = new JobRegistry();
    const older = registry.start("tab-1");
    const newer = registry.start("tab-1");

    let idle = false;
    void registry.whenIdle().then(() => {
      idle = true;
    });

    registry.finish(newer);
    await Promise.resolve();
    expect(idle).toBe(false); // the retired job is still live

    registry.finish(older);
    await Promise.resolve();
    expect(idle).toBe(true);
  });

  it("does not let a finishing job evict a newer job under the same identifier", () => {
    // A tab that closes and reopens reuses its identifier. If the old job's cleanup removed the
    // new job's entry, the new job would silently become uncancellable.
    const registry = new JobRegistry();
    const older = registry.start("tab-1");
    const newer = registry.start("tab-1");

    registry.finish(older);

    expect(registry.cancel("tab-1")).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });
});

describe("the drain contract", () => {
  it("accepts new jobs again once the drain has finished", async () => {
    const registry = new JobRegistry();
    await registry.drain(() => undefined);
    expect(() => registry.start("after")).not.toThrow();
  });

  it("stops draining even when the work it wraps throws", async () => {
    // Otherwise a failed clear would lock the registry shut and no document could ever be
    // indexed again for the life of the process.
    const registry = new JobRegistry();
    await expect(
      registry.drain(() => {
        throw new Error("clear failed");
      }),
    ).rejects.toThrow("clear failed");

    expect(() => registry.start("after-failure")).not.toThrow();
  });

  it("serialises concurrent drains rather than letting them interleave", async () => {
    // Two clears at once must not each believe the store is theirs alone.
    const registry = new JobRegistry();
    const order: string[] = [];

    const first = registry.drain(async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
    });
    const second = registry.drain(() => {
      order.push("second");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("the signal a job is cancelled through", () => {
  it("hands out a live signal that is not yet aborted", () => {
    const token = new JobRegistry().start("tab-1");
    expect(token.signal.aborted).toBe(false);
  });

  it("aborts the signal when the job is cancelled by identifier", () => {
    // AbortSignal rather than a mutable boolean, so the check is a standard contract every
    // layer already understands and a listener can react the moment it fires, instead of each
    // caller inventing its own polling.
    const registry = new JobRegistry();
    const token = registry.start("tab-1");

    expect(registry.cancel("tab-1")).toBe(true);
    expect(token.signal.aborted).toBe(true);
  });

  it("aborts a job that a newer job took the identifier from", () => {
    const registry = new JobRegistry();
    const retired = registry.start("tab-1");
    const replacement = registry.start("tab-1");

    expect(retired.signal.aborted).toBe(true);
    expect(replacement.signal.aborted).toBe(false);
  });

  it("aborts every live job when everything is cancelled, including a retired one", () => {
    const registry = new JobRegistry();
    const retired = registry.start("tab-1");
    const replacement = registry.start("tab-1");
    const other = registry.start("tab-2");

    registry.cancelAll();

    expect([retired.signal.aborted, replacement.signal.aborted, other.signal.aborted]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("does not abort a job that simply finished, because finishing is not cancelling", () => {
    const registry = new JobRegistry();
    const token = registry.start("tab-1");
    registry.finish(token);
    expect(token.signal.aborted).toBe(false);
  });

  it("notifies a listener the moment the job is cancelled", () => {
    const registry = new JobRegistry();
    const token = registry.start("tab-1");
    let notified = false;
    token.signal.addEventListener("abort", () => {
      notified = true;
    });

    registry.cancel("tab-1");

    expect(notified).toBe(true);
  });
});
