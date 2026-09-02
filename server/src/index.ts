import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { env } from "./lib/env.ts";
import { pruneUsedTokens } from "./lib/session.ts";
import { MAX_UPLOAD_BYTES } from "./lib/uploads.ts";
import { chatRoutes } from "./routes/chat.ts";
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

app.get("/health", async () => ({ ok: true }));

await app.register(sessionRoutes);
await app.register(otpRoutes);
await app.register(chatRoutes);
await app.register(uploadRoutes);

// Housekeeping for the replay-protection table.
const prune = setInterval(() => {
  pruneUsedTokens().catch((error: unknown) => app.log.error({ err: error }, "prune failed"));
}, 60 * 60 * 1000);
prune.unref();

try {
  await app.listen({ port: env.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
