import { randomUUID } from "node:crypto";

/**
 * In-memory trace of recent turns, readable over HTTP.
 *
 * The service logs to journalctl, which needs shell access on the box. That has
 * meant every production problem so far was diagnosed by inference rather than
 * evidence, and several were diagnosed wrongly. This keeps the last few hundred
 * events in a ring buffer so a turn can be inspected from anywhere with the
 * debug key.
 *
 * Deliberately in memory: it is a debugging aid, not an audit log, and it must
 * never become another table to migrate or another disk to fill. It resets on
 * restart, which is exactly when you would want it to.
 */

const MAX_EVENTS = 400;

export interface TraceEvent {
  id: string;
  at: string;
  sessionId: number | null;
  turnId: string | null;
  kind: string;
  detail: Record<string, unknown>;
}

const events: TraceEvent[] = [];

export function trace(
  kind: string,
  detail: Record<string, unknown> = {},
  ctx: { sessionId?: number | null; turnId?: string | null } = {},
): void {
  events.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    sessionId: ctx.sessionId ?? null,
    turnId: ctx.turnId ?? null,
    kind,
    detail,
  });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

export function newTurnId(): string {
  return randomUUID().slice(0, 8);
}

export function readTrace(options: { sessionId?: number; limit?: number } = {}): TraceEvent[] {
  const limit = Math.min(options.limit ?? 120, MAX_EVENTS);
  const filtered =
    options.sessionId === undefined
      ? events
      : events.filter((e) => e.sessionId === options.sessionId);
  return filtered.slice(-limit);
}

/**
 * Truncates anything that goes into a trace.
 *
 * Traces hold model output and tool results; a base64 image or a whole catalog
 * would push everything useful out of the ring buffer within one turn.
 */
export function brief(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  const collapsed = text.replace(/\s+/g, " ");
  return collapsed.length > max ? `${collapsed.slice(0, max)}… (${collapsed.length} chars)` : collapsed;
}
