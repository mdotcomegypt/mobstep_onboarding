import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { env } from "../lib/env.ts";
import { trace } from "../lib/trace.ts";
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

/**
 * Removes image data from every message except the most recent one.
 *
 * Images live in the checkpointed history forever, and this node re-sends the
 * whole history on every model call — including each tool round-trip within a
 * single turn. A 500 KB photo is ~670 KB of base64, so two or three menu
 * photographs push the request past Gemini's size limit and the turn fails with
 * an opaque 400.
 *
 * Dropping them is safe: whatever the model read out of a photo is already in
 * the facts record and in its own prior replies. Keeping the pixels buys
 * nothing and costs the conversation. A placeholder is left behind so the
 * history still reads coherently.
 */
function stripOldImages(messages: BaseMessage[]): BaseMessage[] {
  const lastImageIndex = messages.findLastIndex(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => (part as { type?: string }).type === "image_url"),
  );
  if (lastImageIndex < 0) return messages;

  return messages.map((message, index) => {
    if (index === lastImageIndex || !Array.isArray(message.content)) {
      return message;
    }

    const parts = message.content as Array<Record<string, unknown>>;
    if (!parts.some((part) => part["type"] === "image_url")) {
      return message;
    }

    const kept = parts.filter((part) => part["type"] !== "image_url");
    const dropped = parts.length - kept.length;
    // kept may now be empty (a message that was only an image); the placeholder
    // below is what stops this producing a zero-parts entry.
    kept.push({
      type: "text",
      text: `(${dropped} image${dropped === 1 ? "" : "s"} sent earlier, already read)`,
    });

    // Cloning keeps the checkpointed state untouched; only what goes to the
    // model this call is trimmed.
    const trimmed = Object.create(Object.getPrototypeOf(message)) as BaseMessage;
    Object.assign(trimmed, message, { content: kept });
    return trimmed;
  });
}

/**
 * Drops messages that would serialize to an empty `parts` array.
 *
 * Gemini rejects the whole request with
 *   400 "must include at least one parts field"
 * if any entry in `contents` has no parts. An assistant message with empty
 * content produces exactly that — and empty assistant messages are precisely
 * what this service used to write whenever a model run returned nothing.
 *
 * The consequence is worse than one lost reply: once such a message is in the
 * checkpoint it is re-sent on every later turn, so the conversation is
 * permanently broken from that point on. That is why uploading a menu failed
 * every single time while earlier turns had worked — the image was never the
 * problem, the history was.
 *
 * A message is kept when it has text, or tool calls, or is a tool result:
 * dropping an assistant message that carries tool calls, or the tool result
 * that answers it, would break the pairing Gemini validates.
 */
function hasRenderableContent(message: BaseMessage): boolean {
  const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  if (message.getType() === "tool") return true;

  const content = message.content;
  if (typeof content === "string") return content.trim() !== "";

  if (Array.isArray(content)) {
    return content.some((part: unknown) => {
      if (typeof part === "string") return part.trim() !== "";
      const typed = part as { type?: string; text?: string };
      if (typed.type === "text") return (typed.text ?? "").trim() !== "";
      // Images and other non-text parts are content in their own right.
      return typed.type !== undefined;
    });
  }

  return false;
}

function sanitizeHistory(
  messages: BaseMessage[],
  ctx: { sessionId: number },
): BaseMessage[] {
  const kept = stripOldImages(messages).filter(hasRenderableContent);
  const dropped = messages.length - kept.length;
  if (dropped > 0) {
    // Worth seeing: it means empty messages are still being written somewhere,
    // even though they no longer break the conversation.
    trace("history.pruned", { dropped, kept: kept.length }, { sessionId: ctx.sessionId });
  }
  return kept;
}

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
      ...sanitizeHistory(state.messages, { sessionId: ctx.sessionId }),
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
