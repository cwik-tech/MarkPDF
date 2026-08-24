import { readFile } from "node:fs/promises";
import {
  AccessDeniedError,
  grantableRootFor,
  remedyFor,
  requireAccess,
  type AccessKind,
  type Allowlist,
  type GrantScope,
} from "../dist-core/consent/allowlist.js";
import { updateAllowlist } from "../dist-core/consent/allowlistFile.js";
import { createDeterministicEmbedder } from "../dist-core/index/deterministicEmbedder.js";
import { shouldUseDeterministicEmbedder } from "../dist-core/index/embedderSelection.js";
import { createTransformersEmbedder, type Embedder } from "../dist-core/index/embeddings.js";
import { getCuratedEmbeddingModel } from "../dist-core/models.js";
import { openSemanticStore, type SemanticStore } from "../dist-core/store/index.js";
import type { SemanticSearchSettings } from "../dist-core/ipc/settings.js";
import type { GlobalSettings } from "./parse.js";
import type { Reporter } from "./report.js";

/**
 * What a person at the terminal is asked, and what they answered.
 *
 * A function rather than a flag so that the run layer never talks to a terminal itself: the
 * entry point supplies a real prompt when there is one, tests supply an answer, and a
 * non-interactive run supplies nothing at all.
 */
export type ConfirmGrant = (request: { path: string; kind: AccessKind; remedy: string }) => Promise<boolean>;

export interface CommandContext {
  dataDir: string;
  settings: SemanticSearchSettings;
  report: Reporter;
  global: GlobalSettings;
  signal: AbortSignal;
  /** The environment this run started in — input, never a place to write configuration back. */
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  allowlist(): Allowlist;
  /** Opens the index on first use, so a run that is refused before it starts writes nothing. */
  store(): SemanticStore;
  embedder(): Embedder;
  /**
   * The resolved path, or `AccessDeniedError`. May offer a grant when someone is watching.
   *
   * `scope` decides what a grant would cover: the containing folder for a named file, or the
   * path itself for one the caller named as the thing to work on.
   */
  requireAccess(target: string, kind: AccessKind, scope?: GrantScope): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  close(): void;
}

export interface ContextInput {
  dataDir: string;
  allowlist: Allowlist;
  settings: SemanticSearchSettings;
  report: Reporter;
  global: GlobalSettings;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  confirmGrant: ConfirmGrant | undefined;
}

export function createContext(input: ContextInput): CommandContext {
  let allowlist = input.allowlist;
  let store: SemanticStore | null = null;
  let embedder: Embedder | null = null;

  return {
    dataDir: input.dataDir,
    settings: input.settings,
    report: input.report,
    global: input.global,
    signal: input.signal,
    env: input.env,
    isPackaged: input.isPackaged,

    allowlist: () => allowlist,

    store() {
      // Opened here and nowhere else, and only when something is actually going to use it.
      // `markpdf index` on a path nobody granted must leave the data directory as it found it,
      // and an eagerly opened connection would have created an empty index first.
      store ??= openSemanticStore({ dataDir: input.dataDir });
      return store;
    },

    embedder() {
      if (embedder !== null) return embedder;
      const modelId = input.settings.activeModelId;
      // The same guarded seam the application uses: unpackaged, the exact opt-in token, and a
      // test data directory. Nothing on the command line can reach it.
      embedder = shouldUseDeterministicEmbedder({ isPackaged: input.isPackaged, env: input.env })
        ? createDeterministicEmbedder(getCuratedEmbeddingModel(modelId).dimensions, modelId)
        : createTransformersEmbedder({
            modelId,
            dataDir: input.dataDir,
            onProgress: (progress) => {
              const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
              input.report.progress(`Downloading ${modelId}: ${percent}%`);
            },
          });
      return embedder;
    },

    async requireAccess(target, kind, scope = "parent") {
      try {
        return requireAccess(allowlist, target, kind, scope);
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;
        // The *resolved* root, so whoever answers is shown exactly the directory that will be
        // recorded — which a typed or linked spelling would not be.
        const folder = grantableRootFor(target, scope);
        const remedy = remedyFor(target, kind, scope);
        // Nobody is asked anything after they have cancelled. Ctrl-C at a raw-mode prompt reaches
        // the run as an aborted signal rather than as a signal to the process, so this is the only
        // place that can notice.
        if (input.confirmGrant === undefined || input.global.noInput || input.signal.aborted) throw error;

        const agreed = await input.confirmGrant({ path: folder, kind, remedy });
        if (!agreed) throw error;

        // One indivisible read-change-write. The record this run started with is a snapshot, and
        // a prompt is exactly the moment it is most likely to be stale: somebody spends time
        // reading the question while another process withdraws something. Writing the snapshot
        // back would reinstate what they had just revoked, and re-reading first would only make
        // that less likely. Contention fails closed rather than guessing.
        const applied = updateAllowlist(input.dataDir, [{ change: "allow", access: kind, path: folder }]);
        allowlist = applied.allowlist;
        return requireAccess(allowlist, target, kind, scope);
      }
    },

    readFile: async (path) => new Uint8Array(await readFile(path)),

    close() {
      store?.close();
      store = null;
    },
  };
}
