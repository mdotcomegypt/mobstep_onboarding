import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A channel from inside a tool back out to the SSE stream.
 *
 * The problem this solves: a tool call is opaque while it runs. The chat route
 * can say a tool *started* and that it *finished*, and between those two events
 * — which for a batch of twenty generated images is a couple of minutes — the
 * owner has nothing but a spinner. "Thinking…" for two minutes is
 * indistinguishable from a hang, and owners reload the page, which is the one
 * thing guaranteed to make it worse.
 *
 * So tools report what they are actually doing, item by item, and the route
 * forwards it. `AsyncLocalStorage` carries the reporter down through LangGraph's
 * call stack without threading a parameter through every tool signature — the
 * tools are built by `buildTools(ctx)` long before a turn exists, so the turn
 * cannot be closed over.
 */

export interface ProgressUpdate {
  /** A sentence for the owner, in their language where it matters. */
  label: string;
  /** 0-1 where the work has a known size; omitted where it does not. */
  fraction?: number;
  /** Which of how many, for a batch. */
  step?: number;
  total?: number;
  /** Set once the work is finished, so the UI can settle the row. */
  done?: boolean;
}

export type ProgressSink = (update: ProgressUpdate) => void;

const storage = new AsyncLocalStorage<ProgressSink>();

/** Runs `fn` with `sink` installed as the progress channel for its subtree. */
export function withProgress<T>(sink: ProgressSink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

/**
 * Reports progress, if anything is listening.
 *
 * Safe to call from anywhere — a tool invoked outside a turn (a test, the
 * simulation harness) simply has no sink and drops the update.
 */
export function report(update: ProgressUpdate): void {
  storage.getStore()?.(update);
}

/**
 * Runs a batch, reporting each item as it starts and never letting one failure
 * take the rest with it.
 *
 * Every batch in this service is decorative — icons, item photos — so partial
 * success is the correct outcome and the caller gets told exactly which parts
 * are missing rather than losing everything to one 429.
 */
export async function eachWithProgress<In, Out>(
  items: In[],
  label: (item: In, index: number) => string,
  work: (item: In, index: number) => Promise<Out>,
  options: { concurrency?: number } = {},
): Promise<Array<{ item: In; value: Out | null; error: string | null }>> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const results: Array<{ item: In; value: Out | null; error: string | null }> = items.map(
    (item) => ({ item, value: null, error: null }),
  );

  let started = 0;
  let finished = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = started;
      started += 1;
      if (index >= items.length) return;

      const item = items[index] as In;

      // `step` counts COMPLETED work, always — never the index of whatever
      // happened to start. With two runners in flight the two meanings diverge
      // immediately, and the owner watched a counter go 1, 2, 1, 3, 2 while
      // each label named a different section. A progress indicator that goes
      // backwards is worse than none.
      report({
        label: label(item, index),
        step: finished,
        total: items.length,
        fraction: finished / items.length,
      });

      try {
        results[index] = { item, value: await work(item, index), error: null };
      } catch (error) {
        results[index] = { item, value: null, error: (error as Error).message };
      }

      finished += 1;
      report({
        label: label(item, index),
        step: finished,
        total: items.length,
        fraction: finished / items.length,
        done: true,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
  );

  return results;
}
