import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { processIsRunning } from "./processLiveness.js";

/**
 * Whether the process that wrote a piece of shared state is still there.
 *
 * The only question this answers, and the direction of its doubt matters: a live process wrongly
 * called dead loses a user their open documents, while a dead one wrongly called live shows a
 * stale name. So anything that is not a definite "no" is treated as still running.
 */

/** A process identifier that is genuinely gone: one this test started, waited for, and reaped. */
function reapedPid(): number {
  const finished = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof finished.pid !== "number") throw new Error("could not start a child to reap");
  return finished.pid;
}

describe("deciding whether a process is still running", () => {
  it("says yes for this very process", () => {
    expect(processIsRunning(process.pid)).toBe(true);
  });

  it("says no for a process that has exited and been reaped", () => {
    expect(processIsRunning(reapedPid())).toBe(false);
  });

  it("says yes for anything it cannot decide, rather than declaring it dead", () => {
    // Process 1 exists on every platform this ships to and is not ours, so asking about it is
    // either permitted or refused — never "no such process". Either way the answer must not be
    // the one that throws state away.
    expect(processIsRunning(1)).toBe(true);
  });

  it("treats an identifier that cannot name a process as not running", () => {
    for (const impossible of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(processIsRunning(impossible)).toBe(false);
    }
  });
});
