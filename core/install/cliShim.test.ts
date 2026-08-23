import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeInstallation, occupantForScript, parseShimIdentity, renderShim, SHIM_MARKER_PREFIX } from "./cliShim.js";

const run = promisify(execFile);

/**
 * The `markpdf` command a person types, and whether the one on their PATH is this application's.
 *
 * The shim exists so the command line runs against the Electron binary that already ships inside
 * the app — one signing target instead of two, and no dependence on whichever of nvm, volta, asdf
 * or mise happens to win on someone's PATH. Everything here is a decision about text and paths,
 * with no filesystem, so the rules are testable without installing anything.
 */

const identity = {
  version: "1.4.0",
  appPath: "/Applications/MarkPDF.app",
  electronPath: "/Applications/MarkPDF.app/Contents/MacOS/MarkPDF",
  entryPoint: "/Applications/MarkPDF.app/Contents/Resources/app.asar/dist-cli/main.js",
  dataDir: "/Users/me/Library/Application Support/markpdf",
};

const survey = {
  installPath: "/Users/me/.local/bin/markpdf",
  occupant: occupantForScript(renderShim(identity)),
  onPath: ["/Users/me/.local/bin/markpdf"],
  directoryOnPath: true,
  pathKnown: true,
  installedIsExecutable: true,
  expected: identity,
};

describe("the shim script", () => {
  it("runs the application's own Electron binary as a plain Node process", () => {
    const script = renderShim(identity);

    expect(script).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain(identity.electronPath);
    expect(script).toContain(identity.entryPoint);
  });

  it("starts with a shebang, so it is executable as written", () => {
    expect(renderShim(identity).startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("passes the caller's arguments through", () => {
    expect(renderShim(identity)).toContain('"$@"');
  });

  it("quotes every path, so a bundle installed somewhere with a space still runs", () => {
    const spaced = { ...identity, electronPath: "/Volumes/My Disk/MarkPDF.app/Contents/MacOS/MarkPDF" };

    expect(renderShim(spaced)).toContain("'/Volumes/My Disk/MarkPDF.app/Contents/MacOS/MarkPDF'");
  });

  it("bakes in the data directory, so the command and the application share one index", () => {
    expect(renderShim(identity)).toContain(identity.dataDir);
  });

  it("still lets somebody point it elsewhere for one run", () => {
    expect(renderShim(identity)).toContain('if [ -z "${MARKPDF_DATA_DIR:-}" ]; then');
  });
});

describe("the shim as a real shell actually runs it", () => {
  // Rendering the right-looking text is not the claim; the claim is that `/bin/sh` does the right
  // thing with it. An earlier version nested the quoted path inside `"${VAR:=word}"`, where the
  // word is not re-parsed — so the variable was assigned a value complete with its quotation
  // marks, and nothing that only read the script would have noticed.
  let workDir: string;
  let shim: string;
  let dataDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "markpdf-shim-run-"));
    // Spaces and a dollar sign, because those are what quoting is for.
    dataDir = join(workDir, "Application Support", "mark $pdf");
    mkdirSync(dataDir, { recursive: true });

    // Stands in for the Electron binary: prints what the shim set and what it was handed.
    const stub = join(workDir, "fake electron");
    writeFileSync(stub, '#!/bin/sh\nprintf "DATA_DIR=[%s]\\n" "$MARKPDF_DATA_DIR"\nprintf "NODE=[%s]\\n" "$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do printf "ARG=[%s]\\n" "$a"; done\n');
    chmodSync(stub, 0o755);

    // The shim checks that the entry point is reachable before it execs, so it has to exist.
    writeFileSync(join(workDir, "main entry.js"), "");

    shim = join(workDir, "markpdf");
    writeFileSync(
      shim,
      renderShim({ ...identity, electronPath: stub, entryPoint: join(workDir, "main entry.js"), dataDir }),
    );
    chmodSync(shim, 0o755);
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("sets the data directory to the path itself, not to a quoted copy of it", async () => {
    const { stdout } = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } });

    expect(stdout).toContain(`DATA_DIR=[${dataDir}]`);
  });

  it("leaves an explicit setting alone, so one run can point somewhere else", async () => {
    const { stdout } = await run(shim, [], {
      env: { PATH: process.env.PATH ?? "", MARKPDF_DATA_DIR: "/somewhere/else" },
    });

    expect(stdout).toContain("DATA_DIR=[/somewhere/else]");
  });

  it("runs the bundled binary as a plain Node process", async () => {
    const { stdout } = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } });

    expect(stdout).toContain("NODE=[1]");
  });

  it("exits 69 when the application it was installed from is no longer there", async () => {
    // `exec` on a missing binary is a shell error — 126 or 127 — which says nothing about which
    // application is missing. 69 is the documented code for exactly this, and it is only
    // reachable if the script looks before it leaps.
    const gone = join(workDir, "not-here", "MarkPDF");
    writeFileSync(shim, renderShim({ ...identity, electronPath: gone, entryPoint: join(workDir, "main.js"), dataDir }));
    chmodSync(shim, 0o755);
    writeFileSync(join(workDir, "main.js"), "");

    const failure = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } }).catch((error: unknown) => error);

    expect((failure as { code?: number }).code).toBe(69);
    expect(String((failure as { stderr?: string }).stderr)).toContain("MarkPDF");
  });

  it("exits 69 when the application is there but cannot be run", async () => {
    // Deliberately not "MarkPDF": the shim beside it is called "markpdf", and macOS volumes are
    // case-insensitive by default, so that name would overwrite the very script under test.
    const notRunnable = join(workDir, "unrunnable-electron");
    writeFileSync(notRunnable, "#!/bin/sh\nexit 0\n");
    chmodSync(notRunnable, 0o644);
    writeFileSync(join(workDir, "main.js"), "");
    writeFileSync(shim, renderShim({ ...identity, electronPath: notRunnable, entryPoint: join(workDir, "main.js"), dataDir }));
    chmodSync(shim, 0o755);

    const failure = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } }).catch((error: unknown) => error);

    expect((failure as { code?: number }).code).toBe(69);
  });

  it("exits 69 when the application is there but its command line is missing", async () => {
    writeFileSync(shim, renderShim({ ...identity, electronPath: join(workDir, "fake electron"), entryPoint: join(workDir, "absent", "main.js"), dataDir }));
    chmodSync(shim, 0o755);

    const failure = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } }).catch((error: unknown) => error);

    expect((failure as { code?: number }).code).toBe(69);
  });

  it("looks for the archive rather than a path inside it, which no shell can stat", async () => {
    // A packaged entry point lives at `…/app.asar/dist-cli/main.js`, and `app.asar` is a file.
    // Testing the entry point directly would report every packaged installation as broken.
    const archive = join(workDir, "app.asar");
    writeFileSync(archive, "pretend archive");
    writeFileSync(shim, renderShim({ ...identity, electronPath: join(workDir, "fake electron"), entryPoint: join(archive, "dist-cli", "main.js"), dataDir }));
    chmodSync(shim, 0o755);

    const { stdout } = await run(shim, [], { env: { PATH: process.env.PATH ?? "" } });

    expect(stdout).toContain("NODE=[1]");
  });

  it("hands the entry point and the caller's arguments through as single words", async () => {
    const { stdout } = await run(shim, ["search", "two words", "--path", "/a b/c.pdf"], {
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(stdout).toContain(`ARG=[${join(workDir, "main entry.js")}]`);
    expect(stdout).toContain("ARG=[search]");
    expect(stdout).toContain("ARG=[two words]");
    expect(stdout).toContain("ARG=[/a b/c.pdf]");
  });
});

describe("recognising a shim as ours", () => {
  it("reads back exactly what was written into it", () => {
    expect(parseShimIdentity(renderShim(identity))).toEqual(identity);
  });

  it("does not claim a script somebody else wrote", () => {
    expect(parseShimIdentity("#!/bin/sh\nexec /usr/local/bin/markpdf-real \"$@\"\n")).toBeNull();
  });

  it("does not claim a marker that is not readable", () => {
    expect(parseShimIdentity(`#!/bin/sh\n${SHIM_MARKER_PREFIX}{not json}\n`)).toBeNull();
  });

  it("does not claim a marker missing the fields status depends on", () => {
    expect(parseShimIdentity(`#!/bin/sh\n${SHIM_MARKER_PREFIX}{"version":"1.0.0"}\n`)).toBeNull();
  });
});

describe("what the settings screen should say", () => {
  it("reports a matching shim on PATH as installed and current", () => {
    expect(describeInstallation(survey)).toEqual({ state: "current", path: survey.installPath });
  });

  it("reports nothing at the install path as not installed", () => {
    expect(describeInstallation({ ...survey, occupant: { kind: "nothing" as const }, onPath: [] })).toEqual({
      state: "not-installed",
      path: survey.installPath,
    });
  });

  it("reports a file it did not write as a conflict, and never offers to overwrite it silently", () => {
    const foreign = "#!/bin/sh\nexec /opt/homebrew/bin/markpdf \"$@\"\n";

    expect(describeInstallation({ ...survey, occupant: occupantForScript(foreign) })).toEqual({
      state: "foreign",
      path: survey.installPath,
    });
  });

  it("reports a shim from an older version as stale", () => {
    const older = renderShim({ ...identity, version: "1.3.0" });

    expect(describeInstallation({ ...survey, occupant: occupantForScript(older) })).toEqual({
      state: "stale",
      path: survey.installPath,
      installedVersion: "1.3.0",
      differences: ["version"],
    });
  });

  it("reports a shim that runs the wrong file as stale, even at the right version", () => {
    // A shim carrying today's version and yesterday's entry point runs yesterday's code. Version
    // is not the only thing that can be wrong with it.
    const moved = renderShim({ ...identity, entryPoint: "/Applications/MarkPDF.app/Contents/Resources/old/main.js" });

    expect(describeInstallation({ ...survey, occupant: occupantForScript(moved) })).toEqual({
      state: "stale",
      path: survey.installPath,
      installedVersion: identity.version,
      differences: ["entryPoint"],
    });
  });

  it("reports a shim writing to a different index as stale, which is the quietest way to be wrong", () => {
    const otherIndex = renderShim({ ...identity, dataDir: "/Users/me/Library/Application Support/markpdf-old" });

    expect(describeInstallation({ ...survey, occupant: occupantForScript(otherIndex) })).toEqual({
      state: "stale",
      path: survey.installPath,
      installedVersion: identity.version,
      differences: ["dataDir"],
    });
  });

  it("reports a shim launching a different binary as stale", () => {
    const otherBinary = renderShim({ ...identity, electronPath: "/usr/local/bin/electron" });

    expect(describeInstallation({ ...survey, occupant: occupantForScript(otherBinary) })).toEqual({
      state: "stale",
      path: survey.installPath,
      installedVersion: identity.version,
      differences: ["electronPath"],
    });
  });

  it("names every field that differs, not only the first", () => {
    const drifted = renderShim({ ...identity, version: "1.3.0", dataDir: "/elsewhere" });
    const state = describeInstallation({ ...survey, occupant: occupantForScript(drifted) });

    expect(state.state === "stale" && state.differences).toEqual(["version", "dataDir"]);
  });

  it("reports a shim pointing at a different copy of the application", () => {
    const elsewhere = renderShim({ ...identity, appPath: "/Users/me/Downloads/MarkPDF.app" });

    expect(describeInstallation({ ...survey, occupant: occupantForScript(elsewhere) })).toEqual({
      state: "points-elsewhere",
      path: survey.installPath,
      installedAppPath: "/Users/me/Downloads/MarkPDF.app",
    });
  });

  it("reports another markpdf earlier on PATH, because that is the one that would run", () => {
    expect(
      describeInstallation({ ...survey, onPath: ["/opt/homebrew/bin/markpdf", survey.installPath] }),
    ).toEqual({ state: "shadowed", path: survey.installPath, shadowedBy: "/opt/homebrew/bin/markpdf" });
  });

  it("declines to say which markpdf runs when it could not read the shell's PATH", () => {
    // A Finder-launched application inherits launchd's minimal PATH, not the login shell's.
    // Claiming "shadowed" or "not on PATH" from that would be a guess dressed as a finding.
    expect(describeInstallation({ ...survey, pathKnown: false, onPath: [], directoryOnPath: false })).toEqual({
      state: "path-unknown",
      path: survey.installPath,
    });
  });

  it("does not report a shim the shell cannot run as the working command", () => {
    // The file is exactly ours and cannot start. Calling that `current` would show a working
    // indicator for a command that does nothing.
    expect(describeInstallation({ ...survey, installedIsExecutable: false, onPath: [] })).toEqual({
      state: "not-executable",
      path: survey.installPath,
    });
  });

  it("says so even when the shell's PATH could not be read", () => {
    // Whether the file can execute is a fact about the file. Making it wait on a PATH answer
    // hides the one state that has a button to fix it, and reports a second broken state instead.
    expect(
      describeInstallation({ ...survey, installedIsExecutable: false, pathKnown: false, onPath: [], directoryOnPath: false }),
    ).toEqual({ state: "not-executable", path: survey.installPath });
  });

  it("says so even when its directory is nowhere on PATH", () => {
    // "Add this to your PATH" is useless advice for a file that would still not run.
    expect(
      describeInstallation({ ...survey, installedIsExecutable: false, onPath: [], directoryOnPath: false }),
    ).toEqual({ state: "not-executable", path: survey.installPath });
  });

  it("still reports the identity problems first, because reinstalling fixes those too", () => {
    // A shim that is both stale and unreadable is stale: the repair is the same write either way,
    // and naming the version is the more useful of the two sentences.
    const older = renderShim({ ...identity, version: "1.3.0" });

    expect(
      describeInstallation({ ...survey, occupant: occupantForScript(older), installedIsExecutable: false }),
    ).toEqual({ state: "stale", path: survey.installPath, installedVersion: "1.3.0", differences: ["version"] });
  });

  it("reports a correct shim in a directory nobody can reach", () => {
    // Installing without elevation means a directory that is often not on PATH yet. Saying the
    // command is installed while typing it does nothing would be the least helpful answer.
    expect(describeInstallation({ ...survey, onPath: [], directoryOnPath: false })).toEqual({
      state: "not-on-path",
      path: survey.installPath,
    });
  });

  it("prefers the conflict it cannot fix over the one it can", () => {
    // A foreign file and a stale version cannot both be true, but a foreign file and a shadow
    // can. Overwriting is refused either way, so the conflict at the install path is what to say.
    const foreign = "#!/bin/sh\necho hello\n";

    expect(
      describeInstallation({ ...survey, occupant: occupantForScript(foreign), onPath: ["/opt/homebrew/bin/markpdf", survey.installPath] }),
    ).toEqual({ state: "foreign", path: survey.installPath });
  });
});

describe("the copy of this contract the renderer reads", () => {
  it("declares the same states, because the renderer cannot import core", () => {
    // The renderer never imports from `core/` or `dist-core/`; IPC shapes cross as declarations
    // in `src/global.d.ts`. That is a copy, and a copy drifts unless something compares it.
    const source = readFileSync("core/install/cliShim.ts", "utf8");
    const declared = readFileSync("src/global.d.ts", "utf8");
    const states = [...source.matchAll(/\{ state: "([a-z-]+)"/g)].map((match) => match[1]);

    expect(states.length).toBeGreaterThan(0);
    for (const state of new Set(states)) {
      expect(declared).toContain(`state: "${state}"`);
    }
  });
});

describe("what counts as a shim this application wrote", () => {
  it("accepts the script exactly as it renders it", () => {
    expect(occupantForScript(renderShim(identity))).toEqual({ kind: "ours", identity });
  });

  it("refuses a script that only copied the marker line", () => {
    // The marker is one line. Anything could quote it, and treating that as ownership would let a
    // file be overwritten or deleted by copying a comment into it.
    expect(occupantForScript(`${renderShim(identity)}echo something else\n`).kind).toBe("foreign");
  });

  it("refuses a shim somebody has edited since", () => {
    expect(occupantForScript(renderShim(identity).replace("exec ", "echo ")).kind).toBe("foreign");
  });

  it("refuses a script with no marker at all", () => {
    expect(occupantForScript("#!/bin/sh\nexec markpdf-real \"$@\"\n").kind).toBe("foreign");
  });
});
