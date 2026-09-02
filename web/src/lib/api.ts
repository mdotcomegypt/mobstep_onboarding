/**
 * Thin fetch wrapper. Every call carries the session cookie.
 */

export interface SessionView {
  uid: number;
  email: string | null;
  name: string | null;
  appId: number | null;
  phone: string | null;
  phoneVerified: boolean;
  status: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: init.body ? { "Content-Type": "application/json" } : {},
    ...init,
  });

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? response.statusText, response.status);
  }
  return body as T;
}

export const api = {
  openSession: (token: string) =>
    call<{ session: SessionView }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  session: () => call<{ session: SessionView }>("/api/session"),

  requestOtp: (phone: string) =>
    call<{ phone: string; expiresAt: string; resendsRemaining: number }>(
      "/api/otp/request",
      { method: "POST", body: JSON.stringify({ phone }) },
    ),

  verifyOtp: (code: string) =>
    call<{ phone: string; phoneVerified: boolean }>("/api/otp/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
};
