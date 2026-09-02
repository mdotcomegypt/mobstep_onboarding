/**
 * Business name to Android package slug: "Rosto Fried Chicken" -> "rosto_fried_chicken".
 *
 * Must satisfy the same [a-z0-9_] shape Drupal enforces before the value reaches
 * a shell, so anything else is dropped rather than escaped.
 */
export function slugify(name: string, uid: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/, "");

  // An all-Arabic name leaves nothing behind, and most of this market's shops
  // are named in Arabic. A digit-leading name ("7 Eleven") is also rejected by
  // Drupal, which requires a leading letter. Neither may block a build.
  if (base === "") {
    return `store_${uid}`;
  }
  if (!/^[a-z]/.test(base)) {
    return `app_${base}`.slice(0, 30).replace(/_+$/, "");
  }
  return base;
}

