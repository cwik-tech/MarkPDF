import type { Database as Db } from "better-sqlite3";
import { StoreDataError } from "./errors.js";

/**
 * Run something with this connection as the only one attached to the database.
 *
 * Reclaiming space is not merely slower with a second connection attached — it does not happen.
 * So exclusivity is established **before** anything is deleted: `BEGIN IMMEDIATE` under
 * `locking_mode = EXCLUSIVE` either succeeds, in which case nothing else can attach until it is
 * released, or raises `SQLITE_BUSY` having changed nothing at all. That ordering is what makes
 * the refusal safe: somebody who is told their document could not be forgotten still has it,
 * and can try again, rather than being left with a withdrawal that half happened and was
 * reported as done.
 *
 * The schema upgrade uses it for the same reason. A connection that has queried the index holds
 * it open in a way that blocks this — measured against better-sqlite3 13.0.3 — and every MarkPDF
 * store queries at open, so an older MarkPDF that still has the index open is found here rather
 * than left writing under rules it does not know.
 *
 * `busy_timeout` still applies, so this waits for a passing writer rather than failing on one.
 */
export function withExclusiveAccess<T>(db: Db, body: () => T): T {
  db.pragma("locking_mode = EXCLUSIVE");

  // A discriminated outcome rather than a nullable result, so the success value never has to be
  // asserted back into existence after the release step below.
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  let outcome: Outcome;
  try {
    // Forces the transition; the lock is not taken until a transaction actually starts.
    db.exec("BEGIN IMMEDIATE; COMMIT;");
    outcome = { ok: true, value: body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    db.pragma("locking_mode = NORMAL");
    // And released: the mode change only takes effect at the next transaction.
    db.exec("BEGIN IMMEDIATE; COMMIT;");
  } catch (releaseError) {
    // Not swallowed. A connection left in exclusive mode locks every other process out of the
    // index for the rest of its life, which is a worse outcome than the operation failing — so
    // when nothing else went wrong, this is the failure to report. When something else did, that
    // one is the more useful of the two and this would only hide it.
    if (outcome.ok) {
      const reason = releaseError instanceof Error ? releaseError.message : String(releaseError);
      throw new StoreDataError(`The index could not be returned to shared access: ${reason}`);
    }
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Whether SQLite refused because another connection holds the database. */
export function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED";
}
