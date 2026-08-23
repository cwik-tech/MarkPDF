import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReportPdf } from "./fixtures.test-support.js";
import { installShim, jsonOf, runCli, runShell } from "./runCli.test-support.js";
import { EXIT_CODE } from "../exit.js";
import { semanticIndexPath } from "../../dist-core/paths.js";

/**
 * V7 and V8: the two checks that prove the consent model is implemented rather than asserted.
 *
 * The library directory's name deliberately contains a space, because the remedy printed by a
 * refusal is claimed to be runnable and that claim is only worth something if it survives a real
 * shell parsing it.
 */

let dataDir: string;
let libraryDir: string;
let binDir: string;
let fixture: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-consent-data-")));
  // Realpathed, because that is the spelling an ordinary path under someone's home already has,
  // and because the index records the path it actually read.
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf journey library ")));
  binDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-consent-bin-")));
  installShim(binDir);
  fixture = join(libraryDir, "annual-report.pdf");
  writeFileSync(fixture, await buildReportPdf());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir, binDir]) rmSync(directory, { recursive: true, force: true });
});

describe("V7 — a document nobody granted", () => {
  it("refuses it, prints a command that really does fix it, and writes nothing in the meantime", async () => {
    const refused = await runCli(["index", fixture], { dataDir });

    expect(refused.code).toBe(EXIT_CODE.accessDenied);
    // Nothing was permitted, so nothing was created: no index, and no consent record either.
    expect(existsSync(semanticIndexPath(dataDir))).toBe(false);
    expect(existsSync(join(dataDir, "consent"))).toBe(false);

    const remedy = /^Try: (.+)$/m.exec(refused.stderr)?.[1];
    expect(remedy).toBeDefined();
    expect(remedy).toContain("--allow-read");

    // Run it as written, through a shell, with `markpdf` on PATH. This is the assertion that
    // matters: a remedy that needed hand-editing would not be a remedy.
    const granted = await runShell(remedy!, { dataDir, binDir });
    expect(granted.code).toBe(EXIT_CODE.success);

    const accepted = await runCli(["index", fixture, "--json"], { dataDir });
    expect(accepted.code).toBe(EXIT_CODE.success);
    expect((jsonOf(accepted) as { documents: unknown[] }).documents).toHaveLength(1);
  }, 180_000);
});

describe("V8 — a document that is already indexed", () => {
  it("stays searchable after its folder is no longer granted, and does so without reading it", async () => {
    await runCli(["--allow-read", libraryDir], { dataDir });
    const indexed = await runCli(["index", fixture, "--json"], { dataDir });
    expect(indexed.code).toBe(EXIT_CODE.success);

    // Consent withdrawn. From here the command may not touch this directory at all.
    const withdrawn = await runCli(["--revoke-read", libraryDir], { dataDir });
    expect(withdrawn.code).toBe(EXIT_CODE.success);

    const denied = await runCli(["convert", fixture], { dataDir });
    expect(denied.code).toBe(EXIT_CODE.accessDenied);

    const found = await runCli(["search", "Enterprise 1204 1318", "--path", fixture, "--min-score", "0.1", "--json"], {
      dataDir,
    });

    expect(found.code).toBe(EXIT_CODE.success);
    const search = jsonOf(found) as { readFromDisk: boolean; results: Array<{ page: number }> };
    expect(search.results[0]?.page).toBe(2);
    // The claim is not merely that it answered, but that it answered without the filesystem.
    expect(search.readFromDisk).toBe(false);
  }, 180_000);
});
