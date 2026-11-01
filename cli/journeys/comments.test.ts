import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { DEFAULT_REPLY_BUDGET } from "../../dist-core/output/budget.js";
import { allowlistPath } from "../../dist-core/paths.js";
import { EXIT_CODE } from "../exit.js";
import { buildReviewedContract, REVIEWER_NOTE } from "../../core/annotations/reviewedContract.test-support.js";
import { jsonOf, runCli } from "./runCli.test-support.js";

/**
 * `markpdf comments`: the same bounded answer the MCP tool gives, on the command line.
 *
 * Two promises are checked here because only a real process can break them. The output is bounded
 * however much another application wrote into the file, and the command cannot widen its own
 * access: it never offers a grant, and a grant written in front of it is refused before anything
 * is recorded.
 */

let dataDir: string;
let libraryDir: string;
let fixture: string;

/** A page whose reviewer wrote far more than any reply can carry. */
async function buildOverloadedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const refs = Array.from({ length: 80 }, (_, index) =>
    pdf.context.register(
      pdf.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [72, 700 - index * 8, 96, 724 - index * 8],
        Contents: PDFHexString.fromText(`Note ${String(index)}: ${'"quoted" \\ text '.repeat(400)}`),
        T: PDFHexString.fromText("Prolific Reviewer"),
        NM: PDFString.of(`note-${String(index)}`),
      }),
    ),
  );
  page.node.set(PDFName.of("Annots"), pdf.context.obj(refs));
  return await pdf.save();
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-comments-data-")));
  libraryDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-cli-comments-lib-")));
  fixture = join(libraryDir, "contract.pdf");
  writeFileSync(fixture, await buildReviewedContract());
});

afterEach(() => {
  for (const directory of [dataDir, libraryDir]) rmSync(directory, { recursive: true, force: true });
});

describe("markpdf comments", () => {
  it("prints the comments of a granted document as JSON and as text", async () => {
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);

    const json = await runCli(["comments", "--path", fixture, "--json"], { dataDir });
    expect(json.code).toBe(EXIT_CODE.success);
    expect(jsonOf(json)).toMatchObject({ totalComments: 3, nextOffset: null });

    const human = await runCli(["comments", "--path", fixture], { dataDir });
    expect(human.code).toBe(EXIT_CODE.success);
    expect(human.stdout).toContain(REVIEWER_NOTE);
  });

  it("keeps its output inside the reply bound however much a file carries, and says where to continue", async () => {
    const overloaded = join(libraryDir, "overloaded.pdf");
    writeFileSync(overloaded, await buildOverloadedPdf());
    expect((await runCli(["--allow-read", libraryDir], { dataDir })).code).toBe(EXIT_CODE.success);

    const json = await runCli(["comments", "--path", overloaded, "--json"], { dataDir });
    expect(json.code).toBe(EXIT_CODE.success);
    expect(Buffer.byteLength(json.stdout, "utf8")).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET + 1);
    const payload = jsonOf(json);
    expect(payload).toMatchObject({ totalComments: 80, truncated: true });

    const human = await runCli(["comments", "--path", overloaded], { dataDir });
    expect(Buffer.byteLength(human.stdout, "utf8")).toBeLessThanOrEqual(DEFAULT_REPLY_BUDGET + 1);
    expect(human.stderr).toContain("--offset");
  });

  it("refuses a document outside the grants without offering one, also when input is allowed", async () => {
    for (const extra of [[], ["--no-input"]]) {
      const run = await runCli(["comments", "--path", fixture, ...extra], { dataDir });
      expect(run.code).toBe(EXIT_CODE.accessDenied);
      expect(run.stderr).toContain("--allow-read");
    }
    expect(existsSync(allowlistPath(dataDir))).toBe(false);
  });

  it("refuses a grant written in front of it and records nothing", async () => {
    expect((await runCli(["--allow-read", join(libraryDir, "unrelated")], { dataDir })).code).toBe(EXIT_CODE.success);
    const before = readFileSync(allowlistPath(dataDir), "utf8");

    const run = await runCli(["--allow-read", libraryDir, "comments", "--path", fixture], { dataDir });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain("Grant access as a separate command first.");
    expect(readFileSync(allowlistPath(dataDir), "utf8")).toBe(before);
  });
});
