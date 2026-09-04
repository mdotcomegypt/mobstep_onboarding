import { createHash } from "node:crypto";

/**
 * A stable fingerprint of a value.
 *
 * Assembly re-runs a step when the thing it was built from has changed. That
 * needs a comparison that does not depend on key order, because the facts
 * record is JSONB and comes back from Postgres in whatever order it likes —
 * comparing `JSON.stringify` directly would re-push the whole catalog to Drupal
 * because two keys swapped places.
 */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members are absent members; including them would make an
    // optional field's arrival look like a change when nothing was set.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
