import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { trace } from "./trace.ts";

/**
 * Registering an Android app with Firebase.
 *
 * The Android build has a hard, compile-time dependency on Firebase:
 * `apply plugin: 'com.google.gms.google-services'` is unconditional, so a
 * package with no client in google-services.json cannot compile. Until now every
 * package was registered by hand, and the failure surfaced four minutes into a
 * Gradle build as "No matching client found for package name".
 *
 * Two things shape this module.
 *
 * First, **capacity**. A Firebase project caps how many apps it can hold — the
 * default is thirty. `mob-step` already holds 28 (15 Android, 13 iOS), so it has
 * room for two more merchants and then Android builds stop being possible at
 * all, automated or not. New merchants therefore register in a project of their
 * own, `mobstep-customers`, under a service account that exists only for this.
 *
 * Second, **`androidApps.create` does not reject a duplicate package name.** It
 * creates a second app and consumes another slot against that cap. So every
 * registration lists first. A retry that skipped the check would quietly burn
 * the capacity this module exists to protect.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id: string;
}

const SCOPE = "https://www.googleapis.com/auth/firebase";
const API = "https://firebase.googleapis.com/v1beta1";

let account: ServiceAccount | null = null;
let cached: { token: string; expiresAt: number } | null = null;

const b64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class FirebaseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Where the onboarding service account key lives, and which project it owns. */
function keyPath(): string {
  const path = process.env["FIREBASE_CREDENTIALS"];
  if (!path) {
    throw new FirebaseError(
      "FIREBASE_CREDENTIALS is not set, so no Android app can be registered. " +
        "Point it at the onboarding service account key for the customers project.",
      0,
    );
  }
  return path;
}

async function serviceAccount(): Promise<ServiceAccount> {
  if (account) return account;
  const path = keyPath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error("the file is not a service account key");
    }
    account = parsed;
    return parsed;
  } catch (error) {
    throw new FirebaseError(
      `FIREBASE_CREDENTIALS (${path}) could not be read: ${(error as Error).message}`,
      0,
    );
  }
}

/** The Firebase project new merchants are registered into. */
export async function project(): Promise<string> {
  return process.env["FIREBASE_PROJECT"] || (await serviceAccount()).project_id;
}

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const sa = await serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);

  const response = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new FirebaseError(
      `Could not authenticate ${sa.client_email} with Firebase: ${body.error_description ?? response.statusText}`,
      response.status,
    );
  }

  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith("http") ? path : `${API}/${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new FirebaseError(`Firebase returned a non-JSON response: ${text.slice(0, 200)}`, response.status);
  }

  if (!response.ok) {
    const error = (parsed as { error?: { message?: string } }).error?.message ?? response.statusText;
    throw new FirebaseError(error, response.status);
  }
  return parsed as T;
}

export interface AndroidApp {
  name: string;
  appId: string;
  packageName: string;
}

/** Every Android app already in the project, paged. */
export async function listAndroidApps(): Promise<AndroidApp[]> {
  const proj = await project();
  const apps: AndroidApp[] = [];
  let pageToken = "";

  do {
    const page = await api<{ apps?: AndroidApp[]; nextPageToken?: string }>(
      `projects/${proj}/androidApps?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    apps.push(...(page.apps ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  return apps;
}

export interface Registration {
  appId: string;
  packageName: string;
  project: string;
  /** The google-services.json content, parsed. */
  config: unknown;
  /** True when the app already existed and nothing new was created. */
  reused: boolean;
}

/**
 * Ensures the package has an Android app, and returns its google-services.json.
 */
export async function ensureAndroidApp(
  packageName: string,
  displayName: string,
): Promise<Registration> {
  const proj = await project();

  // List first, always. create() would happily make a second app for the same
  // package and consume another slot against the project's cap.
  const existing = (await listAndroidApps()).find((app) => app.packageName === packageName);

  if (existing) {
    trace("firebase.reused", { packageName, appId: existing.appId, project: proj });
    return { ...(await withConfig(existing)), reused: true };
  }

  const created = await api<{ name: string; done?: boolean; response?: AndroidApp; error?: { message: string } }>(
    `projects/${proj}/androidApps`,
    { method: "POST", body: JSON.stringify({ packageName, displayName: displayName.slice(0, 100) }) },
  );

  const app = created.done && created.response ? created.response : await awaitOperation(created.name);
  trace("firebase.created", { packageName, appId: app.appId, project: proj });
  return { ...(await withConfig(app)), reused: false };
}

/** Polls a long-running operation until the app exists. */
async function awaitOperation(name: string): Promise<AndroidApp> {
  let wait = 1_000;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 8_000);

    const operation = await api<{ done?: boolean; response?: AndroidApp; error?: { message: string } }>(name);
    if (operation.error) throw new FirebaseError(operation.error.message, 500);
    if (operation.done && operation.response) return operation.response;
  }

  throw new FirebaseError("Firebase did not finish creating the app in time.", 504);
}

async function withConfig(app: AndroidApp): Promise<Omit<Registration, "reused">> {
  const proj = await project();
  const config = await api<{ configFileContents?: string }>(
    `projects/${proj}/androidApps/${app.appId}/config`,
  );
  if (!config.configFileContents) {
    throw new FirebaseError("Firebase returned no configuration for the app.", 502);
  }
  return {
    appId: app.appId,
    packageName: app.packageName,
    project: proj,
    config: JSON.parse(Buffer.from(config.configFileContents, "base64").toString("utf8")),
  };
}

/**
 * How much room is left.
 *
 * Reported rather than assumed. A registration that fails on the project's cap
 * is the worst possible moment to discover it — a paying merchant has just
 * asked for their app.
 */
export async function capacity(): Promise<{ project: string; android: number; limit: number; room: number }> {
  const proj = await project();
  const android = (await listAndroidApps()).length;
  const limit = Number(process.env["FIREBASE_APP_LIMIT"] ?? 30);
  return { project: proj, android, limit, room: Math.max(0, limit - android) };
}
