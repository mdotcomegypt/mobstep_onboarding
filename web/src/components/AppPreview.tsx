import { useEffect, useState } from "react";
import type { PreviewFacts } from "../lib/chat.ts";
import { loadPreview, type LivePreview } from "../lib/preview.ts";
import { AppBar, Screen, type ScreenConfig } from "./preview/Screen.tsx";
import type { BlockContext } from "./preview/blocks.tsx";

/**
 * The app being built.
 *
 * Two modes, and it says which one it is in.
 *
 *   Projected  Before assembly there is no project on disk, so there is nothing
 *              real to read. Everything the conversation has settled — the
 *              palette, the icons, the catalog — is drawn against the standard
 *              layout. It is a forecast, and it is labelled as one.
 *
 *   Live       After assembly it renders the project's own blocks.json and
 *              config.xml. A block absent here is absent in the app. This is
 *              what stops the preview drifting from the thing it previews the
 *              moment anyone edits a layout.
 *
 * Saying which is not a detail. A mock that claims to be live is worse than no
 * preview at all, because the owner stops checking.
 */
export function AppPreview({
  facts,
  appId,
  onClose,
}: {
  facts: PreviewFacts | null;
  /** Changes when the app is assembled, which is when a live read starts working. */
  appId: number | null;
  onClose?: () => void;
}) {
  const [live, setLive] = useState<LivePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadPreview();
      if (!cancelled) setLive(result);
    })();
    return () => {
      cancelled = true;
    };
    // Re-read whenever the app is assembled or the catalog changes underneath.
  }, [appId, facts?.categories.length, facts?.placeholderUrl]);

  const tokens = live?.live?.tokens ?? {};

  // The keys are the raw Android resource names — `design_system_brand`, not
  // `brand`. Reading the short form meant this branch never once fired and the
  // pane always fell back to the chosen palette, so a theme that failed to
  // apply still looked applied.
  const token = (name: string): string | undefined => {
    const value = tokens[`design_system_${name}`];
    return value?.startsWith("#") ? value : undefined;
  };

  const ctx: BlockContext = {
    // Live values win: once the app exists, its own colours.xml is the truth,
    // and a palette chosen but not yet applied would be a lie about the build.
    brand: token("brand") ?? facts?.palette?.brand ?? "#3d5afe",
    onBrand: token("on_brand") ?? facts?.palette?.onBrand ?? "#ffffff",
    surface: token("surface") ?? facts?.palette?.surface ?? "#ffffff",
    onSurface: token("on_surface") ?? facts?.palette?.onSurface ?? "#1a1d23",
    border: token("border") ?? facts?.palette?.border ?? "#e9edf2",

    shopName: live?.live?.strings["app_name"] ?? facts?.name ?? "Your shop",
    logoUrl: facts?.logoUrl ?? null,
    currency: facts?.currency ?? "",
    placeholderUrl: facts?.placeholderUrl ?? null,
    categories: (facts?.categories ?? []).map((c) => ({
      name: c.name,
      iconUrl: c.iconUrl,
      items: c.items,
    })),
  };

  const config: ScreenConfig =
    live?.live?.screens["product_catalog"] ?? PROJECTED_HOME;

  const totalItems = (facts?.categories ?? []).reduce((n, c) => n + c.total, 0);

  // Three states, and the pane says which it is in. A mock that claims to be
  // the real thing is worse than no preview, because the owner stops checking.
  const web = live?.web;
  const published = web?.status === "live" && web.url ? web.url : null;
  const mode: "preview" | "publishing" | "live" =
    published ? "live" : web?.status === "publishing" ? "publishing" : "preview";

  return (
    <aside className="preview" aria-label="Preview of your app">
      <div className="preview-head">
        <span className={`preview-label${mode === "live" ? " is-live" : ""}`}>
          {mode === "live" ? (web?.stale ? "Live · updating" : "Live") : mode === "publishing" ? "Publishing…" : "Preview"}
          {appId && <em>#{appId}</em>}
        </span>
        {totalItems > 0 && (
          <span className="preview-count">
            {facts?.categories.length} sections · {totalItems} items
          </span>
        )}
        {onClose && (
          <button
            type="button"
            className="preview-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ✕
          </button>
        )}
      </div>

      <p className="preview-mode">
        {published ? (
          <a href={published} target="_blank" rel="noreferrer">
            {published.replace(/^https:\/\//, "")} ↗
          </a>
        ) : mode === "publishing" ? (
          "Going live now…"
        ) : (
          "What your app will look like. It goes live once it's built."
        )}
      </p>

      <div className="phone">
        <span className="phone-notch" aria-hidden="true" />
        <div className="phone-screen">
          {published ? (
            /* The real shop, not a rendering of one. It already lays itself out
               as a phone column below 451px, and an iframe is the only container
               where that viewport media query resolves against the frame rather
               than the whole browser window. `key` forces a reload when a
               re-publish lands. */
            <iframe
              key={`${published}-${String(web?.stale)}`}
              className="phone-live"
              src={published}
              title="Your live app"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          ) : (
            <>
              <AppBar config={config} ctx={ctx} />
              <Screen config={config} ctx={ctx} />
            </>
          )}
        </div>
      </div>

      <dl className="preview-facts">
        <Fact label="Business" value={facts?.name} />
        <Fact label="Trade" value={facts?.type} />
        <Fact label="Branches" value={facts?.branches ? String(facts.branches) : null} />
        <Fact
          label="Brand"
          value={facts?.palette?.brand ?? null}
          swatch={facts?.palette?.brand ?? null}
        />
        <Fact
          label="Features"
          value={live?.live?.features.length ? String(live.live.features.length) : null}
        />
      </dl>
    </aside>
  );
}

/**
 * The standard layout, as the core ships it.
 *
 * Used only before assembly, and only for the blocks a projection can honestly
 * claim: these are the ones every app gets from the template. It deliberately
 * does not include anything the features step decides — showing a loyalty card
 * before anyone has chosen loyalty would be inventing the answer.
 */
const PROJECTED_HOME: ScreenConfig = {
  product_catalog_layout_toolbar_position_toolbar_start: [
    { block: "product_catalog_block_menu_icon", label: "Menu", placed: true, enabled: true },
  ],
  product_catalog_layout_toolbar_position_toolbar_center: [
    { block: "product_catalog_block_logo", label: "Logo", placed: true, enabled: true },
    { block: "product_catalog_block_title", label: "Shop name", placed: true, enabled: true },
  ],
  product_catalog_layout_toolbar_position_toolbar_end: [
    { block: "product_catalog_block_search", label: "Search", placed: true, enabled: true },
  ],
  product_catalog_layout_content_position_content: [
    { block: "product_catalog_block_categories", label: "Categories", placed: true, enabled: true },
    { block: "product_catalog_block_listing_group", label: "Item list", placed: true, enabled: true },
  ],
  product_catalog_layout_footer_position_footer_center: [
    { block: "product_catalog_block_cart", label: "Cart", placed: true, enabled: true },
  ],
};

function Fact({
  label,
  value,
  swatch,
}: {
  label: string;
  value?: string | null;
  swatch?: string | null;
}) {
  return (
    <div className={`fact${value ? "" : " is-empty"}`}>
      <dt>{label}</dt>
      <dd>
        {swatch && <i className="fact-swatch" style={{ background: swatch }} />}
        {value ?? "—"}
      </dd>
    </div>
  );
}
