import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfirmGrant } from "./run.js";
import { createRunner } from "./harness.test-support.js";
import { EXIT_CODE } from "./exit.js";
import { buildReportPdf } from "./journeys/fixtures.test-support.js";
import { readAllowlist } from "../dist-core/consent/allowlistFile.js";
import { semanticIndexPath } from "../dist-core/paths.js";

/**
 * The command line's contract with whatever invoked it: what goes to which stream, and what the
 * exit code says. Everything here runs the real store, the real extractor and a real allowlist
 * file; only the embedding model is replaced, and only through the same guarded seam the
 * application uses.
 */

let dataDir: string;
let libraryDir: string;
let fixture: string;

const run = createRunner(() => dataDir);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "markpdf-run-data-"));
  libraryDir = mkdtempSync(join(tmpdir(), "markpdf-run-library-"));
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(libraryDir, { recursive: true, force: true });
});

describe("what goes to which stream", () => {
  it("prints help on stdout and succeeds, because asking for help is not an error", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(result.stdout).toContain("markpdf <command>");
    expect(result.stderr).toBe("");
  });

  it("prints the version on stdout", async () => {
    const result = await run(["--version"]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(result.stdout.trim()).toBe("9.9.9-test");
  });

  it("keeps a usage complaint off stdout, so a pipeline reading results sees nothing", async () => {
    const result = await run(["summarise", "a.pdf"]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("summarise");
  });

  it("prints help on stderr when there is no command, since there is no result to print", async () => {
    const result = await run([]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
});

describe("granting and withdrawing", () => {
  it("remembers a grant given with no command to run", async () => {
    const result = await run(["--allow-read", libraryDir]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(readAllowlist(dataDir).readRoots).toHaveLength(1);
  });

  it("says what the grant actually did rather than implying it was new", async () => {
    await run(["--allow-read", libraryDir]);

    const again = await run(["--allow-read", libraryDir]);

    expect(again.stderr).toMatch(/already granted/i);
  });

  it("withdraws a grant when asked, and says so", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["--revoke-read", libraryDir]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect(readAllowlist(dataDir).readRoots).toEqual([]);
  });
});

describe("refusing a path nobody granted", () => {
  it("exits 5, prints a command that would fix it, and writes nothing at all", async () => {
    const result = await run(["index", fixture]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain("--allow-read");
    expect(result.stderr).toContain(libraryDir);
    // Nothing was permitted, so nothing may have been created — not even an empty index.
    expect(existsSync(semanticIndexPath(dataDir))).toBe(false);
  }, 60_000);

  it("still refuses on a terminal when input was declined by the caller", async () => {
    const refuse: ConfirmGrant = async () => false;

    const result = await run(["index", fixture], { confirmGrant: refuse });

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(existsSync(semanticIndexPath(dataDir))).toBe(false);
  }, 60_000);

  it("offers the directory that was named when indexing it recursively, not everything beside it", async () => {
    // `index --recursive ~/Papers` names the directory itself. Offering its parent would put
    // every sibling of Papers inside the grant, which is not what anybody asked for and not what
    // the person answering the prompt would think they were agreeing to.
    let offered = "";
    const capture: ConfirmGrant = async (request) => {
      offered = request.path;
      return true;
    };

    await run(["index", "--recursive", libraryDir], { confirmGrant: capture });

    expect(offered).toBe(realpathSync(libraryDir));
    expect(readAllowlist(dataDir).readRoots).toEqual([realpathSync(libraryDir)]);
  }, 120_000);

  it("prints a remedy for the named directory when a recursive run is refused", async () => {
    const result = await run(["index", "--recursive", libraryDir]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain(`--allow-read '${realpathSync(libraryDir)}'`);
  });

  it("proceeds and remembers the grant when the person at the terminal agrees", async () => {
    const agree: ConfirmGrant = async () => true;

    const result = await run(["index", fixture], { confirmGrant: agree });

    expect(result.code).toBe(EXIT_CODE.success);
    expect(readAllowlist(dataDir).readRoots).toHaveLength(1);
  }, 120_000);

  it("reports a prompt the person interrupted as an interruption, not as a refusal", async () => {
    // Ctrl-C at the prompt reaches the run as a cancelled signal rather than as a signal to the
    // process, because raw mode swallowed SIGINT. Ending at 5 would tell a caller the path was
    // refused and suggest they grant it, which is not what happened.
    const controller = new AbortController();
    const interrupt: ConfirmGrant = async () => {
      controller.abort();
      return false;
    };

    const result = await run(["index", fixture], { confirmGrant: interrupt, signal: controller.signal });

    expect(result.code).toBe(EXIT_CODE.interrupted);
  }, 60_000);

  it("scopes the offered grant to the containing folder, not the single file", async () => {
    let offered = "";
    const capture: ConfirmGrant = async (request) => {
      offered = request.path;
      return false;
    };

    await run(["index", fixture], { confirmGrant: capture });

    expect(offered).toBe(realpathSync(libraryDir));
  }, 60_000);

  it("offers the directory that would actually be granted, not the spelling that was typed", async () => {
    // Whoever answers this is told which directory they are opening up. If the offer showed the
    // typed spelling while the grant recorded the resolved one, the two would disagree — and the
    // disagreement would be invisible precisely when it matters, on a linked path.
    const elsewhere = mkdtempSync(join(tmpdir(), "markpdf-run-link-"));
    const link = join(elsewhere, "shortcut");
    symlinkSync(libraryDir, link);
    let offered = "";
    const capture: ConfirmGrant = async (request) => {
      offered = request.path;
      return true;
    };

    try {
      await run(["index", join(link, "annual-report.pdf")], { confirmGrant: capture });

      expect(offered).toBe(realpathSync(libraryDir));
      expect(readAllowlist(dataDir).readRoots).toEqual([realpathSync(libraryDir)]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("indexing a folder", () => {
  it("says to pass --recursive rather than asking to be granted the folder's parent", async () => {
    // Demanding access before establishing what the argument is produced a remedy granting
    // `dirname(folder)` — every sibling of the folder somebody named — for a command that could
    // never have worked. Whoever pasted it widened their consent permanently and still got an
    // error.
    const result = await run(["index", libraryDir]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stderr).toContain("--recursive");
    expect(result.stderr).not.toContain("--allow-read");
  });

  it("finds the PDFs inside it, skipping hidden entries and everything that is not a PDF", async () => {
    // The hidden-entry rule is a privacy rule: `~/Library` and `.Trash` are full of documents
    // nobody meant to index.
    mkdirSync(join(libraryDir, "nested"), { recursive: true });
    mkdirSync(join(libraryDir, ".hidden"), { recursive: true });
    const pdf = await buildReportPdf();
    writeFileSync(join(libraryDir, "nested", "inner.pdf"), pdf);
    writeFileSync(join(libraryDir, ".hidden", "secret.pdf"), pdf);
    writeFileSync(join(libraryDir, "notes.txt"), "not a PDF");
    writeFileSync(join(libraryDir, ".dotfile.pdf"), pdf);
    await run(["--allow-read", libraryDir]);

    const result = await run(["index", "--recursive", libraryDir, "--json"]);

    const report = JSON.parse(result.stdout) as { documents: Array<{ path: string }> };
    const found = report.documents.map((document) => document.path.slice(realpathSync(libraryDir).length + 1)).sort();
    expect(found).toEqual(["annual-report.pdf", "nested/inner.pdf"]);
  }, 180_000);

  it("keeps going past a folder it cannot open, rather than losing the whole tree", async () => {
    const locked = join(libraryDir, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    await run(["--allow-read", libraryDir]);

    try {
      const result = await run(["index", "--recursive", libraryDir, "--json"]);

      const report = JSON.parse(result.stdout) as { documents: unknown[]; failures: Array<{ code: number }> };
      // The readable document is still indexed, and the unreadable folder is reported as its own
      // failure rather than swallowing the run.
      expect(report.documents).toHaveLength(1);
      expect(report.failures[0]?.code).toBe(EXIT_CODE.accessDenied);
      expect(result.code).toBe(EXIT_CODE.partialFailure);
    } finally {
      chmodSync(locked, 0o755);
    }
  }, 180_000);

  it("does not follow a link out of the folder it was granted", async () => {
    // The root is checked once; every file the walk produces is checked again before it is
    // opened. Without that, anything able to write in the tree during the walk could redirect it.
    const outside = mkdtempSync(join(tmpdir(), "markpdf-run-outside-"));
    try {
      writeFileSync(join(outside, "private.pdf"), await buildReportPdf());
      symlinkSync(join(outside, "private.pdf"), join(libraryDir, "shortcut.pdf"));
      await run(["--allow-read", libraryDir]);

      const result = await run(["index", "--recursive", libraryDir, "--json"]);

      const report = JSON.parse(result.stdout) as { documents: Array<{ path: string }> };
      expect(report.documents.map((document) => document.path)).not.toContain(realpathSync(join(outside, "private.pdf")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 180_000);

  it("stops asking once the person has interrupted", async () => {
    // Ctrl-C at a raw-mode prompt never reaches the process as a signal; it aborts the run's own
    // cancellation. A loop that does not read it keeps prompting for every remaining argument and
    // prints a remedy for each — for a run somebody cancelled.
    const second = mkdtempSync(join(tmpdir(), "markpdf-run-second-"));
    try {
      writeFileSync(join(second, "other.pdf"), await buildReportPdf());
      const controller = new AbortController();
      let prompts = 0;
      const interrupt: ConfirmGrant = async () => {
        prompts += 1;
        controller.abort();
        return false;
      };

      const result = await run(["index", fixture, join(second, "other.pdf")], {
        confirmGrant: interrupt,
        signal: controller.signal,
      });

      expect(prompts).toBe(1);
      expect(result.code).toBe(EXIT_CODE.interrupted);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("paths and documents that are not there", () => {
  it("exits 3 when a granted path does not exist", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["index", join(libraryDir, "absent.pdf")]);

    expect(result.code).toBe(EXIT_CODE.notFound);
  });

  it("exits 6 when a granted path is not a PDF at all", async () => {
    await run(["--allow-read", libraryDir]);
    const notAPdf = join(libraryDir, "notes.pdf");
    writeFileSync(notAPdf, "this is not a PDF");

    const result = await run(["index", notAPdf]);

    expect(result.code).toBe(EXIT_CODE.parseFailed);
  }, 60_000);

  it("offers an index command that is safe to run even for a hostile file name", async () => {
    // The suggestion is printed for a person to paste. A double-quoted path would let `$(...)`,
    // backticks and `$VAR` inside a file name run as shell syntax, so the same POSIX quoting the
    // access remedy uses is the only correct rendering here too.
    const hostile = join(libraryDir, "a b;$(id)`whoami`$HOME'q'.pdf");
    writeFileSync(hostile, await buildReportPdf());
    await run(["--allow-read", libraryDir]);

    const result = await run(["search", "revenue", "--path", hostile]);

    expect(result.code).toBe(EXIT_CODE.notIndexed);
    expect(result.stderr).toContain(`markpdf index '${hostile.split("'").join(`'\\''`)}'`);
  }, 60_000);

  it("exits 4 when asked to search a document that was never indexed", async () => {
    const result = await run(["search", "revenue", "--id", "a".repeat(64)]);

    expect(result.code).toBe(EXIT_CODE.notIndexed);
  });

  it("exits 7 when some documents in a batch succeeded and some did not", async () => {
    await run(["--allow-read", libraryDir]);

    const result = await run(["index", fixture, join(libraryDir, "absent.pdf"), "--json"]);

    expect(result.code).toBe(EXIT_CODE.partialFailure);
    const report = JSON.parse(result.stdout) as { documents: unknown[]; failures: unknown[] };
    expect(report.documents).toHaveLength(1);
    expect(report.failures).toHaveLength(1);
  }, 120_000);
});

describe("running without anybody to ask", () => {
  it("never prompts when told not to, even with a way to ask available", async () => {
    // A caller that passes `--no-input` is saying there is nobody at the keyboard. Prompting
    // anyway would hang an automated run at a question nothing will answer.
    let asked = false;
    const capture: ConfirmGrant = async () => {
      asked = true;
      return true;
    };

    const result = await run(["index", fixture, "--no-input"], { confirmGrant: capture });

    expect(asked).toBe(false);
    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain("--allow-read");
  }, 60_000);
});

describe("choosing where the index lives", () => {
  it("uses the directory named on the command line rather than the environment's", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "markpdf-run-elsewhere-"));
    try {
      const granted = await run(["--data-dir", elsewhere, "--allow-read", libraryDir]);

      expect(granted.code).toBe(EXIT_CODE.success);
      expect(existsSync(join(elsewhere, "consent", "allowlist.json"))).toBe(true);
      // And the environment's directory was left alone.
      expect(existsSync(join(dataDir, "consent", "allowlist.json"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("a run that was interrupted", () => {
  it("prints no result once the person has cancelled, and says it was interrupted", async () => {
    // Embedding a query is not preemptible, so a cancel arriving during it is noticed when it
    // returns. What must not happen is the answer being printed anyway: a caller reading stdout
    // would take a result from a run it had already stopped.
    await run(["--allow-read", libraryDir]);
    await run(["index", fixture]);
    const controller = new AbortController();
    controller.abort();

    const result = await run(["search", "Enterprise 1204 1318", "--path", fixture, "--json"], {
      signal: controller.signal,
    });

    expect(result.code).toBe(EXIT_CODE.interrupted);
    expect(result.stdout).toBe("");
  }, 120_000);

  it("reports a cancelled page render as an interruption rather than a fault", async () => {
    // `RasterisationCancelled` is an outcome of stopping, not a failure of the document. Landing
    // on the unexpected-failure code would tell an agent the tool is broken.
    await run(["--allow-read", libraryDir]);
    const controller = new AbortController();
    controller.abort();

    const result = await run(["convert", fixture], { signal: controller.signal });

    expect(result.code).toBe(EXIT_CODE.interrupted);
  }, 60_000);
});

describe("an empty answer", () => {
  it("exits 0, because finding nothing is an answer", async () => {
    await run(["--allow-read", libraryDir]);
    await run(["index", fixture]);

    const result = await run(["search", "xylophone quarantine", "--path", fixture, "--json"]);

    expect(result.code).toBe(EXIT_CODE.success);
    expect((JSON.parse(result.stdout) as { results: unknown[] }).results).toEqual([]);
  }, 120_000);
});

describe("settings this run cannot read", () => {
  it("reports it through the same boundary as everything else, rather than throwing out of the run", async () => {
    // Building the context happened outside the failure boundary, so an unreadable settings file
    // rejected the call instead of producing an exit code and a line on stderr. A caller would
    // have seen a stack trace where it expected a number.
    await run(["--allow-read", libraryDir]);
    const settings = join(dataDir, "config.json");
    writeFileSync(settings, JSON.stringify({ semanticSearch: { chunkingProfile: "precise" } }));
    chmodSync(settings, 0o000);

    try {
      const result = await run(["index", fixture]);

      expect(result.code).toBe(EXIT_CODE.unexpected);
      expect(result.stderr).toContain(settings);
      expect(result.stdout).toBe("");
    } finally {
      chmodSync(settings, 0o600);
    }
  }, 60_000);
});

describe("granting while something else is changing the record", () => {
  it("does not resurrect a grant somebody withdrew while the prompt was open", async () => {
    // The record was read when the run started. Applying an interactive grant to that snapshot
    // and writing the whole thing back reinstates every root the snapshot had — including one
    // another process revoked while the person was reading the question.
    const other = mkdtempSync(join(tmpdir(), "markpdf-run-other-"));
    try {
      // Only the other folder is granted, so indexing the fixture prompts.
      await run(["--allow-read", other]);
      const agreeAfterConcurrentRevoke: ConfirmGrant = async () => {
        // Another process withdraws one of the two roots while the question is on screen.
        await run(["--revoke-read", other]);
        return true;
      };

      await run(["index", fixture], { confirmGrant: agreeAfterConcurrentRevoke });

      const roots = readAllowlist(dataDir).readRoots;
      expect(roots).not.toContain(realpathSync(other));
      // And the grant the person actually agreed to is there.
      expect(roots).toContain(realpathSync(libraryDir));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("a path that tries to forge output", () => {
  it("is refused as a usage error rather than escaped into a remedy nobody could run", async () => {
    // Two things have to hold at once: no line of output may be forged, and the `Try:` line must
    // still be pastable. Escaping the path for display would satisfy the first and break the
    // second — the escaped spelling names a file that does not exist. So such a path is refused
    // before any of that, and every remedy that is ever printed is for a path that can be typed.
    const forged = join(libraryDir, "a\nmarkpdf: access granted\u001b[31m.pdf");
    writeFileSync(forged, await buildReportPdf());

    const result = await run(["index", forged]);

    expect(result.code).toBe(EXIT_CODE.usage);
    expect(result.stderr).not.toContain("Try:");
    for (const line of result.stderr.split("\n")) {
      expect(line).not.toBe("markpdf: access granted");
    }
    expect(result.stderr).not.toContain("\u001b");
  }, 60_000);

  it("still accepts an awkward but ordinary name, and offers a remedy that runs", async () => {
    const awkward = join(libraryDir, "a b;$(id)`x`$HOME'q'.pdf");
    writeFileSync(awkward, await buildReportPdf());

    const result = await run(["index", awkward]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain(`--allow-read '${realpathSync(libraryDir).split("'").join(`'\\''`)}'`);
  }, 60_000);
});

describe("the consent record while another process holds it", () => {
  it("says to try again, and never suggests deleting the record", async () => {
    // Removing the consent record would throw away every grant and leave the lock exactly where
    // it was. Waiting is the whole remedy.
    const holder = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "core",
      "consent",
      "holdAllowlistLock.test-support.mjs",
    );
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

      const result = await run(["--allow-read", libraryDir]);

      expect(result.code).toBe(EXIT_CODE.indexBusy);
      expect(result.stderr).toContain("Try again");
      // Nothing to run and nothing to delete: the holder will release it. A `Try:` line here
      // would be inviting somebody to interfere with a process that is working correctly.
      expect(result.stderr).not.toContain("Try:");
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
    }
  }, 30_000);
});

describe("a damaged consent record", () => {
  it("refuses to run rather than proceeding as though nothing had been granted", async () => {
    await run(["--allow-read", libraryDir]);
    const record = join(dataDir, "consent", "allowlist.json");
    const before = readFileSync(record, "utf8");
    writeFileSync(record, "{ truncated");

    const result = await run(["index", fixture]);

    expect(result.code).toBe(EXIT_CODE.accessDenied);
    expect(result.stderr).toContain(record);
    // The damaged record is left exactly as found: repairing or replacing it would destroy the
    // only evidence of what somebody had consented to.
    expect(readFileSync(record, "utf8")).not.toBe(before);
    expect(readFileSync(record, "utf8")).toBe("{ truncated");
  });
});
