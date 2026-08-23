/**
 * Run work exclusively per key, in the order it was requested.
 *
 * Indexing is keyed by content hash because two tabs holding the same PDF is ordinary, and the
 * replace protocol is not safe to interleave: each job clears the scope and then inserts
 * deterministic chunk ids, so a second job that clears after the first has cleared collides on
 * `document_chunks.id` when both insert.
 *
 * This guards a single process. Two processes sharing the index — the app and a command line
 * run — are handled separately by SQLite's own locking with `busy_timeout`.
 */
const running = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = running.get(key) ?? Promise.resolve();
  // `work` runs whether the predecessor settled or rejected, so one failed job does not block
  // the queue. The caller still receives its own rejection through the returned promise.
  const next = previous.then(work, work);

  const tracked = next.then(
    () => undefined,
    () => undefined,
  );
  running.set(key, tracked);
  void tracked.then(() => {
    // Only the last job for a key removes it, so the map cannot grow without bound and an
    // in-flight successor is never dropped.
    if (running.get(key) === tracked) running.delete(key);
  });

  return next;
}
