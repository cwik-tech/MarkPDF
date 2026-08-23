import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAllowed, resolveRealPath } from "./allowlist.js";
import {
  AllowlistFileError,
  AllowlistLockedError,
  applyGrants,
  allowlistFilePath,
  readAllowlist,
  updateAllowlist,
  writeAllowlist,
} from "./allowlistFile.js";

/**
 * The consent record: what was granted, remembered between runs.
 *
 * It lives in core because the MCP server will read the same file. A second copy of the rule
 * would be a second chance to disagree about what someone consented to.
 */

let dataDir: string;
let workDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-consent-data-"));
  workDir = mkdtempSync(join(tmpdir(), "markpdf-consent-work-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const EMPTY = { readRoots: [], writeRoots: [] };

/** A process id that is certainly not running: a child that has already exited. */
async function pidOfAnExitedProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return child.pid ?? 0;
}

describe("the starting position", () => {
  it("grants nothing at all when nothing has ever been granted", () => {
    expect(readAllowlist(dataDir)).toEqual(EMPTY);
  });
});

describe("granting", () => {
  it("remembers a grant for the next run", () => {
    const { allowlist } = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]);
    writeAllowlist(dataDir, allowlist);

    expect(isAllowed(readAllowlist(dataDir), join(workDir, "paper.pdf"), "read")).toBe(true);
  });

  it("does not let a read grant become a write grant", () => {
    const { allowlist } = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]);

    expect(isAllowed(allowlist, join(workDir, "paper.pdf"), "write")).toBe(false);
  });

  it("records the same directory once, however many times it is granted", () => {
    const { allowlist } = applyGrants(EMPTY, [
      { change: "allow", access: "read", path: workDir },
      { change: "allow", access: "read", path: workDir },
    ]);

    expect(allowlist.readRoots).toHaveLength(1);
  });

  it("records the directory a link points at, so two spellings are one grant", () => {
    const real = join(workDir, "papers");
    mkdirSync(real);
    const link = join(workDir, "shortcut");
    symlinkSync(real, link);

    const { allowlist } = applyGrants(EMPTY, [
      { change: "allow", access: "read", path: link },
      { change: "allow", access: "read", path: real },
    ]);

    expect(allowlist.readRoots).toHaveLength(1);
  });

  it("says a grant already held changed nothing, rather than reporting it as new", () => {
    const first = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]);
    const second = applyGrants(first.allowlist, [{ change: "allow", access: "read", path: workDir }]);

    expect(second.records[0]?.effect).toBe("already-granted");
  });
});

describe("withdrawing", () => {
  it("takes back what was granted", () => {
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist;

    const { allowlist } = applyGrants(granted, [{ change: "revoke", access: "read", path: workDir }]);

    expect(isAllowed(allowlist, join(workDir, "paper.pdf"), "read")).toBe(false);
  });

  it("takes back everything underneath the directory withdrawn, not only an exact match", () => {
    const nested = join(workDir, "papers", "2026");
    mkdirSync(nested, { recursive: true });
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: nested }]).allowlist;

    const { allowlist } = applyGrants(granted, [{ change: "revoke", access: "read", path: workDir }]);

    expect(allowlist.readRoots).toEqual([]);
  });

  it("says plainly that nothing was withdrawn when nothing was held", () => {
    const { records } = applyGrants(EMPTY, [{ change: "revoke", access: "read", path: workDir }]);

    expect(records[0]?.effect).toBe("not-granted");
  });

  it("does not claim a subdirectory was never granted when a broader grant still reaches it", () => {
    // Narrowing a grant is the most likely thing somebody does after granting broadly, and this
    // record cannot express it: roots are a union with no deny rule. What must not happen is the
    // tool reporting "nothing was held" about a directory it can still read — the one sentence
    // that would stop somebody investigating their own exposure.
    const nested = join(workDir, "papers", "private");
    mkdirSync(nested, { recursive: true });
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist;

    const { allowlist, records } = applyGrants(granted, [{ change: "revoke", access: "read", path: nested }]);

    expect(records[0]?.effect).toBe("covered-by-ancestor");
    expect(records[0]?.coveredBy).toBe(resolveRealPath(workDir));
    // And nothing was removed, because removing the ancestor would withdraw far more than asked.
    expect(allowlist.readRoots).toEqual([resolveRealPath(workDir)]);
    expect(isAllowed(allowlist, join(nested, "a.pdf"), "read")).toBe(true);
  });

  it("still says nothing was held when nothing reaches the path at all", () => {
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist;
    const elsewhere = mkdtempSync(join(tmpdir(), "markpdf-consent-far-"));

    try {
      const { records } = applyGrants(granted, [{ change: "revoke", access: "read", path: elsewhere }]);

      expect(records[0]?.effect).toBe("not-granted");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("looks only at the access being withdrawn, not the other kind", () => {
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "write", path: workDir }]).allowlist;
    const nested = join(workDir, "papers");
    mkdirSync(nested, { recursive: true });

    const { records } = applyGrants(granted, [{ change: "revoke", access: "read", path: nested }]);

    expect(records[0]?.effect).toBe("not-granted");
  });

  it("withdraws by the boundary that was stored, not by wherever the name now points", () => {
    // A stored root is a canonical boundary, not a live lookup. Resolving it again while
    // deciding what a withdrawal covers means a granted directory that has since been replaced
    // by a link escapes the withdrawal entirely — consent that cannot be taken back.
    const papers = join(workDir, "papers");
    mkdirSync(papers);
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: papers }]).allowlist;
    const elsewhere = mkdtempSync(join(tmpdir(), "markpdf-consent-elsewhere-"));
    try {
      rmSync(papers, { recursive: true, force: true });
      symlinkSync(elsewhere, papers);

      const { allowlist } = applyGrants(granted, [{ change: "revoke", access: "read", path: workDir }]);

      expect(allowlist.readRoots).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("takes back a directory that has since been replaced by a link, named exactly as granted", () => {
    // The stored root is the canonical directory. If withdrawal only ever compares against the
    // *currently resolved* spelling, then replacing that directory with a link makes the grant
    // unwithdrawable by its own name: the resolved path is now somewhere else entirely, and the
    // stored root survives every attempt to revoke it.
    const papers = join(workDir, "papers");
    mkdirSync(papers);
    const granted = applyGrants(EMPTY, [{ change: "allow", access: "read", path: papers }]).allowlist;
    expect(granted.readRoots).toHaveLength(1);
    const elsewhere = mkdtempSync(join(tmpdir(), "markpdf-consent-elsewhere-"));
    try {
      rmSync(papers, { recursive: true, force: true });
      symlinkSync(elsewhere, papers);

      const { allowlist, records } = applyGrants(granted, [{ change: "revoke", access: "read", path: papers }]);

      expect(allowlist.readRoots).toEqual([]);
      expect(records[0]?.effect).toBe("withdrawn");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("leaves the other kind of access alone", () => {
    const granted = applyGrants(EMPTY, [
      { change: "allow", access: "read", path: workDir },
      { change: "allow", access: "write", path: workDir },
    ]).allowlist;

    const { allowlist } = applyGrants(granted, [{ change: "revoke", access: "read", path: workDir }]);

    expect(allowlist.readRoots).toEqual([]);
    expect(allowlist.writeRoots).toHaveLength(1);
  });
});

describe("changing the record while something else might be", () => {
  const lockPath = () => `${allowlistFilePath(dataDir)}.lock`;

  it("applies the change to the record as it is now, not to whatever was read earlier", () => {
    const other = join(workDir, "other");
    mkdirSync(other);
    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: other }]).allowlist);

    const { allowlist } = updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);

    expect(allowlist.readRoots).toHaveLength(2);
  });

  it("refuses rather than overwriting while another process holds the record", () => {
    // Re-reading before writing narrows the window; it does not close it. Two processes that both
    // read and then both write still lose one of the two changes, and the one that gets lost can
    // be a withdrawal. Failing closed is the only answer that cannot silently undo consent.
    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist);
    const before = readFileSync(allowlistFilePath(dataDir), "utf8");
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(lockPath(), "another process", { flag: "wx" });

    try {
      expect(() => updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }])).toThrow(
        AllowlistLockedError,
      );
      expect(readFileSync(allowlistFilePath(dataDir), "utf8")).toBe(before);
    } finally {
      rmSync(lockPath(), { force: true });
    }
  });

  it("refuses while another process really is holding the record", async () => {
    // Two processes, not a planted file. The child takes the same lock through the same function
    // the product uses and holds it until its input closes, so the contention below is real and
    // happens exactly when this test says it does.
    const holder = join(dirname(fileURLToPath(import.meta.url)), "holdAllowlistLock.test-support.mjs");
    const child = spawn(process.execPath, [holder, dataDir], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes("held")) resolve();
        });
        child.on("error", reject);
        child.on("close", () => reject(new Error("the holder exited before it took the lock")));
      });

      // A distinct type, because the two failures need opposite advice: a damaged record has to
      // be looked at, and a held one only has to be waited for.
      expect(() => updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }])).toThrow(
        AllowlistLockedError,
      );
      expect(readAllowlist(dataDir)).toEqual(EMPTY);
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
    }

    // And once it lets go, the same change goes through.
    expect(() => updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }])).not.toThrow();
    expect(readAllowlist(dataDir).readRoots).toHaveLength(1);
  }, 30_000);

  it("cannot lose a withdrawal to a grant that started first", () => {
    // The property that matters, stated as a sequence: a withdrawal lands, and a grant that began
    // before it cannot put back what was withdrawn — because it could not have read the record
    // while the withdrawal held it, and it re-reads once it can.
    const other = join(workDir, "other");
    mkdirSync(other);
    updateAllowlist(dataDir, [
      { change: "allow", access: "read", path: workDir },
      { change: "allow", access: "read", path: other },
    ]);

    updateAllowlist(dataDir, [{ change: "revoke", access: "read", path: other }]);
    const { allowlist } = updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);

    expect(allowlist.readRoots).toEqual([resolveRealPath(workDir)]);
    expect(readAllowlist(dataDir).readRoots).toEqual([resolveRealPath(workDir)]);
  });

  it("releases the record when it is done, so the next change is not blocked", () => {
    updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);

    expect(() => updateAllowlist(dataDir, [{ change: "revoke", access: "read", path: workDir }])).not.toThrow();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("releases the record even when the change itself fails", () => {
    // A lock held by a failure would make consent unchangeable until it went stale.
    const blocked = join(workDir, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);

    try {
      expect(() => updateAllowlist(dataDir, [{ change: "allow", access: "read", path: join(blocked, "inner") }])).toThrow();
      expect(existsSync(lockPath())).toBe(false);
    } finally {
      chmodSync(blocked, 0o755);
    }
  });

  it("never takes over a lock, even one whose owner is gone", async () => {
    // Removing a lock and creating another is two operations. Two processes reading the same
    // abandoned lock could each delete the other's fresh one and both proceed — the very overlap
    // the lock exists to prevent, reintroduced by the cleanup. So it is left, and named.
    const departed = await pidOfAnExitedProcess();
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(lockPath(), `markpdf-lock ${departed}\n`);

    const thrown = (() => {
      try {
        updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(AllowlistLockedError);
    // A runnable command, not a sentence: everything this surface calls a remedy can be pasted.
    expect(thrown instanceof AllowlistLockedError && thrown.recoverCommand).toBe(`rm -- '${lockPath()}'`);
    expect(existsSync(lockPath())).toBe(true);
    expect(readAllowlist(dataDir)).toEqual(EMPTY);
  });

  it("refuses a lock whose owner is still running, however old the file is, and offers only waiting", () => {
    // The wall clock says nothing about ownership. A process stopped at a breakpoint, or paused
    // by the scheduler, still holds what it took.
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(lockPath(), `markpdf-lock ${process.pid}\n`);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(lockPath(), longAgo, longAgo);

    const thrown = (() => {
      try {
        updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(AllowlistLockedError);
    // Nothing to remove: it will be released on its own.
    expect(thrown instanceof AllowlistLockedError && thrown.recoverCommand).toBeUndefined();
    expect(readAllowlist(dataDir)).toEqual(EMPTY);
  });

  it("refuses a lock it cannot read the ownership of, rather than guessing", () => {
    for (const contents of ["", "who knows", "markpdf-lock", "markpdf-lock abc", "markpdf-lock -1", "markpdf-lock 0"]) {
      rmSync(lockPath(), { force: true });
      mkdirSync(join(dataDir, "consent"), { recursive: true });
      writeFileSync(lockPath(), contents);

      const thrown = (() => {
        try {
          updateAllowlist(dataDir, [{ change: "allow", access: "read", path: workDir }]);
          return null;
        } catch (error) {
          return error;
        }
      })();

      expect(thrown).toBeInstanceOf(AllowlistLockedError);
      // Never the consent record: removing that would throw away the grants and not clear the
      // lock. Only the lock file is ever named, and only when nobody can be shown to own it.
      expect(thrown instanceof AllowlistLockedError && thrown.recoverCommand).toBe(`rm -- '${lockPath()}'`);
    }
  });
});

describe("the file on disk", () => {
  it("is readable only by its owner, because it records what someone consented to", () => {
    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist);

    expect(statSync(allowlistFilePath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("leaves nothing behind from the write that replaced it", () => {
    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist);
    writeAllowlist(dataDir, EMPTY);

    expect(readdirSync(join(dataDir, "consent"))).toEqual(["allowlist.json"]);
  });

  it("leaves nothing behind even when something is already sitting at the old staging name", () => {
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(`${allowlistFilePath(dataDir)}.writing`, "a bystander");

    writeAllowlist(dataDir, EMPTY);

    expect(readdirSync(join(dataDir, "consent")).sort()).toEqual(["allowlist.json", "allowlist.json.writing"]);
  });

  it("does not touch an unrelated file beside it while being written", () => {
    // A fixed staging name is a file this application did not create. Writing to it destroys
    // somebody else's file, and this is the security boundary — the place least able to afford it.
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    const bystander = `${allowlistFilePath(dataDir)}.writing`;
    writeFileSync(bystander, "a file that belongs to somebody else");

    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist);

    expect(readFileSync(bystander, "utf8")).toBe("a file that belongs to somebody else");
  });

  it("does not write through a link left beside it", () => {
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    const target = join(workDir, "someone-elses-notes.txt");
    writeFileSync(target, "notes nobody asked this application to change");
    symlinkSync(target, `${allowlistFilePath(dataDir)}.writing`);

    writeAllowlist(dataDir, applyGrants(EMPTY, [{ change: "allow", access: "read", path: workDir }]).allowlist);

    expect(readFileSync(target, "utf8")).toBe("notes nobody asked this application to change");
    expect(readAllowlist(dataDir).readRoots).toHaveLength(1);
  });

  it("refuses to read a damaged record rather than quietly treating it as no consent", () => {
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(allowlistFilePath(dataDir), "{ not json");

    expect(() => readAllowlist(dataDir)).toThrow(AllowlistFileError);
  });

  it("refuses a record whose shape is wrong, so a hand-edit cannot widen access by accident", () => {
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(allowlistFilePath(dataDir), JSON.stringify({ readRoots: "/", writeRoots: [] }));

    expect(() => readAllowlist(dataDir)).toThrow(AllowlistFileError);
  });

  it("refuses a relative root, so the working directory cannot reinterpret the record", () => {
    // The record is external input: it can be hand-edited, or written by a different build. A
    // relative root would mean whatever the process happened to be launched from, so the same
    // file would grant different things in different directories.
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(allowlistFilePath(dataDir), JSON.stringify({ readRoots: ["papers"], writeRoots: [] }));

    expect(() => readAllowlist(dataDir)).toThrow(AllowlistFileError);
  });

  it("names the file when it cannot be read at all", () => {
    mkdirSync(join(dataDir, "consent"), { recursive: true });
    writeFileSync(allowlistFilePath(dataDir), JSON.stringify(EMPTY));
    chmodSync(allowlistFilePath(dataDir), 0o000);

    try {
      expect(() => readAllowlist(dataDir)).toThrow(allowlistFilePath(dataDir));
    } finally {
      chmodSync(allowlistFilePath(dataDir), 0o600);
    }
  });
});
