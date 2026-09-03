import type { FastifyInstance } from "fastify";
import { drupal } from "../lib/drupal.ts";
import { trace } from "../lib/trace.ts";
import { loadFacts } from "../graph/facts.ts";
import { requireVerified } from "./guard.ts";

/**
 * What the app actually contains, for the preview pane.
 *
 * A proxy rather than a direct call: the browser has no shared secret, and it
 * must not get one. This route is the only place the two are joined.
 *
 * Two modes, because there are genuinely two situations:
 *
 *   before assembly  there is no project directory yet, so there is nothing
 *                    real to read. `live` is null and the client draws from the
 *                    facts it already has — a projection of what is coming.
 *   after assembly   `live` is the project's own blocks.json and config.xml.
 *                    The preview stops being a drawing of an app and starts
 *                    being a rendering of one.
 *
 * The distinction is reported rather than smoothed over. A preview that claims
 * to be live when it is a mock is worse than one that says which it is.
 */
export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/preview", async (request, reply) => {
    const session = await requireVerified(request, reply);
    if (!session) return;

    const facts = await loadFacts(session.id);
    const appId = facts.appId ?? session.app_id;

    if (!appId) {
      return reply.send({ stage: "projected", appId: null, live: null });
    }

    try {
      const live = await drupal.preview(appId);
      return reply.send({ stage: "live", appId, live });
    } catch (error) {
      // A failure here must not blank the pane. The projected view is still
      // true about everything the conversation has decided, which is most of
      // what the owner is looking at it for.
      trace("preview.failed", {
        appId,
        message: (error as Error).message.replace(/\s+/g, " ").slice(0, 200),
      }, { sessionId: session.id });

      return reply.send({
        stage: "projected",
        appId,
        live: null,
        note: "Could not read the built app just now; showing what we have so far.",
      });
    }
  });

  /**
   * The feature catalog, so the client can name a feature the agent mentions.
   *
   * Cached hard on the Drupal side and changed only by a deploy.
   */
  app.get("/api/manifest", async (request, reply) => {
    const session = await requireVerified(request, reply);
    if (!session) return;

    try {
      const manifest = await drupal.manifest();
      return reply
        .header("Cache-Control", "private, max-age=300")
        .send({
          coreVersion: manifest.core_version,
          counts: manifest.counts,
          features: manifest.features,
          presets: manifest.presets,
        });
    } catch {
      // The client uses this only to put nicer names on things; without it the
      // ids still render.
      return reply.send({ coreVersion: null, counts: null, features: {}, presets: {} });
    }
  });
}
