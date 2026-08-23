import type { SemanticStore } from "../store/index.js";
import type { JobRegistry } from "./jobRegistry.js";

/**
 * Empty the index safely.
 *
 * The ordering is the whole contract, and each step is necessary. Cancelling alone only marks
 * tokens. Clearing before jobs have actually stopped lets an in-flight or queued job write
 * afterwards — a document row, or a chunk batch that fails a foreign key because its parent row
 * is gone. Draining waits for every registered job to finish, and refuses new ones meanwhile,
 * so the clear runs against a store nothing is writing to.
 */
export async function clearSemanticIndex(store: SemanticStore, registry: JobRegistry): Promise<void> {
  await registry.drain(() => {
    store.clear();
  });
}
