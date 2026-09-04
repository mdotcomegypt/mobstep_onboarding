import { createHmac, timingSafeEqual } from "node:crypto";
import { one, query } from "../db/index.ts";
import { env } from "./env.ts";
import { verifyHandoff } from "./jwt.ts";

/**
 * Session handling.
 *
 * The Drupal handoff token crosses the origin boundary exactly once and is then
 * exchanged for a cookie scoped to this service. The token's jti is recorded so
 * a link copied out of browser history — or captured anywhere in between —
 * cannot be replayed inside its remaining validity window.
 */

export const SESSION_COOKIE = "mobstep_onboarding";
const SESSION_TTL_DAYS = 30;

export interface OnboardingSession {
  id: number;
  drupal_uid: number;
  email: string | null;
  name: string | null;
  app_id: number | null;
  phone: string | null;
  phone_verified_at: Date | null;
  status: string;
}

/** `<sessionId>.<hmac>` — the id is not guessable on its own. */
export function signSessionCookie(sessionId: number): string {
  const mac = createHmac("sha256", env.sessionSecret)
    .update(String(sessionId))
    .digest("base64url");
  return `${sessionId}.${mac}`;
}

export function readSessionCookie(value: string | undefined): number | null {
  if (!value) return null;
  const [id, mac] = value.split(".");
  if (!id || !mac) return null;

  const expected = createHmac("sha256", env.sessionSecret).update(id).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const parsed = Number(id);
  return Number.isInteger(parsed) ? parsed : null;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: !env.isDev,
  path: "/",
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
};

/**
 * Exchanges a handoff token for a session, creating or refreshing the row.
 */
export async function exchangeHandoff(token: string): Promise<OnboardingSession> {
  const claims = verifyHandoff(token, env.onboardingSecret);

  // Single-use. The unique constraint is what actually enforces it, so two
  // concurrent exchanges cannot both succeed.
  //
  // Only a unique violation means "replayed". Every other failure — the
  // database being unreachable, most obviously — must surface as itself:
  // telling an owner their link was already used when the real problem is an
  // outage sends them round the login loop forever and buries the actual fault.
  try {
    await query(
      `INSERT INTO onboarding_used_tokens (jti, drupal_uid, expires_at)
       VALUES ($1, $2, to_timestamp($3))`,
      [claims.jti, claims.uid, claims.exp],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error("This sign-in link has already been used. Please sign in again.");
    }
    throw error;
  }

  const session = await one<OnboardingSession>(
    `INSERT INTO onboarding_sessions (drupal_uid, email, name, app_id, phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (drupal_uid) DO UPDATE
        SET email      = COALESCE(EXCLUDED.email, onboarding_sessions.email),
            name       = COALESCE(EXCLUDED.name, onboarding_sessions.name),
            app_id     = COALESCE(EXCLUDED.app_id, onboarding_sessions.app_id),
            -- A fresh handoff is a fresh sign-in, so it lifts an earlier
            -- logout rather than handing back a session that loadSession
            -- would then refuse.
            revoked_at = NULL,
            updated_at = now()
     RETURNING id, drupal_uid, email, name, app_id, phone, phone_verified_at, status`,
    [claims.uid, claims.email, claims.name, claims.app_id, claims.phone],
  );

  if (!session) throw new Error("Could not open an onboarding session.");
  return session;
}

export async function loadSession(id: number): Promise<OnboardingSession | null> {
  // revoked_at IS NULL is the whole of the logout check. Signing out of
  // Mobstep used to leave this session usable for the rest of its 30 days,
  // because the handoff token is verified once and never consulted again.
  return one<OnboardingSession>(
    `SELECT id, drupal_uid, email, name, app_id, phone, phone_verified_at, status
       FROM onboarding_sessions WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

/**
 * Signs a Mobstep user out of this service.
 *
 * Called by Drupal's hook_user_logout. Returns how many sessions it closed,
 * which is 0 for someone who never started onboarding — a normal answer, not
 * an error.
 */
export async function revokeSessionsFor(drupalUid: number): Promise<number> {
  // RETURNING, because the query helper hands back rows rather than a result
  // object and there is no rowCount to read.
  const closed = await query<{ id: number }>(
    `UPDATE onboarding_sessions
        SET revoked_at = now()
      WHERE drupal_uid = $1 AND revoked_at IS NULL
      RETURNING id`,
    [drupalUid],
  );
  return closed.length;
}

export async function recordEvent(
  sessionId: number,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await query(
    "INSERT INTO onboarding_events (session_id, kind, payload) VALUES ($1, $2, $3)",
    [sessionId, kind, JSON.stringify(payload)],
  );
}

/** Housekeeping for the replay table; safe to call on a timer. */
export async function pruneUsedTokens(): Promise<void> {
  await query("DELETE FROM onboarding_used_tokens WHERE expires_at < now() - interval '1 day'");
}
