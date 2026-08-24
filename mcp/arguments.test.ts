import { describe, expect, it } from "vitest";
import { parseToolArguments } from "./arguments.js";
import { TOOLS } from "./toolSchemas.js";

/**
 * Everything a client sends is unknown until this file has looked at it.
 *
 * The schema published in the tool list is advisory: a client may ignore it, and a hostile one
 * will. So the same schema drives the validator here, and it is the validator — not the
 * publication — that decides what reaches core.
 */

const schemaFor = (name: string) => TOOLS.find((tool) => tool.name === name)!.inputSchema;

function accept(name: string, raw: unknown): Record<string, unknown> {
  const parsed = parseToolArguments(schemaFor(name), raw);
  if (!parsed.ok) throw new Error(`Expected ${name} to accept this, but: ${parsed.message}`);
  return parsed.value;
}

function refuse(name: string, raw: unknown): string {
  const parsed = parseToolArguments(schemaFor(name), raw);
  if (parsed.ok) throw new Error(`Expected ${name} to refuse this, but it accepted ${JSON.stringify(parsed.value)}`);
  return parsed.message;
}

describe("what arrives at all", () => {
  it("refuses arguments that are not an object", () => {
    for (const raw of [undefined, null, 42, "path", [], true]) {
      expect(refuse("search", raw)).toMatch(/object/i);
    }
  });

  it("refuses a property the tool never declared", () => {
    // `additionalProperties: false` in the published schema is a statement of intent. This is the
    // part that enforces it.
    expect(refuse("search", { query: "x", path: "/a.pdf", scope: "library" })).toContain("scope");
  });

  it("accepts an argument object with only what the tool declares", () => {
    expect(accept("search", { query: "revenue", path: "/a.pdf" })).toMatchObject({ query: "revenue", path: "/a.pdf" });
  });
});

describe("types and ranges, from the table", () => {
  it("refuses a string where a number belongs", () => {
    expect(refuse("search", { query: "x", path: "/a.pdf", top_k: "12" })).toContain("top_k");
  });

  it("refuses a fraction where a whole number belongs", () => {
    expect(refuse("search", { query: "x", path: "/a.pdf", top_k: 2.5 })).toContain("top_k");
  });

  it("refuses a number outside the range the command line enforces", () => {
    expect(refuse("search", { query: "x", path: "/a.pdf", top_k: 0 })).toContain("top_k");
    expect(refuse("search", { query: "x", path: "/a.pdf", top_k: 101 })).toContain("top_k");
    expect(refuse("search", { query: "x", path: "/a.pdf", min_score: 1.5 })).toContain("min_score");
  });

  it("refuses a choice that is not one of the choices, and says which are", () => {
    const message = refuse("to_markdown", { path: "/a.pdf", mode: "pretty" });

    expect(message).toContain("page-preserving");
    expect(message).toContain("clean");
  });

  it("applies the default the table declares when an argument is absent", () => {
    expect(accept("search", { query: "x", path: "/a.pdf" })).toMatchObject({ top_k: 12 });
    expect(accept("outline", { path: "/a.pdf" })).toMatchObject({ depth: 3 });
    expect(accept("to_markdown", { path: "/a.pdf" })).toMatchObject({ mode: "page-preserving" });
  });

  it("leaves min_score absent, because its fallback is a setting read per call, not a constant", () => {
    const value = accept("search", { query: "x", path: "/a.pdf" });

    expect("min_score" in value).toBe(false);
  });

  it("refuses a missing argument the tool cannot work without", () => {
    expect(refuse("search", { path: "/a.pdf" })).toContain("query");
    expect(refuse("read_pages", { path: "/a.pdf" })).toContain("pages");
  });

  it("refuses an empty string where text is required", () => {
    expect(refuse("search", { path: "/a.pdf", query: "   " })).toContain("query");
  });
});

describe("naming the document", () => {
  /** The other arguments each tool cannot do without, so identity is the only thing under test. */
  const otherwiseValid: Record<string, Record<string, unknown>> = {
    outline: {},
    search: { query: "revenue" },
    read_pages: { pages: "1" },
    to_markdown: {},
  };

  it("takes a path, for every tool", () => {
    for (const [name, rest] of Object.entries(otherwiseValid)) {
      expect(accept(name, { ...rest, path: "/a.pdf" })).toMatchObject({ path: "/a.pdf" });
    }
  });

  it("takes a content hash, for every tool", () => {
    for (const [name, rest] of Object.entries(otherwiseValid)) {
      expect(accept(name, { ...rest, id: "a".repeat(64) })).toMatchObject({ id: "a".repeat(64) });
    }
  });

  it("refuses both at once, because they could name different documents", () => {
    for (const [name, rest] of Object.entries(otherwiseValid)) {
      expect(refuse(name, { ...rest, path: "/a.pdf", id: "a".repeat(64) })).toMatch(/one of/i);
    }
  });

  it("refuses neither, because there would be nothing to answer about", () => {
    for (const [name, rest] of Object.entries(otherwiseValid)) {
      expect(refuse(name, { ...rest })).toMatch(/one of/i);
    }
  });

  it("enforces whatever the schema published, rather than its own idea of it", () => {
    // Handed a schema whose alternatives are different, the validator follows those. The rule is
    // read from the contract, not carried beside it.
    const schema = {
      type: "object" as const,
      properties: { left: { type: "string" as const, description: "l" }, right: { type: "string" as const, description: "r" } },
      required: [] as readonly string[],
      oneOf: [
        { required: ["left"], not: { required: ["right"] } },
        { required: ["right"], not: { required: ["left"] } },
      ],
      additionalProperties: false as const,
    };

    expect(parseToolArguments(schema, { left: "a" }).ok).toBe(true);
    expect(parseToolArguments(schema, { right: "b" }).ok).toBe(true);
    expect(parseToolArguments(schema, {}).ok).toBe(false);
    expect(parseToolArguments(schema, { left: "a", right: "b" }).ok).toBe(false);
  });
});

describe("text that would act on a terminal", () => {
  it("refuses a path carrying a control character", () => {
    // The same rule the command line applies to its arguments. A path that can forge a line of
    // output is refused before anything resolves it.
    expect(refuse("outline", { path: "/a\nmarkpdf: granted.pdf" })).toMatch(/control character/i);
  });
});
