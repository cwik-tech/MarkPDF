import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShellPath, removeShellPath } from "./shellProfile.js";

let workDir: string;
let profileDir: string;
let profilePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "markpdf-shell-profile-"));
  profileDir = join(workDir, "shell");
  profilePath = join(profileDir, ".zshrc");
  mkdirSync(profileDir, { recursive: true });
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("installing the command directory in the shell profile", () => {
  it("adds one managed block while preserving existing configuration", () => {
    writeFileSync(profilePath, "# Existing shell configuration\n", "utf8");

    const outcome = installShellPath({
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    });

    expect(outcome).toEqual({ ok: true, changed: true, profilePath });
    expect(readFileSync(profilePath, "utf8")).toBe(
      `# Existing shell configuration\n\n# >>> MarkPDF command >>>\nexport PATH='${join(workDir, "bin")}':\"$PATH\"\n# <<< MarkPDF command <<<\n`,
    );
  });

  it("creates a missing zsh profile and does not duplicate its block", () => {
    const input = {
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    };

    expect(installShellPath(input)).toMatchObject({ ok: true, changed: true, profilePath });
    const once = readFileSync(profilePath, "utf8");
    expect(installShellPath(input)).toEqual({ ok: true, changed: false, profilePath });
    expect(readFileSync(profilePath, "utf8")).toBe(once);
  });

  it("quotes a directory as data rather than executable shell syntax", () => {
    const dangerousDirectory = join(workDir, "bin'; touch should-not-exist; echo '");

    const outcome = installShellPath({
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: dangerousDirectory,
    });

    expect(outcome.ok).toBe(true);
    expect(readFileSync(profilePath, "utf8")).toContain("'\\''");
  });

  it("updates a symlink target without replacing the profile symlink", () => {
    const target = join(workDir, "shared-zshrc");
    writeFileSync(target, "# Shared profile\n", { encoding: "utf8", mode: 0o600 });
    symlinkSync(target, profilePath);

    const outcome = installShellPath({
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    });

    expect(outcome.ok).toBe(true);
    expect(lstatSync(profilePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("# >>> MarkPDF command >>>");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("refuses an unsupported shell without changing a profile", () => {
    const outcome = installShellPath({
      env: { SHELL: "/opt/homebrew/bin/fish" },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("fish");
  });
});

describe("removing the managed shell profile block", () => {
  it("restores the profile content that existed before installation", () => {
    const original = "# Existing shell configuration\n";
    writeFileSync(profilePath, original, "utf8");
    const input = {
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    };
    installShellPath(input);

    expect(removeShellPath(input)).toEqual({ ok: true, changed: true, profilePath });
    expect(readFileSync(profilePath, "utf8")).toBe(original);
  });

  it("leaves a person's similar PATH line untouched when there is no managed block", () => {
    const manual = `export PATH='${join(workDir, "bin")}':\"$PATH\"\n`;
    writeFileSync(profilePath, manual, "utf8");
    const input = {
      env: { SHELL: "/bin/zsh", ZDOTDIR: profileDir },
      homeDirectory: workDir,
      installDirectory: join(workDir, "bin"),
    };

    expect(removeShellPath(input)).toEqual({ ok: true, changed: false, profilePath });
    expect(readFileSync(profilePath, "utf8")).toBe(manual);
  });
});
