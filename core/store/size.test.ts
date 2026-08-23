import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSizeOnDisk } from "./size.js";
import { StoreDataError } from "./errors.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "markpdf-size-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("measuring the index on disk", () => {
  it("sums the database with whichever sidecars exist", () => {
    const path = join(dir, "index.sqlite");
    writeFileSync(path, Buffer.alloc(100));
    writeFileSync(`${path}-wal`, Buffer.alloc(250));
    expect(indexSizeOnDisk(path)).toBe(350);
  });

  it("treats an absent sidecar as zero, because they exist only while write-ahead logging is active", () => {
    const path = join(dir, "index.sqlite");
    writeFileSync(path, Buffer.alloc(64));
    expect(indexSizeOnDisk(path)).toBe(64);
  });

  it("reports a missing database rather than silently calling it empty", () => {
    // Returning zero here would present a real fault as an empty index.
    expect(() => indexSizeOnDisk(join(dir, "absent.sqlite"))).toThrow(StoreDataError);
    expect(() => indexSizeOnDisk(join(dir, "absent.sqlite"))).toThrow(/Could not measure the index/);
  });

  it("surfaces a sidecar that fails for a reason other than being absent", () => {
    // A self-referential symlink makes statSync fail with ELOOP, which is a genuine fault and
    // must not be reported as zero bytes the way "sidecar not present" legitimately is.
    const path = join(dir, "index.sqlite");
    writeFileSync(path, Buffer.alloc(10));
    symlinkSync(`${path}-wal`, `${path}-wal`);

    expect(() => indexSizeOnDisk(path)).toThrow(StoreDataError);
    expect(() => indexSizeOnDisk(path)).toThrow(/write-ahead log/);
  });

  it("keeps the underlying error as the cause, so the real fault is not lost", () => {
    const path = join(dir, "index.sqlite");
    writeFileSync(path, Buffer.alloc(10));
    symlinkSync(`${path}-shm`, `${path}-shm`);

    try {
      indexSizeOnDisk(path);
      expect.unreachable("expected a StoreDataError");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreDataError);
      const cause = (error as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as NodeJS.ErrnoException).code).toBe("ELOOP");
    }
  });
});
