import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { env } from "../lib/env.ts";
import { trace } from "../lib/trace.ts";
import { sanitizeHistory, hasRenderableContent } from "../lib/messages.ts";
import { loadFacts } from "./facts.ts";
import { systemPrompt } from "./prompt.ts";
import { buildTools, type ToolContext } from "./tools.ts";

/**
 * The onboarding agent.
 *
 * A single tool-using agent over a MessagesAnnotation graph rather than a
 * supervisor with specialist subgraphs. Onboarding is one continuous
 * conversation in which the owner routinely answers ahead, doubles back and
 * changes their mind; routing that between sub-agents adds handoff bugs without
 * buying anything, since every "specialist" would share the same context and
 * the same tools. Phases live in the facts record instead, and the prompt uses
 * them to decide what to ask next.
 *
 * State lives in two places on purpose: LangGraph's checkpoint holds the message
 * history (so a closed tab resumes mid-sentence), and onboarding_facts holds the
 * structured result (so assembly and support can read it without deserializing
 * a checkpoint).
 */

let checkpointer: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    checkpointer = PostgresSaver.fromConnString(env.databaseUrl);
    await checkpointer.setup();
  }
  return checkpointer;
}

function model() {
  return new ChatVertexAI({
    model: env.vertex.chatModel,
    location: env.vertex.location,
    temperature: 0.4,
    maxOutputTokens: 2048,

    // Own the retry policy rather than inheriting LangChain's default of six
    // attempts with exponential backoff. Vertex 429s under bursty load, and
    // those retries are invisible: a turn that took 72 seconds to write one
    // sentence looked like a hang, with nothing in the trace to say why.
    // Two attempts, then fail loudly — a fast error beats a silent minute.
    maxRetries: 2,

    // Retries are the thing that made 72 seconds look like a hang, so surface
    // each one. `maxRetries` binds to the internal AsyncCaller; the constructor
    // `timeout` option does NOT reliably reach the request, so the deadline is
    // enforced with an AbortSignal at the call site instead of trusted here.
    onFailedAttempt: (error: { attemptNumber?: number; message?: string }) => {
      trace("model.retry", {
        attempt: error.attemptNumber ?? 0,
        reason: (error.message ?? "").replace(/\s+/g, " ").slice(0, 200),
      });
      throw error;
    },

    // Gemini 2.5 reasons before answering by default, and those thinking
    // tokens come out of the SAME maxOutputTokens budget as the reply — a
    // heavy turn can spend the whole cap thinking and return an empty
    // candidate. Verified to bind: this maps to maxReasoningTokens=0.
    ...(({ thinkingBudget: 0 }) as Record<string, unknown>),
  });
}

export async function buildGraph(ctx: ToolContext) {
  const tools = buildTools(ctx);
  const llm = model().bindTools(tools);
  const toolNode = new ToolNode(tools);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    // Re-read the facts every turn: a tool call earlier in this same turn may
    // have changed them, and the prompt must reflect that.
    const facts = await loadFacts(ctx.sessionId);
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt(facts, null)),
      ...sanitizeHistory(state.messages, { sessionId: ctx.sessionId }),
    ];
    // A hard deadline the agent owns. Without it a stalled Vertex request holds
    // the SSE stream open until the browser gives up, and the owner sees an
    // indicator that never resolves.
    const reply = await llm.invoke(messages, { signal: AbortSignal.timeout(45_000) });

    // Sanitize on the way IN, not just on the way out. An assistant message
    // with no text and no tool calls serializes to a zero-parts entry, which
    // Gemini rejects for the WHOLE request — so one empty reply broke every
    // later turn in that conversation until the read-side filter was added.
    // Filtering here means it never reaches the checkpoint at all.
    if (!hasRenderableContent(reply)) {
      trace("model.empty", { note: "model returned nothing; not checkpointed" }, {
        sessionId: ctx.sessionId,
      });
      return { messages: [] };
    }

    return { messages: [reply] };
  };

  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages.at(-1);
    const calls = (last as { tool_calls?: unknown[] } | undefined)?.tool_calls;
    return calls && calls.length > 0 ? "tools" : END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
    .addEdge("tools", "agent");

  return graph.compile({ checkpointer: await getCheckpointer() });
}

export const threadId = (sessionId: number): string => `onboarding-${sessionId}`;

export { HumanMessage };
