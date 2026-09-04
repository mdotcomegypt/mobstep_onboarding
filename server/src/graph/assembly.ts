import { drupal } from "../lib/drupal.ts";
import { digest } from "../lib/digest.ts";
import { report } from "../lib/progress.ts";
import { trace } from "../lib/trace.ts";
import { slugify } from "../lib/slug.ts";
import { loadFacts, mutateFacts } from "./facts.ts";
import type { AssemblyStep, OnboardingFacts, StepStatus } from "./state.ts";

/**
 * Assembly, as a set of steps that converge.
 *
 * The old assembly was one function that ran six Drupal calls and recorded a
 * single fact: the app id. Any failure after the first call left a session that
 * could never be repaired, because the next attempt saw the id and returned
 * "this app is already assembled" without touching anything. App 965 reached a
 * green build with a name, no theme, no branches and no catalog that way.
 *
 * Here each step records its own outcome and the fingerprint of what it ran
 * against, so a retry does exactly the work still outstanding — and nothing
 * else. That distinction matters more than it sounds: `createBranches` and
 * `createCatalog` APPEND, so a retry that re-ran everything would give the shop
 * two of every branch. Blindly retrying is worse than not retrying.
 */

export interface StepOutcome {
  step: AssemblyStep;
  status: StepStatus;
  ran: boolean;
  error?: string;
}

export interface ReconcileResult {
  appId: number | null;
  package: string | null;
  outcomes: StepOutcome[];
  /** Things worth saying out loud, in the owner's terms. */
  notes: string[];
  /** True when the app itself could not be created; nothing else was attempted. */
  fatal?: string;
}

interface Context {
  sessionId: number;
  uid: number;
  appId: number | null;
}

interface Step {
  name: AssemblyStep;
  label: string;
  /** Steps that must have succeeded first. */
  needs: AssemblyStep[];
  /** null = nothing to do for these facts. */
  digest: (f: OnboardingFacts) => string | null;
  run: (f: OnboardingFacts, appId: number, ctx: Context) => Promise<string | void>;
}

// ---------------------------------------------------------------- the steps

const STEPS: Step[] = [
  {
    name: "app",
    label: "Creating your app in Mobstep",
    needs: [],
    digest: (f) =>
      f.business.name
        ? digest({
            name: f.business.name,
            type: f.business.type,
            language: f.business.languages?.[0],
            currency: f.business.currency,
            theme: f.themeId,
          })
        : null,
    // `app` is handled by reconcile() itself, because everything else needs the
    // id it produces and it is the only step whose failure is fatal.
    run: async () => {},
  },
  {
    name: "theme",
    label: "Applying your colours across the app",
    needs: ["app"],
    digest: (f) => (f.brand.palette ? digest(f.brand.palette) : null),
    run: async (f, appId) => {
      const p = f.brand.palette!;
      // Design-system tokens, not individual keys: 755 of the app's colour keys
      // reference these, so this is what actually repaints the app. Writing
      // global_colorPrimary alone moved three keys out of a thousand.
      await drupal.setTheme(appId, {
        tokens: {
          brand: p.brand,
          on_brand: p.onBrand,
          surface: p.surface,
          on_surface: p.onSurface,
          border: p.border,
        },
        // Not tokenized in the core — they are the Android theme's own
        // attributes — so they are set directly.
        colors: {
          global_colorPrimary: p.brand,
          global_colorPrimaryDark: p.brand,
          global_colorAccent: p.brand,
        },
      });
    },
  },
  {
    name: "assets",
    label: "Attaching your logo and app icon",
    needs: ["app"],
    digest: (f) => (f.brand.logoUrl ? digest(f.brand.logoUrl) : null),
    run: async (f, appId) => {
      await drupal.addAsset(appId, "logo", f.brand.logoUrl!);
      await drupal.addAsset(appId, "icon", f.brand.logoUrl!);
    },
  },
  {
    name: "features",
    label: "Switching on the features you chose",
    needs: ["app"],
    digest: (f) => (f.features.length ? digest([...f.features].sort()) : null),
    run: async (f, appId, ctx) => {
      // Declarative and re-sendable: the list IS the desired state, so this is
      // the one step that is safe to repeat unconditionally.
      const applied = await drupal.setFeatures(appId, f.features);
      await mutateFacts(ctx.sessionId, (next) => {
        next.features = applied.applied;
      });
    },
  },
  {
    name: "branches",
    label: "Creating your branches",
    needs: ["app"],
    // Keyed on the whole branch, not just the name: changing a delivery fee
    // must count as a change, or it would never be pushed.
    digest: (f) => (f.locations.branches.length ? digest(f.locations.branches) : null),
    run: async (f, appId, ctx) => {
      // Only the ones Drupal does not have yet. This is the whole reason the
      // ledger records ids by name rather than a boolean.
      const known = new Set(f.assembly.branches.map((b) => b.name));
      const missing = f.locations.branches.filter((b) => !known.has(b.name));
      if (missing.length === 0) return;

      // `missing` carries coverage straight through: BranchInput already models
      // it, and it is the only place a delivery fee can live.
      const { branches } = await drupal.createBranches(appId, missing);
      await mutateFacts(ctx.sessionId, (next) => {
        missing.forEach((branch, i) => {
          const id = branches[i];
          if (id !== undefined) next.assembly.branches.push({ name: branch.name, id });
        });
      });
      return `${missing.length} created`;
    },
  },
  {
    name: "catalog",
    label: "Building your categories and items",
    needs: ["app", "branches"],
    digest: (f) =>
      f.catalog.categories.length
        ? digest(f.catalog.categories.map((c) => ({ name: c.name, items: c.items.length })))
        : null,
    run: async (f, appId, ctx) => {
      const known = new Set(f.assembly.categories.map((c) => c.name));
      const missing = f.catalog.categories.filter((c) => !known.has(c.name));
      if (missing.length === 0) {
        // Every category exists but the digest moved, so the catalog was edited
        // after it was created. There is no delete endpoint, and re-posting
        // would duplicate — so say so rather than quietly doing the wrong thing.
        return "changed after creation";
      }

      const branchIds = f.assembly.branches.map((b) => b.id);
      const placeholder = f.artwork.placeholderUrl;

      const { categories } = await drupal.createCatalog(
        appId,
        missing.map((category) => ({
          name: category.name,
          ...(category.iconUrl ? { image: category.iconUrl } : {}),
          items: category.items.map((item) => ({
            name: item.name,
            ...(item.price === undefined ? {} : { price: item.price }),
            ...(item.description ? { description: item.description } : {}),
            ...(item.imageUrl ?? placeholder ? { image: item.imageUrl ?? placeholder } : {}),
          })),
        })),
        branchIds,
      );

      await mutateFacts(ctx.sessionId, (next) => {
        missing.forEach((category, i) => {
          const created = categories[i];
          if (created) {
            next.assembly.categories.push({
              name: category.name,
              id: created.category_id,
              items: created.items.length,
            });
          }
        });
      });
      return `${missing.length} categories created`;
    },
  },
];

// ---------------------------------------------------------------- adoption

/**
 * Seeds the ledger for a session that predates it.
 *
 * An in-flight session has an app in Drupal and no record of how it got there.
 * Leaving the ledger empty would make the next assembly re-append every branch
 * and category the owner already has. So we ask Drupal what exists and mark
 * those steps `adopted` — believed done, ids unknown, never re-pushed.
 */
export async function adopt(sessionId: number, appId: number): Promise<void> {
  const facts = await loadFacts(sessionId);
  if (Object.keys(facts.assembly.steps).length > 0) return;

  let live: Awaited<ReturnType<typeof drupal.preview>> | null = null;
  try {
    live = await drupal.preview(appId);
  } catch (error) {
    // Without evidence, adopt only the app itself. Being cautious here costs a
    // duplicate-free repair; being wrong costs the owner duplicate branches.
    trace("assembly.adopt_blind", {
      appId,
      reason: (error as Error).message.slice(0, 160),
    }, { sessionId });
  }

  const now = new Date().toISOString();
  await mutateFacts(sessionId, (f) => {
    const mark = (step: AssemblyStep): void => {
      f.assembly.steps[step] = { status: "adopted", at: now, attempts: 0 };
    };

    mark("app");
    if (!live) return;

    const brand = live.tokens?.["design_system_brand"];
    if (brand?.startsWith("#") && f.brand.palette && brand.toLowerCase() === f.brand.palette.brand.toLowerCase()) {
      mark("theme");
    }
    if ((live.features ?? []).length > 0) mark("features");
    for (const category of live.catalog?.categories ?? []) {
      f.assembly.categories.push({ name: category.name, id: 0, items: category.items.length });
    }
    if ((live.catalog?.categories ?? []).length > 0) mark("catalog");
  });

  trace("assembly.adopted", { appId, hadPreview: live !== null }, { sessionId });
}

// ---------------------------------------------------------------- reconcile

export async function reconcile(
  ctx: Context,
  options: { packageName?: string; plan?: string } = {},
): Promise<ReconcileResult> {
  let facts = await loadFacts(ctx.sessionId);
  const outcomes: StepOutcome[] = [];
  const notes: string[] = [];

  const businessName = facts.business.name;
  if (!businessName) {
    return { appId: null, package: null, outcomes, notes, fatal: "The business name is not set yet." };
  }

  // ---- the app itself -------------------------------------------------
  let appId = facts.appId ?? ctx.appId;

  if (appId && Object.keys(facts.assembly.steps).length === 0) {
    await adopt(ctx.sessionId, appId);
    facts = await loadFacts(ctx.sessionId);
  }

  if (!appId) {
    const slug = options.packageName ?? slugify(businessName, ctx.uid);
    const base = {
      uid: ctx.uid,
      name: businessName,
      package_name: slug,
      plan: options.plan ?? "starter",
      business_type: facts.business.type ?? "general",
      language: facts.business.languages?.[0] ?? "en",
      currency: facts.business.currency ?? "USD",
    };

    report({ label: `Creating "${businessName}" in Mobstep` });

    let created;
    try {
      created = await drupal.createApp({
        ...base,
        ...(facts.themeId ? { theme: facts.themeId } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A template that is not published is cosmetic; the app is what they came
      // for. Retry without it rather than losing the whole assembly.
      if (facts.themeId && /theme/i.test(message)) {
        trace("assembly.theme_rejected", { themeId: facts.themeId }, { sessionId: ctx.sessionId });
        await mutateFacts(ctx.sessionId, (f) => {
          f.themeId = null;
        });
        report({ label: "That layout is unavailable — using the standard one" });
        created = await drupal.createApp(base);
        notes.push("The layout they picked was not available, so the app uses the standard Mobstep one.");
      } else {
        return { appId: null, package: null, outcomes, notes, fatal: message };
      }
    }

    appId = created.application_id;
    const now = new Date().toISOString();
    await mutateFacts(ctx.sessionId, (f) => {
      f.appId = created.application_id;
      f.packageName = created.package;
      f.assembly.steps["app"] = { status: "done", at: now, attempts: 1 };
    });
    outcomes.push({ step: "app", status: "done", ran: true });
    facts = await loadFacts(ctx.sessionId);
  } else {
    outcomes.push({ step: "app", status: facts.assembly.steps["app"]?.status ?? "adopted", ran: false });
  }

  // ---- everything else -------------------------------------------------
  for (const step of STEPS) {
    if (step.name === "app") continue;

    const record = facts.assembly.steps[step.name];
    const want = step.digest(facts);

    if (want === null) {
      outcomes.push({ step: step.name, status: "skipped", ran: false });
      continue;
    }

    const satisfied =
      (record?.status === "done" || record?.status === "adopted") && record.digest === want;
    if (satisfied) {
      outcomes.push({ step: step.name, status: record.status, ran: false });
      continue;
    }

    const blocked = step.needs.some((need) => {
      const dep = facts.assembly.steps[need];
      return dep?.status !== "done" && dep?.status !== "adopted";
    });
    if (blocked) {
      outcomes.push({ step: step.name, status: "failed", ran: false, error: "a step it depends on has not succeeded" });
      continue;
    }

    report({ label: step.label });
    const now = new Date().toISOString();

    try {
      const note = await step.run(facts, appId, ctx);
      await mutateFacts(ctx.sessionId, (f) => {
        f.assembly.steps[step.name] = {
          status: "done",
          at: now,
          digest: want,
          attempts: (record?.attempts ?? 0) + 1,
        };
      });
      outcomes.push({ step: step.name, status: "done", ran: true });
      if (note === "changed after creation") {
        notes.push(
          "The catalog changed after it was created; the new items are not pushed " +
            "automatically, so tell them to edit it from the dashboard.",
        );
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await mutateFacts(ctx.sessionId, (f) => {
        f.assembly.steps[step.name] = {
          status: "failed",
          at: now,
          digest: want,
          error: message,
          attempts: (record?.attempts ?? 0) + 1,
        };
      });
      outcomes.push({ step: step.name, status: "failed", ran: true, error: message });
      trace("assembly.step_failed", { step: step.name, appId, message }, { sessionId: ctx.sessionId });
    }

    facts = await loadFacts(ctx.sessionId);
  }

  return { appId, package: facts.packageName ?? null, outcomes, notes };
}
