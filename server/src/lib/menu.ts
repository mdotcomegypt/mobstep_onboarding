import { query } from "../db/index.ts";
import { report } from "./progress.ts";
import { trace } from "./trace.ts";
import { loadUpload, type Upload } from "./uploads.ts";
import { generateJson, type InlineImage } from "./vertex.ts";
import type { CatalogCategory } from "../graph/state.ts";

/**
 * Reading a menu out of a photograph.
 *
 * This deliberately does NOT go through the conversational agent's own turn,
 * and that is the whole point of the module.
 *
 * The agent used to extract the menu itself, by calling `review_catalog` with
 * every item as a tool argument. On a real menu — the Rosto sheet is 93 items
 * across 6 sections — that tool call is several thousand output tokens, and it
 * shares one `maxOutputTokens` budget with the reply the owner is waiting to
 * read. The observed result was not a truncated catalog, which would at least
 * be visible: it was a turn that produced *nothing at all*, twice, because the
 * budget ran out mid-call and the candidate came back empty. From the owner's
 * side the assistant said "I'll read this menu" and then lost its train of
 * thought — the single worst failure this product has.
 *
 * So extraction is its own call, with its own much larger budget, whose entire
 * answer is the catalog. The agent asks for it and gets a finished result back.
 */

interface ExtractedCategory {
  name: string;
  items: Array<{ name: string; price?: number | null; description?: string | null }>;
}

interface Extraction {
  categories: ExtractedCategory[];
  currency?: string | null;
  unreadable?: string[] | null;
  language?: string | null;
}

const PROMPT = `
You are reading a shop's printed menu or price list from photographs.

Extract EVERY line item you can see. This is the shop's real catalog and a
missing item means a customer cannot order it.

Rules:
- Keep names EXACTLY as printed, in the original language and script. Do not
  translate. Do not transliterate. Do not tidy up spelling.
- Group items under the section headings the menu itself uses, in the order they
  appear. If a section has no heading, name it after what it contains.
- Prices: digits only, no currency symbol. Convert Arabic-Indic numerals
  (٠١٢٣٤٥٦٧٨٩) to Western digits. If an item has no price, omit the field.
- When one item shows several prices for several sizes (S/M/L), create ONE item
  and use the SMALLEST price, then record the other sizes in the description,
  e.g. "S 110 / M 160 / L 220".
- Put the ingredient or description line, if there is one, in \`description\`.
- Ignore anything that is not an orderable item: service-charge notices, tax
  notices, phone numbers, addresses, social media handles, slogans.
- The shop's OWN NAME is not a section. A banner or logo reading "Rosto Pizza"
  is the masthead; the section is whatever the list beneath it actually is
  ("Pizza"). Never create a section named after the business.
- Do not create the same section twice. A heading printed in two languages
  ("المناقيش" and "Manakeesh") is ONE section — use the original-language name
  once and put every item under it.
- An add-on or upgrade strip — stuffed crust, extra cheese, size upcharges —
  is not a section of its own. Fold those into the section they modify as
  items, or into the description of the items they apply to.
- Every section you return must contain at least one real orderable item. If a
  heading has no items under it, leave it out.
- If part of the image is genuinely unreadable, list what you could not read in
  \`unreadable\` and still return everything else.

Return JSON:
{
  "categories": [{ "name": "...", "items": [{ "name": "...", "price": 123, "description": "..." }] }],
  "currency": "EGP" | null,
  "language": "ar" | "en" | ...,
  "unreadable": ["..."]
}
`.trim();

export interface ScanResult {
  categories: CatalogCategory[];
  currency: string | null;
  language: string | null;
  unreadable: string[];
  imagesRead: number;
}

/**
 * The images this session has uploaded that are worth reading.
 *
 * Generated artwork is excluded by kind: once icons and item photographs are in
 * the uploads table, "the most recent images" would otherwise mean the icons
 * this service drew a minute ago, and a rescan would read its own output.
 */
export async function menuImages(sessionId: number, limit = 4): Promise<Upload[]> {
  return query<Upload>(
    `SELECT id, session_id, filename, mime, bytes, kind FROM onboarding_uploads
      WHERE session_id = $1 AND kind = 'attachment' AND mime LIKE 'image/%'
      ORDER BY created_at DESC LIMIT $2`,
    [sessionId, limit],
  );
}


/**
 * A second pass over the section list, and only the section list.
 *
 * Extraction gets the items right and the sections wrong, consistently and in
 * the same three ways. On the Rosto sheet it produced nine sections where the
 * menu has seven: it made the masthead ("بيتزا روستو", the shop's own name) into
 * a section, it made the stuffed-crust upcharge strip into a section, and it
 * split the manakeesh list in two because the heading is printed in Arabic and
 * English side by side.
 *
 * Telling the extraction prompt not to do those things did not stop it — which
 * is unsurprising, because at the moment it reads a heading it has not yet seen
 * the rest of the sheet. Judging the *shape* of a menu is a different job from
 * reading it, and it is a cheap one: this call sees only section names and item
 * counts, never the items, so it stays small however long the menu is.
 */
async function tidySections(
  categories: CatalogCategory[],
  businessName: string,
): Promise<CatalogCategory[]> {
  if (categories.length < 2) return categories;

  const summary = categories.map((c, index) => ({
    index,
    name: c.name,
    items: c.items.length,
    sample: c.items.slice(0, 3).map((i) => i.name),
  }));

  interface Plan {
    keep: Array<{ index: number; name: string; mergeFrom?: number[] | null }>;
    drop?: number[] | null;
  }

  const plan = await generateJson<Plan>(
    [
      `These are the sections extracted from a printed menu for "${businessName || "a shop"}".`,
      "They came out of an image and contain the usual mistakes. Tidy the LIST.",
      "",
      "Fix exactly these problems, and change nothing else:",
      "1. A section named after the SHOP ITSELF is the masthead, not a section.",
      "   Rename it to what its items actually are (look at `sample`).",
      "2. The SAME section printed in two languages appears twice. Merge them into",
      "   one, keeping the name in the menu's main language.",
      "3. A section that is an add-on or upcharge strip rather than a course",
      "   (stuffed crust, extra toppings, size upgrades) should be merged into the",
      "   section it modifies.",
      "4. Drop a section only if it is clearly not orderable food or products.",
      "",
      "Do NOT merge two genuinely different sections just because they are similar.",
      "Pizzas and manakeesh are different. Preserve the original order.",
      "",
      "Return JSON:",
      '{ "keep": [{ "index": 0, "name": "final name", "mergeFrom": [4] }], "drop": [] }',
      "`index` is the section to keep, `name` its final name, `mergeFrom` other",
      "indexes whose items move into it. Every index must appear exactly once,",
      "in `keep`, in some `mergeFrom`, or in `drop`.",
      "",
      JSON.stringify(summary, null, 1),
    ].join("\n"),
    { timeoutMs: 60_000 },
  );

  const keep = plan.keep ?? [];
  if (keep.length === 0) return categories;

  const used = new Set<number>();
  const tidied: CatalogCategory[] = [];

  for (const entry of keep) {
    const base = categories[entry.index];
    if (!base || used.has(entry.index)) continue;
    used.add(entry.index);

    const merged: CatalogCategory = {
      name: (entry.name || base.name).trim(),
      items: [...base.items],
    };

    for (const from of entry.mergeFrom ?? []) {
      const source = categories[from];
      if (!source || used.has(from)) continue;
      used.add(from);
      const seen = new Set(merged.items.map((i) => i.name.toLowerCase()));
      for (const item of source.items) {
        if (!seen.has(item.name.toLowerCase())) merged.items.push(item);
      }
    }

    if (merged.items.length > 0) tidied.push(merged);
  }

  // Anything the plan forgot is kept, not lost. A tidy-up that silently drops a
  // section is far worse than one that leaves a duplicate behind.
  for (const [index, category] of categories.entries()) {
    if (!used.has(index) && !(plan.drop ?? []).includes(index)) {
      tidied.push(category);
    }
  }

  const before = categories.reduce((n, c) => n + c.items.length, 0);
  const after = tidied.reduce((n, c) => n + c.items.length, 0);
  trace("menu.tidied", {
    sectionsBefore: categories.length,
    sectionsAfter: tidied.length,
    itemsBefore: before,
    itemsAfter: after,
  });

  // A tidy pass must never lose items. If it somehow has, the untouched
  // extraction is the safer answer.
  return after >= before ? tidied : categories;
}

export async function scanMenu(
  sessionId: number,
  uploadIds?: string[],
  businessName = "",
): Promise<ScanResult> {
  const wanted = uploadIds?.length
    ? (await menuImages(sessionId, 12)).filter((u) => uploadIds.includes(u.id))
    : await menuImages(sessionId);

  if (wanted.length === 0) {
    throw new Error("No menu photo has been uploaded yet.");
  }

  // Oldest first, so a menu sent across several photos is read in the order the
  // owner sent it and the sections come out in the menu's own order.
  const ordered = [...wanted].reverse();

  const images: InlineImage[] = [];
  for (const upload of ordered) {
    const file = await loadUpload(upload.id);
    if (file) images.push({ mime: file.meta.mime, bytes: file.bytes });
  }

  if (images.length === 0) {
    throw new Error("The uploaded menu photo could not be read back from storage.");
  }

  report({
    label:
      images.length === 1
        ? "Reading your menu"
        : `Reading your menu (${images.length} photos)`,
  });

  const extracted = await generateJson<Extraction>(PROMPT, {
    images,
    // A long menu is genuinely long. 93 items came to roughly 6k tokens, and
    // the failure mode of being a little too small is total, not partial.
    maxOutputTokens: 32_768,
    timeoutMs: 180_000,
    attempts: 3,
  });

  const categories: CatalogCategory[] = (extracted.categories ?? [])
    .filter((category) => category?.name && Array.isArray(category.items))
    .map((category) => ({
      name: String(category.name).trim(),
      items: category.items
        .filter((item) => item?.name)
        .map((item) => ({
          name: String(item.name).trim(),
          ...(typeof item.price === "number" && Number.isFinite(item.price)
            ? { price: item.price }
            : {}),
          ...(item.description ? { description: String(item.description).trim() } : {}),
        })),
    }))
    .filter((category) => category.items.length > 0);

  const tidied = await tidySections(categories, businessName).catch((error: unknown) => {
    // Best effort. A menu with a duplicated section still works.
    trace("menu.tidy_failed", {
      reason: (error as Error).message.replace(/\s+/g, " ").slice(0, 160),
    });
    return categories;
  });

  const total = tidied.reduce((n, c) => n + c.items.length, 0);
  trace("menu.scanned", {
    images: images.length,
    categories: tidied.length,
    items: total,
    currency: extracted.currency ?? null,
  });

  report({ label: `Read ${total} items across ${tidied.length} sections` });

  return {
    categories: tidied,
    currency: extracted.currency ?? null,
    language: extracted.language ?? null,
    unreadable: extracted.unreadable ?? [],
    imagesRead: images.length,
  };
}
