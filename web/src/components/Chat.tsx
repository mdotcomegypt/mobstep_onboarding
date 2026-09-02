import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../lib/api.ts";
import { type Card, type PreviewFacts, loadHistory, streamTurn } from "../lib/chat.ts";
import { AppPreview } from "./AppPreview.tsx";
import { CardView } from "./Cards.tsx";
import { Composer } from "./Composer.tsx";

interface Step {
  name: string;
  done: boolean;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  /** Work the agent did in this turn, kept visible after it finishes. */
  steps?: Step[];
}

/**
 * A transient "Thinking…" label tells the owner nothing and disappears, so a
 * slow turn looks like a hang. These stay in the transcript as a short record of
 * what was actually done.
 */
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
  const [facts, setFacts] = useState<PreviewFacts | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
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
      { role: "assistant", text: "", cards: [], steps: [] },
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
        onTool: (name) => {
          setActivity(TOOL_LABELS[name] ?? "Working");
          patchLast((t) => ({
            ...t,
            steps: [...(t.steps ?? []), { name, done: false }],
          }));
        },
        onToolDone: (name) =>
          patchLast((t) => ({
            ...t,
            steps: (t.steps ?? []).map((s) =>
              s.name === name && !s.done ? { ...s, done: true } : s,
            ),
          })),
        onDone: (info) => {
          setActivity(null);
          setPhase(info.phase);
          if (info.facts) setFacts(info.facts);
        },
        onError: (message, detail) => setError({ message, detail }),
      });
    } catch {
      setError({ message: "The connection dropped." });
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
      if (history.facts) setFacts(history.facts);
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
    <div className={`workspace${previewOpen ? " preview-open" : ""}`}>
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

        {/* Phones get a bar and the current step's name: six labels do not fit
            in 360px, and truncated ones convey nothing. */}
        <div
          className="phase-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={PHASES.length}
          aria-valuenow={activeIndex + 1}
          aria-label={`Step ${activeIndex + 1} of ${PHASES.length}`}
        >
          <i style={{ width: `${((activeIndex + 1) / PHASES.length) * 100}%` }} />
        </div>
        <span className="phase-now">{PHASES[activeIndex]?.label ?? ""}</span>
        <span className="muted small who">{session.name ?? session.email}</span>
      </header>

      <div className="transcript">
        {turns.map((turn, i) => (
          <article key={i} className={`turn turn-${turn.role}`}>
            {turn.role === "assistant" && turn.text && <span className="avatar">M</span>}
            <div className="turn-body">
              {(turn.steps?.length ?? 0) > 0 && (
                <ol className="steps">
                  {turn.steps!.map((step, k) => (
                    <li key={k} className={step.done ? "is-done" : "is-running"}>
                      <span className="step-mark" aria-hidden="true" />
                      {TOOL_LABELS[step.name] ?? step.name}
                    </li>
                  ))}
                </ol>
              )}
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
            <div className="error-text">
              <span>{error.message}</span>
              {/* The provider's own words. Muted and secondary, but present:
                  without it every failure looks the same from the outside. */}
              {error.detail && <code className="error-detail">{error.detail}</code>}
            </div>
            <button type="button" className="link inline" onClick={retry}>
              Try again
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <Composer busy={busy} onSend={(text, attachments) => void send(text, attachments)} />
    </div>

      {/* On a phone the preview is a sheet the owner pulls up; there is not
          room for it beside a conversation. On desktop it is always visible. */}
      <button
        type="button"
        className="preview-toggle"
        aria-expanded={previewOpen}
        onClick={() => setPreviewOpen((open) => !open)}
      >
        {previewOpen ? "Hide preview" : "Preview your app"}
      </button>

      <AppPreview facts={facts} onClose={() => setPreviewOpen(false)} />
    </div>
  );
}
