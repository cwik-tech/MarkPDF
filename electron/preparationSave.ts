import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const execute = promisify(execFile);
/** Copy metadata first; a changed source is refused again immediately before replacement. */
export async function savePreparation(path: string, expected: Uint8Array, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Preparation requires an ordinary, unlinked file");
  if (!Buffer.from(await readFile(path)).equals(expected)) throw new Error("Source changed before preparation save");
  const directory = await mkdtemp(join(dirname(path), ".markpdf-save-"));
  const target = join(directory, "prepared.pdf");
  try {
    // macOS cp -p preserves permissions, ACLs and extended attributes. Other platforms need their own proof.
    if (process.platform !== "darwin") throw new Error("Automatic preparation save currently requires macOS");
    await execute("/bin/cp", ["-p", path, target], { timeout: 10_000 });
    await writeFile(target, bytes);
    const latest = await lstat(path);
    if (latest.ino !== before.ino || latest.dev !== before.dev || !Buffer.from(await readFile(path)).equals(expected)) {
      throw new Error("Source changed during preparation save");
    }
    signal?.throwIfAborted();
    await rename(target, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
