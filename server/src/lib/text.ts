/**
 * Reading text out of a model response.
 */

/**
 * Pulls display text out of a chunk or a finished message.
 *
 * `.text` is only reliable when `content` is a plain string. Gemini returns an
 * array of parts whenever a reply carries anything besides prose — including
 * every reply that accompanies a function call — and `.text` is empty for
 * those, so the parts have to be walked.
 */
export function textOf(value: unknown): string {
  if (!value) return "";

  const message = value as { text?: unknown; content?: unknown };

  if (typeof message.content === "string") return message.content;

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        const typed = part as { type?: string; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .join("");
  }

  return typeof message.text === "string" ? message.text : "";
}

