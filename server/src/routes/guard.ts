import type { FastifyReply, FastifyRequest } from "fastify";
import {
  SESSION_COOKIE,
  type OnboardingSession,
  loadSession,
  readSessionCookie,
} from "../lib/session.ts";

/**
 * Resolves the session cookie, or replies 401 and returns null.
 *
 * Returning null rather than throwing keeps the route bodies flat: every caller
 * is `const s = await requireSession(...); if (!s) return;`.
 */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<OnboardingSession | null> {
  const id = readSessionCookie(request.cookies[SESSION_COOKIE]);
  if (id === null) {
    await reply.code(401).send({ error: "not signed in" });
    return null;
  }

  const session = await loadSession(id);
  if (!session) {
    await reply.code(401).send({ error: "session expired" });
    return null;
  }

  return session;
}

/**
 * As requireSession, but also insists the phone has been verified.
 *
 * Everything past the OTP gate costs money — model calls, a build slot — so the
 * check belongs on the server, not on whether the client rendered the step.
 */
export async function requireVerified(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<OnboardingSession | null> {
  const session = await requireSession(request, reply);
  if (!session) return null;

  if (!session.phone_verified_at) {
    await reply.code(403).send({ error: "phone not verified" });
    return null;
  }

  return session;
}
