import type { PreviewFacts } from "../lib/chat.ts";

/**
 * A live mock of the app being built.
 *
 * This is the "step preview": rather than describing decisions in prose, it
 * renders them — the chosen brand colour on a real button, the logo in a real
 * header, the extracted menu as real rows. Each answer visibly changes the
 * thing being built, which is the only honest way to show progress.
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
  const brand = facts?.palette?.brand ?? "#0075ff";
  const onBrand = facts?.palette?.onBrand ?? "#ffffff";
  const surface = facts?.palette?.surface ?? "#ffffff";
  const onSurface = facts?.palette?.onSurface ?? "#232323";
  const border = facts?.palette?.border ?? "#e9edf2";

  const categories = facts?.categories ?? [];
  const items = categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.name })));
  const totalItems = categories.reduce((n, c) => n + c.total, 0);

  return (
    <aside className="preview" aria-label="Preview of your app">
      <div className="preview-head">
        <span className="preview-label">Your app</span>
        {totalItems > 0 && (
          <span className="preview-count">
            {totalItems} item{totalItems === 1 ? "" : "s"}
          </span>
        )}
        {/* Phones only: closing belongs on the sheet, not on a pill floating
            over the conversation behind it. */}
        {onClose && (
          <button type="button" className="preview-close" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        )}
      </div>

      <div className="phone">
        <div className="phone-screen" style={{ background: surface, color: onSurface }}>
          <div className="phone-status">
            <span>9:41</span>
            <span className="phone-status-icons">▪ ▪ ▮</span>
          </div>

          <header className="phone-header" style={{ background: brand, color: onBrand }}>
            {facts?.logoUrl ? (
              <img className="phone-logo" src={facts.logoUrl} alt="" />
            ) : (
              <span className="phone-logo phone-logo--empty" aria-hidden="true" />
            )}
            <span className="phone-name">{facts?.name ?? "Your store"}</span>
          </header>

          {categories.length > 0 && (
            <nav className="phone-tabs" style={{ borderColor: border }}>
              {categories.slice(0, 3).map((c, i) => (
                <span
                  key={c.name}
                  className="phone-tab"
                  style={
                    i === 0
                      ? { color: brand, borderBottomColor: brand }
                      : { color: onSurface, opacity: 0.5 }
                  }
                >
                  {c.name}
                </span>
              ))}
            </nav>
          )}

          <div className="phone-body">
            {items.length > 0
              ? items.slice(0, 4).map((item, i) => (
                  <div key={i} className="phone-item" style={{ borderColor: border }}>
                    <span className="phone-thumb" style={{ background: border }} />
                    <span className="phone-item-text">
                      <b>{item.name}</b>
                      {item.price !== null && <i>{item.price}</i>}
                    </span>
                  </div>
                ))
              : [0, 1, 2].map((i) => (
                  <div key={i} className="phone-item is-empty" style={{ borderColor: border }}>
                    <span className="phone-thumb" style={{ background: border }} />
                    <span className="phone-item-text">
                      <b style={{ background: border }} />
                      <i style={{ background: border }} />
                    </span>
                  </div>
                ))}
          </div>

          <div className="phone-cta" style={{ background: brand, color: onBrand }}>
            {facts?.categories?.length ? "Order now" : " "}
          </div>
        </div>
      </div>

      <dl className="preview-facts">
        <Fact label="Name" value={facts?.name} />
        <Fact label="Type" value={facts?.type} />
        <Fact label="Colours" value={facts?.palette ? facts.palette.brand : null} swatch={facts?.palette?.brand} />
        <Fact label="Logo" value={facts?.logoUrl ? "Chosen" : null} />
        <Fact label="Menu" value={totalItems ? `${categories.length} categories` : null} />
        <Fact label="Locations" value={facts?.branches ? String(facts.branches) : null} />
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
  swatch?: string;
}) {
  return (
    <div className={`fact${value ? " is-set" : ""}`}>
      <dt>{label}</dt>
      <dd>
        {swatch && value && <span className="fact-swatch" style={{ background: swatch }} />}
        {value ?? "—"}
      </dd>
    </div>
  );
}
