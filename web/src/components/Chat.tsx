import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../lib/api.ts";
import {
  type Card,
  type PreviewFacts,
  type Status,
  loadHistory,
  streamTurn,
} from "../lib/chat.ts";
import { AppPreview } from "./AppPreview.tsx";
import { CardView } from "./Cards.tsx";
import { Composer } from "./Composer.tsx";

interface Step {
  name: string;
  done: boolean;
  /** The last thing this step said it was doing. */
  detail?: string;
  step?: number;
  total?: number;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  /** Work the agent did in this turn, kept visible after it finishes. */
  steps?: Step[];
}

/**
 * What each tool is called, in the owner's terms.
 *
 * These stay in the transcript after the turn ends. A transient "Thinking…"
 * that disappears tells the owner nothing about what was done on their behalf,
 * and when the answer arrives two minutes later they have no way to tell a slow
 * job from a broken one.
 */
const TOOL_LABELS: Record<string, string> = {
  inspect_website: "Reading their page",
  record_business: "Noting that down",
  show_themes: "Finding layouts that fit",
  choose_theme: "Saving the layout",
  propose_palette: "Putting colour schemes together",
  choose_palette: "Saving your colours",
  show_logo_options: "Looking for their logo",
  choose_logo: "Saving the logo",
  draw_logo: "Drawing a logo mark",
  scan_menu: "Reading your menu",
  review_catalog: "Laying out the catalog",
  add_items: "Adding those items",
  set_catalog: "Saving the catalog",
  draw_category_icons: "Drawing section icons",
  draw_item_photos: "Photographing sample items",
  draw_placeholder: "Designing your placeholder",
  propose_features: "Working out what your app needs",
  apply_features: "Switching on your features",
  set_branches: "Saving your locations",
  assemble_app: "Assembling your app",
  start_build: "Starting the Android build",
  check_build: "Checking the build",
};

const PHASES = [
  { id: "discovery", label: "Business", hint: "Who you are" },
  { id: "branding", label: "Brand", hint: "Colours and logo" },
  { id: "catalog", label: "Menu", hint: "What you sell" },
  { id: "locations", label: "Branches", hint: "Where you are" },
  { id: "assembly", label: "Assembly", hint: "Putting it together" },
  { id: "build", label: "Build", hint: "Making the app" },
] as const;

export function Chat({ session }: { session: SessionView }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState("discovery");
  const [facts, setFacts] = useState<PreviewFacts | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activity, setActivity] = useState<{ tool: string; status: Status | null } | null>(null);
  const [retry, setRetry] = useState<{ attempt: number; of: number; message: string } | null>(null);
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
    setRetry(null);
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
          setActivity({ tool: name, status: null });
          setRetry(null);
          patchLast((t) => ({
            ...t,
            steps: [...(t.steps ?? []), { name, done: false }],
          }));
        },
        onStatus: (status) => {
          setActivity((current) =>
            current ? { ...current, status } : { tool: "", status },
          );
          // Also written into the step itself, so the detail survives in the
          // transcript rather than vanishing with the live indicator.
          patchLast((t) => {
            const steps = [...(t.steps ?? [])];
            const last = steps.at(-1);
            if (last && !last.done) {
              steps[steps.length - 1] = {
                ...last,
                detail: status.label,
                ...(status.step === undefined ? {} : { step: status.step }),
                ...(status.total === undefined ? {} : { total: status.total }),
              };
            }
            return { ...t, steps };
          });
        },
        onToolDone: (name) =>
          patchLast((t) => ({
            ...t,
            steps: (t.steps ?? []).map((s) =>
              s.name === name && !s.done ? { ...s, done: true } : s,
            ),
          })),
        onRetry: (info) => setRetry(info),
        onDone: (info) => {
          setActivity(null);
          setRetry(null);
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
      setRetry(null);
    }
  }, []);

  const retrySend = (): void => {
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
            <span className="mark" aria-hidden="true">
              <i />
            </span>
            <span className="brand-text">
              <strong>Mobstep</strong>
              <em>building {facts?.name ?? "your app"}</em>
            </span>
          </div>

          <Rail activeIndex={activeIndex} />

          <span className="who">{session.name ?? session.email}</span>
        </header>

        <div className="transcript">
          {turns.map((turn, i) => (
            <article key={i} className={`turn turn-${turn.role}`}>
              {turn.role === "assistant" && (turn.text || turn.cards.length > 0) && (
                <span className="avatar" aria-hidden="true">
                  <i />
                </span>
              )}
              <div className="turn-body">
                {(turn.steps?.length ?? 0) > 0 && <StepList steps={turn.steps ?? []} />}
                {turn.text && <div className="bubble">{turn.text}</div>}
                {turn.cards.map((card, j) => (
                  <CardView
                    key={j}
                    card={card}
                    currency={facts?.currency ?? null}
                    disabled={busy}
                    onReply={(text) => void send(text)}
                  />
                ))}
              </div>
            </article>
          ))}

          {activity && <LiveActivity activity={activity} />}
          {retry && (
            <div className="retry-bar" role="status">
              <span className="pulse" aria-hidden="true" />
              {retry.message}
              <em>
                attempt {retry.attempt + 1} of {retry.of}
              </em>
            </div>
          )}

          {error && (
            <div className="error-bar">
              <div className="error-text">
                <span>{error.message}</span>
                {/* The provider's own words. Muted and secondary, but present:
                    without it every failure looks the same from the outside. */}
                {error.detail && <code className="error-detail">{error.detail}</code>}
              </div>
              <button type="button" className="link inline" onClick={retrySend}>
                Try again
              </button>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <Composer
          busy={busy}
          activity={activity?.status?.label ?? (activity ? TOOL_LABELS[activity.tool] : null) ?? null}
          onSend={(text, attachments) => void send(text, attachments)}
        />
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

      <AppPreview
        facts={facts}
        appId={facts?.appId ?? null}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}

/**
 * The step rail.
 *
 * Six labels do not fit across a 360px phone, and truncating them conveys
 * nothing — so the rail carries a node per phase everywhere, and the *name* of
 * the current step only where there is room for all of them.
 */
function Rail({ activeIndex }: { activeIndex: number }) {
  const progress = ((Math.max(activeIndex, 0) + 1) / PHASES.length) * 100;

  return (
    <nav
      className="rail"
      aria-label="Progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={PHASES.length}
      aria-valuenow={activeIndex + 1}
      aria-valuetext={PHASES[activeIndex]?.label ?? ""}
    >
      <span className="rail-track" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </span>
      <ol className="rail-steps">
        {PHASES.map((p, i) => (
          <li
            key={p.id}
            className={`rail-step${i < activeIndex ? " is-done" : ""}${
              i === activeIndex ? " is-active" : ""
            }`}
          >
            <span className="node" aria-hidden="true" />
            <span className="rail-label">{p.label}</span>
          </li>
        ))}
      </ol>
      <span className="rail-now">
        <b>{PHASES[activeIndex]?.label ?? ""}</b>
        <em>{PHASES[activeIndex]?.hint ?? ""}</em>
      </span>
    </nav>
  );
}

/** The work done in a finished turn, kept as a short record. */
function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((step, k) => (
        <li key={k} className={step.done ? "is-done" : "is-running"}>
          <span className="step-mark" aria-hidden="true" />
          <span className="step-name">{TOOL_LABELS[step.name] ?? step.name}</span>
          {step.detail && !step.done && <span className="step-detail">{step.detail}</span>}
          {step.total !== undefined && step.total > 1 && (
            <span className="step-count">
              {step.done ? step.total : (step.step ?? 0)}/{step.total}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * What is happening right now.
 *
 * This is the replacement for a spinner. Generating a set of category icons
 * takes a couple of minutes, and for that whole time the only honest thing to
 * show is which icon is being drawn and how many are left — an indeterminate
 * spinner held for two minutes is indistinguishable from a hang, and owners
 * reload the page, which loses the turn.
 */
function LiveActivity({ activity }: { activity: { tool: string; status: Status | null } }) {
  const { tool, status } = activity;
  const headline = TOOL_LABELS[tool] ?? "Working";
  const detail = status?.label ?? null;
  const fraction =
    status?.total && status.total > 1 ? (status.step ?? 0) / status.total : undefined;

  return (
    <article className="turn turn-assistant">
      <span className="avatar is-live" aria-hidden="true">
        <i />
      </span>
      <div className="turn-body">
        <div className="activity" role="status" aria-live="polite">
          <div className="activity-head">
            <span className="scanner" aria-hidden="true" />
            <strong>{headline}</strong>
            {status?.total !== undefined && status.total > 1 && (
              <span className="activity-count">
                {status.step ?? 0}
                <em>/{status.total}</em>
              </span>
            )}
          </div>
          {detail && detail !== headline && <p className="activity-detail">{detail}</p>}
          <div className={`activity-bar${fraction === undefined ? " is-indeterminate" : ""}`}>
            <i style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }} />
          </div>
        </div>
      </div>
    </article>
  );
}
