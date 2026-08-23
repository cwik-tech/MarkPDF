/**
 * Hold the consent record from a separate process, until told to let go.
 *
 * A test that plants a lock file by hand proves something about a file; this proves something
 * about two processes. It takes the same lock the product takes, through the same function, and
 * releases it only when its input closes — so the contention the parent observes is real and
 * happens exactly when the test says it does.
 *
 * Not a `.test.ts`: it is a program the test runs, not a test.
 */
import { readSync } from "node:fs";
import { withAllowlistLock } from "../../dist-core/consent/allowlistFile.js";

const dataDir = process.argv[2];
if (dataDir === undefined) {
  process.stderr.write("usage: holdAllowlistLock <dataDir>\n");
  process.exit(2);
}

withAllowlistLock(dataDir, () => {
  process.stdout.write("held\n");
  // Block until the parent closes this process's input. Synchronous on purpose: the lock is held
  // for exactly as long as this function runs.
  const byte = Buffer.alloc(1);
  for (;;) {
    try {
      if (readSync(0, byte, 0, 1, null) === 0) return;
    } catch (error) {
      if (error?.code === "EAGAIN") continue;
      return;
    }
  }
});
