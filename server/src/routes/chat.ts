import type { FastifyInstance } from "fastify";
import { HumanMessage, buildGraph, threadId } from "../graph/agent.ts";
import { loadFacts } from "../graph/facts.ts";
import { CARD_TOOLS } from "../graph/tools.ts";
import type { Card, OnboardingFacts } from "../graph/state.ts";
import { query } from "../db/index.ts";
import { listUploads, loadUpload, publicUrl } from "../lib/uploads.ts";
import { withProgress } from "../lib/progress.ts";
import { brief, newTurnId, trace } from "../lib/trace.ts";
import { textOf } from "../lib/text.ts";
import { requireVerified } from "./guard.ts";

/**
 * The chat endpoint.
 *
 * Streams over SSE rather than returning a whole reply: the agent regularly
 * spends ten or twenty seconds fetching a website or assembling an app, and a
 * silent spinner for that long reads as a hang.
 *
 * Events that reach the browser:
 *   token     — a fragment of assistant prose, appended as it arrives
 *   card      — a structured preview (palette, logo, catalog, gallery, progress)
 *   tool      — a tool started; the client names it
 *   status    — what that tool is doing *right now*, item by item
 *   tool_done — that tool finished
 *   retry     — the turn hit a transient failure and is being attempted again
 *   done      — end of turn, carrying the updated phase
 *   error     — something failed for good; the message is safe to show
 *
 * `status` is the one that matters most. A tool call is otherwise opaque for as
 * long as it runs, and generating a set of category icons runs for a minute or
 * more. A spinner held for a minute is indistinguishable from a hang, and the
 * owner reloads — which loses the turn and starts the same minute again.
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /** Transcript for reconnects and reloads. */
  app.get("/api/chat/history", async (request, reply) => {
    const session = await requireVerified(request, reply);
    if (!session) return;

    const rows = await query<{ role: string; content: string; cards: Card[] }>(
      `SELECT role, content, cards FROM onboarding_messages
        WHERE session_id = $1 ORDER BY id`,
      [session.id],
    );
    const facts = await loadFacts(session.id);
    return reply.send({ messages: rows, phase: facts.phase, facts: previewOf(facts) });
  });

  app.post<{ Body: { message?: string; attachments?: string[] } }>(
    "/api/chat",
    async (request, reply) => {
    const session = await requireVerified(request, reply);
    if (!session) return;

    const text = (request.body?.message ?? "").trim();
    const attachmentIds = (request.body?.attachments ?? []).slice(0, 6);
    // An empty message with no files is how the client asks for the greeting.
    const isOpening = text === "" && attachmentIds.length === 0;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat: proxies and browsers drop an idle stream, and a website fetch
    // plus a model call can easily exceed the default timeouts.
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    let assistantText = "";
    // The last thing a tool said it was doing, so a failure can name where it
    // got to instead of reporting a bare stack. Held in an object because it is
    // only ever assigned from inside a callback, and TypeScript's control-flow
    // analysis cannot see that — it narrows a bare `let` to `null` and then
    // types the truthy branch as `never`.
    const progress = { label: null as string | null };
    const cards: Card[] = [];
    const turnId = newTurnId();
    const startedAt = Date.now();
    const ctx = { sessionId: session.id, turnId };

    try {
      // Only this session's uploads are addressable, so a guessed id from
      // another owner's conversation resolves to nothing.
      const attachments = await listUploads(session.id, attachmentIds);
      trace("turn.start", {
        text: brief(text, 120),
        attachments: attachments.map((a) => `${a.mime} ${a.bytes}b`),
      }, ctx);

      if (!isOpening) {
        const cards: Card[] = attachments.map((a) => ({
          kind: "attachment",
          url: publicUrl(a.id),
          filename: a.filename,
          mime: a.mime,
        }));
        await query(
          "INSERT INTO onboarding_messages (session_id, role, content, cards) VALUES ($1, 'user', $2, $3)",
          [session.id, text, JSON.stringify(cards)],
        );
      }

      const graph = await buildGraph({
        sessionId: session.id,
        uid: session.drupal_uid,
        appId: session.app_id,
      });

      // Images go to the model as image parts, not as a link for it to fetch.
      // Gemini reads them directly, which is how a photographed menu becomes a
      // catalog without the owner retyping it.
      const parts: Array<Record<string, unknown>> = [];
      for (const attachment of attachments) {
        if (!attachment.mime.startsWith("image/")) continue;
        const file = await loadUpload(attachment.id);
        if (!file) continue;
        parts.push({
          type: "image_url",
          image_url: { url: `data:${attachment.mime};base64,${file.bytes.toString("base64")}` },
        });
      }

      const nonImages = attachments.filter((a) => !a.mime.startsWith("image/"));
      const preamble = isOpening
        ? "(The owner has just arrived. Greet them and start.)"
        : text ||
          (parts.length
            ? "(The owner sent this image. Read it and tell them what you found.)"
            : "(The owner sent a file.)");

      parts.unshift({
        type: "text",
        text:
          nonImages.length > 0
            ? `${preamble}\n\n(Also attached, which you cannot read directly: ${nonImages
                .map((a) => a.filename)
                .join(", ")})`
            : preamble,
      });

      trace("model.input", {
        parts: parts.map((p) => {
          const type = String(p["type"]);
          return type === "image_url" ? "image_url(inline)" : type;
        }),
      }, ctx);

      const input = {
        messages: [new HumanMessage({ content: parts })],
      };

      // Text streamed per model run, so the end-of-run fallback can tell
      // "this run streamed nothing" from "this run already streamed".
      const streamedByRun = new Map<string, number>();

      /**
       * One attempt at the turn.
       *
       * Separated out so it can be retried. The retry is safe precisely because
       * the graph is checkpointed: the human message is already in the thread,
       * and any tool that ran before the failure has already written its result
       * to the facts record. Re-entering resumes from the checkpoint rather
       * than replaying the work.
       */
      const runOnce = async (): Promise<void> => {
        const stream = graph.streamEvents(input, {
          version: "v2",
          configurable: { thread_id: threadId(session.id) },
          recursionLimit: 40,
        });

        for await (const event of stream) {
        if (event.event === "on_chat_model_stream") {
          const piece = textOf(event.data?.chunk);
          if (piece) {
            streamedByRun.set(event.run_id, (streamedByRun.get(event.run_id) ?? 0) + piece.length);
            assistantText += piece;
            send("token", { text: piece });
          }
        }

        // Some responses never arrive as usable stream chunks — most often the
        // reply *after* a tool call, where Gemini returns content as an array
        // of parts. Those were dropped silently, which is how a turn ended at
        // "Great" with the actual question missing. If a run streamed nothing,
        // take the text off its final message instead.
        if (event.event === "on_chat_model_end") {
          const streamed = streamedByRun.get(event.run_id) ?? 0;
          const output = event.data?.output as
            | { tool_calls?: Array<{ name: string }> }
            | undefined;

          trace("model.end", {
            streamedChars: streamed,
            toolCalls: (output?.tool_calls ?? []).map((c) => c.name),
            finalText: brief(textOf(output), 200),
          }, ctx);

          if (!streamed) {
            const piece = textOf(output);
            if (piece) {
              assistantText += piece;
              send("token", { text: piece });
            }
          }
        }

        if (event.event === "on_tool_end") {
          trace("tool.end", {
            name: event.name,
            result: brief(
              typeof event.data?.output === "string"
                ? event.data.output
                : (event.data?.output as { content?: unknown } | undefined)?.content,
              200,
            ),
          }, ctx);

          if (CARD_TOOLS.has(event.name)) {
            const card = extractCard(event.data?.output);
            if (card) {
              cards.push(card);
              send("card", card);
            }
          }
          send("tool_done", { name: event.name });
        }

        if (event.event === "on_tool_start") {
          trace("tool.start", { name: event.name, args: brief(event.data?.input, 200) }, ctx);
          send("tool", { name: event.name });
        }
        }
      };

      /**
       * Retry the turn on a transient failure, in the open stream.
       *
       * Vertex 429s under bursty load and occasionally stalls, and the previous
       * behaviour — surface the error, show a "Try again" button — put the cost
       * of the provider's bad minute onto the owner, who has no idea whether
       * pressing it will duplicate anything. Two silent-but-announced retries
       * absorb almost all of it.
       *
       * What is NOT retried: anything that already produced output. Re-running
       * a turn that streamed half a sentence would repeat it, and a garbled
       * duplicate reply is worse than an error.
       */
      const transient = (error: unknown): boolean => {
        const message = error instanceof Error ? error.message : String(error);
        const name = (error as Error)?.name ?? "";
        return (
          name === "TimeoutError" ||
          name === "AbortError" ||
          /429|resource[ _]exhausted|quota|rate.?limit|unavailable|503|502|504|deadline|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(
            message,
          )
        );
      };

      const MAX_ATTEMPTS = 4;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await withProgress(
            (update) => {
              progress.label = update.label;
              send("status", update);
            },
            runOnce,
          );
          break;
        } catch (error) {
          const producedOutput = assistantText.trim() !== "" || cards.length > 0;
          const canRetry = attempt < MAX_ATTEMPTS && transient(error) && !producedOutput;

          trace("turn.attempt_failed", {
            attempt,
            willRetry: canRetry,
            producedOutput,
            message: brief(error instanceof Error ? error.message : String(error), 300),
          }, ctx);

          if (!canRetry) throw error;

          // Say so rather than sitting silent: a ten-second gap with no
          // explanation is exactly what makes people reload.
          send("retry", {
            attempt,
            of: MAX_ATTEMPTS,
            message:
              attempt === 1
                ? "That took longer than it should — trying again."
                : attempt === 2
                  ? "Still busy on our side. Giving it another go."
                  : "One last try.",
          });
          // Exponential with jitter. A Vertex 429 is a quota window measured in
          // seconds, so retrying 1.2s later just spends the second attempt
          // hitting the same wall.
          const wait = Math.round(2_500 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }

      // A turn that produced no words at all is a bug, not a valid reply.
      // Rather than leave the owner looking at an empty bubble with no idea
      // whether anything happened, say so and keep the conversation moving.
      if (!assistantText.trim() && cards.length === 0) {
        const fallback = "Sorry — I lost my train of thought there. Could you say that again?";
        assistantText = fallback;
        send("token", { text: fallback });
        request.log.warn({ sessionId: session.id }, "turn produced no assistant output");
        trace("turn.empty", {}, ctx);
      }

      await query(
        "INSERT INTO onboarding_messages (session_id, role, content, cards) VALUES ($1, 'assistant', $2, $3)",
        [session.id, assistantText, JSON.stringify(cards)],
      );

      const facts = await loadFacts(session.id);
      trace("turn.done", {
        ms: Date.now() - startedAt,
        chars: assistantText.length,
        cards: cards.length,
        phase: facts.phase,
      }, ctx);
      send("done", {
        phase: facts.phase,
        appId: facts.appId ?? null,
        facts: previewOf(facts),
      });
    } catch (error) {
      request.log.error({ err: error }, "chat turn failed");
      trace("turn.error", {
        ms: Date.now() - startedAt,
        message: brief(error instanceof Error ? error.message : String(error), 600),
      }, ctx);

      // The generic message alone made every failure look identical and lived
      // only in journalctl, so the same class of bug had to be guessed at
      // repeatedly. `detail` carries the provider's own words — model errors
      // are about payload shape and size, not user data — and the UI shows it
      // small and muted beneath the friendly line.
      const raw = error instanceof Error ? error.message : String(error);
      send("error", {
        message: progress.label
          ? `Something went wrong while ${progress.label.charAt(0).toLowerCase()}${progress.label.slice(1)}. ` +
            "Try sending that again — I kept everything up to that point."
          : "Something went wrong on our side. Try sending that again — I kept everything so far.",
        detail: raw.replace(/\s+/g, " ").slice(0, 400),
      });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  },
  );
}

/**
 * The slice of the facts the live preview renders.
 *
 * Deliberately narrow: the preview needs a name, a palette, a logo and a few
 * item names. Shipping the whole record would put branch phone numbers and
 * every extracted price into a payload sent on every turn for no reason.
 */
function previewOf(facts: OnboardingFacts) {
  return {
    name: facts.business.name ?? null,
    type: facts.business.type ?? null,
    currency: facts.business.currency ?? null,
    logoUrl: facts.brand.logoUrl ?? null,
    palette: facts.brand.palette ?? null,
    themeId: facts.themeId ?? null,
    placeholderUrl: facts.artwork.placeholderUrl ?? null,
    branches: facts.locations.branches.length,
    appId: facts.appId ?? null,
    categories: facts.catalog.categories.map((c) => ({
      name: c.name,
      iconUrl: c.iconUrl ?? null,
      // Four is what the preview's category strip shows; the count carries the
      // rest. Shipping 120 items on every turn to render four is pure waste.
      items: c.items.slice(0, 4).map((i) => ({
        name: i.name,
        price: i.price ?? null,
        imageUrl: i.imageUrl ?? null,
      })),
      total: c.items.length,
    })),
  };
}

/**
 * Tool results arrive as a ToolMessage whose content is the JSON string the
 * tool returned; pull the card out if there is one.
 */
function extractCard(output: unknown): Card | null {
  const content =
    typeof output === "string"
      ? output
      : (output as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return null;

  try {
    const parsed = JSON.parse(content) as { card?: Card };
    return parsed.card ?? null;
  } catch {
    return null;
  }
}
