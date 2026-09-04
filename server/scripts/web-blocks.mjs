/**
 * Regenerates the list of blocks the Next storefront can render.
 *
 * ComponentRenderer returns null for a name it has no component for, so a block
 * the web cannot draw does not error — it silently disappears. Onboarding was
 * therefore switching on features whose blocks the web app has never had, and
 * telling the owner they were on.
 *
 *   node scripts/web-blocks.mjs [path-to-mobstep_web_next]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] ?? join(process.env["HOME"] ?? "", "Projects/mobstep_web_next");
const out = join(
  process.env["HOME"] ?? "",
  "Projects/mobstep_drupal/modules/custom/apps/data/web_blocks.json",
);

const files = (await readdir(join(root, "src/blocks")))
  .filter((f) => f.endsWith(".js"))
  .map((f) => f.replace(/\.js$/, ""));

const mapper = await readFile(join(root, "src/utils/componentMapper.js"), "utf8");
const registered = files.filter((b) => new RegExp(`\\b${b}\\b`).test(mapper)).sort();

const existing = JSON.parse(await readFile(out, "utf8"));
await writeFile(out, `${JSON.stringify({ ...existing, count: registered.length, blocks: registered }, null, 2)}\n`);
console.log(`${files.length} block files, ${registered.length} registered -> ${out}`);
