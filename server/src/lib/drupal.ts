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
  theme?: string;
  voucher?: string;
  voucher_value?: number;
  action_button_text?: string;
  offer?: unknown;
}

export interface BranchInput {
  name: string;
  phone?: string;
  whatsapp?: string;
  coverage?: Array<{ area: string; price: number }>;
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
    throw new DrupalError(`Non-JSON response from ${path}: ${text.slice(0, 200)}`, response.status);
  }

  if (!response.ok) {
    const error = (parsed as { error?: string }).error ?? response.statusText;
    throw new DrupalError(`${method} ${path} failed: ${error}`, response.status);
  }

  return parsed as T;
}

export const drupal = {
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

  createBranches: (appId: number, branches: BranchInput[]) =>
    call<{ branches: number[] }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/branches`,
      { branches },
    ),

  createCatalog: (appId: number, categories: CategoryInput[], branches: number[] = []) =>
    call<{ categories: Array<{ category_id: number; items: number[] }> }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/catalog`,
      { categories, branches },
    ),

  setTheme: (
    appId: number,
    theme: { colors?: Record<string, string>; dimens?: Record<string, string> },
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

  build: (appId: number, mode: "debug" | "release" = "debug") =>
    call<{ package: string; mode: string; log: string }>(
      "POST",
      `/api/v3.0/onboarding/app/${appId}/build`,
      { mode },
    ),

  buildStatus: (appId: number, lines = 60) =>
    call<BuildStatus>("GET", `/api/v3.0/onboarding/app/${appId}/build/log?lines=${lines}`),

  setPhone: (uid: number, phone: string) =>
    call<{ uid: number; phone: string }>(
      "POST",
      `/api/v3.0/onboarding/user/${uid}/phone`,
      { phone },
    ),
};
