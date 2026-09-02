import type { BaseMessage } from "@langchain/core/messages";
import { trace } from "./trace.ts";

/**
 * Message-history hygiene.
 *
 * Kept free of config and network imports so it can be unit tested directly —
 * these are the functions that carry the scar tissue, and they are worthless
 * if they are awkward to test.
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
export function stripOldImages(messages: BaseMessage[]): BaseMessage[] {
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
export function hasRenderableContent(message: BaseMessage): boolean {
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

export function sanitizeHistory(
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

