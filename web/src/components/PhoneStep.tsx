import { useState } from "react";
import { ApiError, api, type SessionView } from "../lib/api.ts";

/**
 * Phone entry and WhatsApp OTP.
 *
 * Two states in one component because they are one task to the user: give us
 * your number, prove it is yours.
 */
export function PhoneStep({
  session,
  onVerified,
}: {
  session: SessionView;
  onVerified: (phone: string) => void;
}) {
  const [phone, setPhone] = useState(session.phone ?? "");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    run(async () => {
      const result = await api.requestOtp(phone);
      setPhone(result.phone);
      setSent(true);
      setNotice(
        result.resendsRemaining > 0
          ? `Code sent on WhatsApp. You can resend ${result.resendsRemaining} more time${
              result.resendsRemaining === 1 ? "" : "s"
            }.`
          : "Code sent on WhatsApp. This was your last resend for now.",
      );
    });

  const verify = () =>
    run(async () => {
      const result = await api.verifyOtp(code);
      onVerified(result.phone);
    });

  return (
    <main className="shell">
      <div className="card">
        <h1>Let’s verify your number</h1>
        <p className="muted">
          We’ll send a code on WhatsApp. This is the number we’ll use to reach you about
          your app.
        </p>

        {!sent ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="phone">Phone number</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+20 100 000 0000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <button className="button" type="submit" disabled={busy || phone.trim().length < 8}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
              autoFocus
            />
            <button className="button" type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify"}
            </button>
            <button
              className="link"
              type="button"
              disabled={busy}
              onClick={() => {
                setCode("");
                void send();
              }}
            >
              Resend code
            </button>
          </form>
        )}

        {notice && !error && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
