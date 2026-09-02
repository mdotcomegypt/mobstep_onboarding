import { eachWithProgress, report } from "./progress.ts";
import { publicUrl, storeUpload } from "./uploads.ts";
import { trace } from "./trace.ts";
import { generateImage, generateJson, type GeneratedImage } from "./vertex.ts";
import type { Palette } from "../graph/state.ts";

/**
 * The app's artwork: category icons, item photographs and the placeholder that
 * stands in for every item without one.
 *
 * Why this exists at all: a catalog scanned off a printed menu arrives as pure
 * text. Dropped into an app it produces a grid of grey rectangles, which is
 * exactly what a store owner sees when they conclude the product does not work.
 * The menu they photographed had pictures on it; the app has to as well.
 *
 * Two economies shape everything here. Generating a photograph for all 120
 * items of a real menu costs more than the whole onboarding is worth and takes
 * long enough that the owner leaves — so items get a handful of real
 * photographs and one brand-matched placeholder covers the rest. And every
 * image is optional: a failure returns null and the catalog ships without it.
 */

/** House style for icons. Consistency across a set matters more than any one icon. */
/**
 * The no-text clause, spelled out for every prompt that mentions a colour.
 *
 * "No text" alone is not enough when the prompt contains a hex code: the model
 * treats "#D31130" as a string it has been given and renders it INTO the image.
 * The first generated placeholder came back with "D31130" set in bold across
 * the bottom. The colour still has to be named, so the prohibition has to name
 * the failure instead.
 */
const NO_TEXT =
  "Render NO text of any kind: no letters, no words, no numbers, no hex codes, " +
  "no colour names, no labels, no captions, no watermark, no signature. " +
  "The hex value above is an instruction about colour, never something to draw.";

const ICON_STYLE = [
  "Flat vector icon, minimal, geometric, single solid colour on a fully transparent background.",
  "Centered, generous even padding, no drop shadow, no gradient, no outline frame, no background shape.",
  "Thick confident shapes that stay legible at 48x48 pixels.",
].join(" ");

const PHOTO_STYLE = [
  "Professional food photography, appetising, shot on a plain neutral surface.",
  "Soft diffused daylight, shallow depth of field, 45-degree angle, centered composition.",
  "Square 1:1 crop with the dish filling most of the frame.",
  "No packaging branding, no hands, no cutlery clutter.",
  "No text, no letters, no numbers, no labels, no watermark anywhere in the frame.",
].join(" ");

export interface Artwork {
  /** The upload id; the bytes are on disk under it. */
  id: string;
  url: string;
  prompt: string;
}

async function store(
  sessionId: number,
  image: GeneratedImage,
  filename: string,
  kind: string,
  prompt: string,
): Promise<Artwork> {
  const upload = await storeUpload(sessionId, filename, image.bytes, kind);
  return { id: upload.id, url: publicUrl(upload.id), prompt };
}

/** Filesystem-safe, human-recognisable, and never empty even for Arabic input. */
function fileSlug(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Asks the model what each category actually depicts, in English, before any
 * icon is drawn.
 *
 * Drawing straight from the category name fails in exactly the case that
 * matters most here: the menus in this market are written in Arabic, and
 * "مشويات" handed to an image model produces either nothing or a picture of
 * Arabic letters. One cheap text call turns every name — in any script — into a
 * concrete subject, and gives a much better icon for English names too, because
 * "Sides" is not a drawable thing but "a paper cup of french fries" is.
 */
export async function describeForIcons(
  categories: string[],
  businessType: string,
): Promise<Map<string, string>> {
  const fallback = new Map(categories.map((name) => [name, name]));
  if (categories.length === 0) return fallback;

  try {
    const described = await generateJson<Array<{ name: string; subject: string }>>(
      [
        `A ${businessType || "shop"} has these menu/product categories.`,
        "For each, name ONE concrete, simple, drawable object that best represents it.",
        "",
        "Rules:",
        "- Answer in English even when the category is written in another language.",
        "- A single physical object, 2-6 words, no styling adjectives, no text.",
        '- "Pizza" -> "a whole pizza with one slice lifted". "مشويات" -> "a skewer of grilled meat".',
        '- "Desserts" -> "a slice of layered cake". "Beverages" -> "a paper cup with a straw".',
        "",
        "Return a JSON array of objects with keys `name` (copied EXACTLY as given) and `subject`.",
        "",
        "Categories:",
        JSON.stringify(categories),
      ].join("\n"),
    );

    const map = new Map(fallback);
    for (const row of described) {
      if (row?.name && row?.subject) map.set(row.name, row.subject);
    }
    return map;
  } catch (error) {
    // Not worth failing the batch over: the raw names still draw something.
    trace("imagery.describe_failed", {
      reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 160),
    });
    return fallback;
  }
}

export interface CategoryIcon extends Artwork {
  category: string;
}

/**
 * One icon per category, in the brand colour, as a matching set.
 */
export async function generateCategoryIcons(
  sessionId: number,
  categories: string[],
  palette: Palette | undefined,
  businessType: string,
): Promise<{ icons: CategoryIcon[]; failed: Array<{ category: string; reason: string }> }> {
  const colour = palette?.brand ?? "#111827";

  report({ label: "Working out what each section should look like" });
  const subjects = await describeForIcons(categories, businessType);

  const results = await eachWithProgress(
    categories,
    (category) => `Drawing the ${category} icon`,
    async (category, index) => {
      const subject = subjects.get(category) ?? category;
      const prompt = [
        `${ICON_STYLE}`,
        `Subject: ${subject}.`,
        `Colour: fill every shape in solid ${colour}. Use only that one colour.`,
        `This icon belongs to a set for a ${businessType || "shop"} app; keep the weight and level of detail identical across the set.`,
        NO_TEXT,
      ].join(" ");

      const image = await generateImage(prompt, { timeoutMs: 45_000 });
      const artwork = await store(
        sessionId,
        image,
        `icon-${fileSlug(category, `category-${index + 1}`)}.png`,
        "category_icon",
        prompt,
      );
      return { ...artwork, category };
    },
    // Two, not more. The image model shares a quota with the conversation, and
    // three in flight reliably 429s the owner's next reply — which is a far
    // worse trade than icons arriving a few seconds later.
    { concurrency: 2 },
  );

  const icons: CategoryIcon[] = [];
  const failed: Array<{ category: string; reason: string }> = [];
  for (const result of results) {
    if (result.value) icons.push(result.value);
    else failed.push({ category: result.item, reason: result.error ?? "unknown" });
  }

  trace("imagery.icons", { requested: categories.length, made: icons.length, failed: failed.length });
  return { icons, failed };
}

export interface ItemPhoto extends Artwork {
  category: string;
  item: string;
}

export interface ItemRef {
  category: string;
  name: string;
  description?: string;
}

/**
 * Photographs for a chosen few items.
 *
 * Deliberately a *few*. These are the items that appear on the home screen and
 * in the category headers, and they exist to prove to the owner that the app
 * can look like a real storefront. Everything else gets the placeholder.
 */
export async function generateItemPhotos(
  sessionId: number,
  items: ItemRef[],
  businessType: string,
): Promise<{ photos: ItemPhoto[]; failed: Array<{ item: string; reason: string }> }> {
  const results = await eachWithProgress(
    items,
    (item) => `Photographing ${item.name}`,
    async (item, index) => {
      const prompt = [
        PHOTO_STYLE,
        `Subject: ${item.name}${item.description ? ` — ${item.description}` : ""},`,
        `a ${item.category} item from a ${businessType || "restaurant"}.`,
        "Make it look like the real dish a customer would receive, not a stock illustration.",
      ].join(" ");

      const image = await generateImage(prompt, { timeoutMs: 60_000 });
      const artwork = await store(
        sessionId,
        image,
        `item-${fileSlug(item.name, `item-${index + 1}`)}.png`,
        "item_photo",
        prompt,
      );
      return { ...artwork, category: item.category, item: item.name };
    },
    { concurrency: 2 },
  );

  const photos: ItemPhoto[] = [];
  const failed: Array<{ item: string; reason: string }> = [];
  for (const result of results) {
    if (result.value) photos.push(result.value);
    else failed.push({ item: result.item.name, reason: result.error ?? "unknown" });
  }

  trace("imagery.photos", { requested: items.length, made: photos.length, failed: failed.length });
  return { photos, failed };
}

/**
 * The image every item without a photograph falls back to.
 *
 * It has to read as *deliberate* rather than missing, which means it has to be
 * built out of the palette the owner just chose. A generic grey camera glyph in
 * a red-and-cream app is the single clearest signal that a catalog was imported
 * and never finished.
 */
export async function generatePlaceholder(
  sessionId: number,
  palette: Palette | undefined,
  businessType: string,
  businessName: string,
): Promise<Artwork | null> {
  const brand = palette?.brand ?? "#111827";
  const surface = palette?.surface ?? "#f8fafc";

  const prompt = [
    `A square placeholder image for a ${businessType || "shop"} app's product grid.`,
    `Flat vector, no photography. Background: a soft even wash of ${surface}.`,
    `Foreground: one simple centered emblem in ${brand}, at about 40% of the frame —`,
    `a minimal geometric mark suggesting ${businessType || "a shop"}, plus a subtle`,
    `repeating ${brand} pattern at very low opacity behind it.`,
    "It must look intentional and designed, like part of the brand — not like a broken or missing image.",
    "No camera icon and no crossed-out symbols: it must not read as an error state.",
    `Calm and premium; it will sit behind item names in ${businessName || "the shop"}'s menu.`,
    NO_TEXT,
  ].join(" ");

  report({ label: "Designing a placeholder that matches your colours" });

  try {
    const image = await generateImage(prompt, { timeoutMs: 45_000 });
    return await store(sessionId, image, "item-placeholder.png", "placeholder", prompt);
  } catch (error) {
    trace("imagery.placeholder_failed", {
      reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 160),
    });
    return null;
  }
}

/**
 * A logo, for owners who do not have one.
 *
 * Most small shops here have a Facebook cover and nothing else, and an app
 * needs a square mark that survives being shrunk to a launcher icon.
 */
export async function generateLogo(
  sessionId: number,
  businessName: string,
  businessType: string,
  palette: Palette | undefined,
  brief: string,
): Promise<Artwork | null> {
  const brand = palette?.brand ?? "#111827";
  const onBrand = palette?.onBrand ?? "#ffffff";

  const prompt = [
    `A square app icon / logo mark for "${businessName}", a ${businessType || "shop"}.`,
    brief ? `Direction: ${brief}.` : "",
    `Palette: ${brand} as the dominant colour with ${onBrand} for the mark itself.`,
    "Flat vector, bold, symmetrical, centered, with a clear silhouette that still reads at 48x48.",
    "A single emblem, with no photographic detail and no gradients.",
    "Fill the square edge to edge as a solid rounded tile.",
    NO_TEXT,
  ]
    .filter(Boolean)
    .join(" ");

  report({ label: "Sketching a logo mark" });

  try {
    const image = await generateImage(prompt, { timeoutMs: 45_000 });
    return await store(sessionId, image, "logo.png", "logo", prompt);
  } catch (error) {
    trace("imagery.logo_failed", {
      reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 160),
    });
    return null;
  }
}
