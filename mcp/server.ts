import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ProgressNotification,
  type ProgressToken,
} from "@modelcontextprotocol/sdk/types.js";
import { boundText, DEFAULT_REPLY_BUDGET, renderReply, type OutputBudget } from "../dist-core/output/budget.js";
import { safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import { parseToolArguments, type ArgumentValue } from "./arguments.js";
import { runListOpenDocuments, runReadOpenDocument } from "./openDocumentOperations.js";
import { runOutline, runReadPages, runSearch, runToMarkdown, type ToolContext, type ToolOutcome } from "./operations.js";
import type { ToolProgress } from "./progress.js";
import { TOOLS } from "./toolSchemas.js";

/**
 * The result shape every tool answers with: one JSON document, or one sentence and a failure.
 *
 * A type alias rather than an interface, deliberately: the SDK's result type carries an index
 * signature, and TypeScript infers an implicit one for an alias but not for an interface. Widening
 * this to `[key: string]: unknown` to satisfy it would give away the narrowness that makes it
 * worth having.
 */
export type ToolReply = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type Runner = (context: ToolContext, args: Record<string, ArgumentValue>, signal?: AbortSignal) => Promise<ToolOutcome>;

const RUNNERS: Record<string, Runner> = {
  outline: runOutline,
  search: runSearch,
  read_pages: runReadPages,
  to_markdown: runToMarkdown,
  list_open_documents: runListOpenDocuments,
  read_open_document: runReadOpenDocument,
};

/** What a call that was given up on is told, whether it had started or was still waiting. */
const CANCELLED = "The request was cancelled.";

export interface ProgressReporter {
  report: (update: ToolProgress) => void;
  finish: () => Promise<void>;
}

interface ProgressReporterInput {
  progressToken: ProgressToken;
  send: (notification: ProgressNotification) => Promise<void>;
  now?: () => number;
  budget?: OutputBudget;
}

/** Throttle chatty producers without losing the first update or the final state they reported. */
export function createProgressReporter(input: ProgressReporterInput): ProgressReporter {
  const now = input.now ?? Date.now;
  const budget = input.budget ?? DEFAULT_REPLY_BUDGET;
  let lastSentAt: number | null = null;
  let lastProgress = 0;
  let pending: ToolProgress | null = null;
  let sending = Promise.resolve();

  const normalized = (update: ToolProgress): ToolProgress => {
    const proposed = update.progress;
    const progress =
      typeof proposed === "number" && Number.isFinite(proposed)
        ? Math.max(lastProgress, proposed)
        : lastProgress + 1;
    lastProgress = progress;
    const message = update.message === undefined
      ? undefined
      : boundText(safeForTerminal(update.message), budget).text;
    const total =
      typeof update.total === "number" && Number.isFinite(update.total) && update.total >= progress
        ? update.total
        : undefined;
    return {
      progress,
      ...(total === undefined ? {} : { total }),
      ...(message === undefined ? {} : { message }),
    };
  };

  const emit = (update: ToolProgress): void => {
    const params = {
      progressToken: input.progressToken,
      progress: update.progress ?? 0,
      ...(update.total === undefined ? {} : { total: update.total }),
      ...(update.message === undefined ? {} : { message: update.message }),
    };
    sending = sending
      .then(async () => await input.send({ method: "notifications/progress", params }))
      .catch(() => undefined);
  };

  return {
    report(update) {
      const next = normalized(update);
      const at = now();
      if (lastSentAt === null || at - lastSentAt >= 500) {
        emit(next);
        lastSentAt = at;
        pending = null;
      } else {
        pending = next;
      }
    },
    async finish() {
      if (pending !== null) {
        emit(pending);
        pending = null;
      }
      await sending;
    },
  };
}

/**
 * A refusal, bounded like an answer.
 *
 * Almost everything a refusal says came from somewhere else: the tool name a client chose, the
 * path it asked about, the message on an exception. A half-megabyte tool name would otherwise come
 * straight back as a half-megabyte reply, so the per-call bound would hold for every successful
 * call and fail for the one case a client controls completely.
 *
 * Bounded *after* `safeForTerminal`, not before: making text terminal-safe is what lengthens it — a
 * control character becomes the four characters that spell it — so a bound applied first would not
 * be a bound on what is handed over. This is that escaping, not JSON serialization, which the
 * transport does afterwards to the whole string.
 */
function failure(message: string, budget: OutputBudget): ToolReply {
  return { content: [{ type: "text", text: boundText(safeForTerminal(message), budget).text }], isError: true };
}

/**
 * Run one tool call, from a name and arguments that are both still unknown.
 *
 * Exported separately from the transport so the contract can be exercised without a socket: what a
 * client sends is a name and a bag of values, and everything this function is protecting against
 * is expressible as those two things.
 *
 * Nothing thrown escapes. A tool that raised would otherwise close the session for a client that
 * merely asked something the server could not do, and the protocol has a way of saying "that
 * failed" that does not involve ending the conversation.
 */
export async function callTool(
  context: ToolContext,
  name: unknown,
  args: unknown,
  signal?: AbortSignal,
  reporter?: ProgressReporter,
): Promise<ToolReply> {
  const budget = context.replyBudget;
  if (typeof name !== "string") return failure("A tool call must name a tool.", budget);
  const tool = TOOLS.find((candidate) => candidate.name === name);
  const run = RUNNERS[name];
  if (tool === undefined || run === undefined) {
    // The offered names come last, so a client that sent a very long name still reads them: the
    // bound cuts from the end, and what a caller needs is the list.
    return failure(`This server offers: ${TOOLS.map((t) => t.name).join(", ")}. There is no tool called ${name}.`, budget);
  }

  // The schema the tool list published is advisory; this is where it is enforced.
  const parsed = parseToolArguments(tool.inputSchema, args ?? {});
  if (!parsed.ok) return failure(parsed.message, budget);

  const cancelled = (): boolean => signal?.aborted === true;
  // Cancelled before it was ever queued. Taking a place in the queue for work nobody wants would
  // delay calls that are still wanted.
  if (cancelled()) return failure(CANCELLED, budget);

  const operationContext: ToolContext = reporter === undefined
    ? context
    : { ...context, progress: reporter.report };

  try {
    const outcome = await context.scheduler.run(async () => {
      // Checked again on the way in. A call can sit in the queue for as long as the calls ahead of
      // it take, and a client that gave up in that time must not have its work started anyway —
      // which is the whole difference between bounding concurrency and merely delaying it.
      if (cancelled()) return null;
      return await run(operationContext, parsed.value, signal);
    }, signal);
    if (outcome === null) return failure(CANCELLED, budget);
    if (!outcome.ok) return failure(outcome.message, budget);
    // The same serialization the operation measured its reply with. Two spellings of "turn this
    // into JSON" would mean the budget was checked against a string nobody sent.
    const text = renderReply(outcome.payload);
    if (Buffer.byteLength(text, "utf8") > budget) {
      // The last invariant, and the only one stated where every reply must pass. Each operation
      // fits its own reply to the budget, but an operation is a branch of code and branches are
      // added — a fixed part that outgrew the cap, or a path that forgot to fit at all, would
      // otherwise leave here as a reply larger than this server promises. Refusing says so;
      // sending it would not.
      return failure(
        `${name} produced a reply of ${Buffer.byteLength(text, "utf8")} bytes, which is more than the ${budget} this server returns in one call. This is a fault in MarkPDF; ask for fewer pages meanwhile.`,
        budget,
      );
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (cancelled()) return failure(CANCELLED, budget);
    return failure(error instanceof Error ? error.message : String(error), budget);
  } finally {
    await reporter?.finish();
  }
}

export interface ServerIdentity {
  name: string;
  version: string;
}

/**
 * The MarkPDF MCP server: six tools, no resources, no prompts.
 *
 * Built on the SDK's low-level `Server` rather than `McpServer` for one reason that matters: the
 * higher-level class takes Zod schemas, and these tools' schemas are generated from the command
 * table that already validates the command line. Publishing a second, separately authored
 * description of the same arguments is the drift this whole arrangement exists to avoid.
 */
export function createMarkpdfServer(identity: ServerIdentity, context: ToolContext): Server {
  const server = new Server(identity, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // Annotated, because the result type is a union with a task-shaped member the compiler would
  // otherwise try to fit this into.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    // The SDK parsed the envelope; the arguments inside it are still whatever the client sent.
    const params: unknown = request.params;
    const name = typeof params === "object" && params !== null ? Reflect.get(params, "name") : undefined;
    const args = typeof params === "object" && params !== null ? Reflect.get(params, "arguments") : undefined;
    // The client's own cancellation, carried through to the work rather than dropped: reading and
    // recognising a document is the longest thing this server does.
    const token = extra._meta?.progressToken;
    const reporter = typeof token === "string" || typeof token === "number"
      ? createProgressReporter({
          progressToken: token,
          send: async (notification) => await extra.sendNotification(notification),
          budget: context.replyBudget,
        })
      : undefined;
    return await callTool(context, name, args, extra.signal, reporter);
  });

  return server;
}
