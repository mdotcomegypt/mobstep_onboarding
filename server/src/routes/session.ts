import type { FastifyInstance } from "fastify";
import {
  SESSION_COOKIE,
  cookieOptions,
  exchangeHandoff,
  recordEvent,
  signSessionCookie,
} from "../lib/session.ts";
import { requireSession } from "./guard.ts";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/session — trade the Drupal handoff token for a session cookie.
   */
  app.post<{ Body: { token?: string } }>("/api/session", async (request, reply) => {
    const token = request.body?.token;
    if (!token) {
      return reply.code(400).send({ error: "token is required" });
    }

    try {
      const session = await exchangeHandoff(token);
      await recordEvent(session.id, "session.opened", { uid: session.drupal_uid });

      reply.setCookie(SESSION_COOKIE, signSessionCookie(session.id), cookieOptions);
      return reply.send({ session: publicView(session) });
    } catch (error) {
      // A rejected token is the user's problem (401); anything else is ours
      // (503), and the two must not look the same to whoever is on support.
      const message = (error as Error).message;
      const rejected =
        /signature|expired|malformed|already been used|usable uid|no jti/i.test(message);

      if (rejected) {
        request.log.warn({ err: error }, "handoff token rejected");
        return reply.code(401).send({ error: message });
      }

      request.log.error({ err: error }, "handoff exchange failed");
      return reply
        .code(503)
        .send({ error: "We could not start your session. Please try again in a moment." });
    }
  });

  /**
   * GET /api/session — who am I, and how far through onboarding.
   */
  app.get("/api/session", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return reply.send({ session: publicView(session) });
  });

  app.post("/api/session/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.send({ ok: true });
  });
}

function publicView(session: {
  drupal_uid: number;
  email: string | null;
  name: string | null;
  app_id: number | null;
  phone: string | null;
  phone_verified_at: Date | null;
  status: string;
}) {
  return {
    uid: session.drupal_uid,
    email: session.email,
    name: session.name,
    appId: session.app_id,
    phone: session.phone,
    phoneVerified: session.phone_verified_at !== null,
    status: session.status,
  };
}
