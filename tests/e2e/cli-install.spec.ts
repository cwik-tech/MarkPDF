import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);

/**
 * Installing and removing the `markpdf` command from Settings.
 *
 * The pieces of this were already covered — the script, the filesystem rules, the sentences —
 * but each was covered on its own. What nothing proved was that the button is wired to them:
 * renderer state, the preload bridge, the IPC handler, and a file appearing on disk. That is the
 * whole of this journey, and it is the layer `AGENTS.md` asks for when preload and IPC are
 * involved.
 *
 * The destination is a temporary directory, selected through a seam that refuses unless the build
 * is unpackaged, opted in by an exact token, and already pointed at a test profile — so a real
 * `bin` directory is never touched by a test run, and a released build cannot reach this path.
 */

test("installs the markpdf command from settings and removes it again", async () => {
  // The repository's journeys are budgeted well under this; the explicit cap keeps a regression
  // in the launch path visible as a timeout rather than a long wait.
  test.setTimeout(30_000);
  const workDir = await mkdtemp(path.join(tmpdir(), "markpdf-cli-install-"));
  const userDataPath = path.join(workDir, "user-data");
  const binDir = path.join(workDir, "bin");
  const commandPath = path.join(binDir, "markpdf");
  let app: ElectronApplication | null = null;
  let window: Page | null = null;

  try {
    app = await electron.launch({
      executablePath: electronPath,
      // No document: this journey is about the command, and an opened PDF would start indexing
      // and put a progress dialog over the settings button.
      args: [path.join(projectRoot, "dist-electron/bootstrap.js")],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        MARKPDF_TEST_USER_DATA: userDataPath,
        MARKPDF_DATA_DIR: userDataPath,
        MARKPDF_E2E_CLI_INSTALL: "test-install-directory",
        MARKPDF_TEST_CLI_INSTALL_DIR: binDir,
        // The renderer is loaded from Playwright's own dev server, which builds with
        // `VITE_MARKPDF_E2E=1`. That flag is what stops the application installing its Markdown
        // conversion environment on first launch — a several-minute job behind a modal that would
        // otherwise sit over the settings button for the whole run.
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });

    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByTitle("Settings").click();
    await window.getByRole("button", { name: "General" }).click();

    const section = window.locator(".settings-section", { hasText: "Command Line" });
    await expect(section).toBeVisible({ timeout: 15_000 });
    // The offered action is the observable state: "Install command" appears only when the status
    // says nothing of ours is there.
    const install = section.getByRole("button", { name: "Install command" });
    await expect(install).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText("is not installed");
    expect(existsSync(commandPath)).toBe(false);

    await install.click();

    // What the settings screen now says, and the file that is actually there.
    await expect(section.getByRole("button", { name: "Remove command" })).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText(binDir);
    expect(existsSync(commandPath)).toBe(true);
    const installed = await stat(commandPath);
    expect(installed.mode & 0o111).toBeGreaterThan(0);

    // An executable bit is not a working command. The shim bakes in a binary and an entry point,
    // and a stale or missing one is exactly the failure this journey exists to catch — so it is
    // run, not merely inspected.
    const version = await run(commandPath, ["--version"], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000 });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    // A mode that was changed is invisible to anything that only reads the file, and the state it
    // produces is the one with a button attached — so this is the path that has to be wired all
    // the way through: filesystem, status, IPC, bridge, copy, button, filesystem again.
    await chmod(commandPath, 0o644);
    await section.getByRole("button", { name: "Refresh" }).click();
    await expect(section.getByRole("button", { name: "Repair command" })).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText("cannot run it");

    await section.getByRole("button", { name: "Repair command" }).click();

    await expect(section.getByRole("button", { name: "Remove command" })).toBeVisible({ timeout: 15_000 });
    expect((await stat(commandPath)).mode & 0o111).toBeGreaterThan(0);

    await section.getByRole("button", { name: "Remove command" }).click();

    await expect(section.getByRole("button", { name: "Install command" })).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText("is not installed");
    expect(existsSync(commandPath)).toBe(false);
  } finally {
    await window?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    // Retried: the application sets up a Markdown conversion environment in its data directory in
    // the background, so a directory can still be growing as this runs.
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined);
  }
});
