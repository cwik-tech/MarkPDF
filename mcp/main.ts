import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDataDir } from "../dist-core/paths.js";
import { isPackagedModulePath } from "../dist-cli/packaging.js";
import { createToolContext } from "./context.js";
import { createMarkpdfServer } from "./server.js";

const here = fileURLToPath(import.meta.url);

function readVersion(): string {
  try {
    const manifest: unknown = createRequire(here)("../package.json");
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = manifest.version;
      if (typeof version === "string") return version;
    }
  } catch {
    // A missing manifest is not worth refusing to start over.
  }
  return "unknown";
}

/**
 * **stdout belongs to the protocol.** Every byte written there is a JSON-RPC frame, so anything
 * this process wants to say goes to stderr — where a client either shows it to a person or throws
 * it away, and either way does not try to parse it.
 */
function report(message: string): void {
  process.stderr.write(`${message}\n`);
}

const dataDir = resolveDataDir(undefined, process.env);
const { context, close } = createToolContext({
  dataDir,
  env: process.env,
  isPackaged: isPackagedModulePath(here),
});

const server = createMarkpdfServer({ name: "markpdf", version: readVersion() }, context);

// A tool call that fails answers with a failure; anything that escapes that is a fault in this
// process, and the client should hear about it on the stream that is not the protocol.
process.on("uncaughtException", (error: unknown) => {
  report(`markpdf: ${error instanceof Error ? error.message : String(error)}`);
  close();
  process.exit(1);
});
process.on("unhandledRejection", (error: unknown) => {
  report(`markpdf: ${error instanceof Error ? error.message : String(error)}`);
  close();
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    close();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
report(`markpdf MCP server ready, using the index at ${dataDir}`);
