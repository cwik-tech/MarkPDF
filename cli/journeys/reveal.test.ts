import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopRequestsDir } from "../../dist-core/paths.js";
import { EXIT_CODE } from "../exit.js";
import { buildReviewedContract } from "../../core/annotations/reviewedContract.test-support.js";
import { runCli } from "./runCli.test-support.js";

/**
 * `markpdf reveal` refuses before it starts anything.
 *
 * A reveal that may not happen must not write a request or launch the desktop: the client checks
 * the grants and the open-document record first. What the desktop does with an allowed request is
 * the Electron journey's to show; this proves the command never gets that far when it should not.
 */

let dataDir: string;
let libraryDir: string;
let fixture: string;

function requestFiles(): string[] {
  const directory = desktopRequestsDir(dataDir);
  return existsSync(directory) ? readdirSync(directory) : [];
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-reveal-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-reveal-lib-")));
  fixture = join(libraryDir, "contract.pdf");
  writeFileSync(fixture, await buildReviewedContract());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("markpdf reveal", () => {
  it("refuses a document outside the grants, with the grant remedy, and sends nothing", async () => {
    const run = await runCli(["reveal", "--path", fixture, "--page", "1"], { dataDir });
    expect(run.code).toBe(EXIT_CODE.accessDenied);
    expect(run.stderr).toContain("--allow-read");
    expect(requestFiles()).toEqual([]);
  });

  it("refuses the active document when MarkPDF has nothing open, and sends nothing", async () => {
    const run = await runCli(["reveal", "--ref", "active", "--page", "1"], { dataDir });
    expect(run.code).toBe(EXIT_CODE.notFound);
    expect(run.stderr).toContain("no document open");
    expect(requestFiles()).toEqual([]);
  });

  it("needs a page", async () => {
    const run = await runCli(["reveal", "--path", fixture], { dataDir });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain("--page is required.");
  });
});
