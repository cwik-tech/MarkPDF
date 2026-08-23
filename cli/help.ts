import { commandSpecs, globalOptions, renderOptionUsage, type CommandSpec, type OptionSpec } from "./spec.js";

/**
 * Help, generated from the table rather than written beside it.
 *
 * Written beside it, the two drift: an option gains a range and the help still quotes the old
 * one. Generated, a wrong help text means a wrong table, and the table is what validates argv.
 */

const INDENT = "  ";

function describeDefault(option: OptionSpec): string {
  return option.default === undefined ? "" : ` (default ${option.default})`;
}

function describeChoices(option: OptionSpec): string {
  return option.type.kind === "choice" ? ` One of: ${option.type.choices.join(", ")}.` : "";
}

function describeRange(option: OptionSpec): string {
  const type = option.type;
  if (type.kind !== "integer" && type.kind !== "number") return "";
  return ` Between ${type.minimum} and ${type.maximum}.`;
}

function optionLines(options: readonly OptionSpec[]): string[] {
  const usages = options.map(renderOptionUsage);
  const width = Math.max(0, ...usages.map((usage) => usage.length));
  return options.map((option, position) => {
    const usage = usages[position] ?? "";
    const detail = `${option.description}${describeChoices(option)}${describeRange(option)}${describeDefault(option)}`;
    return `${INDENT}${usage.padEnd(width)}  ${detail}`;
  });
}

function positionalUsage(command: CommandSpec): string {
  return command.positionals
    .map((positional) => (positional.variadic ? `<${positional.name}...>` : `<${positional.name}>`))
    .join(" ");
}

/** The one-line synopsis a usage error prints alongside its message. */
export function renderSynopsis(command: CommandSpec): string {
  const required = command.exactlyOneOf === undefined ? "" : ` (${command.exactlyOneOf.map((name) => `--${name}`).join(" | ")})`;
  return `markpdf ${command.name} ${positionalUsage(command)}${required} [options]`.replace(/\s+/g, " ").trim();
}

export function renderCommandHelp(command: CommandSpec): string {
  const sections = [command.summary, "", `Usage: ${renderSynopsis(command)}`, ""];

  if (command.positionals.length > 0) {
    sections.push("Arguments:");
    const width = Math.max(...command.positionals.map((positional) => positional.name.length + 2));
    for (const positional of command.positionals) {
      sections.push(`${INDENT}${`<${positional.name}>`.padEnd(width)}  ${positional.description}`);
    }
    sections.push("");
  }

  if (command.options.length > 0) {
    sections.push("Options:", ...optionLines(command.options), "");
  }

  sections.push("Global options:", ...optionLines(globalOptions), "");
  return sections.join("\n");
}

export function renderGeneralHelp(): string {
  const width = Math.max(...commandSpecs.map((command) => command.name.length));
  return [
    "markpdf — read, index, search and convert PDFs from the command line.",
    "",
    "Usage: markpdf <command> [arguments] [options]",
    "",
    "Commands:",
    ...commandSpecs.map((command) => `${INDENT}${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Global options:",
    ...optionLines(globalOptions),
    "",
    "Run `markpdf <command> --help` for a command's own options.",
    "",
  ].join("\n");
}
