import { JobRegistry, RegistryDrainingError, type JobToken } from "./jobRegistry.js";
import type { BoundedScheduler } from "./boundedScheduler.js";
import type { IndexDocumentResult } from "./indexDocument.js";

export interface IndexJobSchedule {
  registry: JobRegistry;
  scheduler: BoundedScheduler;
  jobId: string;
}

/**
 * Register, queue, then index — in that order, because the order is the contract.
 *
 * Registering *before* queueing is what makes a queued job cancellable. Registering after would
 * leave a job invisible to `cancel` and to a clear's drain for as long as it waited for a
 * permit, so turning semantic search off would appear to work and then a queued job would wake
 * up and write into the index that had just been emptied.
 *
 * The composition lives in core rather than the Electron shell so it can be tested and
 * mutation-proved without an Electron process, and so a command line surface inherits exactly
 * the same bound.
 */
export async function scheduleIndexJob(
  schedule: IndexJobSchedule,
  run: (token: JobToken) => Promise<IndexDocumentResult>,
): Promise<IndexDocumentResult> {
  let token: JobToken;
  try {
    token = schedule.registry.start(schedule.jobId);
  } catch (error) {
    // A clear is draining. Cancelled rather than an error: the renderer treats cancelled as
    // retryable and leaves the tab idle, so indexing resumes once the clear completes. An error
    // would settle the tab and leave the document unindexed.
    if (error instanceof RegistryDrainingError) return { status: "cancelled" };
    throw error;
  }

  try {
    return await schedule.scheduler.run(async () => {
      // Re-checked after the permit, not only before the queue. A cancel that arrived while
      // this job waited must be honoured before any work begins — before the file is read,
      // before the model loads, before a single row is written.
      if (token.signal.aborted) return { status: "cancelled" };
      return run(token);
    });
  } finally {
    schedule.registry.finish(token);
  }
}
