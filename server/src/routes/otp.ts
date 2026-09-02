import type { FastifyInstance } from "fastify";
import { OtpError, requestOtp, verifyOtp } from "../lib/otp.ts";
import { drupal } from "../lib/drupal.ts";
import { recordEvent } from "../lib/session.ts";
import { requireSession } from "./guard.ts";

export async function otpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/otp/request — send a code over WhatsApp.
   */
  app.post<{ Body: { phone?: string } }>("/api/otp/request", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const phone = request.body?.phone;
    if (!phone) return reply.code(400).send({ error: "phone is required" });

    try {
      const result = await requestOtp(session.id, phone);
      await recordEvent(session.id, "otp.sent", { phone: result.phone });
      return reply.send({
        phone: result.phone,
        expiresAt: result.expiresAt.toISOString(),
        resendsRemaining: result.resendsRemaining,
      });
    } catch (error) {
      if (error instanceof OtpError) {
        return reply.code(error.status).send({ error: error.message });
      }
      // A Graph API failure is ours, not the user's; log the detail and keep
      // the message actionable.
      request.log.error({ err: error }, "otp send failed");
      return reply.code(502).send({
        error: "We could not send the code right now. Please try again in a moment.",
      });
    }
  });

  /**
   * POST /api/otp/verify — check the code and mirror the number into Drupal.
   */
  app.post<{ Body: { code?: string } }>("/api/otp/verify", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const code = request.body?.code;
    if (!code) return reply.code(400).send({ error: "code is required" });

    try {
      const phone = await verifyOtp(session.id, code);
      await recordEvent(session.id, "otp.verified", { phone });

      // Keep Drupal's field_phone in step. A failure here must not undo a
      // verification the user has already completed, so it is logged and the
      // response still succeeds; the assembly step re-sends the number anyway.
      try {
        await drupal.setPhone(session.drupal_uid, phone);
      } catch (error) {
        request.log.error({ err: error }, "could not mirror phone to Drupal");
      }

      return reply.send({ phone, phoneVerified: true });
    } catch (error) {
      if (error instanceof OtpError) {
        return reply.code(error.status).send({ error: error.message });
      }
      request.log.error({ err: error }, "otp verify failed");
      return reply.code(500).send({ error: "Verification failed. Please try again." });
    }
  });
}
