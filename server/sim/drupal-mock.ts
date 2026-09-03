import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  /** Feature ids currently applied, per app. */
  features: Map<number, string[]>;
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
    features: new Map(),
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

  /**
   * The manifest, built from the REAL core block files and the REAL feature
   * catalog on disk.
   *
   * Not a fixture: if a placement in data/onboarding_features.json names a
   * block the core does not declare, this drops it exactly as BlockManifest
   * does, and the simulation shows the agent working from a catalog one feature
   * short. That is the failure worth catching here.
   *
   * The resolution itself is only approximated — the real one is PHP and is
   * verified against a real project copy by its own harness. What this exists
   * to exercise is the agent: that it names features rather than blocks, reads
   * the report back to the owner, and never gets stuck.
   */
  const manifest = await loadManifest();

  app.get("/api/v3.0/onboarding/manifest", async () => ({
    status: "ok",
    ...manifest,
  }));

  app.get<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/preview",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!state.apps.has(id)) return reply.code(404).send({ error: "no such app" });

      const on = new Set(state.features.get(id) ?? []);
      const screens: Record<string, Record<string, unknown[]>> = {};

      for (const [featureId, feature] of Object.entries(manifest.features)) {
        if (!on.has(featureId)) continue;
        for (const placement of feature.blocks ?? []) {
          const block = manifest.blocks[placement.block];
          if (!block) continue;
          screens[block.screen] ??= {};
          screens[block.screen][placement.position] ??= [];
          (screens[block.screen][placement.position] as unknown[]).push({
            block: placement.block,
            label: block.label,
            placed: true,
            enabled: true,
            weight: placement.weight ?? 0,
          });
        }
      }

      for (const positions of Object.values(screens)) {
        for (const list of Object.values(positions)) {
          (list as Array<{ weight: number }>).sort((a, b) => a.weight - b.weight);
        }
      }

      const theme = state.themeKeys.get(id) ?? {};
      return {
        status: "ok",
        package: String(state.apps.get(id)?.["package_name"] ?? ""),
        core_version: manifest.core_version,
        features: [...on],
        screens,
        tokens: theme,
        dimens: {},
        strings: { app_name: String(state.apps.get(id)?.["name"] ?? "") },
        catalog: { categories: [], sampled_items: 0 },
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v3.0/onboarding/app/:id/features",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!state.apps.has(id)) return reply.code(404).send({ error: "no such app" });

      const wanted = (request.body as { features?: string[] }).features ?? [];
      const known = new Set(Object.keys(manifest.features));
      const unknown = wanted.filter((f) => !known.has(f));
      const resolved = wanted.filter((f) => known.has(f));

      // requires/provides, transitively — the part the agent's replies depend
      // on, since `added` is what it reads out loud.
      const added: string[] = [];
      for (let i = 0; i < resolved.length; i++) {
        const feature = manifest.features[resolved[i] as string];
        for (const need of feature?.requires ?? []) {
          const satisfied =
            resolved.includes(need) ||
            resolved.some((r) => (manifest.features[r]?.provides ?? []).includes(need));
          if (satisfied) continue;

          const supplier =
            known.has(need)
              ? need
              : Object.entries(manifest.features).find(([, f]) =>
                  (f.provides ?? []).includes(need),
                )?.[0];
          if (supplier && !resolved.includes(supplier)) {
            resolved.push(supplier);
            added.push(supplier);
          }
        }
      }

      const conflicts: string[][] = [];
      for (const featureId of resolved) {
        for (const other of manifest.features[featureId]?.conflicts ?? []) {
          if (resolved.includes(other) && !conflicts.some(([a, b]) => a === other && b === featureId)) {
            conflicts.push([featureId, other]);
          }
        }
      }

      const before = state.features.get(id) ?? [];
      state.features.set(id, resolved);

      const placed = resolved.reduce(
        (n, f) => n + (manifest.features[f]?.blocks?.length ?? 0),
        0,
      );
      const removedFeatures = before.filter((f) => !resolved.includes(f));

      return {
        status: "ok",
        applied: resolved,
        added,
        blocked: [],
        unknown,
        conflicts,
        blocks_placed: placed,
        blocks_removed: removedFeatures.reduce(
          (n, f) => n + (manifest.features[f]?.blocks?.length ?? 0),
          0,
        ),
        config_keys_written: placed,
        warnings: [],
      };
    },
  );

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

    // Drupal answers an id that is not a published template with exactly this,
    // and it does so AFTER creating the application entity. Reproduced because
    // it is a failure the agent has actually hit in production: the id was
    // invented, the 400 arrived ten minutes into the conversation, and it took
    // the whole assembly with it.
    const theme = body["theme"];
    if (theme !== undefined && ![41, 42, 43].includes(Number(theme))) {
      return reply.code(400).send({ error: `Theme ${String(theme)} is not a template.` });
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

      // Drupal answers a build that has never run with `pending` and a 200, not
      // a 404 — there is simply no log file yet. Getting this wrong here made
      // the harness see a hard failure where production sees a quiet wait,
      // which is the case most likely to strand a conversation.
      if (!build) {
        return {
          status: "pending",
          package: String(state.apps.get(id)?.["package_name"] ?? ""),
          log: "",
          artifact: null,
        };
      }

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

// -------------------------------------------------------------------------

interface MockPlacement { block: string; position: string; weight?: number }
interface MockFeature {
  id: string;
  label: string;
  blurb: string;
  blocks?: MockPlacement[];
  requires?: string[];
  provides?: string[];
  conflicts?: string[];
  suggest_when?: string;
}
interface MockManifest {
  core_version: string;
  counts: { screens: number; positions: number; blocks: number; features: number };
  blocks: Record<string, { label: string; screen: string; ios_supported: boolean | null }>;
  features: Record<string, MockFeature>;
  presets: Record<string, string[]>;
}

/**
 * Builds the manifest the same way BlockManifest does, from the same two
 * sources: the core's own *_blocks.json and the curated feature catalog.
 *
 * Reading the real files rather than a fixture is the point. A feature whose
 * placement the core does not accept is dropped here exactly as it would be in
 * production, so the simulation runs against the catalog as it actually is.
 */
async function loadManifest(): Promise<MockManifest> {
  const core =
    process.env["SIM_ANDROID_CORE"] ??
    `${process.env["HOME"]}/Projects/mobstep_android_core/app/src/main/res`;
  const catalogPath =
    process.env["SIM_FEATURE_CATALOG"] ??
    `${process.env["HOME"]}/Projects/mobstep_drupal/modules/custom/apps/data/onboarding_features.json`;
  const labelsPath = catalogPath.replace("onboarding_features", "onboarding_labels");

  const accepts = new Map<string, Set<string>>();
  const blocks: MockManifest["blocks"] = {};
  let positions = 0;
  let screens = 0;

  const raw = join(core, "raw");
  for (const file of (await readdir(raw).catch(() => [])) as string[]) {
    if (!file.endsWith("_blocks.json")) continue;
    const screen = file.replace("_blocks.json", "");
    screens += 1;
    const entries = JSON.parse(await readFile(join(raw, file), "utf8")) as Array<{
      block: string;
      position: string;
    }>;
    for (const entry of entries) {
      if (!entry?.block || !entry?.position) continue;
      if (!accepts.has(entry.position)) {
        accepts.set(entry.position, new Set());
        positions += 1;
      }
      accepts.get(entry.position)?.add(entry.block);
      blocks[entry.block] = { label: humanise(entry.block, screen), screen, ios_supported: null };
    }
  }

  const labels = JSON.parse(await readFile(labelsPath, "utf8").catch(() => "{}")) as {
    blocks?: Record<string, string>;
  };
  for (const [id, label] of Object.entries(labels.blocks ?? {})) {
    if (blocks[id]) blocks[id].label = label;
  }

  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    features: Record<string, MockFeature>;
    presets: Record<string, string[]>;
  };

  const features: Record<string, MockFeature> = {};
  for (const [id, feature] of Object.entries(catalog.features)) {
    const bad = (feature.blocks ?? []).filter(
      (p) => !blocks[p.block] || !accepts.get(p.position)?.has(p.block),
    );
    if (bad.length > 0) {
      console.error(
        `  ⚠ mock manifest dropped feature "${id}": ${bad
          .map((p) => `${p.block} @ ${p.position}`)
          .join("; ")}`,
      );
      continue;
    }
    features[id] = { ...feature, id };
  }

  return {
    core_version: "sim",
    counts: { screens, positions, blocks: Object.keys(blocks).length, features: Object.keys(features).length },
    blocks,
    features,
    presets: catalog.presets ?? {},
  };
}

function humanise(id: string, screen: string): string {
  const bare = id.replace(new RegExp(`^${screen}_block_`), "").replace(/_/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
