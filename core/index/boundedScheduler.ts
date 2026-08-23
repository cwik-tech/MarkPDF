/**
 * Run at most `limit` pieces of work at once, in the order they were requested.
 *
 * This is a different guarantee from `runExclusive`, and both are needed. `runExclusive` keeps
 * two jobs for the *same* document from interleaving their clear-then-insert protocol; it says
 * nothing about how many *different* documents may run together. Opening ten tabs schedules ten
 * documents, each with a distinct content hash, so nothing there was bounded before.
 *
 * Why bound it at all: embedding is synchronous native work. `session.run` blocks this thread
 * (see createTransformersEmbedder), so overlapping jobs cannot make progress in parallel — they
 * only interleave at await points. What overlapping does buy is multiplied peak memory, because
 * each job holds a batch of chunk texts and their vectors, and a longer, more ragged pattern of
 * event-loop stalls in the process that also draws the interface.
 */
export class BoundedScheduler {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("A bounded scheduler needs a limit of at least 1.");
    }
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  /** How many pieces of work hold a permit right now. */
  get active(): number {
    return this.#active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await work();
    } finally {
      // Released on every path. A throwing job that kept its permit would shrink the limit for
      // the life of the process, and enough of them would wedge the queue permanently.
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    // FIFO, so a document queued first is indexed first. A stack would starve the tab the user
    // opened at the start of a batch, which is usually the one they are looking at.
    return new Promise<void>((resolve) => {
      this.#waiting.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    const next = this.#waiting.shift();
    if (next !== undefined) next();
  }
}
