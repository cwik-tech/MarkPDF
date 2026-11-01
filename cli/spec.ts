/**
 * The command and option table.
 *
 * One data structure, three jobs. It validates argv, it generates `--help`, and it carries the
 * kinds, ranges, choices and descriptions an MCP tool's JSON Schema needs — so when Phase 4
 * adds that adapter it reads this table rather than restating it. A third-party argument parser
 * would own its own schema format and that reuse would be gone.
 *
 * No generator for the schema is written here. Phase 4 needs it and Phase 3 does not, and an
 * abstraction built for a caller that does not exist yet is a guess about the caller.
 */

import { defaultSemanticTopK } from "../dist-core/models.js";
import type { SemanticSearchSettings } from "../dist-core/ipc/settings.js";

/** What an option's value is, and what would make one invalid. */
export type OptionKind =
  | { kind: "boolean" }
  | { kind: "string"; placeholder: string; maxLength?: number }
  | { kind: "choice"; placeholder: string; choices: readonly string[] }
  | { kind: "integer"; placeholder: string; minimum: number; maximum: number }
  | { kind: "number"; placeholder: string; minimum: number; maximum: number };

export interface OptionSpec {
  /** The long name, without the leading dashes. */
  name: string;
  type: OptionKind;
  description: string;
  /** Applied when the option is absent. Only meaningful for valued options. */
  default?: string | number;
  /**
   * The application setting that supplies the fallback when the option is absent — instead of a
   * constant. An option carrying this never carries `default`: publishing a constant would
   * freeze one reading of the setting into the parser and the tool schema, and the setting
   * itself would then be honoured nowhere. The command reads the setting where it runs.
   */
  settingsDefault?: keyof SemanticSearchSettings;
  /** Whether repeating the option collects every occurrence instead of keeping the last. */
  repeatable?: boolean;
}

export interface PositionalSpec {
  /** Displayed in help as `<name>`, and named in the message when it is missing. */
  name: string;
  description: string;
  /** True when the command takes any number of these. */
  variadic: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  positionals: readonly PositionalSpec[];
  options: readonly OptionSpec[];
  /** Exactly one of these option names must be present. */
  exactlyOneOf?: readonly string[];
  /**
   * Option names that only make sense when the command was given a single target.
   *
   * `convert --out` is the case: one output file cannot hold several converted documents, and
   * writing each in turn would leave only the last. Declared here rather than branched on in the
   * parser, so the rule is visible in the same table that generates the help.
   */
  singleTargetOptions?: readonly string[];
  /** Options that must be present. Published as `required` in the MCP schema. */
  requiredOptions?: readonly string[];
  /**
   * A command an agent runs against a document. It may use only the grants that already exist:
   * a grant option given with it is refused, and it never asks at the terminal for a new one, so
   * the command cannot widen its own access.
   */
  agentFacing?: true;
}

/** The three ways a document is named by a command an agent runs. Exactly one is given. */
const documentIdentityOptions: readonly OptionSpec[] = [
  { name: "path", type: { kind: "string", placeholder: "<pdf>" }, description: "The document, by path." },
  { name: "id", type: { kind: "string", placeholder: "<hash>" }, description: "The document, by content hash." },
  {
    name: "ref",
    type: { kind: "string", placeholder: "<ref>" },
    description: 'The document, by a reference from list_open_documents, or "active" for the one in front.',
  },
];

/**
 * Options every command accepts, plus the grant options that need no command at all.
 *
 * Grants are global because the remedy printed by a refusal has to be pastable in front of the
 * command that was refused, and equally has to work on its own.
 */
export const globalOptions: readonly OptionSpec[] = [
  { name: "json", type: { kind: "boolean" }, description: "Write the result to stdout as JSON." },
  { name: "help", type: { kind: "boolean" }, description: "Show this help and exit." },
  { name: "version", type: { kind: "boolean" }, description: "Show the version and exit." },
  {
    name: "data-dir",
    type: { kind: "string", placeholder: "<dir>" },
    description: "Read and write the index in this directory instead of the default.",
  },
  {
    name: "no-input",
    type: { kind: "boolean" },
    description: "Never prompt, even on a terminal. A refused path exits 5 with a remedy.",
  },
  {
    name: "allow-read",
    type: { kind: "string", placeholder: "<dir>" },
    description: "Permit reading files under this directory, and remember it.",
    repeatable: true,
  },
  {
    name: "allow-write",
    type: { kind: "string", placeholder: "<dir>" },
    description: "Permit writing files under this directory, and remember it.",
    repeatable: true,
  },
  {
    name: "revoke-read",
    type: { kind: "string", placeholder: "<dir>" },
    description: "Withdraw permission to read under this directory.",
    repeatable: true,
  },
  {
    name: "revoke-write",
    type: { kind: "string", placeholder: "<dir>" },
    description: "Withdraw permission to write under this directory.",
    repeatable: true,
  },
];

/** The grant options, in the order help should show them. */
export const grantOptionNames = ["allow-read", "allow-write", "revoke-read", "revoke-write"] as const;

export const commandSpecs: readonly CommandSpec[] = [
  { name: "prepare", summary: "Open a PDF in MarkPDF, save automatic metadata and prepare retrieval.", positionals: [{ name: "path", description: "PDF to prepare.", variadic: false }], options: [] },
  {
    name: "index",
    summary: "Read documents and add them to the semantic index.",
    positionals: [{ name: "path", description: "A PDF, or a directory when --recursive is given.", variadic: true }],
    options: [
      { name: "recursive", type: { kind: "boolean" }, description: "Descend into directories given as paths." },
      { name: "force", type: { kind: "boolean" }, description: "Re-index even when the index is already complete." },
    ],
  },
  {
    name: "search",
    summary: "Find the passages in one indexed document that answer a query.",
    positionals: [{ name: "query", description: "What to search for.", variadic: false }],
    options: [
      { name: "path", type: { kind: "string", placeholder: "<pdf>" }, description: "The document, by path." },
      { name: "id", type: { kind: "string", placeholder: "<hash>" }, description: "The document, by content hash." },
      {
        name: "top-k",
        type: { kind: "integer", placeholder: "<n>", minimum: 1, maximum: 100 },
        description: "How many passages to return.",
        // One home for the constant: the models catalogue, not a literal repeated here.
        default: defaultSemanticTopK,
      },
      {
        name: "min-score",
        type: { kind: "number", placeholder: "<n>", minimum: 0, maximum: 1 },
        description: "Discard passages scoring below this.",
        // No constant default: the application's setting supplies the fallback per run, and an
        // explicit --min-score outranks it.
        settingsDefault: "minSemanticScore",
      },
    ],
    exactlyOneOf: ["path", "id"],
  },
  {
    name: "outline",
    summary: "Show a document's heading structure.",
    positionals: [{ name: "path", description: "The document to outline.", variadic: false }],
    options: [
      {
        name: "depth",
        type: { kind: "integer", placeholder: "<n>", minimum: 1, maximum: 6 },
        description: "How many heading levels to show.",
        default: 3,
      },
    ],
  },
  {
    name: "convert",
    summary: "Convert documents to Markdown.",
    positionals: [{ name: "path", description: "A PDF to convert.", variadic: true }],
    options: [
      {
        name: "pages",
        type: { kind: "string", placeholder: "<range>" },
        description: "Only these pages, as 3, 3-7, or 1,4-6.",
      },
      {
        name: "mode",
        type: { kind: "choice", placeholder: "<mode>", choices: ["page-preserving", "clean"] },
        description: "Keep page boundaries, or run the text together.",
        default: "page-preserving",
      },
      {
        name: "out",
        type: { kind: "string", placeholder: "<file>" },
        description: "Write to this file instead of stdout. Needs write permission.",
      },
    ],
    singleTargetOptions: ["out"],
  },
  {
    name: "reveal",
    summary: "Show a page of a PDF in MarkPDF, and mark a quoted passage on it for a few seconds.",
    positionals: [],
    options: [
      ...documentIdentityOptions,
      {
        name: "page",
        type: { kind: "integer", placeholder: "<n>", minimum: 1, maximum: 100_000 },
        description: "The page to show, counted from 1.",
      },
      {
        name: "quote",
        type: { kind: "string", placeholder: "<text>", maxLength: 500 },
        description: "Words on that page to mark, as they appear there.",
      },
      {
        name: "mode",
        type: { kind: "choice", placeholder: "<mode>", choices: ["show", "link"] },
        description: "Show the passage now, or only return a markpdf:// link that shows it when clicked.",
        default: "show",
      },
      {
        name: "agent",
        type: { kind: "string", placeholder: "<name>", maxLength: 64 },
        description: "The name MarkPDF shows beside the mark.",
        default: "markpdf command line",
      },
    ],
    exactlyOneOf: ["path", "id", "ref"],
    requiredOptions: ["page"],
    agentFacing: true,
  },
  {
    name: "suggest",
    summary: "Propose a highlight or a comment on a PDF open in MarkPDF, for the person to accept or reject.",
    positionals: [],
    options: [
      ...documentIdentityOptions,
      {
        name: "page",
        type: { kind: "integer", placeholder: "<n>", minimum: 1, maximum: 100_000 },
        description: "The page the suggestion is about, counted from 1.",
      },
      {
        name: "quote",
        type: { kind: "string", placeholder: "<text>", maxLength: 500 },
        description: "Words on that page to anchor it to. Without a note, this suggests a highlight.",
      },
      {
        name: "note",
        type: { kind: "string", placeholder: "<text>", maxLength: 2_000 },
        description: "The comment. Without a quote, it is pinned to the top of the page.",
      },
      {
        name: "agent",
        type: { kind: "string", placeholder: "<name>", maxLength: 64 },
        description: "The name MarkPDF shows as the suggestion's author.",
        default: "markpdf command line",
      },
    ],
    exactlyOneOf: ["path", "id", "ref"],
    requiredOptions: ["page"],
    agentFacing: true,
  },
  {
    name: "comments",
    summary: "List the comments and highlights a saved PDF carries, with author, page, quote and note.",
    positionals: [],
    options: [
      ...documentIdentityOptions,
      {
        name: "pages",
        type: { kind: "string", placeholder: "<range>" },
        description: "Only these pages, as 3, 3-7, or 1,4-6.",
      },
      {
        name: "offset",
        type: { kind: "integer", placeholder: "<n>", minimum: 0, maximum: 100_000 },
        description: "Start at this comment, in reading order. A reply names the next offset.",
        default: 0,
      },
    ],
    exactlyOneOf: ["path", "id", "ref"],
    agentFacing: true,
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return commandSpecs.find((command) => command.name === name);
}

/** `--name <placeholder>`, as help and error messages spell it. */
export function renderOptionUsage(option: OptionSpec): string {
  return option.type.kind === "boolean" ? `--${option.name}` : `--${option.name} ${option.type.placeholder}`;
}
