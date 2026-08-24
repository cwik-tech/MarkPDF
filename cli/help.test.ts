import { describe, expect, it } from "vitest";
import { renderCommandHelp, renderGeneralHelp, renderSynopsis } from "./help.js";
import { commandSpecs, findCommand, globalOptions, renderOptionUsage } from "./spec.js";

/**
 * Help is generated, so these assert the generation rather than a wording.
 *
 * Each one walks the table and requires the text to account for what it found. A new option
 * that help forgot fails here without anyone remembering to add a case.
 */

describe("the general help", () => {
  const text = renderGeneralHelp();

  it("accounts for every command in the table", () => {
    for (const command of commandSpecs) {
      expect(text).toContain(command.name);
      expect(text).toContain(command.summary);
    }
  });

  it("accounts for every global option, spelled the way it is typed", () => {
    for (const option of globalOptions) {
      expect(text).toContain(renderOptionUsage(option));
      expect(text).toContain(option.description);
    }
  });
});

describe("a command's help", () => {
  it("accounts for that command's own options and for the global ones", () => {
    for (const command of commandSpecs) {
      const text = renderCommandHelp(command);
      for (const option of [...command.options, ...globalOptions]) {
        expect(text).toContain(renderOptionUsage(option));
      }
    }
  });

  it("shows no other command's options", () => {
    const text = renderCommandHelp(findCommand("outline")!);
    expect(text).not.toContain("--recursive");
    expect(text).not.toContain("--min-score");
  });

  it("states the range a numeric option is checked against", () => {
    expect(renderCommandHelp(findCommand("search")!)).toContain("Between 0 and 1");
  });

  it("states the default that will be used when the option is absent", () => {
    expect(renderCommandHelp(findCommand("search")!)).toContain("default 12");
  });

  it("says a settings-backed option falls back to the application setting, not a constant", () => {
    // --min-score has no fixed default: the application's setting supplies it per run, and the
    // help must say so rather than advertising a number that could disagree with the setting.
    expect(renderCommandHelp(findCommand("search")!)).toContain("application setting");
  });

  it("lists the allowed values of a choice", () => {
    const text = renderCommandHelp(findCommand("convert")!);
    expect(text).toContain("page-preserving, clean");
  });

  it("marks a variadic argument as taking more than one", () => {
    expect(renderCommandHelp(findCommand("index")!)).toContain("<path...>");
  });
});

describe("the synopsis a usage error prints", () => {
  it("shows the mutually exclusive options as a choice", () => {
    expect(renderSynopsis(findCommand("search")!)).toBe("markpdf search <query> (--path | --id) [options]");
  });

  it("shows a variadic argument as repeatable", () => {
    expect(renderSynopsis(findCommand("index")!)).toBe("markpdf index <path...> [options]");
  });
});
