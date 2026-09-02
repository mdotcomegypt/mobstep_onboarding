import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact HS256 verification, matching the signer in Drupal's
 * OnboardingHandoff::signJwt() byte for byte. Deliberately dependency-free —
 * the two implementations are ten lines each and are easier to keep in step
 * than a shared library across PHP and Node.
 */

export interface HandoffClaims {
  uid: number;
  email: string | null;
  name: string | null;
  app_id: number | null;
  phone: string | null;
  iat: number;
  exp: number;
  jti: string;
}

function b64urlToBuffer(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifyHandoff(token: string, secret: string): HandoffClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest();
  const presented = b64urlToBuffer(signature);

  // Compare lengths first: timingSafeEqual throws on a length mismatch, and
  // that throw would itself be a (very coarse) oracle.
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    throw new Error("bad signature");
  }

  const claims = JSON.parse(b64urlToBuffer(payload).toString("utf8")) as HandoffClaims;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    throw new Error("token expired");
  }
  if (typeof claims.uid !== "number" || !Number.isInteger(claims.uid)) {
    throw new Error("token has no usable uid");
  }
  if (!claims.jti) {
    throw new Error("token has no jti");
  }

  return claims;
}
