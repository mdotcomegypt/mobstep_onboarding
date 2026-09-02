import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { env } from "./lib/env.ts";
import { pruneUsedTokens } from "./lib/session.ts";
import { MAX_UPLOAD_BYTES, assertUploadDirWritable } from "./lib/uploads.ts";
import { chatRoutes } from "./routes/chat.ts";
import { debugRoutes } from "./routes/debug.ts";
import { otpRoutes } from "./routes/otp.ts";
import { sessionRoutes } from "./routes/session.ts";
import { uploadRoutes } from "./routes/upload.ts";

const app = Fastify({
  logger: {
    level: env.isDev ? "debug" : "info",
    // The handoff token and OTP codes must never reach the logs.
    redact: ["req.headers.cookie", "req.headers.authorization", "body.token", "body.code"],
  },
  trustProxy: true,
  // Attachment ids only — the bytes went up via /api/upload — but transcripts
  // and pasted menus make 1 MB tight.
  bodyLimit: 4 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 6 },
});
await app.register(cors, {
  origin: env.isDev ? true : env.publicOrigin,
  credentials: true,
});

/**
 * Health, plus which build is actually running.
 *
 * The commit matters: dist/ is gitignored and systemd runs the compiled output,
 * so a pull without a rebuild leaves this reporting the old commit while the
 * checkout shows the new one. That mismatch is the whole diagnosis.
 */
const buildInfo = await (async () => {
  try {
    const { readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(await readFile(join(here, "build-info.json"), "utf8")) as {
      commit: string;
      builtAt: string;
    };
  } catch {
    // Running from source via --experimental-strip-types, or never built.
    return { commit: "unknown", builtAt: "unknown" };
  }
})();

const health = async () => ({ ok: true, ...buildInfo });

// Registered under /api/ as well as at the root. nginx proxies /api/ and serves
// everything else from the SPA's dist with a try_files fallback to index.html,
// so a bare /health is answered with the React app rather than this JSON —
// which makes it useless for checking which build is running.
app.get("/health", health);
app.get("/api/health", health);

await app.register(sessionRoutes);
await app.register(otpRoutes);
await app.register(chatRoutes);
await app.register(uploadRoutes);
await app.register(debugRoutes);

// Housekeeping for the replay-protection table.
const prune = setInterval(() => {
  pruneUsedTokens().catch((error: unknown) => app.log.error({ err: error }, "prune failed"));
}, 60 * 60 * 1000);
prune.unref();

// Degrade, do not die.
//
// This used to exit(1), on the reasoning that a service which cannot store
// uploads should not pretend it can. That was wrong twice over: sessions, OTP
// and the whole onboarding conversation work fine without uploads, so a
// misconfigured directory took down features it has nothing to do with; and it
// made /health and /api/upload/health — the endpoints whose entire job is
// reporting this — unreachable. A dead process cannot explain why it died.
//
// So: complain loudly, keep serving, and let the upload route answer with 503
// and a fix when someone actually tries to upload.
try {
  await assertUploadDirWritable();
} catch (error) {
  app.log.error(
    { err: error },
    "File uploads are DISABLED: " +
      (error as Error).message +
      " Everything else still works; see GET /api/upload/health.",
  );
}

try {
  await app.listen({ port: env.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
