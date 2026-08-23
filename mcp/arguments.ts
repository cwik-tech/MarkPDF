import { hasTerminalControlCharacter, safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import type { SchemaProperty, ToolInputSchema } from "./toolSchemas.js";

export type ArgumentValue = string | number;
export type ParsedArguments =
  | { ok: true; value: Record<string, ArgumentValue> }
  | { ok: false; message: string };

/**
 * Read one property off an object without asserting anything about it.
 *
 * `Reflect.get` rather than an indexed access through a cast: `in` narrows the presence of a key
 * but not the object's index signature, and this value came from a client.
 */
function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function refuse(message: string): ParsedArguments {
  return { ok: false, message };
}

function checkValue(name: string, spec: SchemaProperty, raw: unknown): { ok: true; value: ArgumentValue } | { ok: false; message: string } {
  if (spec.type === "string") {
    if (typeof raw !== "string") return { ok: false, message: `${name} must be text.` };
    if (raw.trim().length === 0) return { ok: false, message: `${name} must not be empty.` };
    if (spec.enum !== undefined && !spec.enum.includes(raw)) {
      return { ok: false, message: `${name} must be one of: ${spec.enum.join(", ")}. Received ${JSON.stringify(safeForTerminal(raw))}.` };
    }
    // The same rule the command line applies to its own arguments: a value that can forge a line
    // of output is refused before anything resolves it.
    if (hasTerminalControlCharacter(raw)) {
      return { ok: false, message: `${name} contains a control character, which MarkPDF will not use.` };
    }
    return { ok: true, value: raw };
  }

  if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, message: `${name} must be a number.` };
  if (spec.type === "integer" && !Number.isInteger(raw)) return { ok: false, message: `${name} must be a whole number.` };
  if (spec.minimum !== undefined && raw < spec.minimum) {
    return { ok: false, message: `${name} must be at least ${spec.minimum}. Received ${raw}.` };
  }
  if (spec.maximum !== undefined && raw > spec.maximum) {
    return { ok: false, message: `${name} must be at most ${spec.maximum}. Received ${raw}.` };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a client's arguments against the tool's own published schema.
 *
 * **The published schema is advisory; this is not.** A client may ignore what the tool list said,
 * and a hostile one will, so the same schema drives the check here — one description of the
 * contract, enforced at the only place that matters. Unknown properties are refused rather than
 * ignored: a client sending `scope` should be told the server does not have one, not silently
 * given a document-scoped answer.
 *
 * Every tool here names a document, and naming it twice would name two. That rule is published in
 * each tool's schema as a `oneOf`, and read back from there below rather than restated — so a
 * client validating against what the tool list said reaches the same verdict this does.
 */
export function parseToolArguments(schema: ToolInputSchema, raw: unknown): ParsedArguments {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("Arguments must be an object.");
  }

  const declared = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      return refuse(`${safeForTerminal(key)} is not an argument this tool takes. It takes: ${[...declared].join(", ")}.`);
    }
  }

  const value: Record<string, ArgumentValue> = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    const given = property(raw, name);
    if (given === undefined) {
      if ((schema.required ?? []).includes(name)) return refuse(`${name} is required.`);
      if (spec.default !== undefined) value[name] = spec.default;
      continue;
    }
    const checked = checkValue(name, spec, given);
    if (!checked.ok) return refuse(checked.message);
    value[name] = checked.value;
  }

  for (const name of schema.required ?? []) {
    if (value[name] === undefined) return refuse(`${name} is required.`);
  }

  // Derived from the schema, not restated. `oneOf` says exactly one branch must hold, and this
  // reads the branches the tool published rather than carrying its own idea of the same rule.
  const branches = schema.oneOf;
  if (branches !== undefined) {
    const satisfied = branches.filter(
      (branch) =>
        branch.required.every((name) => value[name] !== undefined) &&
        (branch.not?.required ?? []).every((name) => value[name] === undefined),
    );
    if (satisfied.length !== 1) {
      const alternatives = branches.map((branch) => branch.required.join(" and ")).join(" or ");
      return refuse(`Give exactly one of ${alternatives}.`);
    }
  }

  return { ok: true, value };
}
