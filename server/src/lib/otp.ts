import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { one, query } from "../db/index.ts";
import { normalizePhone, sendOtp } from "./whatsapp.ts";

/**
 * Phone verification over WhatsApp.
 *
 * Rules, all enforced here rather than in the route so they cannot be bypassed
 * by a second caller: codes are stored hashed, expire in five minutes, allow
 * five wrong guesses, and may be re-sent three times per quarter hour per
 * number. Verification is always scoped to the session that requested it —
 * deliberately unlike the legacy OTPService, whose getActiveOTPByPhoneOnly()
 * looks a code up across every tenant.
 */

const CODE_LENGTH = 6;
const TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3;
const SEND_WINDOW_MINUTES = 15;

export class OtpError extends Error {
  // Written out rather than declared as a constructor parameter property:
  // node --experimental-strip-types cannot erase those, since they emit code.
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const hash = (code: string, phone: string): string =>
  createHash("sha256").update(`${phone}:${code}`).digest("hex");

export interface SendResult {
  phone: string;
  expiresAt: Date;
  resendsRemaining: number;
}

export async function requestOtp(sessionId: number, rawPhone: string): Promise<SendResult> {
  const phone = normalizePhone(rawPhone);

  const recent = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM onboarding_otp
      WHERE phone = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [phone, String(SEND_WINDOW_MINUTES)],
  );
  const sends = Number(recent?.count ?? 0);
  if (sends >= MAX_SENDS) {
    throw new OtpError(
      `Too many codes requested. Please wait ${SEND_WINDOW_MINUTES} minutes and try again.`,
      429,
    );
  }

  // Uniform over the full range, including codes with leading zeros.
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

  // Supersede any outstanding code for this session so an older one cannot be
  // used after a resend.
  await query(
    `UPDATE onboarding_otp SET consumed_at = now()
      WHERE session_id = $1 AND consumed_at IS NULL`,
    [sessionId],
  );

  await query(
    `INSERT INTO onboarding_otp (session_id, phone, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, phone, hash(code, phone), expiresAt],
  );

  await sendOtp(phone, code);

  return { phone, expiresAt, resendsRemaining: MAX_SENDS - sends - 1 };
}

export async function verifyOtp(sessionId: number, code: string): Promise<string> {
  const row = await one<{
    id: string;
    phone: string;
    code_hash: string;
    attempts: number;
  }>(
    `SELECT id, phone, code_hash, attempts FROM onboarding_otp
      WHERE session_id = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );

  if (!row) {
    throw new OtpError("That code has expired. Request a new one.");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new OtpError("Too many incorrect attempts. Request a new code.", 429);
  }

  const expected = Buffer.from(row.code_hash, "hex");
  const presented = Buffer.from(hash(code.trim(), row.phone), "hex");
  const ok =
    presented.length === expected.length && timingSafeEqual(presented, expected);

  if (!ok) {
    await query("UPDATE onboarding_otp SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw new OtpError(
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? "" : "s"} left.`
        : "Too many incorrect attempts. Request a new code.",
    );
  }

  await query("UPDATE onboarding_otp SET consumed_at = now() WHERE id = $1", [row.id]);
  await query(
    `UPDATE onboarding_sessions
        SET phone = $2, phone_verified_at = now(), updated_at = now()
      WHERE id = $1`,
    [sessionId, row.phone],
  );

  return row.phone;
}
