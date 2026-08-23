import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { directoryIsOnPath, findOnPath, isExecutableFile } from "./pathLookup.js";

/**
 * Which `markpdf` the shell would actually run.
 *
 * Pure, with the "is there an executable here" question injected, so every case can be written
 * down without creating files. The order is the whole point: the first match on PATH wins, and
 * an installed shim that sits behind somebody else's copy is not the command being typed.
 */

const executables = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

describe("finding a command on PATH", () => {
  it("returns matches in the order the shell would search", () => {
    const found = findOnPath("/opt/homebrew/bin:/usr/local/bin", "markpdf", executables("/usr/local/bin/markpdf", "/opt/homebrew/bin/markpdf"));

    expect(found).toEqual(["/opt/homebrew/bin/markpdf", "/usr/local/bin/markpdf"]);
  });

  it("finds nothing when PATH is not set", () => {
    expect(findOnPath(undefined, "markpdf", () => true)).toEqual([]);
  });

  it("skips an empty entry rather than searching the current directory", () => {
    // An empty PATH entry means "here" to a POSIX shell. Reporting a `markpdf` that happens to be
    // in whatever directory the application was launched from would be noise at best.
    //
    // The candidate is spelled the way the code would build it — resolved against the working
    // directory — because an unresolved "markpdf" is a path the search never produces, and a fake
    // seeded with one could not tell a working skip from a broken one.
    const here = resolve("markpdf");
    expect(findOnPath(":/usr/local/bin", "markpdf", executables(here, "/usr/local/bin/markpdf"))).toEqual([
      "/usr/local/bin/markpdf",
    ]);
  });

  it("reports a directory listed twice only once", () => {
    expect(findOnPath("/usr/local/bin:/usr/local/bin", "markpdf", executables("/usr/local/bin/markpdf"))).toEqual([
      "/usr/local/bin/markpdf",
    ]);
  });

  it("ignores a directory that has no such command", () => {
    expect(findOnPath("/empty:/usr/local/bin", "markpdf", executables("/usr/local/bin/markpdf"))).toEqual([
      "/usr/local/bin/markpdf",
    ]);
  });
});

describe("whether a directory is on PATH at all", () => {
  it("recognises it", () => {
    expect(directoryIsOnPath("/opt/bin:/Users/me/.local/bin", "/Users/me/.local/bin")).toBe(true);
  });

  it("recognises it despite a trailing separator", () => {
    expect(directoryIsOnPath("/Users/me/.local/bin/", "/Users/me/.local/bin")).toBe(true);
  });

  it("does not mistake a directory whose name merely starts the same", () => {
    expect(directoryIsOnPath("/Users/me/.local/bin2", "/Users/me/.local/bin")).toBe(false);
  });

  it("says no when PATH is not set", () => {
    expect(directoryIsOnPath(undefined, "/Users/me/.local/bin")).toBe(false);
  });
});

describe("whether a shell would actually run a file", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "markpdf-exec-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("says no to a file without an executable bit", () => {
    // The case that mattered: a shim whose mode was changed is installed, matches, and cannot
    // run. Reporting it as the working command would be the most misleading answer available.
    const file = join(workDir, "markpdf");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);

    expect(isExecutableFile(file)).toBe(false);
  });

  it("says yes once it is executable", () => {
    const file = join(workDir, "markpdf");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);

    expect(isExecutableFile(file)).toBe(true);
  });

  it("says no to a directory, however its mode reads", () => {
    const directory = join(workDir, "markpdf");
    mkdirSync(directory);

    expect(isExecutableFile(directory)).toBe(false);
  });

  it("says no to something that is not there", () => {
    expect(isExecutableFile(join(workDir, "absent"))).toBe(false);
  });

  it("says no to a link pointing at nothing", () => {
    const link = join(workDir, "markpdf");
    symlinkSync(join(workDir, "absent"), link);

    expect(isExecutableFile(link)).toBe(false);
  });
});
