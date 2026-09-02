import { useEffect, useState } from "react";
import { ApiError, api, type SessionView } from "./lib/api.ts";
import { PhoneStep } from "./components/PhoneStep.tsx";
import { Chat } from "./components/Chat.tsx";

type Status =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; session: SessionView };

/**
 * Reads the handoff token Drupal put in the URL fragment.
 *
 * The fragment is cleared immediately: it is a credential, and leaving it in
 * the address bar puts it into browser history and into any screenshot the
 * owner sends to support.
 */
function takeHandoffToken(): string | null {
  const match = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return null;

  const token = decodeURIComponent(match[1]);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return token;
}

export function App() {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  useEffect(() => {
    const token = takeHandoffToken();

    const open = async (): Promise<void> => {
      try {
        const { session } = token ? await api.openSession(token) : await api.session();
        setStatus({ state: "ready", session });
      } catch (error) {
        setStatus({
          state: "error",
          message:
            error instanceof ApiError && error.status === 401
              ? "Your sign-in link has expired. Please sign in again from mobstep.com."
              : (error as Error).message,
        });
      }
    };

    void open();
  }, []);

  if (status.state === "loading") {
    return <Centered>Loading…</Centered>;
  }

  if (status.state === "error") {
    return (
      <Centered>
        <p className="error">{status.message}</p>
        <a className="button" href="https://mobstep.com/user/login">
          Sign in
        </a>
      </Centered>
    );
  }

  const { session } = status;

  if (!session.phoneVerified) {
    return (
      <PhoneStep
        session={session}
        onVerified={(phone) =>
          setStatus({ state: "ready", session: { ...session, phone, phoneVerified: true } })
        }
      />
    );
  }

  return <Chat session={session} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      <div className="card centered">{children}</div>
    </main>
  );
}
