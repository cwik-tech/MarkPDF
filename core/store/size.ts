import { statSync } from "node:fs";
import { StoreDataError } from "./errors.js";

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function sizeOf(path: string, optional: boolean, what: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    // A sidecar that does not exist is normal: they appear only while WAL is active. Anything
    // else — a permission problem, an I/O fault, a path that is not a file — is a real
    // condition and must not be reported as zero bytes.
    if (optional && isMissingFile(error)) return 0;
    throw new StoreDataError(
      `Could not measure ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * What the index actually occupies on disk.
 *
 * `page_count * page_size` is the logical size of the main file and ignores the write-ahead
 * log, where committed data lives until a checkpoint. After a bulk insert that understated real
 * usage roughly twentyfold, which matters because the figure is shown to the user.
 */
export function indexSizeOnDisk(databasePath: string): number {
  return (
    sizeOf(databasePath, false, "the index") +
    sizeOf(`${databasePath}-wal`, true, "the write-ahead log") +
    sizeOf(`${databasePath}-shm`, true, "the shared-memory index")
  );
}
