import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../lib/api.ts";
import { type Card, loadHistory, streamTurn } from "../lib/chat.ts";
import { CardView } from "./Cards.tsx";

interface Turn {
  role: "user" | "assistant";
  text: string;
  cards: Card[];
}

const TOOL_LABELS: Record<string, string> = {
  inspect_website: "Reading their website…",
  record_business: "Noting that down…",
  propose_palette: "Putting colour schemes together…",
  review_catalog: "Laying out the catalog…",
  set_catalog: "Saving the catalog…",
  set_branches: "Saving locations…",
  assemble_app: "Building your app…",
  start_build: "Starting the Android build…",
  check_build: "Checking the build…",
};

export function Chat({ session }: { session: SessionView }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, activity]);

  const send = useCallback(async (message: string) => {
    setBusy(true);
    setError(null);
    setActivity(null);

    setTurns((prev) => [
      ...prev,
      ...(message ? ([{ role: "user", text: message, cards: [] }] as Turn[]) : []),
      { role: "assistant", text: "", cards: [] },
    ]);

    // Every event mutates the final turn in place, so the reply grows as it
    // streams instead of appearing all at once.
    const patchLast = (fn: (turn: Turn) => Turn): void =>
      setTurns((prev) => {
        const next = [...prev];
        const last = next.at(-1);
        if (last) next[next.length - 1] = fn(last);
        return next;
      });

    try {
      await streamTurn(message, {
        onToken: (text) => {
          setActivity(null);
          patchLast((t) => ({ ...t, text: t.text + text }));
        },
        onCard: (card) => patchLast((t) => ({ ...t, cards: [...t.cards, card] })),
        onTool: (name) => setActivity(TOOL_LABELS[name] ?? "Working…"),
        onDone: () => setActivity(null),
        onError: (message) => setError(message),
      });
    } catch {
      setError("The connection dropped. Try sending that again.");
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }, []);

  // Load the transcript, then open the conversation if it is empty. The ref
  // guards against StrictMode's double-invoke sending two greetings.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const history = await loadHistory();
      if (history.messages.length > 0) {
        setTurns(
          history.messages.map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            text: m.content,
            cards: m.cards ?? [],
          })),
        );
        return;
      }
      await send("");
    })();
  }, [send]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    void send(message);
  };

  return (
    <div className="chat">
      <header className="chat-header">
        <strong>Set up your app</strong>
        <span className="muted small">
          {session.name ?? session.email}
          {session.appId ? ` · app #${session.appId}` : ""}
        </span>
      </header>

      <div className="transcript">
        {turns.map((turn, i) => (
          <article key={i} className={`turn turn-${turn.role}`}>
            {turn.text && <div className="bubble">{turn.text}</div>}
            {turn.cards.map((card, j) => (
              <CardView key={j} card={card} onReply={(text) => void send(text)} />
            ))}
          </article>
        ))}

        {activity && (
          <article className="turn turn-assistant">
            <div className="bubble activity">{activity}</div>
          </article>
        )}
        {error && <p className="error">{error}</p>}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
          placeholder={busy ? "Thinking…" : "Tell me about your business…"}
          rows={1}
          disabled={busy}
        />
        <button className="button send" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
