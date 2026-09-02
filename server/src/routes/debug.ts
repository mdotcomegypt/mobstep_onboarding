import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { readTrace } from "../lib/trace.ts";

/**
 * GET /api/debug/log?key=…&session=…&limit=…
 *
 * Recent turn traces as JSON, or text/plain with `&format=text`.
 *
 * Gated on DEBUG_KEY, which has no default: with the variable unset the route
 * 404s exactly as if it did not exist, so an unconfigured deployment cannot
 * accidentally expose model output.
 */
export async function debugRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { key?: string; session?: string; limit?: string; format?: string } }>(
    "/api/debug/log",
    async (request, reply) => {
      const expected = process.env["DEBUG_KEY"];
      if (!expected) {
        return reply.code(404).send({ error: "not found" });
      }

      const presented = Buffer.from(request.query.key ?? "");
      const secret = Buffer.from(expected);
      if (
        presented.length !== secret.length ||
        !timingSafeEqual(presented, secret)
      ) {
        return reply.code(404).send({ error: "not found" });
      }

      const events = readTrace({
        sessionId: request.query.session ? Number(request.query.session) : undefined,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });

      if (request.query.format === "text") {
        const lines = events.map((e) => {
          const where = [e.sessionId ? `s${e.sessionId}` : null, e.turnId].filter(Boolean).join("/");
          const detail = Object.entries(e.detail)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("  ");
          return `${e.at}  ${(where || "-").padEnd(14)}  ${e.kind.padEnd(20)}  ${detail}`;
        });
        return reply.type("text/plain; charset=utf-8").send(lines.join("\n") + "\n");
      }

      return reply.send({ count: events.length, events });
    },
  );
}
