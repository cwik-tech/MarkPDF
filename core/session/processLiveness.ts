/**
 * Whether the process that wrote a piece of shared state is still running.
 *
 * `process.kill(pid, 0)` performs the existence and permission checks without delivering a signal.
 * The same primitive decides what the consent record's lock says about its owner, and this is
 * deliberately a second, separate helper rather than a shared one: that one is a security
 * boundary whose only job is to choose an error message, and coupling an advisory session check to
 * it would mean a change made for one could quietly alter the other.
 *
 * **The doubt points one way.** Only a definite "no such process" counts as gone. A refusal, or
 * anything unexplained, is read as still running, because the two mistakes are not equal: a live
 * window wrongly called dead loses a person the documents they have open, while a dead one wrongly
 * called live shows a name that is merely out of date.
 *
 * Process identifiers are reused, so a `true` here can be a different process entirely. Nothing is
 * granted on the strength of this answer — a snapshot supplies a name, never an authority — so the
 * worst a reused identifier produces is a stale entry in a listing.
 */
export function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code !== "ESRCH";
  }
}
