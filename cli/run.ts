import type { Allowlist } from "../dist-core/consent/allowlist.js";
import {
  AllowlistFileError,
  AllowlistLockedError,
  readAllowlist,
  updateAllowlist,
  type GrantRecord,
} from "../dist-core/consent/allowlistFile.js";
import { resolveDataDir } from "../dist-core/paths.js";
import { readSemanticSettings } from "../dist-core/settings/appSettings.js";
import { runConvertCommand } from "./commands/convertCommand.js";
import { runIndexCommand } from "./commands/indexCommand.js";
import { runOutlineCommand } from "./commands/outlineCommand.js";
import { runSearchCommand } from "./commands/searchCommand.js";
import { createContext, type CommandContext, type ConfirmGrant } from "./context.js";
import { classifyRunFailure } from "./errors.js";
import { EXIT_CODE, type ExitCode } from "./exit.js";
import { parseCliArgs, type GlobalSettings } from "./parse.js";
import { createReporter, type Reporter } from "./report.js";

export type { ConfirmGrant };

export interface CliOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  version: string;
  isPackaged: boolean;
  /** Supplied only when a person is at the terminal to answer. */
  confirmGrant?: ConfirmGrant | undefined;
  signal?: AbortSignal | undefined;
}

const NEVER_ABORTED = new AbortController().signal;

function describeGrant(record: GrantRecord): string {
  const what = `${record.access} access to ${record.resolvedPath}`;
  switch (record.effect) {
    case "added":
      return `Granted ${what}.`;
    case "already-granted":
      return `Already granted ${what}; nothing changed.`;
    case "withdrawn":
      return `Withdrew ${what}.`;
    case "not-granted":
      return `No ${what} was held; nothing to withdraw.`;
    case "covered-by-ancestor":
      // Says what is true rather than what is convenient. Nothing changed, and the path is still
      // reachable — telling somebody it was never granted would be the one sentence that stops
      // them looking further.
      return `Nothing to withdraw at ${record.resolvedPath}: ${record.access} access still reaches it through the broader grant on ${record.coveredBy ?? "a parent folder"}. Withdraw that folder to remove it.`;
  }
}

/**
 * Apply the grants a run carried, and say what each one did.
 *
 * Reported one line each rather than as a single "done", because "already granted" and "nothing
 * to withdraw" are the two answers somebody most needs to see: the first means their earlier
 * grant is still in force, and the second means the thing they meant to take back was spelled
 * differently from the thing they hold.
 */
function applyRunGrants(
  dataDir: string,
  global: GlobalSettings,
  report: Reporter,
): { allowlist: Allowlist; records: GrantRecord[] } {
  if (global.grants.length === 0) return { allowlist: readAllowlist(dataDir), records: [] };
  // Read, change and write as one operation. Two runs granting and revoking at the same moment
  // must not be able to lose one of the two changes.
  const applied = updateAllowlist(dataDir, global.grants);
  for (const record of applied.records) report.note(describeGrant(record));
  return applied;
}

export async function runCli(options: CliOptions): Promise<number> {
  const streams = { stdout: options.stdout, stderr: options.stderr };
  const outcome = parseCliArgs(options.argv);

  if (outcome.status === "help") {
    options.stdout(outcome.text);
    return EXIT_CODE.success;
  }
  if (outcome.status === "version") {
    options.stdout(`${options.version}\n`);
    return EXIT_CODE.success;
  }
  if (outcome.status === "usage-error") {
    options.stderr(`${outcome.message}\nUsage: ${outcome.usage}\n`);
    return EXIT_CODE.usage;
  }

  const global = outcome.global;
  const report = createReporter(streams, global.json);
  const dataDir = global.dataDir ?? resolveDataDir(undefined, options.env);

  let applied: { allowlist: Allowlist; records: GrantRecord[] };
  try {
    applied = applyRunGrants(dataDir, global, report);
  } catch (error) {
    if (error instanceof AllowlistLockedError) {
      // Waiting is the whole remedy. Suggesting the consent record be removed would throw away
      // every grant and leave the lock exactly where it was.
      report.problem({
        code: EXIT_CODE.indexBusy,
        message: error.message,
        ...(error.recoverCommand === undefined ? {} : { remedy: error.recoverCommand }),
      });
      return EXIT_CODE.indexBusy;
    }
    if (error instanceof AllowlistFileError) {
      // Fail closed and leave the file exactly as found. Repairing it would destroy the only
      // record of what somebody consented to, and treating it as empty would silently discard
      // their grants and then overwrite them on the next write.
      report.problem({
        code: EXIT_CODE.accessDenied,
        message: `${error.message} Nothing can be permitted until it is readable again.`,
        remedy: `Inspect or remove ${error.path}`,
      });
      return EXIT_CODE.accessDenied;
    }
    const failure = classifyRunFailure(error);
    report.problem(failure);
    return failure.code;
  }

  if (outcome.status === "grants-only") {
    report.emit({ command: "allowlist", allowlist: applied.allowlist, changes: applied.records }, () => "");
    return EXIT_CODE.success;
  }

  // Built inside the failure boundary. Reading the application's settings can fail — a file this
  // process is not allowed to open is the case that matters — and constructing the context above
  // the `try` meant that failure rejected the call instead of becoming an exit code and a line on
  // stderr, which is the contract every other failure keeps.
  let context: CommandContext | null = null;
  try {
    context = createContext({
      dataDir,
      allowlist: applied.allowlist,
      settings: readSemanticSettings(dataDir),
      report,
      global,
      signal: options.signal ?? NEVER_ABORTED,
      env: options.env,
      isPackaged: options.isPackaged,
      confirmGrant: options.confirmGrant,
    });
    const code = await dispatch(outcome.command.name, context, outcome.positionals, outcome.options);
    return context.signal.aborted ? EXIT_CODE.interrupted : code;
  } catch (error) {
    const failure = classifyRunFailure(error);
    report.problem(failure);
    return failure.code;
  } finally {
    // Only if it was built. Closing a context that never existed would replace the real failure
    // with a `TypeError` from the cleanup.
    context?.close();
  }
}

async function dispatch(
  name: string,
  context: Parameters<typeof runIndexCommand>[0],
  positionals: readonly string[],
  options: Parameters<typeof runIndexCommand>[2],
): Promise<ExitCode> {
  switch (name) {
    case "index":
      return await runIndexCommand(context, positionals, options);
    case "search":
      return await runSearchCommand(context, positionals, options);
    case "outline":
      return await runOutlineCommand(context, positionals, options);
    case "convert":
      return await runConvertCommand(context, positionals, options);
    default:
      // Unreachable: the parser only returns a command the table declares, and every declared
      // command has a case above. Throwing rather than exiting quietly keeps a table entry added
      // without an implementation from silently succeeding.
      throw new Error(`No implementation for the ${name} command.`);
  }
}
