import { env } from "./env.ts";

/**
 * Typed client for Drupal's /api/v3.0/onboarding/* machine API.
 *
 * The shared secret lives here and only here: it is never handed to the agent,
 * never reaches the browser, and no tool signature exposes it. Every method
 * takes the ids explicitly, because these endpoints — unlike the legacy
 * /api/v1.0/create_* ones — do not read a browser session.
 */

export interface CreateAppInput {
  uid: number;
  name: string;
  package_name: string;
  plan: string;
  business_type: string;
  language: string;
  currency: string;
  /** apps_application id of a template to clone; omit for the core default. */
  theme?: number;
  voucher?: string;
  voucher_value?: number;
  action_button_text?: string;
  offer?: unknown;
}

/** One shift. `days` gives several days the same hours in a single entry. */
export interface BranchHours {
  days: string[];
  start_time: string;
  end_time: string;
}

export interface BranchInput {
  name: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  coverage?: Array<{ area: string; price: number }>;
  /** delivery | in-store | pickup | drive-through | resources */
  services?: string[];
  hours?: BranchHours[];
  currency_code?: string;
  money_format?: string;
  timezone?: string;
}

export interface CategoryInput {
  name: string;
  image?: string;
  items?: unknown[];
}

export interface BuildStatus {
  status: "pending" | "running" | "success" | "failed";
  package: string;
  log: string;
  artifact: string | null;
}

class DrupalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${env.drupalBaseUrl}${path}`, {
    method,
    headers: {
      "X-Mobld-Secret": env.mobldSecret,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // An HTML body means Drupal's page pipeline answered instead of the
    // controller — a PHP fatal that escaped the endpoint's own handler, or a
    // route that did not match. Dumping the first 200 characters of a Drupal
    // error page tells nobody anything: it is a doctype and a Google Tag
    // Manager snippet. Say what it actually means and where the cause is.
    if (/^\s*<(!doctype|html)/i.test(text)) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
      throw new DrupalError(
        `${path} returned an HTML page instead of JSON` +
          (title ? ` ("${title.slice(0, 80)}")` : "") +
          `. That is a server-side fault in the endpoint, not a bad request — ` +
          `the detail is in the Drupal log.`,
        response.status,
      );
    }
    throw new DrupalError(
      `Non-JSON response from ${path}: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
      response.status,
    );
  }

  if (!response.ok) {
    const body = parsed as { error?: string; ref?: string };
    const error = body.error ?? response.statusText;
    // Carry the reference through. A bare "internal error" ends the trail for
    // whoever is on support; with the ref they grep the Drupal log once.
    const ref = body.ref ? ` [ref ${body.ref}]` : "";
    throw new DrupalError(`${method} ${path} failed: ${error}${ref}`, response.status);
  }

  return parsed as T;
}

/**
 * The vocabulary of what an app can contain.
 *
 * Derived on the Drupal side from mobstep_android_core itself, so it cannot
 * describe a block the app could not render. The agent reads `features` and
 * `presets` and nothing else — it never names a block, because a block placed
 * somewhere the core does not accept renders nothing and says nothing.
 */
export interface Manifest {
  core_version: string;
  counts: { screens: number; positions: number; blocks: number; features: number };
  features: Record<string, ManifestFeature>;
  presets: Record<string, string[]>;
  blocks: Record<string, { label: string; screen: string; ios_supported: boolean | null }>;
}

export interface ManifestFeature {
  id: string;
  label: string;
  blurb: string;
  core?: boolean;
  requires?: string[];
  conflicts?: string[];
  provides?: string[];
  needs_config?: boolean;
  config_endpoint?: string;
  /** A hint for when to offer it, written for the agent rather than the owner. */
  suggest_when?: string;
  auto_when?: string;
}

/** What the app actually contains right now, read off the project directory. */
export interface AppPreview {
  package: string;
  core_version: string;
  features: string[];
  screens: Record<
    string,
    Record<
      string,
      Array<{ block: string; label: string; placed: boolean; enabled: boolean }>
    >
  >;
  tokens: Record<string, string>;
  strings: Record<string, string>;
  catalog: {
    categories: Array<{ name: string; items: Array<{ name: string; price: number | null }> }>;
  };
  /** What already exists, so a resumed session can adopt rather than duplicate. */
  branches?: Array<{ id: number; name: string; phone: string }>;
}

export interface WebStatus {
  status: "pending" | "running" | "success" | "failed";
  package: string;
  url: string;
  log: string;
}

export interface FeatureReport {
  applied: string[];
  /** Pulled in as a dependency; the agent says these out loud. */
  added: string[];
  /** Skipped because the app is not entitled to the plugin behind them. */
  blocked: Array<{ feature: string; plugin_code: string; label: string }>;
  unknown: string[];
  conflicts: string[][];
  blocks_placed: number;
  blocks_removed: number;
  config_keys_written: number;
  warnings: Array<{ block: string; label: string; reason: string }>;
}

export interface Theme {
  id: number;
  package: string;
  name: string;
  business: string;
  description: string;
  screenshots: string[];
}

export const drupal = {
  themes: () => call<{ themes: Theme[] }>("GET", "/api/v3.0/onboarding/themes"),

  manifest: () => call<Manifest>("GET", "/api/v3.0/onboarding/manifest"),

  preview: (appId: number) =>
    call<AppPreview>("GET", `/api/v3.0/onboarding/app/${appId}/preview`),

  /**
   * Declarative: the list IS the desired state, so anything omitted is turned
   * off. Safe to re-send unchanged, which matters because turns get retried.
   */
  setFeatures: (appId: number, features: string[]) =>
    call<FeatureReport>("POST", `/api/v3.0/onboarding/app/${appId}/features`, { features }),

  createApp: (input: CreateAppInput) =>
    call<{ application_id: number; package: string }>(
      "POST",
      "/api/v3.0/onboarding/app",
      input,
    ),

  updateApp: (appId: number, patch: Partial<CreateAppInput>) =>
    call<{ application_id: number; package: string }>(
      "PATCH",
      `/api/v3.0/onboarding/app/${appId}`,
      patch,
    ),

  /**
   * `country` names the top of the /coverage settings tree, which is a
   * separate store from the branch's own delivery areas.
   */
  createBranches: (appId: number, branches: BranchInput[], country?: string) =>
    call<{ branches: number[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/branches`,
      { branches, ...(country ? { country } : {}) },
    ),

  createCatalog: (appId: number, categories: CategoryInput[], branches: number[] = []) =>
    call<{ categories: Array<{ category_id: number; items: number[] }> }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/catalog`,
      { categories, branches },
    ),

  setTheme: (
    appId: number,
    theme: {
      /** design_system_* tokens; the path that rebrands the whole app. */
      tokens?: Record<string, string>;
      /** per-element overrides, for keys that should not follow a token */
      colors?: Record<string, string>;
      dimens?: Record<string, string>;
    },
  ) =>
    call<{ package: string; keys_written: number }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/theme`,
      theme,
    ),

  addAsset: (appId: number, kind: "logo" | "icon", url: string, name?: string) =>
    call<{ fid: number; uri: string; derivatives: string[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/asset`,
      { kind, url, name },
    ),

  /**
   * `pid` and `started` are the point: the endpoint used to answer "started" to
   * a launch it had no evidence of, so the agent announced a build that was
   * never running.
   */
  androidIdentity: (appId: number) =>
    call<{
      package: string;
      application_id: string;
      has_google_services: boolean;
      covers: string[];
    }>("GET", `/api/v3.0/onboarding/app/${appId}/android`),

  setGoogleServices: (appId: number, googleServices: unknown) =>
    call<{ written: boolean; application_id: string; covers: string[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/android/firebase`,
      { google_services: googleServices },
    ),

  build: (appId: number, mode: "debug" | "release" = "debug") =>
    call<{ package: string; mode: string; log: string; pid?: number; started?: boolean }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/build`,
      { mode },
    ),

  buildStatus: (appId: number, lines = 60) =>
    call<BuildStatus>("GET", `/api/v3.0/onboarding/app/${appId}/build/log?lines=${lines}`),

  /**
   * Derives the web bundle from the Android XML and publishes it.
   *
   * `started` and `pid` are the point: /api/v1.0/deploy_web answers "started"
   * to a launch it has no evidence of, and never truncates its log, so it
   * cannot be polled. This is its v3.0 twin.
   */
  /**
   * `restart` bounces the Next process, which is required the FIRST time a
   * tenant is published: Next resolves its public/ listing at startup, so a
   * directory added afterwards is not served and the app's config.json 404s.
   * It bounces the site for every tenant, so never send it on a re-publish.
   */
  publishWeb: (appId: number, restart = false) =>
    call<{ package: string; url: string; pid: number; started: boolean; restarted: boolean; log: string }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/web`,
      { restart },
    ),

  webLog: (appId: number, lines = 40) =>
    call<WebStatus>("GET", `/api/v3.0/onboarding/app/${appId}/web/log?lines=${lines}`),

  /**
   * A promotional banner. `art_url` is background art only — the name is a
   * field the app composites over it, so it stays translatable and editable.
   */
  createOffer: (
    appId: number,
    offer: {
      name: string;
      art_url?: string;
      type?: "item" | "category" | "game" | "coupons";
      target_id?: number;
      display_type?: "banner" | "popup" | "highlight";
      expiry?: string;
    },
  ) =>
    call<{ offer_id: number; display_type: string; features: string[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/offers`,
      offer,
    ),

  setLoyalty: (
    appId: number,
    loyalty: {
      type?: "points" | "item_points" | "cashback";
      points_factor?: number;
      cashback_factor?: number;
      expiry_days?: number;
    },
  ) =>
    call<{ loyalty_id: number; type: string; features: string[]; added: string[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/loyalty`,
      loyalty,
    ),

  setPhone: (uid: number, phone: string) =>
    call<{ uid: number; phone: string }>(
      "POST",
      `/api/v3.0/onboarding/user/${uid}/phone`,
      { phone },
    ),
};
