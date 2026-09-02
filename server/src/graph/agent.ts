import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { env } from "../lib/env.ts";
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
    // Gemini 2.5 reasons before answering by default, which adds latency and
    // cost to what is mostly a scripted interview. We do the thinking in the
    // prompt instead.
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
      ...state.messages,
    ];
    return { messages: [await llm.invoke(messages)] };
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
