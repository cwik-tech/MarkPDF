import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { boundText, renderReply, type OutputBudget } from "../dist-core/output/budget.js";
import { safeForTerminal } from "../dist-core/text/safeForTerminal.js";
import { parseToolArguments, type ArgumentValue } from "./arguments.js";
import { runOutline, runReadPages, runSearch, runToMarkdown, type ToolContext, type ToolOutcome } from "./operations.js";
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
};

/** What a call that was given up on is told, whether it had started or was still waiting. */
const CANCELLED = "The request was cancelled.";

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

  // Cancelled before it was ever queued. Taking a place in the queue for work nobody wants would
  // delay calls that are still wanted.
  if (signal?.aborted === true) return failure(CANCELLED, budget);

  try {
    const outcome = await context.scheduler.run(async () => {
      // Checked again on the way in. A call can sit in the queue for as long as the calls ahead of
      // it take, and a client that gave up in that time must not have its work started anyway —
      // which is the whole difference between bounding concurrency and merely delaying it.
      if (signal?.aborted === true) return null;
      return await run(context, parsed.value, signal);
    });
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
    return failure(error instanceof Error ? error.message : String(error), budget);
  }
}

export interface ServerIdentity {
  name: string;
  version: string;
}

/**
 * The MarkPDF MCP server: four tools, no resources, no prompts.
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
    return await callTool(context, name, args, extra.signal);
  });

  return server;
}
