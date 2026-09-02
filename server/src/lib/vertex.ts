import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "./env.ts";
import { withVertexSlot } from "./gate.ts";
import { trace } from "./trace.ts";

/**
 * A direct Vertex REST client, used only for image generation.
 *
 * The chat path goes through ChatVertexAI, which is worth its weight for tool
 * binding and streaming. Image generation is not: `gemini-2.5-flash-image`
 * answers on the same `:generateContent` endpoint but needs
 * `responseModalities: ["IMAGE"]` and returns its result as an `inlineData`
 * part, neither of which LangChain's chat abstraction models. Wrapping a
 * chat-shaped API around a request whose entire payload is one field it does
 * not know about buys nothing, so this talks to the endpoint directly.
 *
 * Auth is hand-rolled for the same reason lib/jwt.ts is: signing a service
 * account assertion is twenty lines of node:crypto, and the alternative is a
 * dependency whose failure modes are larger than the thing it replaces.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Refreshed a minute early so a token never expires mid-batch. */
let cached: { token: string; expiresAt: number } | null = null;
let serviceAccount: ServiceAccount | null = null;

const b64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function loadServiceAccount(): Promise<ServiceAccount | null> {
  if (serviceAccount) return serviceAccount;

  const path = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (!path) return null;

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("the file has no client_email/private_key");
    }
    serviceAccount = parsed;
    return parsed;
  } catch (error) {
    throw new VertexError(
      `GOOGLE_APPLICATION_CREDENTIALS (${path}) could not be read as a service account key: ` +
        `${(error as Error).message}`,
      0,
    );
  }
}

/**
 * Exponential backoff with jitter.
 *
 * Vertex answers a burst with 429 and stays unhappy for seconds, not
 * milliseconds — the previous 800ms-per-attempt schedule retried three times
 * inside two and a half seconds and gave up while the quota window was still
 * open. Jitter matters because the image batch runs several requests in
 * parallel: without it they back off in lockstep and collide again on every
 * retry.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(1_500 * 2 ** (attempt - 1), 20_000);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class VertexError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }

  /**
   * Whether trying again could plausibly succeed.
   *
   * 429 and 5xx are the provider being busy; 403 and 404 are configuration and
   * will fail identically forever, so retrying them only delays the message
   * that would have told someone what to fix.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

/**
 * An OAuth access token for the service account, or the metadata server's.
 *
 * The metadata fallback is what lets this run on a GCE/Cloud Run instance with
 * no key file on disk, which is how it should eventually be deployed.
 */
export async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const sa = await loadServiceAccount();

  if (!sa) {
    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
    ).catch(() => null);

    if (!response?.ok) {
      throw new VertexError(
        "No Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service " +
          "account key with the Vertex AI User role, or run on an instance with " +
          "an attached service account.",
        0,
      );
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const response = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new VertexError(
      `Could not get a Google access token for ${sa.client_email}: ` +
        `${body.error_description ?? response.statusText}`,
      response.status,
    );
  }

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/**
 * The `global` location is served from the unprefixed host; every regional one
 * has its own. Getting this wrong 404s with a message about the *model* not
 * existing, which sends you looking in entirely the wrong place.
 */
function endpoint(model: string, location: string = env.vertex.location): string {
  const host =
    location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return (
    `https://${host}/v1/projects/${env.vertex.project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`
  );
}

/**
 * Where image generation may be sent.
 *
 * Image quota is granted PER REGION, and the image model's allowance is far
 * tighter than the text model's — measured on this project, `global` sustains
 * roughly one generation every forty seconds, and a batch of nine icons spent
 * six of them on 429s while waiting politely on a pool that was empty.
 *
 * The same request sent to us-east4 or europe-west4 succeeds immediately,
 * because those are different pools. So a 429 is not a reason to wait; it is a
 * reason to go somewhere else. Waiting is the fallback for when every pool is
 * cold at once.
 */
const IMAGE_LOCATIONS = (
  process.env["VERTEX_IMAGE_LOCATIONS"] ?? "global,us-east4,europe-west4"
)
  .split(",")
  .map((location) => location.trim())
  .filter(Boolean);

/** location -> when it is worth trying again. */
const coolingUntil = new Map<string, number>();

function nextLocation(): { location: string; waitMs: number } {
  const now = Date.now();
  const ranked = [...IMAGE_LOCATIONS].sort(
    (a, b) => (coolingUntil.get(a) ?? 0) - (coolingUntil.get(b) ?? 0),
  );
  const best = ranked[0] as string;
  return { location: best, waitMs: Math.max(0, (coolingUntil.get(best) ?? 0) - now) };
}

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  error?: { code: number; message: string; status: string };
  promptFeedback?: { blockReason?: string };
}

async function callOnce(
  model: string,
  body: unknown,
  timeoutMs: number,
  location?: string,
): Promise<GenerateResponse> {
  const token = await accessToken();
  const response = await withVertexSlot(model, () =>
    fetch(endpoint(model, location), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );

  const text = await response.text();
  let parsed: GenerateResponse;
  try {
    parsed = text ? (JSON.parse(text) as GenerateResponse) : {};
  } catch {
    throw new VertexError(
      `Vertex returned a non-JSON response: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  if (!response.ok || parsed.error) {
    throw new VertexError(
      parsed.error?.message ?? `${response.status} ${response.statusText}`,
      parsed.error?.code ?? response.status,
    );
  }

  return parsed;
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
}

/**
 * Generates one image.
 *
 * Retries only what is worth retrying, with a short backoff. An image is a
 * decoration — a category icon, a placeholder — so failing after a couple of
 * attempts and letting the caller carry on without it is always better than
 * holding a conversation open while a queue drains.
 */
export async function generateImage(
  prompt: string,
  options: { reference?: GeneratedImage; attempts?: number; timeoutMs?: number } = {},
): Promise<GeneratedImage> {
  // With three pools to try, attempts are cheap and mostly land immediately.
  const attempts = options.attempts ?? 6;
  const timeoutMs = options.timeoutMs ?? 60_000;

  const parts: Part[] = [];
  if (options.reference) {
    parts.push({
      inlineData: {
        mimeType: options.reference.mime,
        data: options.reference.bytes.toString("base64"),
      },
    });
  }
  parts.push({ text: prompt });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"], temperature: 0.6 },
  };

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { location, waitMs } = nextLocation();

    // Only sleep when EVERY pool is cold. If one is warm, waitMs is zero and
    // this goes straight there — which is the whole point of rotating.
    if (waitMs > 0) {
      trace("image.all_cold", { waitMs, attempt });
      await sleep(Math.min(waitMs, 15_000));
    }

    try {
      const response = await callOnce(env.vertex.imageModel, body, timeoutMs, location);

      const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!image?.inlineData) {
        // A safety block is not a transient failure and will repeat forever.
        const blocked = response.promptFeedback?.blockReason;
        throw new VertexError(
          blocked
            ? `The image request was blocked (${blocked}).`
            : "The image model returned no image.",
          blocked ? 400 : 502,
        );
      }

      // A success says this pool has room; let the next call come straight back.
      coolingUntil.delete(location);

      return {
        bytes: Buffer.from(image.inlineData.data, "base64"),
        mime: image.inlineData.mimeType || "image/png",
      };
    } catch (error) {
      last = error;
      const status = error instanceof VertexError ? error.status : 0;
      const retryable =
        error instanceof VertexError
          ? error.retryable
          : (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";

      // Park this region and move on. 30s is a measured figure, not a guess:
      // `global` recovers on roughly a forty-second cycle, so a shorter
      // cooldown just spends the next attempt rediscovering that it is empty.
      if (status === 429) coolingUntil.set(location, Date.now() + 30_000);

      trace("image.attempt_failed", {
        attempt,
        of: attempts,
        location,
        retryable,
        reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 120),
      });

      if (!retryable || attempt === attempts) break;
      // A 429 is answered by changing region, not by waiting; anything else
      // (a 5xx, a timeout) really is worth a pause.
      if (status !== 429) await sleep(backoffMs(attempt));
    }
  }

  throw last instanceof Error ? last : new Error("Image generation failed.");
}

/**
 * Structured text generation, for the jobs the conversational agent should not
 * be spending its own turn on — writing thirty image prompts, for instance.
 *
 * Returns parsed JSON, retrying once on a malformed body, because a model that
 * wraps JSON in a code fence on one call usually does not on the next.
 */
export interface InlineImage {
  mime: string;
  bytes: Buffer;
}

export async function generateJson<T>(
  prompt: string,
  options: {
    model?: string;
    timeoutMs?: number;
    attempts?: number;
    /** Images the model should read; sent before the prompt text. */
    images?: InlineImage[];
    /** Raised for jobs whose *answer* is large, like a whole menu. */
    maxOutputTokens?: number;
  } = {},
): Promise<T> {
  const model = options.model ?? env.vertex.chatModel;
  const attempts = options.attempts ?? 4;

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const parts: Part[] = [
        ...(options.images ?? []).map((image) => ({
          inlineData: { mimeType: image.mime, data: image.bytes.toString("base64") },
        })),
        { text: prompt },
      ];

      const response = await callOnce(
        model,
        {
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: options.maxOutputTokens ?? 8192,
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        options.timeoutMs ?? 60_000,
      );

      // A reply that ran out of room is truncated JSON, which parses as a
      // syntax error and looks like a flaky model. It is not: it will truncate
      // again at the same size every time, so say what actually happened.
      if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        throw new VertexError(
          "The answer was cut off by the output-token limit — raise maxOutputTokens.",
          400,
        );
      }

      const text = (response.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim()
        // Belt and braces: responseMimeType usually prevents the fence, but a
        // single stray one should not cost the whole batch.
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/, "");

      return JSON.parse(text) as T;
    } catch (error) {
      last = error;

      // A malformed body is worth one more go — a model that fences its JSON
      // on one call usually does not on the next. A 403 is not: it will fail
      // identically forever, and retrying only delays the message that names
      // the fix.
      const retryable =
        error instanceof SyntaxError ||
        (error instanceof VertexError && error.retryable) ||
        (error as Error).name === "TimeoutError";

      trace("json.attempt_failed", {
        attempt,
        of: attempts,
        retryable,
        reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 160),
      });

      if (!retryable || attempt === attempts) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw last instanceof Error ? last : new Error("Structured generation failed.");
}
