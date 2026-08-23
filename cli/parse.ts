import { parseArgs, type ParseArgsConfig } from "node:util";
import { hasTerminalControlCharacter, safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import { renderCommandHelp, renderGeneralHelp, renderSynopsis } from "./help.js";
import {
  commandSpecs,
  findCommand,
  globalOptions,
  renderOptionUsage,
  type CommandSpec,
  type OptionSpec,
} from "./spec.js";

export type GrantChange = "allow" | "revoke";
export type GrantAccess = "read" | "write";

export interface Grant {
  change: GrantChange;
  access: GrantAccess;
  path: string;
}

export interface GlobalSettings {
  json: boolean;
  noInput: boolean;
  dataDir: string | undefined;
  /** Every occurrence, in the order given, so a run can grant and withdraw in one command. */
  grants: readonly Grant[];
}

/**
 * A command's own options, after coercion and range checking.
 *
 * Asking for a name the command never declared throws rather than answering `undefined`. A
 * typo in a command implementation is a programming error, and returning a plausible absence
 * would let it ship as "the user did not pass that option".
 */
export interface ParsedOptions {
  /** Throws unless this command's table declares the option. Global options are not command options. */
  declared(name: string): void;
  boolean(name: string): boolean;
  /** The value, or `undefined` when the option was absent and has no declared default. */
  text(name: string): string | undefined;
  /** The value, for an option the table gives a default, so a caller never restates it. */
  requiredText(name: string): string;
  number(name: string): number;
}

export type ParseOutcome =
  | { status: "run"; command: CommandSpec; positionals: readonly string[]; options: ParsedOptions; global: GlobalSettings }
  | { status: "grants-only"; global: GlobalSettings }
  | { status: "help"; text: string }
  | { status: "version" }
  | { status: "usage-error"; message: string; usage: string };

type OptionValue = string | number | boolean;

function parseArgsType(option: OptionSpec): "boolean" | "string" {
  return option.type.kind === "boolean" ? "boolean" : "string";
}

function configFor(options: readonly OptionSpec[]): NonNullable<ParseArgsConfig["options"]> {
  const config: NonNullable<ParseArgsConfig["options"]> = {};
  for (const option of options) {
    config[option.name] = { type: parseArgsType(option), ...(option.repeatable === true ? { multiple: true } : {}) };
  }
  return config;
}

/**
 * Where the command name sits in argv.
 *
 * Scanned rather than assumed at position zero, because a grant may precede the command — that
 * is the whole point of printing the remedy as something pastable in front of the failed run.
 * Only global options can appear before the command, so only their arities are needed here; an
 * option this scan does not recognise is skipped as though it took no value, and its value then
 * reads as an unrecognised command, which is what the message will say.
 */
function findCommandIndex(argv: readonly string[]): number {
  let position = 0;
  while (position < argv.length) {
    const argument = argv[position];
    if (argument === undefined || argument === "--") return -1;
    if (!argument.startsWith("-")) return position;
    if (argument.includes("=")) {
      position += 1;
      continue;
    }
    const spec = globalOptions.find((option) => `--${option.name}` === argument);
    position += spec !== undefined && spec.type.kind !== "boolean" ? 2 : 1;
  }
  return -1;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function collectGrants(values: Record<string, unknown>): Grant[] {
  const grants: Grant[] = [];
  for (const [name, value] of Object.entries(values)) {
    const match = /^(allow|revoke)-(read|write)$/.exec(name);
    if (match === null) continue;
    const change = match[1] === "allow" ? "allow" : "revoke";
    const access = match[2] === "read" ? "read" : "write";
    for (const path of asStringList(value)) grants.push({ change, access, path });
  }
  return grants;
}

/**
 * Grants in the order the user wrote them, not the order the option table happens to list.
 *
 * `parseArgs` groups values by option name, which loses the interleaving of two different
 * options. Recovering it from argv keeps `--revoke-read /x --allow-read /x` meaning what it
 * reads as, rather than depending on which name the table declares first.
 */
function orderGrants(argv: readonly string[], grants: readonly Grant[]): Grant[] {
  const remaining = grants.map((grant) => ({ ...grant, used: false }));
  const ordered: Grant[] = [];
  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position];
    if (argument === undefined || !argument.startsWith("--")) continue;
    const [flag, inlineValue] = argument.includes("=") ? argument.split(/=(.*)/s) : [argument, argv[position + 1]];
    const match = /^--(allow|revoke)-(read|write)$/.exec(flag ?? "");
    if (match === null || inlineValue === undefined) continue;
    const candidate = remaining.find(
      (grant) => !grant.used && grant.change === match[1] && grant.access === match[2] && grant.path === inlineValue,
    );
    if (candidate === undefined) continue;
    candidate.used = true;
    ordered.push({ change: candidate.change, access: candidate.access, path: candidate.path });
  }
  // Anything the scan could not place still counts. Dropping a grant because its spelling was
  // unusual would silently narrow what the user asked for.
  for (const grant of remaining) {
    if (!grant.used) ordered.push({ change: grant.change, access: grant.access, path: grant.path });
  }
  return ordered;
}

function coerce(option: OptionSpec, raw: string): { ok: true; value: OptionValue } | { ok: false; message: string } {
  const usage = renderOptionUsage(option);
  const type = option.type;
  if (type.kind === "string") return { ok: true, value: raw };
  if (type.kind === "choice") {
    return type.choices.includes(raw)
      ? { ok: true, value: raw }
      : { ok: false, message: `${usage} must be one of: ${type.choices.join(", ")}. Received ${JSON.stringify(raw)}.` };
  }
  if (type.kind === "boolean") return { ok: true, value: true };

  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value)) {
    return { ok: false, message: `${usage} must be a number. Received ${JSON.stringify(raw)}.` };
  }
  if (type.kind === "integer" && !Number.isInteger(value)) {
    return { ok: false, message: `${usage} must be a whole number. Received ${JSON.stringify(raw)}.` };
  }
  if (value < type.minimum || value > type.maximum) {
    return { ok: false, message: `${usage} must be between ${type.minimum} and ${type.maximum}. Received ${raw}.` };
  }
  return { ok: true, value };
}

function makeParsedOptions(command: CommandSpec, values: ReadonlyMap<string, OptionValue>): ParsedOptions {
  const declared = (name: string): OptionSpec => {
    const spec = command.options.find((option) => option.name === name);
    if (spec === undefined) {
      throw new Error(`The ${command.name} command does not declare --${name}.`);
    }
    return spec;
  };
  return {
    declared(name) {
      declared(name);
    },
    boolean(name) {
      declared(name);
      return values.get(name) === true;
    },
    text(name) {
      declared(name);
      const value = values.get(name);
      return typeof value === "string" ? value : undefined;
    },
    requiredText(name) {
      const spec = declared(name);
      const value = values.get(name);
      if (typeof value !== "string") {
        throw new Error(`--${spec.name} has no value and no default, so it cannot be read as text.`);
      }
      return value;
    },
    number(name) {
      const spec = declared(name);
      const value = values.get(name);
      if (typeof value !== "number") {
        throw new Error(`--${spec.name} has no value and no default, so it cannot be read as a number.`);
      }
      return value;
    },
  };
}

function usageError(message: string, usage: string): ParseOutcome {
  return { status: "usage-error", message, usage };
}

const GENERAL_USAGE = "markpdf <command> [arguments] [options]";

export function parseCliArgs(argv: readonly string[]): ParseOutcome {
  // Refused here, before anything is resolved or printed. A path carrying a newline or an escape
  // could otherwise forge a line of output — and the alternative, escaping it for display, would
  // make the printed remedy name a file that does not exist. Refusing keeps the promise that a
  // remedy can be pasted and will work.
  for (const argument of argv) {
    if (hasTerminalControlCharacter(argument)) {
      return usageError(
        `The argument ${JSON.stringify(safeForTerminal(argument))} contains a control character. MarkPDF will not use it.`,
        GENERAL_USAGE,
      );
    }
  }

  const commandIndex = findCommandIndex(argv);
  const commandName = commandIndex === -1 ? undefined : argv[commandIndex];
  const command = commandName === undefined ? undefined : findCommand(commandName);

  if (commandName !== undefined && command === undefined) {
    const known = commandSpecs.map((spec) => spec.name).join(", ");
    return usageError(`Unrecognised command ${JSON.stringify(commandName)}. Known commands: ${known}.`, GENERAL_USAGE);
  }

  const withoutCommand = commandIndex === -1 ? [...argv] : [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
  const options = [...globalOptions, ...(command?.options ?? [])];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: withoutCommand,
      options: configFor(options),
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(message, command === undefined ? GENERAL_USAGE : renderSynopsis(command));
  }

  // Help and version answer before anything else is validated. `markpdf search --help` must
  // explain the command rather than complain that the command is incomplete.
  if (values.help === true) {
    return { status: "help", text: command === undefined ? renderGeneralHelp() : renderCommandHelp(command) };
  }
  if (values.version === true) return { status: "version" };

  const global: GlobalSettings = {
    json: values.json === true,
    noInput: values["no-input"] === true,
    dataDir: typeof values["data-dir"] === "string" ? values["data-dir"] : undefined,
    grants: orderGrants(argv, collectGrants(values)),
  };

  if (command === undefined) {
    if (global.grants.length > 0) return { status: "grants-only", global };
    return usageError("No command given.", GENERAL_USAGE);
  }

  const synopsis = renderSynopsis(command);
  const variadic = command.positionals.some((positional) => positional.variadic);
  if (positionals.length < command.positionals.length) {
    const missing = command.positionals[positionals.length];
    return usageError(`Missing <${missing?.name ?? "argument"}>.`, synopsis);
  }
  if (!variadic && positionals.length > command.positionals.length) {
    return usageError(`The ${command.name} command takes exactly one <${command.positionals[0]?.name}>.`, synopsis);
  }

  const coerced = new Map<string, OptionValue>();
  for (const option of command.options) {
    const raw = values[option.name];
    if (raw === undefined) {
      if (option.default !== undefined) coerced.set(option.name, option.default);
      continue;
    }
    if (option.type.kind === "boolean") {
      coerced.set(option.name, raw === true);
      continue;
    }
    const result = coerce(option, String(raw));
    if (!result.ok) return usageError(result.message, synopsis);
    coerced.set(option.name, result.value);
  }

  if (command.exactlyOneOf !== undefined) {
    const given = command.exactlyOneOf.filter((name) => coerced.get(name) !== undefined);
    if (given.length !== 1) {
      const list = command.exactlyOneOf.map((name) => `--${name}`).join(" or ");
      return usageError(`Give exactly one of ${list}.`, synopsis);
    }
  }

  for (const name of command.singleTargetOptions ?? []) {
    if (coerced.get(name) !== undefined && positionals.length > 1) {
      return usageError(`--${name} takes a single document, but ${positionals.length} were given.`, synopsis);
    }
  }

  return { status: "run", command, positionals, options: makeParsedOptions(command, coerced), global };
}
