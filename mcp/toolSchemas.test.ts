import { describe, expect, it } from "vitest";
import { propertyFromOption, TOOLS } from "./toolSchemas.js";

/**
 * The tool schemas a client sees, generated from the command table rather than written twice.
 *
 * That table already validates argv and generates `--help`; this is the third job it was built
 * for. Restating `top-k`'s range here would mean two places to change it and one of them to
 * forget, and a client would then validate against a range the product does not enforce.
 */

describe("turning a command option into a schema property", () => {
  it("carries a whole-number option's range and default across", () => {
    expect(propertyFromOption("search", "top-k")).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 12,
      description: "How many passages to return.",
    });
  });

  it("carries a fractional option's range across", () => {
    const property = propertyFromOption("search", "min-score");

    expect(property.type).toBe("number");
    expect(property).toMatchObject({ minimum: 0, maximum: 1, default: 0.3 });
  });

  it("turns a choice into an enum a client can check", () => {
    expect(propertyFromOption("convert", "mode")).toMatchObject({
      type: "string",
      enum: ["page-preserving", "clean"],
      default: "page-preserving",
    });
  });

  it("carries a plain string option across with its description", () => {
    expect(propertyFromOption("convert", "pages")).toMatchObject({ type: "string" });
    expect(propertyFromOption("convert", "pages").description).toContain("3-7");
  });

  it("refuses an option the command does not have, rather than inventing one", () => {
    expect(() => propertyFromOption("search", "recursive")).toThrow(/recursive/);
    expect(() => propertyFromOption("nonesuch", "path")).toThrow(/nonesuch/);
  });
});

describe("the tools this server offers", () => {
  it("is exactly the four the plan names, and no more", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(["outline", "search", "read_pages", "to_markdown"]);
  });

  it("describes every one of them, because a description costs context in every session", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("lets every tool name a document either way, by path or by content hash", () => {
    for (const tool of TOOLS) {
      expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["path", "id"]));
    }
  });

  it("publishes the exactly-one-of rule rather than only enforcing it", () => {
    // A schema leaving both optional advertises calls the server refuses, and a client validating
    // against it builds them.
    for (const tool of TOOLS) {
      expect(tool.inputSchema.oneOf).toEqual([
        { required: ["path"], not: { required: ["id"] } },
        { required: ["id"], not: { required: ["path"] } },
      ]);
    }
  });

  it("requires the arguments a tool cannot work without, and nothing else", () => {
    const required = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.inputSchema.required ?? []]));

    expect(required.outline).toEqual([]);
    expect(required.search).toEqual(["query"]);
    expect(required.read_pages).toEqual(["pages"]);
    expect(required.to_markdown).toEqual([]);
  });

  it("takes search's bounds from the same table the command line validates against", () => {
    const search = TOOLS.find((tool) => tool.name === "search");

    expect(search?.inputSchema.properties.top_k).toEqual(propertyFromOption("search", "top-k"));
    expect(search?.inputSchema.properties.min_score).toEqual(propertyFromOption("search", "min-score"));
  });

  it("says which tools touch the filesystem and which only read the index", () => {
    // The access class is part of the description because it is the thing a person deciding
    // whether to register this server most needs to know.
    const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.description]));

    expect(byName.read_pages).toContain("index");
    expect(byName.search).toContain("index");
    expect(byName.to_markdown).toContain("read");
  });

  it("offers no tool that indexes, grants, or deletes", () => {
    // Consent is granted out of band, with the command line. A server that could widen its own
    // access would make the allowlist decorative.
    const names = TOOLS.map((tool) => tool.name).join(" ");
    for (const forbidden of ["index", "allow", "grant", "forget", "delete", "clear"]) {
      expect(names.split(" ")).not.toContain(forbidden);
    }
  });
});
