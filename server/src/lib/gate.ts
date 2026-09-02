import { trace } from "./trace.ts";

/**
 * One queue in front of every Vertex request this process makes.
 *
 * Measured behaviour of the project's quota: eight requests one after another
 * all succeed, six fired at once produce 429s. It is a concurrency limit, not a
 * sustained-rate limit — which means retrying harder is exactly the wrong
 * response. Each retry adds another simultaneous request to the pile that
 * caused the rejection, and the failure feeds itself.
 *
 * So requests queue. Two in flight at a time, with a small gap between starts,
 * and everything goes through here: the conversation, menu extraction, icon
 * descriptions and image generation. Splitting the limit across several call
 * sites would defeat it, since the whole point is that the *total* is bounded.
 *
 * Waiting in this queue is invisible to the owner — the SSE stream is already
 * open and the status line already says what is being worked on — whereas a 429
 * is a failed turn. A queued second is cheap; a failed turn is not.
 */

const MAX_IN_FLIGHT = Number(process.env["VERTEX_MAX_IN_FLIGHT"] ?? 2);
const MIN_GAP_MS = Number(process.env["VERTEX_MIN_GAP_MS"] ?? 220);

let inFlight = 0;
let lastStart = 0;
const waiting: Array<() => void> = [];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

/**
 * Runs `fn` in a slot, waiting for one if none is free.
 *
 * `label` is only for the trace, but it is what makes a slow turn legible:
 * without it a queue is indistinguishable from a stall.
 */
export async function withVertexSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();

  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;

  // Space out starts as well as capping concurrency: two requests released in
  // the same millisecond are a burst of two even though the cap was respected.
  const gap = MIN_GAP_MS - (Date.now() - lastStart);
  if (gap > 0) await sleep(gap);
  lastStart = Date.now();

  const waited = Date.now() - queuedAt;
  if (waited > 1_000) trace("vertex.queued", { label, waitedMs: waited, inFlight });

  try {
    return await fn();
  } finally {
    release();
  }
}

/** For the preflight and the debug route: is anything backing up? */
export function gateStats(): { inFlight: number; waiting: number; max: number } {
  return { inFlight, waiting: waiting.length, max: MAX_IN_FLIGHT };
}
