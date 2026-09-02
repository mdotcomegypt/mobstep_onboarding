import Fastify from "fastify";

/**
 * A stand-in for Drupal's /api/v3.0/onboarding/* machine API.
 *
 * The simulation drives the real agent, the real tools and the real Postgres.
 * It must not drive the real Drupal: those endpoints create app tenancies,
 * write into mobstep_android_core and queue Gradle builds on the production
 * host. A rehearsal that leaves half-built apps behind for whoever is on
 * support is not a rehearsal.
 *
 * So this speaks the same protocol, checks the same shared secret, applies the
 * same validation Drupal does, and records every request — which is the part
 * that turns "the conversation looked fine" into evidence about what was
 * actually built.
 */

export interface Recorded {
  at: string;
  method: string;
  path: string;
  body: unknown;
}

export interface MockState {
  requests: Recorded[];
  apps: Map<number, Record<string, unknown>>;
  branches: Map<number, Array<Record<string, unknown>>>;
  catalog: Map<number, Array<Record<string, unknown>>>;
  themeKeys: Map<number, Record<string, string>>;
  assets: Map<number, Array<{ kind: string; url: string }>>;
  builds: Map<number, { startedAt: number; mode: string }>;
}

/** How long a "build" takes before it reports success. */
const BUILD_MS = 12_000;

export async function startDrupalMock(options: {
  port: number;
  secret: string;
}): Promise<{ url: string; state: MockState; stop: () => Promise<void> }> {
  const state: MockState = {
    requests: [],
    apps: new Map(),
    branches: new Map(),
    catalog: new Map(),
    themeKeys: new Map(),
    assets: new Map(),
    builds: new Map(),
  };

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  let nextAppId = 9000;
  let nextBranchId = 100;
  let nextCategoryId = 500;
  let nextItemId = 5000;

  // Same gate as the real thing: a caller without the shared secret gets
  // nothing. Worth keeping, because a broken secret is a failure mode the
  // simulation should be able to reproduce.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v3.0/onboarding")) return;
    if (request.headers["x-mobld-secret"] !== options.secret) {
      await reply.code(403).send({ error: "bad secret" });
      return;
    }
    state.requests.push({
      at: new Date().toISOString(),
      method: request.method,
      path: request.url,
      body: request.body ?? null,
    });
  });

  app.get("/api/v3.0/onboarding/themes", async () => ({
    themes: [
      {
        id: 41,
        package: "mobstep_food_classic",
        name: "Classic Diner",
        business: "Food & Beverage",
        description: "Big photography, categories across the top, cart always visible.",
        screenshots: ["https://cdn.mobstep.test/themes/41/1.png", "https://cdn.mobstep.test/themes/41/2.png"],
      },
      {
        id: 42,
        package: "mobstep_food_dark",
        name: "Night Kitchen",
        business: "Food & Beverage",
        description: "Dark theme built for late-night delivery; large prices, one-tap reorder.",
        screenshots: ["https://cdn.mobstep.test/themes/42/1.png"],
      },
      {
        id: 43,
        package: "mobstep_retail_grid",
        name: "Retail Grid",
        business: "Retail",
        description: "Dense product grid with filters. Built for catalogues over 500 items.",
        screenshots: ["https://cdn.mobstep.test/themes/43/1.png"],
      },
    ],
  }));

  app.post("/api/v3.0/onboarding/app", async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // Drupal rejects these before the value reaches a shell; if the agent can
    // produce a slug this refuses, the simulation must fail here and not in
    // production.
    const pkg = String(body["package_name"] ?? "");
    if (!/^[a-z][a-z0-9_]{2,29}$/.test(pkg)) {
      return reply.code(400).send({ error: `invalid package_name "${pkg}"` });
    }
    if (!body["name"] || !body["uid"]) {
      return reply.code(400).send({ error: "name and uid are required" });
    }

    const id = nextAppId++;
    state.apps.set(id, body);
    return { application_id: id, package: pkg };
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id",
    async (request) => {
      const id = Number(request.params.id);
      state.apps.set(id, {
        ...(state.apps.get(id) ?? {}),
        ...(request.body as Record<string, unknown>),
      });
      return { application_id: id, package: String(state.apps.get(id)?.["package_name"] ?? "") };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/branches",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!state.apps.has(id)) return reply.code(404).send({ error: "no such app" });

      const branches = (request.body as { branches?: Array<Record<string, unknown>> }).branches ?? [];
      if (branches.length === 0) return reply.code(400).send({ error: "no branches" });

      const ids = branches.map(() => nextBranchId++);
      state.branches.set(id, [...(state.branches.get(id) ?? []), ...branches]);
      return { branches: ids };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/catalog",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!state.apps.has(id)) return reply.code(404).send({ error: "no such app" });

      const body = request.body as {
        categories?: Array<{ name: string; image?: string; items?: Array<Record<string, unknown>> }>;
        branches?: number[];
      };
      const categories = body.categories ?? [];

      // The ordering constraint that actually bites: a category with no branch
      // is invisible in the app, which looks like the catalog silently
      // vanishing. Drupal accepts it; this refuses it, so the simulation catches
      // an agent that assembles the catalog before the branches.
      if ((body.branches ?? []).length === 0) {
        return reply
          .code(400)
          .send({ error: "catalog was posted with no branches — categories would belong to nothing" });
      }

      state.catalog.set(id, categories);
      return {
        categories: categories.map((category) => ({
          category_id: nextCategoryId++,
          items: (category.items ?? []).map(() => nextItemId++),
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/theme",
    async (request) => {
      const id = Number(request.params.id);
      const body = request.body as {
        tokens?: Record<string, string>;
        colors?: Record<string, string>;
        dimens?: Record<string, string>;
      };
      const merged = { ...(body.tokens ?? {}), ...(body.colors ?? {}), ...(body.dimens ?? {}) };
      state.themeKeys.set(id, { ...(state.themeKeys.get(id) ?? {}), ...merged });

      // The real endpoint fans a token out across every key that references it;
      // 755 in the current core. Reported so the simulation shows the rebrand
      // actually reaching the app rather than writing five keys into a corner.
      const fanout = Object.keys(body.tokens ?? {}).length * 151;
      return {
        package: String(state.apps.get(id)?.["package_name"] ?? ""),
        keys_written: Object.keys(merged).length + fanout,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/asset",
    async (request, reply) => {
      const id = Number(request.params.id);
      const body = request.body as { kind: string; url: string };

      // Drupal fetches the URL server-to-server. If the agent hands over
      // something unreachable, the real call fails — so this one does too.
      try {
        const response = await fetch(body.url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`${response.status}`);
        const bytes = (await response.arrayBuffer()).byteLength;
        state.assets.set(id, [...(state.assets.get(id) ?? []), { kind: body.kind, url: body.url }]);
        return {
          fid: 7000 + (state.assets.get(id)?.length ?? 1),
          uri: `public://apps/${id}/${body.kind}.png`,
          derivatives: ["48", "96", "192", "512"],
          bytes,
        };
      } catch (error) {
        return reply
          .code(422)
          .send({ error: `could not fetch ${body.kind}: ${(error as Error).message}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/build",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!state.apps.has(id)) return reply.code(404).send({ error: "no such app" });
      const mode = (request.body as { mode?: string }).mode ?? "debug";
      state.builds.set(id, { startedAt: Date.now(), mode });
      return { package: String(state.apps.get(id)?.["package_name"] ?? ""), mode, log: "queued" };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/build/log",
    async (request, reply) => {
      const id = Number(request.params.id);
      const build = state.builds.get(id);
      if (!build) return reply.code(404).send({ error: "no build" });

      const elapsed = Date.now() - build.startedAt;
      const pkg = String(state.apps.get(id)?.["package_name"] ?? "app");
      const done = elapsed >= BUILD_MS;

      const lines = [
        "> Configure project :app",
        "> Task :app:preBuild UP-TO-DATE",
        "> Task :app:mergeDebugResources",
        `> Task :app:processDebugManifest  (${pkg})`,
        "> Task :app:compileDebugKotlin",
        ...(elapsed > BUILD_MS / 2 ? ["> Task :app:mergeDebugAssets", "> Task :app:packageDebug"] : []),
        ...(done ? ["> Task :app:assembleDebug", "BUILD SUCCESSFUL in 1m 47s", "42 actionable tasks"] : []),
      ];

      return {
        status: done ? "success" : "running",
        package: pkg,
        log: lines.join("\n"),
        artifact: done ? `https://builds.mobstep.test/${pkg}/${id}/app-debug.apk` : null,
      };
    },
  );

  app.post<{ Params: { uid: string } }>(
    "/api/v3.0/onboarding/user/:uid/phone",
    async (request) => ({
      uid: Number(request.params.uid),
      phone: String((request.body as { phone?: string }).phone ?? ""),
    }),
  );

  await app.listen({ port: options.port, host: "127.0.0.1" });

  return {
    url: `http://127.0.0.1:${options.port}`,
    state,
    stop: () => app.close(),
  };
}
