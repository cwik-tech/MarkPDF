import { describe, expect, it } from "vitest";
import { ACTIVE_DOCUMENT, propertyFromOption, TOOLS } from "./toolSchemas.js";

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
    expect(property).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it("publishes no default where the application's settings supply the fallback", () => {
    // A published default would freeze the setting's value into every client's validation at
    // listing time; the server would then honour a setting the schema never advertised. Absence
    // says what is true: the fallback lives in the application's settings, read per call.
    const property = propertyFromOption("search", "min-score");

    expect(property.default).toBeUndefined();
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

/**
 * The four tools that address a document the caller names.
 *
 * The open-document tools are deliberately not among them: they address a document the *user* has
 * in front of them, which is the whole reason they exist, so the identity rules below are about
 * these four rather than about every tool.
 */
const NAMED_DOCUMENT_TOOLS = ["outline", "search", "read_pages", "to_markdown"];

describe("the tools this server offers", () => {
  it("is the four that name a document plus the two that reach the open application", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "outline",
      "search",
      "read_pages",
      "to_markdown",
      "list_open_documents",
      "read_open_document",
    ]);
  });

  it("describes every one of them, because a description costs context in every session", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("lets every tool that names a document do it either way, by path or by content hash", () => {
    for (const name of NAMED_DOCUMENT_TOOLS) {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["path", "id"]));
    }
  });

  it("publishes the exactly-one-of rule rather than only enforcing it", () => {
    // A schema leaving both optional advertises calls the server refuses, and a client validating
    // against it builds them.
    for (const name of NAMED_DOCUMENT_TOOLS) {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.oneOf).toEqual([
        { required: ["path"], not: { required: ["id"] } },
        { required: ["id"], not: { required: ["path"] } },
      ]);
    }
  });

  it("asks the open-document tools for no document identity at all", () => {
    // Naming a path is exactly what these two exist to avoid, so publishing a path argument would
    // invite the call the feature is for.
    for (const name of ["list_open_documents", "read_open_document"]) {
      const tool = TOOLS.find((candidate) => candidate.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("path");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("id");
      expect(tool?.inputSchema.oneOf).toBeUndefined();
    }
  });

  it("takes no arguments at all to say what is open", () => {
    const listing = TOOLS.find((tool) => tool.name === "list_open_documents");

    expect(listing?.inputSchema.properties).toEqual({});
  });

  it("publishes the active document as the default a read falls back to", () => {
    // A published default is what makes "read the PDF I have open" a call with no arguments; an
    // implied one would leave a client guessing what absence means.
    const read = TOOLS.find((tool) => tool.name === "read_open_document");

    expect(read?.inputSchema.properties.ref?.default).toBe(ACTIVE_DOCUMENT);
    expect(read?.inputSchema.properties.ref?.type).toBe("string");
    expect(ACTIVE_DOCUMENT).toBe("active");
  });

  it("requires the arguments a tool cannot work without, and nothing else", () => {
    const required = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.inputSchema.required ?? []]));

    expect(required.outline).toEqual([]);
    expect(required.search).toEqual(["query"]);
    expect(required.read_pages).toEqual(["pages"]);
    expect(required.to_markdown).toEqual([]);
    expect(required.list_open_documents).toEqual([]);
    expect(required.read_open_document).toEqual([]);
  });

  it("says that an open document's own edits are visible but its markings are not", () => {
    // The distinction a person actually needs: MarkPDF indexes the document it has loaded, so a
    // page they deleted is reflected without saving — while a highlight they drew is not part of
    // the document until it is written into one.
    const read = TOOLS.find((tool) => tool.name === "read_open_document");

    expect(read?.description).toMatch(/annotation|highlight|comment/i);
    expect(read?.description).toMatch(/saved/i);
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
