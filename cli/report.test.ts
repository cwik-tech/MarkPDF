import { describe, expect, it } from "vitest";
import { createReporter, failureLines } from "./report.js";
import { EXIT_CODE } from "./exit.js";

/**
 * What a failure looks like on the way out.
 *
 * The rendering is shared rather than repeated: the crash backstop in `cli/main.ts` renders a
 * failure too, and a second copy of this would be a second chance for one of them to print a
 * dependency's error text raw.
 */

const FORGERY = `a${String.fromCharCode(0x0a)}markpdf: access granted`;

describe("rendering a failure", () => {
  it("puts the message on its own line", () => {
    expect(failureLines({ code: EXIT_CODE.notFound, message: "No such file: a.pdf" })).toBe("No such file: a.pdf\n");
  });

  it("offers the remedy under it, marked as something to run", () => {
    const text = failureLines({ code: EXIT_CODE.accessDenied, message: "Denied.", remedy: "markpdf --allow-read '/a'" });

    expect(text).toBe("Denied.\nTry: markpdf --allow-read '/a'\n");
  });

  it("cannot be made to write a line nobody printed", () => {
    // The message can carry a file name, or whatever a native library put in it.
    const text = failureLines({ code: EXIT_CODE.unexpected, message: FORGERY });

    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    expect(text).not.toContain("\nmarkpdf: access granted");
  });

  it("cannot be made to write one through the remedy either", () => {
    const text = failureLines({ code: EXIT_CODE.accessDenied, message: "Denied.", remedy: FORGERY });

    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });
});

describe("which stream a reporter writes to", () => {
  function capture(json: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const reporter = createReporter({ stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, json);
    return { out, err, reporter };
  }

  it("keeps a failure off stdout, so a caller parsing results sees nothing", () => {
    const { out, err, reporter } = capture(true);

    reporter.problem({ code: EXIT_CODE.notFound, message: "No such file: a.pdf" });

    expect(out).toEqual([]);
    expect(err.join("")).toContain("No such file");
  });

  it("keeps progress and notes off stdout too", () => {
    const { out, err, reporter } = capture(false);

    reporter.progress("Reading document");
    reporter.note("No PDFs under /a");

    expect(out).toEqual([]);
    expect(err.join("")).toBe("Reading document\nNo PDFs under /a\n");
  });

  it("writes the result as JSON when asked, and as the human rendering otherwise", () => {
    const asJson = capture(true);
    asJson.reporter.emit({ ok: true }, () => "human\n");
    expect(JSON.parse(asJson.out.join(""))).toEqual({ ok: true });

    const asText = capture(false);
    asText.reporter.emit({ ok: true }, () => "human\n");
    expect(asText.out.join("")).toBe("human\n");
  });
});
