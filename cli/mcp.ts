import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT_CODE, type ExitCode } from "./exit.js";

/**
 * Where the MCP server's entry point sits, found from the command line's own compiled location.
 *
 * `dist-mcp/` is `dist-cli/`'s sibling in both layouts this ships in — a checkout and the
 * `app.asar` of a packaged build — so walking up from here is correct in both. This mirrors the
 * reasoning `electron/cliInstall.ts` records about not asking Electron for an application path.
 */
export function mcpEntryPoint(cliModulePath: string): string {
  return join(dirname(dirname(cliModulePath)), "dist-mcp", "main.js");
}

/**
 * Serve MCP over stdio by re-executing the bundled runtime on the server's entry point.
 *
 * A child process rather than an import, because the dependency direction is one way: `dist-mcp/`
 * is compiled against `dist-cli/`, so the command line cannot import the server without closing a
 * build cycle. Spawning also keeps the server's lifetime exactly its own — when the client goes
 * away, stdin closes and the server exits, with nothing on this side left to unwind.
 *
 * stdio is inherited rather than piped: **stdout belongs to the protocol**, and passing the
 * descriptor straight through means this process can never add a byte to it, buffered or not.
 * The environment passes through untouched — the shim's baked `MARKPDF_DATA_DIR` and
 * `ELECTRON_RUN_AS_NODE` are exactly what the server needs to share the application's index.
 */
export function runMcpServer(options: {
  cliModulePath: string;
  runtimePath: string;
  env: NodeJS.ProcessEnv;
  stderr: (text: string) => void;
}): Promise<ExitCode> {
  const entryPoint = mcpEntryPoint(options.cliModulePath);
  if (!existsSync(entryPoint)) {
    options.stderr(`markpdf: this installation is missing its MCP server (${entryPoint}).\n`);
    return Promise.resolve(EXIT_CODE.missingDependency);
  }

  return new Promise((resolve) => {
    const child = spawn(options.runtimePath, [entryPoint], { stdio: "inherit", env: options.env });
    // The client signals only the process it spawned. The server is this process's child, so the
    // signal has to be passed on for a disconnect to reach it.
    const onSigint = () => child.kill("SIGINT");
    const onSigterm = () => child.kill("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const settle = (code: ExitCode) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(code);
    };
    child.once("error", (error) => {
      options.stderr(`markpdf: the MCP server could not be started (${error.message}).\n`);
      settle(EXIT_CODE.unexpected);
    });
    // The server's code is the answer, whatever number it chose; only a signal death maps to one of ours.
    child.once("exit", (code) => settle((code ?? EXIT_CODE.unexpected) as ExitCode));
  });
}
