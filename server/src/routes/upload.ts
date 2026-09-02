// Side-effect import: @fastify/multipart augments FastifyRequest with
// isMultipart() and files(), and the augmentation only applies when the
// module is imported here.
import "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import {
  MAX_UPLOAD_BYTES,
  StorageError,
  UploadError,
  loadUpload,
  publicUrl,
  storeUpload,
} from "../lib/uploads.ts";
import { requireVerified } from "./guard.ts";

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/upload/health — is file upload actually usable right now?
   *
   * Unauthenticated and side-effect free. The 500 this replaces told the
   * operator nothing and lived only in journalctl; this makes the two things
   * that break uploads (an unapplied migration, an unwritable directory)
   * answerable with one curl.
   */
  app.get("/api/upload/health", async (_request, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      const { assertUploadDirWritable } = await import("../lib/uploads.ts");
      await assertUploadDirWritable();
      checks["directory"] = "writable";
    } catch (error) {
      checks["directory"] = (error as Error).message;
      ok = false;
    }

    try {
      const { query } = await import("../db/index.ts");
      await query("SELECT 1 FROM onboarding_uploads LIMIT 1");
      checks["table"] = "present";
    } catch (error) {
      checks["table"] =
        (error as { code?: string }).code === "42P01"
          ? "onboarding_uploads is missing — run `pnpm migrate`"
          : `database error: ${(error as { code?: string }).code ?? "unknown"}`;
      ok = false;
    }

    checks["maxBytes"] = String(MAX_UPLOAD_BYTES);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  /**
   * POST /api/upload — multipart, one or more files.
   */
  app.post("/api/upload", async (request, reply) => {
    const session = await requireVerified(request, reply);
    if (!session) return;

    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected a multipart upload" });
    }

    const stored: Array<{ id: string; filename: string; mime: string; url: string }> = [];

    try {
      for await (const part of request.files({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
        const buffer = await part.toBuffer();
        const upload = await storeUpload(session.id, part.filename || "upload", buffer);
        stored.push({
          id: upload.id,
          filename: upload.filename,
          mime: upload.mime,
          url: publicUrl(upload.id),
        });
      }
    } catch (error) {
      if (error instanceof UploadError) {
        return reply.code(400).send({ error: error.message });
      }
      // Fastify signals an over-limit file with this code mid-stream.
      if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply
          .code(413)
          .send({ error: `That file is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
      }
      // A misconfigured server is not the user's fault and "please try again"
      // is false — retrying cannot help. Say what is actually wrong, since the
      // person hitting this is usually the one who can fix it.
      if (error instanceof StorageError) {
        request.log.error({ err: error }, "upload storage failure");
        return reply.code(503).send({ error: error.hint });
      }
      request.log.error({ err: error }, "upload failed");
      return reply.code(500).send({ error: "Could not save that file. Please try again." });
    }

    if (stored.length === 0) {
      return reply.code(400).send({ error: "no files received" });
    }
    return reply.send({ files: stored });
  });

  /**
   * GET /api/files/:id — serve an upload back.
   *
   * Deliberately unauthenticated: Drupal fetches these server-to-server when
   * attaching a logo and has no session. The 32-byte random id is the
   * capability, so the URL must not be logged or shown outside the chat.
   */
  app.get<{ Params: { id: string } }>("/api/files/:id", async (request, reply) => {
    const file = await loadUpload(request.params.id);
    if (!file) return reply.code(404).send({ error: "not found" });

    return reply
      .header("Content-Type", file.meta.mime)
      .header("Cache-Control", "private, max-age=86400")
      .header("Content-Disposition", `inline; filename="${encodeURIComponent(file.meta.filename)}"`)
      // These are third-party bytes served from our origin; stop the browser
      // from ever treating one as a document.
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox")
      .send(file.bytes);
  });
}
