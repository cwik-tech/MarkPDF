import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyShimOccupant, installShimFile, removeShimFile } from "./installShimFile.js";
import { renderShim } from "./cliShim.js";

/**
 * Putting the command on disk, and refusing to when the thing at that path is not ours.
 *
 * Against real directories, because every rule here is about the filesystem: a symbolic link
 * planted at the install path would otherwise redirect the write somewhere nobody chose, and an
 * in-place write interrupted half way would leave a truncated command where a working one was.
 */

let workDir: string;
let target: string;
let outside: string;

const script = renderShim({
  version: "1.4.0",
  appPath: "/Applications/MarkPDF.app",
  electronPath: "/Applications/MarkPDF.app/Contents/MacOS/MarkPDF",
  entryPoint: "/Applications/MarkPDF.app/Contents/Resources/app.asar/dist-cli/main.js",
  dataDir: "/Users/me/Library/Application Support/markpdf",
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "markpdf-install-"));
  target = join(workDir, "bin", "markpdf");
  outside = join(workDir, "elsewhere.txt");
  writeFileSync(outside, "something the application must not touch");
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("installing", () => {
  it("writes the command and makes it executable", () => {
    const result = installShimFile(target, script);

    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(script);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it("creates the directory when it is not there yet", () => {
    installShimFile(target, script);

    expect(statSync(join(workDir, "bin")).isDirectory()).toBe(true);
  });

  it("replaces a shim it wrote before", () => {
    installShimFile(target, script);
    const updated = script.replace("1.4.0", "1.5.0");

    expect(installShimFile(target, updated).ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(updated);
  });

  it("leaves no half-written sibling behind", () => {
    installShimFile(target, script);

    expect(readdirSync(join(workDir, "bin"))).toEqual(["markpdf"]);
  });

  it("does not touch an unrelated file that happens to share the staging name", () => {
    // A fixed staging name is a file this application did not create and has no business
    // deleting. Somebody's `markpdf.markpdf-new` note would have been removed twice over.
    mkdirSync(join(workDir, "bin"), { recursive: true });
    const bystander = `${target}.markpdf-new`;
    writeFileSync(bystander, "a file that belongs to somebody else");

    expect(installShimFile(target, script).ok).toBe(true);
    expect(readFileSync(bystander, "utf8")).toBe("a file that belongs to somebody else");
  });

  it("refuses a script carrying a copied marker but a different body", () => {
    // A marker is a claim, not proof. Overwriting or deleting anything that merely quotes ours
    // would let a file be destroyed by copying one line into it.
    mkdirSync(join(workDir, "bin"), { recursive: true });
    const spoofed = `${script}\nrm -rf "$HOME"\n`;
    writeFileSync(target, spoofed);

    expect(installShimFile(target, script).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(spoofed);
  });

  it("refuses a shim of ours that somebody has since edited", () => {
    // An edited shim is somebody's deliberate change. Replacing it silently would discard it.
    installShimFile(target, script);
    const edited = `${readFileSync(target, "utf8")}# a line somebody added\n`;
    writeFileSync(target, edited);

    expect(installShimFile(target, script).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(edited);
  });

  it("refuses a symbolic link, and does not write through it", () => {
    // A link planted at the install path would send the write wherever it points — which is how
    // an install action becomes a way to overwrite an arbitrary file.
    mkdirSync(join(workDir, "bin"), { recursive: true });
    symlinkSync(outside, target);

    const result = installShimFile(target, script);

    expect(result.ok).toBe(false);
    // Named as a link, not lumped in with "not a regular file". Both refuse, but only one of
    // them tells the person what is actually there.
    expect(result.ok === false && result.reason).toContain("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("something the application must not touch");
  });

  it("refuses a directory at that path", () => {
    mkdirSync(target, { recursive: true });

    expect(installShimFile(target, script).ok).toBe(false);
  });

  it("refuses a file somebody else wrote, and leaves it exactly as it was", () => {
    mkdirSync(join(workDir, "bin"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexec /opt/homebrew/bin/markpdf \"$@\"\n");

    const result = installShimFile(target, script);

    expect(result.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("/opt/homebrew/bin/markpdf");
  });

  it("says why it refused, in words that name the path", () => {
    mkdirSync(join(workDir, "bin"), { recursive: true });
    writeFileSync(target, "not ours");
    const result = installShimFile(target, script);

    expect(result.ok === false && result.reason).toContain(target);
  });
});

describe("removing", () => {
  it("removes a shim this application wrote", () => {
    installShimFile(target, script);

    expect(removeShimFile(target).ok).toBe(true);
    expect(readdirSync(join(workDir, "bin"))).toEqual([]);
  });

  it("is content when there is nothing to remove", () => {
    expect(removeShimFile(target).ok).toBe(true);
  });

  it("refuses to remove a file somebody else wrote", () => {
    mkdirSync(join(workDir, "bin"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\necho not ours\n");

    expect(removeShimFile(target).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("not ours");
  });

  it("refuses to remove a script that only copied our marker", () => {
    mkdirSync(join(workDir, "bin"), { recursive: true });
    const spoofed = `${script}# and something else entirely\n`;
    writeFileSync(target, spoofed);

    expect(removeShimFile(target).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(spoofed);
  });

  it("refuses to remove a symbolic link, whatever it points at", () => {
    // Following it would delete the link's target, which is a file nobody asked about.
    mkdirSync(join(workDir, "bin"), { recursive: true });
    symlinkSync(outside, target);

    const result = removeShimFile(target);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("symbolic link");
    expect(readFileSync(outside, "utf8")).toBe("something the application must not touch");
  });
});

describe("deciding what is at the install path", () => {
  it("recognises a shim exactly as this application would write it", () => {
    installShimFile(target, script);

    expect(classifyShimOccupant(target).kind).toBe("ours");
  });

  it("says nothing is there when nothing is", () => {
    expect(classifyShimOccupant(target).kind).toBe("nothing");
  });

  it("calls a symbolic link foreign without following it", () => {
    // Following it would read a file somewhere else and could report the command as installed and
    // current when the thing at the install path is a link the application refuses to write.
    mkdirSync(join(workDir, "bin"), { recursive: true });
    const real = join(workDir, "real-markpdf");
    writeFileSync(real, script);
    symlinkSync(real, target);

    expect(classifyShimOccupant(target).kind).toBe("foreign");
  });

  it("calls a directory foreign", () => {
    mkdirSync(target, { recursive: true });

    expect(classifyShimOccupant(target).kind).toBe("foreign");
  });
});
