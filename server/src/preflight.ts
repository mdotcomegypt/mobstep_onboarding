/**
 * Deployment preflight.
 *
 * Every dependency this service has, checked in one pass, so a failed deploy
 * names its cause instead of surfacing as a stuck chat. Run it after any config
 * change: `pnpm preflight`.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Configuration is checked before anything is imported.
 *
 * env.ts throws at import time on the first missing variable, which for the
 * *server* is correct. For the tool whose entire job is diagnosing a
 * configuration, crashing on variable one and hiding the other six is the
 * opposite of useful — so report them all, then load the modules that need them.
 */
const REQUIRED = [
  "ONBOARDING_SECRET",
  "MOBLD_SECRET",
  "SESSION_SECRET",
  "DATABASE_URL",
  "WA_BUSINESS_ACCOUNT_ID",
  "WA_PHONE_NUMBER_ID",
  "WA_ACCESS_TOKEN",
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error("\n✗ Missing environment variables:\n");
  for (const name of missing) {
    console.error(`    ${name}`);
  }
  console.error(
    "\n  Set these in .env at the repository root (see .env.example).\n" +
      "  preflight loads that file automatically.\n",
  );
  process.exit(1);
}

const { env } = await import("./lib/env.ts");
const { pool } = await import("./db/index.ts");
const { resolveTemplateLanguage } = await import("./lib/whatsapp.ts");

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];
const record = async (name: string, fn: () => Promise<string>): Promise<void> => {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message.split("\n")[0] ?? "failed" });
  }
};

await record("Postgres connection", async () => {
  const { rows } = await pool.query<{ v: string }>("SELECT version() AS v");
  return rows[0]?.v.split(",")[0] ?? "connected";
});

await record("Migrations applied", async () => {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM onboarding_migrations ORDER BY name",
  );
  if (rows.length === 0) throw new Error("no migrations applied — run `pnpm migrate`");

  // Compared against the files on disk, not just counted. A migration that
  // adds a COLUMN passes every other check here -- the table it touches still
  // exists -- and then fails once per request as a 500 from deep inside a
  // route. Deploying the code without the schema has to be caught here.
  const { readdir } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "db", "migrations");
  const onDisk = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const applied = new Set(rows.map((r) => r.name));
  const pending = onDisk.filter((f) => !applied.has(f));
  if (pending.length) {
    throw new Error(`${pending.join(", ")} not applied — run \`pnpm migrate\` before restarting`);
  }

  return `${rows.length} applied, none pending (latest ${rows.at(-1)?.name})`;
});

await record("Onboarding tables", async () => {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'onboarding_%' ORDER BY table_name`,
  );
  const required = [
    "onboarding_assets", "onboarding_events", "onboarding_facts",
    "onboarding_messages", "onboarding_otp", "onboarding_sessions",
    "onboarding_uploads", "onboarding_used_tokens",
  ];
  const present = new Set(rows.map((r) => r.table_name));
  const missing = required.filter((t) => !present.has(t));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `${required.length} present`;
});

await record("Upload directory", async () => {
  const { assertUploadDirWritable } = await import("./lib/uploads.ts");
  await assertUploadDirWritable();
  return `${env.uploadDir} writable`;
});

await record("Drupal reachable", async () => {
  const response = await fetch(`${env.drupalBaseUrl}/api/v3.0/onboarding/app`, {
    method: "POST",
    headers: { "X-Mobld-Secret": env.mobldSecret, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  // 400 is the healthy answer: the secret was accepted and validation rejected
  // the empty body. 403 means the secret does not match Drupal's.
  if (response.status === 403) {
    throw new Error("MOBLD_SECRET does not match Drupal's $settings['apps.mobld_secret']");
  }
  if (response.status === 404 || response.status === 405) {
    throw new Error(
      `${env.drupalBaseUrl} answered ${response.status}: the onboarding routes are not live there. ` +
        "Deploy the apps module and run `drush cr`.",
    );
  }
  if (response.status !== 400) throw new Error(`unexpected ${response.status}`);
  return "secret accepted";
});

await record("WhatsApp template", async () => {
  const language = await resolveTemplateLanguage(env.whatsapp.otpTemplate);
  return `${env.whatsapp.otpTemplate} registered as "${language}"`;
});

await record("Vertex AI", async () => {
  const path = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (!path) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set");
  const sa = JSON.parse(readFileSync(path, "utf8")) as {
    client_email: string; private_key: string; token_uri: string; project_id: string;
  };

  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");

  const tokenResponse = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${signature}`,
    }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("service account could not mint a token");

  const host =
    env.vertex.location === "global"
      ? "aiplatform.googleapis.com"
      : `${env.vertex.location}-aiplatform.googleapis.com`;
  const url =
    `https://${host}/v1/projects/${env.vertex.project}/locations/${env.vertex.location}` +
    `/publishers/google/models/${env.vertex.chatModel}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: PONG" }] }],
      generationConfig: { maxOutputTokens: 16, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    const message = body.error?.message ?? `HTTP ${response.status}`;
    if (message.includes("has not been used") || message.includes("is disabled")) {
      throw new Error(
        `Vertex AI API is not enabled. Run: gcloud services enable aiplatform.googleapis.com --project ${env.vertex.project}`,
      );
    }
    // The trap this names cost real time: a key that authenticates perfectly
    // but belongs to a different project 403s on every call, and the message
    // Google returns is about the *model*, so it reads as a model problem. The
    // two project names side by side make it obvious in one line.
    if (response.status === 403) {
      const owner = sa.project_id ?? "unknown";
      throw new Error(
        `${sa.client_email} is not allowed to call Vertex on project "${env.vertex.project}" ` +
          `(the key names project "${owner}"). Grant it roles/aiplatform.user there, ` +
          "or point GOOGLE_APPLICATION_CREDENTIALS at a key that has it.",
      );
    }
    throw new Error(message.slice(0, 160));
  }
  return `${env.vertex.chatModel} @ ${env.vertex.location} responded`;
});

/**
 * The image model, in every region it is allowed to use.
 *
 * Separate from the chat check because it fails separately: image quota is
 * granted per region and is far tighter, so a deployment can hold a perfectly
 * good conversation and still be unable to draw a single category icon. A 429
 * here is not a failure — it means the region works and is merely busy, which
 * is exactly what the rotation exists to handle.
 */
await record("Vertex image regions", async () => {
  const locations = (process.env["VERTEX_IMAGE_LOCATIONS"] ?? "global,us-east4,europe-west4")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const { accessToken } = await import("./lib/vertex.ts");
  const token = await accessToken();
  const verdicts: string[] = [];
  let usable = 0;

  for (const location of locations) {
    const imageHost =
      location === "global"
        ? "aiplatform.googleapis.com"
        : `${location}-aiplatform.googleapis.com`;
    try {
      const probe = await fetch(
        `https://${imageHost}/v1/projects/${env.vertex.project}/locations/${location}` +
          `/publishers/google/models/${env.vertex.imageModel}:generateContent`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "A solid grey square." }] }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      if (probe.ok) {
        verdicts.push(`${location} ok`);
        usable += 1;
      } else if (probe.status === 429) {
        // Busy, not broken.
        verdicts.push(`${location} busy`);
        usable += 1;
      } else {
        verdicts.push(`${location} ${probe.status}`);
      }
    } catch {
      verdicts.push(`${location} unreachable`);
    }
  }

  if (usable === 0) {
    throw new Error(
      `no usable image region (${verdicts.join(", ")}). Category icons and item ` +
        "photos will be skipped; the catalog still builds without them.",
    );
  }
  return `${usable}/${locations.length} usable — ${verdicts.join(", ")}`;
});

const pad = Math.max(...results.map((r) => r.name.length));
console.log("");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(pad)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);

await pool.end();
process.exit(failed > 0 ? 1 : 0);
