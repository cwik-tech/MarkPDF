/**
 * A running job's handle.
 *
 * Cancellation travels as an `AbortSignal` rather than a mutable boolean. It is the platform's
 * own contract, so every layer that receives one already knows how to read it; it can be
 * listened to rather than only polled, which is what lets a long await react at once instead of
 * at the next check; and, being read-only here, a holder cannot cancel a job by writing to its
 * own copy of the flag. Only the registry aborts.
 */
export interface JobToken {
  readonly jobId: string;
  readonly signal: AbortSignal;
}

interface JobEntry {
  readonly token: JobToken;
  readonly controller: AbortController;
}

/** Thrown when a job tries to start while a clear is draining. */
export class RegistryDrainingError extends Error {
  constructor() {
    super("The semantic index is being cleared; indexing cannot start until that completes.");
    this.name = "RegistryDrainingError";
  }
}

/**
 * Live index jobs.
 *
 * Two structures, because they answer different questions. `#current` maps an identifier to the
 * job that owns it, so a cancel by identifier reaches the right job. `#live` holds every token
 * that has not finished — including one retired because a newer job took its identifier —
 * because "has everything stopped?" cannot be answered from the identifier map alone.
 *
 * A cancel for an unknown identifier is ignored rather than remembered, so nothing accumulates.
 */
export class JobRegistry {
  readonly #current = new Map<string, JobEntry>();
  readonly #live = new Set<JobEntry>();
  /** Finds a job's own entry from the token it was given, so `finish` cannot release another. */
  readonly #entries = new WeakMap<JobToken, JobEntry>();
  #idleWaiters: Array<() => void> = [];
  /**
   * How many clears are requested or in progress.
   *
   * A counter rather than a flag, incremented synchronously when `drain` is called. Setting it
   * a microtask later would leave a window in which a job could still register, which is
   * exactly what the drain exists to prevent. A counter also keeps refusal in force across
   * queued drains, where one drain's completion would otherwise clear a flag another still
   * needs.
   */
  #drainRequests = 0;
  /** Serialises drains, so two clears cannot each believe the store is theirs alone. */
  #drainChain: Promise<unknown> = Promise.resolve();

  /**
   * Register a job and return its token.
   *
   * A job already running under this identifier — a tab re-indexing after a settings change —
   * is cancelled and loses the identifier, but stays in `#live` until it actually finishes, so
   * a drain still waits for it.
   */
  start(jobId: string): JobToken {
    if (this.#drainRequests > 0) throw new RegistryDrainingError();

    const existing = this.#current.get(jobId);
    if (existing !== undefined) existing.controller.abort();

    const controller = new AbortController();
    const token: JobToken = { jobId, signal: controller.signal };
    const entry: JobEntry = { token, controller };
    this.#current.set(jobId, entry);
    this.#live.add(entry);
    this.#entries.set(token, entry);
    return token;
  }

  /** Release a job. Only its own identifier entry is removed. */
  finish(token: JobToken): void {
    const entry = this.#entries.get(token);
    if (entry === undefined) return;
    // Finishing is not cancelling: the signal is left alone, so a caller that already read a
    // successful result cannot be told afterwards that it was aborted.
    this.#live.delete(entry);
    if (this.#current.get(token.jobId) === entry) this.#current.delete(token.jobId);
    if (this.#live.size === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Returns whether a live job was found. Unknown identifiers are ignored, not recorded. */
  cancel(jobId: string): boolean {
    const entry = this.#current.get(jobId);
    if (entry === undefined) return false;
    entry.controller.abort();
    return true;
  }

  /** Cancel every live job, including one retired from the identifier map. */
  cancelAll(): number {
    let cancelled = 0;
    for (const entry of this.#live) {
      entry.controller.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  /** Resolves once no job is live. Event-driven: nothing polls. */
  whenIdle(): Promise<void> {
    if (this.#live.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  /**
   * Cancel everything, wait for it to actually stop, then run `work` with no job in flight.
   *
   * Waiting is the part that matters. Cancelling only marks a token: a job queued behind
   * another has not reached its first cancellation check yet, and would otherwise start, write
   * its document row, and leave it behind in a store that was just emptied.
   */
  async drain<T>(work: () => T | Promise<T>): Promise<T> {
    this.#drainRequests += 1;

    const run = async (): Promise<T> => {
      try {
        this.cancelAll();
        await this.whenIdle();
        return await work();
      } finally {
        // Released even when the work throws. Leaving it raised would lock the registry shut
        // and no document could be indexed again for the life of the process.
        this.#drainRequests -= 1;
      }
    };

    // Queue behind any drain already in progress. A failed predecessor must not block the
    // queue, so its rejection is absorbed here; its own caller still receives it.
    const queued = this.#drainChain.then(run, run);
    this.#drainChain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  get size(): number {
    return this.#live.size;
  }
}
