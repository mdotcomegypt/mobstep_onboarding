import { drupal } from "../lib/drupal.ts";
import { report } from "../lib/progress.ts";
import { trace } from "../lib/trace.ts";
import { loadFacts, mutateFacts } from "./facts.ts";

/**
 * Publishing the owner's web app.
 *
 * This is the deliverable now, not the Android APK. Publishing derives the web
 * bundle from the same Android resource XML the app is built from — so the
 * preview cannot drift from the thing it previews — and then copies it into the
 * Next site and adds a line to its domain map. No build, no restart. A tenant
 * is live seconds after the call.
 *
 * Because it is that cheap, it happens automatically at checkpoints rather than
 * being left to the model to remember. The evidence for that choice is direct:
 * the agent skipped the entire features stage until the tools' `next:` hints
 * chained it explicitly, and even then compliance is probabilistic. A preview
 * the owner is asked to trust must not depend on the model remembering to
 * refresh it — there is no judgement in a file copy, so there is nothing to
 * gain by asking.
 */

export type PublishReason = "assembly" | "catalog" | "artwork" | "features" | "manual";

export interface PublishResult {
  status: "live" | "publishing" | "failed" | "unchanged" | "no_app";
  url?: string;
  log?: string;
}

/** How long to wait for a publish before handing it back to the next turn. */
const SETTLE_MS = 12_000;

/** A first publish restarts the Next process, which takes longer than a copy. */
const SETTLE_FIRST_MS = 30_000;

/**
 * Records that something Drupal renders has changed.
 *
 * Cheaper and far less error-prone than hashing the world: every tool that
 * mutates the app calls this, and the revision is what tells a later publish
 * whether it would do anything.
 */
export async function touch(sessionId: number): Promise<void> {
  await mutateFacts(sessionId, (f) => {
    f.web.revision += 1;
  });
}

export async function publish(
  sessionId: number,
  reason: PublishReason,
): Promise<PublishResult> {
  const facts = await loadFacts(sessionId);
  const appId = facts.appId;

  if (!appId) return { status: "no_app" };

  // Nothing has changed since the last publish, so a second one would copy the
  // same bytes into the same place.
  if (reason !== "manual" && facts.web.publishedRevision === facts.web.revision) {
    return { status: "unchanged", ...(facts.web.url ? { url: facts.web.url } : {}) };
  }

  const revision = facts.web.revision;
  report({
    label: facts.web.publishedRevision === undefined
      ? "Putting your web app online"
      : "Updating your web app",
  });

  // First publish of this app: the Next process has to be restarted to see the
  // new tenant directory at all. Every publish after that is a plain file copy.
  const firstPublish = facts.web.publishedRevision === undefined;

  let started;
  try {
    started = await drupal.publishWeb(appId, firstPublish);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace("web.publish_failed", { appId, reason, message: message.slice(0, 300) }, { sessionId });
    await mutateFacts(sessionId, (f) => {
      f.web.status = "failed";
      f.web.error = message.slice(0, 300);
    });
    return { status: "failed", log: message };
  }

  await mutateFacts(sessionId, (f) => {
    f.web.status = "publishing";
    f.web.url = started.url;
  });

  // Poll on a widening interval. A publish is seconds, so this usually settles
  // inside the calling tool and the owner never sees a "publishing" state at
  // all — the substantive difference from the Android build, which cannot.
  const deadline = Date.now() + (firstPublish ? SETTLE_FIRST_MS : SETTLE_MS);
  let wait = 800;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 1.6, 3_000);

    let status;
    try {
      status = await drupal.webLog(appId, 20);
    } catch {
      continue;
    }

    if (status.status === "success") {
      await mutateFacts(sessionId, (f) => {
        f.web.status = "live";
        f.web.url = status.url;
        f.web.publishedRevision = revision;
        f.web.at = new Date().toISOString();
        delete f.web.error;
        if (f.phase === "assembly") f.phase = "web";
      });
      trace("web.live", { appId, url: status.url, reason }, { sessionId });
      report({ label: "Your web app is live" });
      return { status: "live", url: status.url };
    }

    if (status.status === "failed") {
      const tail = status.log.split("\n").slice(-6).join("\n");
      await mutateFacts(sessionId, (f) => {
        f.web.status = "failed";
        f.web.error = tail.slice(0, 300);
      });
      trace("web.failed", { appId, reason }, { sessionId });
      return { status: "failed", url: status.url, log: tail };
    }
  }

  // Still going. The URL is real and already recorded, so check_web can pick it
  // up next turn rather than the conversation stalling here.
  return { status: "publishing", ...(started.url ? { url: started.url } : {}) };
}

/**
 * Publishes after a change, if the app is already live.
 *
 * Never throws: a stale preview must never cost the owner a saved catalog.
 */
export async function republish(sessionId: number, reason: PublishReason): Promise<void> {
  try {
    const facts = await loadFacts(sessionId);
    if (!facts.appId || facts.web.status === "none") return;
    await publish(sessionId, reason);
  } catch (error) {
    trace("web.republish_failed", {
      reason,
      message: (error as Error).message.slice(0, 200),
    }, { sessionId });
  }
}
