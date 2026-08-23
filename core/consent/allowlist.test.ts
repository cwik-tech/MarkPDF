import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessDeniedError, isAllowed, isMissingPathError, requireAccess, remedyFor } from "./allowlist.js";

/**
 * Which paths the command line surface may touch, and for what.
 *
 * This lives in core rather than in the CLI because the MCP server has to inherit exactly the
 * same enforcement. A second copy of a security rule is a second chance to get it wrong.
 */

let root: string;
let papers: string;
let papersTwo: string;
let outside: string;

beforeEach(() => {
  // Realpath the temporary root immediately: on macOS `/tmp` is a symlink to `/private/tmp`, so
  // an unresolved fixture path would not be contained by its own resolved root.
  root = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-consent-")));
  papers = join(root, "Papers");
  papersTwo = join(root, "Papers2");
  outside = join(root, "Elsewhere");
  for (const directory of [papers, papersTwo, outside]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(papers, "report.pdf"), "pdf");
  writeFileSync(join(papersTwo, "other.pdf"), "pdf");
  writeFileSync(join(outside, "secret.pdf"), "pdf");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const allow = (readRoots: string[], writeRoots: string[] = []) => ({ readRoots, writeRoots });

describe("deciding whether a path may be read", () => {
  it("allows a file inside a granted root", () => {
    expect(isAllowed(allow([papers]), join(papers, "report.pdf"), "read")).toBe(true);
  });

  it("allows the granted root itself", () => {
    expect(isAllowed(allow([papers]), papers, "read")).toBe(true);
  });

  it("allows a file nested deeply inside a granted root", () => {
    const nested = join(papers, "2026", "q1");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "deep.pdf"), "pdf");
    expect(isAllowed(allow([papers]), join(nested, "deep.pdf"), "read")).toBe(true);
  });

  it("refuses a sibling directory whose name merely starts with a granted root's name", () => {
    // `startsWith` would allow this: "/…/Papers2" begins with "/…/Papers". Containment has to be
    // decided on path segments, which is what `path.relative` gives.
    expect(isAllowed(allow([papers]), join(papersTwo, "other.pdf"), "read")).toBe(false);
  });

  it("refuses a path outside every granted root", () => {
    expect(isAllowed(allow([papers]), join(outside, "secret.pdf"), "read")).toBe(false);
  });

  it("refuses everything when nothing has been granted", () => {
    // The default is empty. A tool that reads the filesystem on someone's behalf starts with no
    // permission and is given some, rather than starting with all and having some taken away.
    expect(isAllowed(allow([]), join(papers, "report.pdf"), "read")).toBe(false);
  });

  it("refuses a path that escapes a granted root with ..", () => {
    expect(isAllowed(allow([papers]), join(papers, "..", "Elsewhere", "secret.pdf"), "read")).toBe(false);
  });
});

describe("symbolic links", () => {
  it("resolves a link before deciding, so a link out of a granted root is refused", () => {
    // Without resolving, a link inside a granted directory is a hole straight through the
    // allowlist: its own path is contained while what it points at is not.
    const link = join(papers, "escape.pdf");
    symlinkSync(join(outside, "secret.pdf"), link);
    expect(isAllowed(allow([papers]), link, "read")).toBe(false);
  });

  it("allows a link that points back inside a granted root", () => {
    const link = join(papers, "alias.pdf");
    symlinkSync(join(papers, "report.pdf"), link);
    expect(isAllowed(allow([papers]), link, "read")).toBe(true);
  });

  it("does not honour a root that was never canonicalised, so a miss fails closed", () => {
    // Roots enter the allowlist already resolved — `applyGrants` does that at grant time. A root
    // that skipped it is not silently repaired here, because repairing it would mean resolving
    // the stored root on every check, and that is exactly what lets a replaced directory widen
    // an old grant. Failing to match is the safe direction.
    const linkedRoot = join(root, "PapersLink");
    symlinkSync(papers, linkedRoot);
    expect(isAllowed(allow([linkedRoot]), join(papers, "report.pdf"), "read")).toBe(false);
  });
});

describe("a granted directory that is replaced afterwards", () => {
  it("refuses a file reached through a granted name that now links somewhere ungranted", () => {
    // The grant was for this directory. Storing its resolved path is only half the guarantee:
    // if the check resolves the stored root again, then removing the directory and putting a
    // link to somewhere else at the same name silently moves the grant with it.
    const allowlist = allow([papers]);
    rmSync(papers, { recursive: true, force: true });
    symlinkSync(outside, papers);

    expect(isAllowed(allowlist, join(papers, "secret.pdf"), "read")).toBe(false);
    expect(() => requireAccess(allowlist, join(papers, "secret.pdf"), "read")).toThrow(AccessDeniedError);
  });

  it("still refuses the replacement's own spelling, which was never granted either", () => {
    const allowlist = allow([papers]);
    rmSync(papers, { recursive: true, force: true });
    symlinkSync(outside, papers);

    expect(isAllowed(allowlist, join(outside, "secret.pdf"), "read")).toBe(false);
  });
});

describe("read roots and write roots are separate", () => {
  it("does not let permission to read imply permission to write", () => {
    // The asymmetry is the point: an agent granted a library to search must not be able to
    // overwrite it.
    const allowlist = allow([papers], []);
    expect(isAllowed(allowlist, join(papers, "report.pdf"), "read")).toBe(true);
    expect(isAllowed(allowlist, join(papers, "report.pdf"), "write")).toBe(false);
  });

  it("does not let permission to write imply permission to read", () => {
    const allowlist = allow([], [papers]);
    expect(isAllowed(allowlist, join(papers, "out.md"), "write")).toBe(true);
    expect(isAllowed(allowlist, join(papers, "report.pdf"), "read")).toBe(false);
  });

  it("allows both when both are granted", () => {
    const allowlist = allow([papers], [papers]);
    expect(isAllowed(allowlist, join(papers, "report.pdf"), "read")).toBe(true);
    expect(isAllowed(allowlist, join(papers, "out.md"), "write")).toBe(true);
  });
});

describe("a path that does not exist yet", () => {
  it("decides a would-be output file by its nearest existing ancestor", () => {
    // `convert --out` names a file that is not there yet. Refusing every such path would make
    // writing impossible; resolving the deepest directory that does exist keeps the symlink
    // guarantee while allowing the write.
    expect(isAllowed(allow([], [papers]), join(papers, "new", "out.md"), "write")).toBe(true);
  });

  it("still refuses one whose nearest existing ancestor is outside", () => {
    expect(isAllowed(allow([], [papers]), join(outside, "new", "out.md"), "write")).toBe(false);
  });

  it("refuses a would-be file under a link that points outside", () => {
    const link = join(papers, "away");
    symlinkSync(outside, link);
    expect(isAllowed(allow([], [papers]), join(link, "out.md"), "write")).toBe(false);
  });
});

describe("refusing access", () => {
  it("names the path and what was attempted", () => {
    const denied = join(outside, "secret.pdf");
    expect(() => requireAccess(allow([papers]), denied, "read")).toThrow(AccessDeniedError);
    expect(() => requireAccess(allow([papers]), denied, "read")).toThrow(/secret\.pdf/);
  });

  it("returns the resolved path when access is allowed, so callers use what was checked", () => {
    // Returning the resolved path narrows the time-of-check to time-of-use window: a caller that
    // reopened the original spelling would re-run link resolution and could reach somewhere else.
    // It does not close that window — a component can still be replaced between the check and
    // the open — and the source says so too.
    const link = join(papers, "alias.pdf");
    symlinkSync(join(papers, "report.pdf"), link);
    expect(requireAccess(allow([papers]), link, "read")).toBe(realpathSync(join(papers, "report.pdf")));
  });

  it("offers a remedy that is a runnable command scoped to the file's directory", () => {
    // Scoped to the parent, not to the file: a human approving this in an agent's permission
    // prompt should see exactly what they are granting.
    const remedy = remedyFor(join(papers, "report.pdf"), "read");
    expect(remedy).toContain("--allow-read");
    expect(remedy).toContain(papers);
    expect(remedy).not.toContain("report.pdf");
  });

  it("names the directory that would actually be granted, not the one that was typed", () => {
    // A path reached through a link is checked after resolution, so granting the directory the
    // link sits in would not make the same command succeed. The remedy has to name the real
    // containing directory, which is also exactly what the interactive offer stores.
    const link = join(root, "PapersLink");
    symlinkSync(papers, link);

    expect(remedyFor(join(link, "report.pdf"), "read")).toBe(`markpdf --allow-read '${papers}'`);
  });

  it("names the directory itself when that is what the caller asked to work on", () => {
    // `index --recursive ~/Papers` names the directory. Granting its parent would take in every
    // sibling of Papers, which is a much wider grant than the command implies.
    expect(remedyFor(papers, "read", "self")).toBe(`markpdf --allow-read '${papers}'`);
  });

  it("still grants only that one file when the caller names a file as the target", () => {
    // `self` on a file is harmless: a root equal to the file contains the file and nothing else.
    const file = join(papers, "report.pdf");
    expect(remedyFor(file, "read", "self")).toBe(`markpdf --allow-read '${file}'`);
    expect(isAllowed({ readRoots: [file], writeRoots: [] }, file, "read")).toBe(true);
    expect(isAllowed({ readRoots: [file], writeRoots: [] }, join(papers, "other.pdf"), "read")).toBe(false);
  });

  it("carries the scope on the refusal, so the printed remedy matches the offer", () => {
    try {
      requireAccess(allow([]), papers, "read", "self");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      if (error instanceof AccessDeniedError) expect(error.scope).toBe("self");
    }
  });

  it("offers a write remedy that grants writing, not reading", () => {
    expect(remedyFor(join(papers, "out.md"), "write")).toContain("--allow-write");
  });

  it("quotes a directory containing spaces, so the remedy can actually be run", () => {
    // "Runnable" is the whole claim. An unquoted `/Users/me/My Papers` becomes two arguments and
    // the command grants something nobody asked for, or fails outright.
    const spaced = join(root, "My Papers");
    mkdirSync(spaced, { recursive: true });
    const remedy = remedyFor(join(spaced, "report.pdf"), "read");

    expect(remedy).toBe(`markpdf --allow-read '${spaced}'`);
  });

  it("escapes an embedded single quote rather than ending the quoted argument early", () => {
    // A directory named `Bob's Papers` would otherwise close the quote mid-path and hand the
    // rest of it to the shell as syntax.
    const awkward = join(root, "Bob's Papers");
    mkdirSync(awkward, { recursive: true });
    const remedy = remedyFor(join(awkward, "report.pdf"), "read");

    expect(remedy).toBe(`markpdf --allow-read '${awkward.replace(/'/g, "'\\''")}'`);
    // And the quoting is balanced: every quote in the emitted argument pairs up.
    const argument = remedy.slice("markpdf --allow-read ".length);
    expect(argument.startsWith("'") && argument.endsWith("'")).toBe(true);
  });

  it("leaves no shell metacharacter unquoted", () => {
    const nasty = join(root, "a b;rm -rf $HOME`x`");
    mkdirSync(nasty, { recursive: true });
    const remedy = remedyFor(join(nasty, "report.pdf"), "read");
    // Everything after the flag is one single-quoted argument, so nothing inside it is syntax.
    expect(remedy.slice("markpdf --allow-read ".length)).toBe(`'${nasty}'`);
  });
});

describe("telling a missing path from a filesystem that refused", () => {
  it("treats only missing-path conditions as reason to fall back to an ancestor", () => {
    // Resolving a would-be output file walks up to the deepest directory that exists. Treating a
    // permission or I/O failure the same way would silently reclassify "I could not look" as
    // "it is not there", and the containment decision would then rest on a guess.
    for (const code of ["ENOENT", "ENOTDIR"]) {
      expect(isMissingPathError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const code of ["EACCES", "EPERM", "ELOOP", "EIO", "ENAMETOOLONG"]) {
      expect(isMissingPathError(Object.assign(new Error(code), { code }))).toBe(false);
    }
  });

  it("treats an error with no code as something other than a missing path", () => {
    expect(isMissingPathError(new Error("something went wrong"))).toBe(false);
    expect(isMissingPathError("not an error")).toBe(false);
  });
});
