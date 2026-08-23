import { runCli, type ConfirmGrant } from "./run.js";
import { DETERMINISTIC_EMBEDDER_TOKEN } from "../dist-core/index/embedderSelection.js";

export interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the command line in-process, against a real store, extractor and allowlist file.
 *
 * Only the embedding model is replaced, and only through the same guarded seam the application
 * uses: unpackaged, the exact opt-in token, and a test data directory.
 */
export function createRunner(dataDir: () => string) {
  return async function run(
    argv: string[],
    extra: { confirmGrant?: ConfirmGrant; signal?: AbortSignal } = {},
  ): Promise<CapturedRun> {
    let stdout = "";
    let stderr = "";
    const code = await runCli({
      argv,
      env: {
        MARKPDF_DATA_DIR: dataDir(),
        MARKPDF_E2E_EMBEDDER: DETERMINISTIC_EMBEDDER_TOKEN,
        MARKPDF_TEST_USER_DATA: dataDir(),
      },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      version: "9.9.9-test",
      isPackaged: false,
      ...extra,
    });
    return { code, stdout, stderr };
  };
}
