import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../lib/api.ts";
import { type Card, loadHistory, streamTurn } from "../lib/chat.ts";
import { CardView } from "./Cards.tsx";
import { Composer } from "./Composer.tsx";

interface Turn {
  role: "user" | "assistant";
  text: string;
  cards: Card[];
}

const TOOL_LABELS: Record<string, string> = {
  inspect_website: "Reading their website",
  record_business: "Noting that down",
  propose_palette: "Putting colour schemes together",
  choose_palette: "Saving your colours",
  show_logo_options: "Looking for their logo",
  choose_logo: "Saving the logo",
  review_catalog: "Laying out the catalog",
  set_catalog: "Saving the catalog",
  set_branches: "Saving locations",
  assemble_app: "Assembling your app",
  start_build: "Starting the Android build",
  check_build: "Checking the build",
};

const PHASES = [
  { id: "discovery", label: "Business" },
  { id: "branding", label: "Brand" },
  { id: "catalog", label: "Menu" },
  { id: "locations", label: "Locations" },
  { id: "assembly", label: "Assembly" },
  { id: "build", label: "Build" },
] as const;

export function Chat({ session }: { session: SessionView }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState("discovery");
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  // The authoritative in-flight flag. State is too slow: a card click and a
  // form submit in the same tick would both read the old value and open two
  // streams onto the same turn, which is what garbled replies in production.
  const inFlight = useRef(false);
  const lastSent = useRef<{ text: string; attachments: string[] } | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, activity]);

  const send = useCallback(async (message: string, attachments: string[] = []) => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastSent.current = { text: message, attachments };

    setBusy(true);
    setError(null);
    setActivity(null);

    const isOpening = message === "" && attachments.length === 0;
    setTurns((prev) => [
      ...prev,
      ...(isOpening ? [] : ([{ role: "user", text: message, cards: [] }] as Turn[])),
      { role: "assistant", text: "", cards: [] },
    ]);

    const patchLast = (fn: (turn: Turn) => Turn): void =>
      setTurns((prev) => {
        const next = [...prev];
        const last = next.at(-1);
        if (last) next[next.length - 1] = fn(last);
        return next;
      });

    try {
      await streamTurn(message, attachments, {
        onToken: (text) => {
          setActivity(null);
          patchLast((t) => ({ ...t, text: t.text + text }));
        },
        onCard: (card) => patchLast((t) => ({ ...t, cards: [...t.cards, card] })),
        onTool: (name) => setActivity(TOOL_LABELS[name] ?? "Working"),
        onDone: (info) => {
          setActivity(null);
          setPhase(info.phase);
        },
        onError: (message) => setError(message),
      });
    } catch {
      setError("The connection dropped.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      setActivity(null);
    }
  }, []);

  const retry = (): void => {
    const last = lastSent.current;
    if (!last) return;
    // Drop the failed assistant turn before retrying so the transcript does not
    // accumulate empty bubbles.
    setTurns((prev) => {
      const next = [...prev];
      if (next.at(-1)?.role === "assistant" && !next.at(-1)?.text) next.pop();
      if (next.at(-1)?.role === "user") next.pop();
      return next;
    });
    void send(last.text, last.attachments);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const history = await loadHistory();
      setPhase(history.phase);
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

  const activeIndex = PHASES.findIndex((p) => p.id === phase);

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="brand">
          <span className="dot" />
          <strong>Set up your app</strong>
        </div>
        <nav className="phases" aria-label="Progress">
          {PHASES.map((p, i) => (
            <span
              key={p.id}
              className={`phase${i < activeIndex ? " done" : ""}${i === activeIndex ? " active" : ""}`}
            >
              {p.label}
            </span>
          ))}
        </nav>
        <span className="muted small who">{session.name ?? session.email}</span>
      </header>

      <div className="transcript">
        {turns.map((turn, i) => (
          <article key={i} className={`turn turn-${turn.role}`}>
            {turn.role === "assistant" && turn.text && <span className="avatar">M</span>}
            <div className="turn-body">
              {turn.text && <div className="bubble">{turn.text}</div>}
              {turn.cards.map((card, j) => (
                <CardView
                  key={j}
                  card={card}
                  disabled={busy}
                  onReply={(text) => void send(text)}
                />
              ))}
            </div>
          </article>
        ))}

        {activity && (
          <article className="turn turn-assistant">
            <span className="avatar">M</span>
            <div className="turn-body">
              <div className="bubble activity">
                {activity}
                <span className="ellipsis"><i /><i /><i /></span>
              </div>
            </div>
          </article>
        )}

        {error && (
          <div className="error-bar">
            <span>{error}</span>
            <button type="button" className="link inline" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <Composer busy={busy} onSend={(text, attachments) => void send(text, attachments)} />
    </div>
  );
}
