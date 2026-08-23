import type { EmbedProgress } from "./embeddings.js";

/**
 * Download progress for embedding models, delivered to whoever is watching right now.
 *
 * An embedder is built once per model and reused, so any progress callback baked into it at
 * construction belongs to whichever caller happened to be first. Every later caller — the
 * settings dialog opening mid-download, an index job that finds the model missing — would then
 * watch a bar that never moves. Publishing through a hub separates the single long-lived
 * producer from the many short-lived consumers.
 */
export class ModelProgressHub {
  readonly #listeners = new Map<string, Set<(progress: EmbedProgress) => void>>();

  /** How many models currently have at least one listener. Bookkeeping must not accumulate. */
  get watchedModelCount(): number {
    return this.#listeners.size;
  }

  subscribe(modelId: string, listener: (progress: EmbedProgress) => void): () => void {
    let listeners = this.#listeners.get(modelId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(modelId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listeners.get(modelId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(modelId);
    };
  }

  publish(modelId: string, progress: EmbedProgress): void {
    const listeners = this.#listeners.get(modelId);
    if (listeners === undefined) return;
    // A copy, so a listener that unsubscribes while being notified cannot disturb this pass.
    for (const listener of [...listeners]) {
      try {
        listener(progress);
      } catch {
        // The publisher is Transformers' own progress callback, running inside the download.
        // A listener that throws there would surface as a failed model load, which is a far
        // worse outcome than a progress bar that misses one update.
      }
    }
  }
}
