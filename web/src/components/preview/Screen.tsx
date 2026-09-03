import type { ReactNode } from "react";
import { BLOCK_VIEWS, UnknownBlock, type BlockContext } from "./blocks.tsx";

/**
 * Renders one screen from its real block configuration.
 *
 * The component boundary is the *position family*, not the position and
 * certainly not the block. Mobstep's 68 positions collapse into six families
 * that repeat across every screen — toolbar, header, content, footer, side
 * menu, overlay — and each family is one component that walks its ordered list.
 *
 * Nothing here holds a list of which blocks exist or an opinion about which are
 * on. It renders what the server says the project contains, which is the whole
 * reason this can stay true as the core changes.
 */

export interface PlacedBlock {
  block: string;
  label: string;
  placed: boolean;
  enabled: boolean;
}

/** position id -> ordered blocks. */
export type ScreenConfig = Record<string, PlacedBlock[]>;

/**
 * Which family a position belongs to.
 *
 * Matched on the position id's tail rather than a lookup table of all 68: the
 * core names them consistently, and a table would need a new row every time a
 * screen gained a slot — which is the drift this whole design avoids.
 */
function familyOf(position: string): Family {
  if (position.includes("overlay") || position.includes("popup")) return "overlay";
  if (position.includes("side_menu")) return "side_menu";
  if (position.includes("toolbar")) return "toolbar";
  if (position.includes("footer")) return "footer";
  if (position.includes("header") || position.includes("featured")) return "header";
  return "content";
}

type Family = "toolbar" | "header" | "content" | "footer" | "side_menu" | "overlay";

/** Families in the order they stack down the screen. */
const ORDER: Family[] = ["toolbar", "header", "content", "footer"];

function Block({ block, ctx }: { block: PlacedBlock; ctx: BlockContext }): ReactNode {
  const View = BLOCK_VIEWS[block.block];
  return View ? <View ctx={ctx} label={block.label} /> : <UnknownBlock label={block.label} />;
}

/**
 * A block renders only when it is both placed and enabled.
 *
 * Exactly the rule the app itself applies. Showing a block that is placed but
 * disabled would make the preview disagree with the thing it is previewing, in
 * the direction that matters least visibly and costs most.
 */
const live = (blocks: PlacedBlock[]): PlacedBlock[] =>
  blocks.filter((b) => b.placed && b.enabled);

export function Screen({
  config,
  ctx,
}: {
  config: ScreenConfig;
  ctx: BlockContext;
}) {
  const families = new Map<Family, PlacedBlock[]>();
  for (const [position, blocks] of Object.entries(config)) {
    const family = familyOf(position);
    families.set(family, [...(families.get(family) ?? []), ...live(blocks)]);
  }

  return (
    <div className="pv-screen" style={{ background: ctx.surface, color: ctx.onSurface }}>
      {ORDER.map((family) => {
        const blocks = families.get(family) ?? [];
        if (blocks.length === 0) return null;
        return (
          <div key={family} className={`pv-family pv-${family}`}>
            {blocks.map((block, i) => (
              <Block key={`${block.block}-${i}`} block={block} ctx={ctx} />
            ))}
          </div>
        );
      })}

      {/* The side menu is a drawer, not a band. Shown as a hint of one so the
          rows the owner just switched on are actually visible somewhere. */}
      {(families.get("side_menu") ?? []).length > 0 && (
        <div className="pv-drawer" style={{ borderColor: ctx.border }}>
          <span className="pv-drawer-label">Side menu</span>
          {(families.get("side_menu") ?? []).slice(0, 7).map((block, i) => (
            <Block key={`${block.block}-${i}`} block={block} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The header bar, which is chrome rather than a block family.
 *
 * Drawn separately because the toolbar's blocks sit *inside* it and take their
 * colour from the brand, not from the page surface.
 */
export function AppBar({ config, ctx }: { config: ScreenConfig; ctx: BlockContext }) {
  const toolbar = Object.entries(config)
    .filter(([position]) => familyOf(position) === "toolbar")
    .flatMap(([, blocks]) => live(blocks));

  return (
    <header className="pv-bar" style={{ background: ctx.brand, color: ctx.onBrand }}>
      {toolbar.length > 0 ? (
        toolbar.map((block, i) => <Block key={`${block.block}-${i}`} block={block} ctx={ctx} />)
      ) : (
        <>
          <span className="pv-logo pv-logo-empty" aria-hidden="true" />
          <span className="pv-name">{ctx.shopName}</span>
        </>
      )}
    </header>
  );
}
