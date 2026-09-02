import type { PreviewFacts } from "../lib/chat.ts";

/**
 * A live mock of the app being built.
 *
 * This is the "step preview": rather than describing decisions in prose, it
 * renders them — the chosen brand colour on a real button, the generated icons
 * on a real category strip, the extracted menu as real rows with the real
 * placeholder behind the items that have no photograph. Each answer visibly
 * changes the thing being built, which is the only honest way to show progress.
 *
 * Empty state matters as much as the filled one: before anything is decided it
 * shows a greyed skeleton, so the owner can see what they are working towards.
 */
export function AppPreview({
  facts,
  onClose,
}: {
  facts: PreviewFacts | null;
  onClose?: () => void;
}) {
  const brand = facts?.palette?.brand ?? "#3d5afe";
  const onBrand = facts?.palette?.onBrand ?? "#ffffff";
  const surface = facts?.palette?.surface ?? "#ffffff";
  const onSurface = facts?.palette?.onSurface ?? "#1a1d23";
  const border = facts?.palette?.border ?? "#e9edf2";

  const categories = facts?.categories ?? [];
  const totalItems = categories.reduce((n, c) => n + c.total, 0);
  const placeholder = facts?.placeholderUrl ?? null;

  // The items shown in the grid, drawn from across the categories so the
  // preview looks like a storefront rather than one section of it.
  const showcase = categories.flatMap((c) =>
    c.items.map((i) => ({ ...i, category: c.name })),
  );

  const currency = facts?.currency ?? "";

  return (
    <aside className="preview" aria-label="Preview of your app">
      <div className="preview-head">
        <span className="preview-label">
          Live preview
          {facts?.appId && <em>#{facts.appId}</em>}
        </span>
        {totalItems > 0 && (
          <span className="preview-count">
            {categories.length} sections · {totalItems} items
          </span>
        )}
        {/* Phones only: closing belongs on the sheet, not on a pill floating
            over the conversation behind it. */}
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

      <div className="phone">
        <span className="phone-notch" aria-hidden="true" />
        <div className="phone-screen" style={{ background: surface, color: onSurface }}>
          <header className="app-bar" style={{ background: brand, color: onBrand }}>
            {facts?.logoUrl ? (
              <img className="app-logo" src={facts.logoUrl} alt="" />
            ) : (
              <span className="app-logo app-logo-empty" aria-hidden="true" />
            )}
            <span className="app-name">{facts?.name ?? "Your shop"}</span>
            <span className="app-cart" aria-hidden="true" />
          </header>

          <div className="app-search" style={{ borderColor: border }}>
            <span style={{ opacity: 0.45 }}>Search the menu…</span>
          </div>

          {/* The category strip is where the generated icons actually land. */}
          <div className="app-cats">
            {(categories.length > 0
              ? categories
              : [{ name: "", iconUrl: null, items: [], total: 0 }, { name: "", iconUrl: null, items: [], total: 0 }, { name: "", iconUrl: null, items: [], total: 0 }]
            )
              .slice(0, 8)
              .map((category, i) => (
                <span key={i} className={`app-cat${category.name ? "" : " is-skeleton"}`}>
                  <span className="app-cat-icon" style={{ borderColor: border }}>
                    {category.iconUrl && <img src={category.iconUrl} alt="" loading="lazy" />}
                  </span>
                  <span className="app-cat-name">{category.name}</span>
                </span>
              ))}
          </div>

          <div className="app-grid">
            {(showcase.length > 0 ? showcase.slice(0, 6) : Array.from({ length: 4 })).map(
              (item, i) => {
                const real = item as { name: string; price: number | null; imageUrl: string | null } | undefined;
                const image = real?.imageUrl ?? placeholder;
                return (
                  <span key={i} className={`app-item${real ? "" : " is-skeleton"}`} style={{ borderColor: border }}>
                    <span className="app-item-img">
                      {image && <img src={image} alt="" loading="lazy" />}
                    </span>
                    <span className="app-item-name">{real?.name ?? ""}</span>
                    <span className="app-item-price" style={{ color: brand }}>
                      {real?.price != null ? `${real.price} ${currency}`.trim() : ""}
                    </span>
                  </span>
                );
              },
            )}
          </div>

          <div className="app-cta" style={{ background: brand, color: onBrand }}>
            Order now
          </div>
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
      </dl>
    </aside>
  );
}

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
