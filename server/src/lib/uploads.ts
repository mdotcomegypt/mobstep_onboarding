import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { one, query } from "../db/index.ts";
import { env } from "./env.ts";

/**
 * Owner-supplied files: menu photographs, logos, brand assets.
 *
 * Bytes go to disk, metadata to Postgres. The id is 32 random bytes and is also
 * the public URL segment: Drupal fetches these server-to-server when attaching
 * a logo to an app and cannot present a session cookie, so the URL itself has
 * to be the capability.
 */

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Sniffed from magic numbers, never from the client's Content-Type. */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { mime: "image/gif", ext: "gif", test: (b) => b.subarray(0, 3).toString() === "GIF" },
  { mime: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString() === "%PDF-" },
];

export interface Upload {
  id: string;
  session_id: number;
  filename: string;
  mime: string;
  bytes: number;
  kind: string;
}

export class UploadError extends Error {}

/**
 * Identifies the file by content.
 *
 * A browser will happily send image/png for a .exe. Since these bytes are
 * handed to a model and re-served over HTTP, the declared type is not evidence
 * of anything — only the magic number is.
 */
export function sniff(buffer: Buffer): { mime: string; ext: string } {
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) {
    throw new UploadError(
      "That file type is not supported. Please upload a PNG, JPEG, WebP, GIF or PDF.",
    );
  }
  return { mime: match.mime, ext: match.ext };
}

const pathFor = (id: string, ext: string): string => join(env.uploadDir, `${id}.${ext}`);

export async function storeUpload(
  sessionId: number,
  filename: string,
  buffer: Buffer,
  kind = "attachment",
): Promise<Upload> {
  if (buffer.length === 0) throw new UploadError("That file is empty.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB.`,
    );
  }

  const { mime, ext } = sniff(buffer);
  const id = randomBytes(32).toString("hex");

  await mkdir(env.uploadDir, { recursive: true });
  await writeFile(pathFor(id, ext), buffer, { mode: 0o640 });

  // The extension is derived from the sniffed type, never from the uploaded
  // name, so a crafted filename cannot decide what lands on disk.
  await query(
    `INSERT INTO onboarding_uploads (id, session_id, filename, mime, bytes, kind)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, sessionId, filename.slice(0, 200), mime, buffer.length, kind],
  );

  return { id, session_id: sessionId, filename, mime, bytes: buffer.length, kind };
}

export async function loadUpload(id: string): Promise<{ meta: Upload; bytes: Buffer } | null> {
  // The id is the lookup key and is random; still, reject anything that is not
  // plain hex before it reaches the filesystem.
  if (!/^[0-9a-f]{64}$/.test(id)) return null;

  const meta = await one<Upload>(
    "SELECT id, session_id, filename, mime, bytes, kind FROM onboarding_uploads WHERE id = $1",
    [id],
  );
  if (!meta) return null;

  const ext = SIGNATURES.find((s) => s.mime === meta.mime)?.ext ?? "bin";
  try {
    return { meta, bytes: await readFile(pathFor(id, ext)) };
  } catch {
    return null;
  }
}

export async function listUploads(sessionId: number, ids: string[]): Promise<Upload[]> {
  if (ids.length === 0) return [];
  return query<Upload>(
    `SELECT id, session_id, filename, mime, bytes, kind FROM onboarding_uploads
      WHERE session_id = $1 AND id = ANY($2::text[]) ORDER BY created_at`,
    [sessionId, ids],
  );
}

export const publicUrl = (id: string): string => `${env.publicOrigin}/api/files/${id}`;
