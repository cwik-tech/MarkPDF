import { describe, expect, it } from "vitest";
import { describeCliInstall } from "./cliInstallCopy";
import type { CliInstallStatus } from "./global";

/**
 * What somebody is told about the `markpdf` command.
 *
 * The distinction that matters is between "it is installed" and "typing it runs ours". A settings
 * screen that reported the first while the second was false would be reassuring and wrong.
 */

const base: CliInstallStatus = {
  supported: true,
  command: "markpdf",
  installDirectory: "/Users/me/.local/bin",
  installPath: "/Users/me/.local/bin/markpdf",
  version: "1.4.0",
  state: { state: "current", path: "/Users/me/.local/bin/markpdf" },
  pathHint: 'export PATH=\'/Users/me/.local/bin\':"$PATH"',
  onDefaultPath: false,
};

const withState = (state: CliInstallStatus["state"]): CliInstallStatus => ({ ...base, state });

describe("when the command works", () => {
  it("says so and offers to remove it", () => {
    const copy = describeCliInstall(base);

    expect(copy.working).toBe(true);
    expect(copy.action).toBe("remove");
  });
});

describe("when it is not there", () => {
  it("offers to install it", () => {
    const copy = describeCliInstall(withState({ state: "not-installed", path: base.installPath }));

    expect(copy.action).toBe("install");
    expect(copy.working).toBe(false);
  });
});

describe("when it is out of date", () => {
  it("does not claim the command works, because nothing checked whether it does", () => {
    // `describeInstallation` answers `stale` before it ever looks at PATH, so at this point there
    // is no evidence the name reaches anything. Showing a working indicator on no evidence is the
    // kind of reassurance that stops somebody investigating.
    const copy = describeCliInstall(
      withState({ state: "stale", path: base.installPath, installedVersion: "1.3.0", differences: ["version"] }),
    );

    expect(copy.working).toBe(false);
  });

  it("names both versions, so the person can see what would change", () => {
    const copy = describeCliInstall(
      withState({ state: "stale", path: base.installPath, installedVersion: "1.3.0", differences: ["version"] }),
    );

    expect(copy.summary).toContain("1.3.0");
    expect(copy.summary).toContain("1.4.0");
    expect(copy.action).toBe("update");
  });

  it("says what else drifted when the version did not", () => {
    // A command at the right version writing to a different index is the quietest way to be
    // wrong, so it must not read as "up to date".
    const copy = describeCliInstall(
      withState({ state: "stale", path: base.installPath, installedVersion: "1.4.0", differences: ["dataDir"] }),
    );

    expect(copy.summary).toContain("dataDir");
    expect(copy.action).toBe("update");
  });
});

describe("when it is there but cannot run", () => {
  it("says so and offers to repair it rather than showing it as working", () => {
    const copy = describeCliInstall(withState({ state: "not-executable", path: base.installPath }));

    expect(copy.working).toBe(false);
    expect(copy.action).toBe("reinstall");
    expect(copy.summary).toContain("cannot run it");
  });
});

describe("when the shell's PATH could not be read", () => {
  it("says the command is installed without claiming it works", () => {
    const copy = describeCliInstall(withState({ state: "path-unknown", path: base.installPath }));

    expect(copy.working).toBe(false);
    expect(copy.summary).toContain(base.installPath);
    expect(copy.instruction).toContain("could not read your shell");
  });

  it("says nothing extra when the directory is one every shell already looks in", () => {
    const copy = describeCliInstall({
      ...base,
      onDefaultPath: true,
      state: { state: "path-unknown", path: base.installPath },
    });

    expect(copy.instruction).toBeNull();
  });
});

describe("when it runs a different copy of the application", () => {
  it("does not claim the command works either, for the same reason", () => {
    expect(
      describeCliInstall(
        withState({ state: "points-elsewhere", path: base.installPath, installedAppPath: "/Users/me/Downloads/MarkPDF.app" }),
      ).working,
    ).toBe(false);
  });

  it("names that copy, because two copies sharing one index is the thing to notice", () => {
    const copy = describeCliInstall(
      withState({ state: "points-elsewhere", path: base.installPath, installedAppPath: "/Users/me/Downloads/MarkPDF.app" }),
    );

    expect(copy.summary).toContain("/Users/me/Downloads/MarkPDF.app");
    expect(copy.action).toBe("reinstall");
  });
});

describe("when something else owns the name", () => {
  it("offers nothing and says what the person would have to do", () => {
    const copy = describeCliInstall(withState({ state: "foreign", path: base.installPath }));

    expect(copy.action).toBe("none");
    expect(copy.actionLabel).toBeNull();
    expect(copy.instruction).toContain(base.installPath);
    expect(copy.working).toBe(false);
  });
});

describe("when a different markpdf is found first", () => {
  it("says the command does not work, even though ours is installed", () => {
    const copy = describeCliInstall(
      withState({ state: "shadowed", path: base.installPath, shadowedBy: "/opt/homebrew/bin/markpdf" }),
    );

    expect(copy.working).toBe(false);
    expect(copy.summary).toContain("/opt/homebrew/bin/markpdf");
    expect(copy.instruction).toContain("PATH");
  });

  it("still offers to remove it, because ours is installed either way", () => {
    const copy = describeCliInstall(
      withState({ state: "shadowed", path: base.installPath, shadowedBy: "/opt/homebrew/bin/markpdf" }),
    );

    expect(copy.action).toBe("remove");
  });
});

describe("when the directory is not on PATH", () => {
  it("says the command does not work, and gives the line to paste", () => {
    const copy = describeCliInstall(withState({ state: "not-on-path", path: base.installPath }));

    expect(copy.working).toBe(false);
    expect(copy.instruction).toContain(base.pathHint);
  });

  it("still offers to remove it", () => {
    expect(describeCliInstall(withState({ state: "not-on-path", path: base.installPath })).action).toBe("remove");
  });
});

describe("where a shell script means nothing", () => {
  it("repeats the reason it was given rather than inventing one", () => {
    const copy = describeCliInstall({ ...base, supported: false, reason: "Windows does not run POSIX shell scripts." });

    expect(copy.summary).toBe("Windows does not run POSIX shell scripts.");
    expect(copy.action).toBe("none");
  });
});
