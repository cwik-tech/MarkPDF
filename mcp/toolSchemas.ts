import { findCommand, type OptionSpec } from "../dist-cli/spec.js";

/**
 * The tool schemas a client sees, generated from the command table rather than written twice.
 *
 * That table already validates argv and generates `--help`; this is the third job it was built
 * for, and the reason a hand-written table was chosen over a third-party parser. Restating
 * `top-k`'s range here would mean two places to change it and one of them to forget — and a
 * client would then validate against a range the product does not enforce.
 */

/** A JSON Schema fragment for one argument. Deliberately narrow: only what these tools need. */
export interface SchemaProperty {
  type: "string" | "integer" | "number";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  default?: string | number;
}

/**
 * One alternative in a `oneOf`: what it demands, and what it forbids.
 *
 * `oneOf` means *exactly* one branch matches, so the pair below expresses "path or id, never
 * both, never neither" in the schema itself. The `not` is redundant for a strict validator — two
 * bare `required` branches would already both match when both fields are present — and is kept
 * because lenient validators are common and the intent should not depend on their strictness.
 */
export interface SchemaBranch {
  required: readonly string[];
  not?: { required: readonly string[] };
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, SchemaProperty>;
  required?: readonly string[];
  /** Alternatives the arguments must satisfy exactly one of. */
  oneOf?: readonly SchemaBranch[];
  /** Unknown arguments are refused, so a client cannot smuggle one past the validator. */
  additionalProperties: false;
}

/**
 * The identity rule, published rather than merely enforced.
 *
 * Every tool names one document. Leaving `path` and `id` both optional would advertise a schema
 * that accepts neither and accepts both, and a client validating against it would build calls the
 * server then refuses — the schema and the enforcement having drifted before anything ran.
 */
export const DOCUMENT_IDENTITY_BRANCHES: readonly SchemaBranch[] = [
  { required: ["path"], not: { required: ["id"] } },
  { required: ["id"], not: { required: ["path"] } },
];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

function toProperty(option: OptionSpec): SchemaProperty {
  const kind = option.type;
  const withDefault = option.default === undefined ? {} : { default: option.default };
  switch (kind.kind) {
    case "integer":
      return { type: "integer", minimum: kind.minimum, maximum: kind.maximum, description: option.description, ...withDefault };
    case "number":
      return { type: "number", minimum: kind.minimum, maximum: kind.maximum, description: option.description, ...withDefault };
    case "choice":
      return { type: "string", enum: kind.choices, description: option.description, ...withDefault };
    case "string":
      return { type: "string", description: option.description, ...withDefault };
    case "boolean":
      // No tool here takes one, and a silent `type: "string"` would be worse than saying so.
      throw new Error(`--${option.name} is a flag, which has no meaning in a tool that has no flags.`);
  }
}

/**
 * One command option, as a JSON Schema property.
 *
 * Throws for an option the command does not declare. That is a programming error — a tool naming
 * an argument the product cannot validate — and answering with a plausible empty schema would
 * ship it.
 */
export function propertyFromOption(commandName: string, optionName: string): SchemaProperty {
  const command = findCommand(commandName);
  if (command === undefined) throw new Error(`There is no ${commandName} command to take an option from.`);
  const option = command.options.find((candidate) => candidate.name === optionName);
  if (option === undefined) throw new Error(`The ${commandName} command does not declare --${optionName}.`);
  return toProperty(option);
}

/** `path` and `id` mean the same thing in every tool, and come from the same table entries. */
function documentIdentity(): Record<string, SchemaProperty> {
  return {
    path: {
      ...propertyFromOption("search", "path"),
      description: "The document's path. Give this or id, not both.",
    },
    id: {
      ...propertyFromOption("search", "id"),
      description: "The document's content hash, as returned by another tool. Give this or path, not both.",
    },
  };
}

/**
 * Exactly four tools.
 *
 * Every tool costs context in every client's session, forever, so the surface is the smallest one
 * that is useful: orient, search, read what a hit points at, convert. Nothing here indexes, grants
 * or deletes — consent is given out of band with the command line, and a server that could widen
 * its own access would make the allowlist decorative.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "outline",
    description:
      "Show a document's shape before reading it: its heading tree with page numbers, page count, and whether it has a text layer. Answered from the index when the document is already indexed; otherwise it reads the file, which needs read permission.",
    inputSchema: {
      type: "object",
      properties: { ...documentIdentity(), depth: propertyFromOption("outline", "depth") },
      required: [],
      oneOf: DOCUMENT_IDENTITY_BRANCHES,
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Find the passages of one indexed document that answer a question. Each hit carries its page and the headings above it. Reads the index only, so it needs no filesystem permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...documentIdentity(),
        query: { type: "string", description: "What to search for, in plain language." },
        top_k: propertyFromOption("search", "top-k"),
        min_score: propertyFromOption("search", "min-score"),
      },
      required: ["query"],
      oneOf: DOCUMENT_IDENTITY_BRANCHES,
      additionalProperties: false,
    },
  },
  {
    name: "read_pages",
    description:
      "Read the text of specific pages of an indexed document — the bridge from a search hit to the surrounding material. Reads the index only, so it needs no filesystem permission and works only for documents already indexed.",
    inputSchema: {
      type: "object",
      properties: { ...documentIdentity(), pages: propertyFromOption("convert", "pages") },
      required: ["pages"],
      oneOf: DOCUMENT_IDENTITY_BRANCHES,
      additionalProperties: false,
    },
  },
  {
    name: "to_markdown",
    description:
      "Convert a document to Markdown. Needs read permission for the document, and write permission separately if output_path is given. Output is bounded; anything longer is truncated explicitly and reports how much was left out.",
    inputSchema: {
      type: "object",
      properties: {
        ...documentIdentity(),
        pages: propertyFromOption("convert", "pages"),
        mode: propertyFromOption("convert", "mode"),
        output_path: {
          ...propertyFromOption("convert", "out"),
          description: "Write the Markdown here instead of returning it. Needs write permission for this path.",
        },
      },
      required: [],
      oneOf: DOCUMENT_IDENTITY_BRANCHES,
      additionalProperties: false,
    },
  },
];
