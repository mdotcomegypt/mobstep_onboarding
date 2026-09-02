import { useState } from "react";
import type { Card, CatalogCard, GalleryCard, Palette } from "../lib/chat.ts";

/**
 * Chat cards.
 *
 * These are the preview: instead of a live app pane, every proposal the
 * assistant makes is rendered inline where it was made, so the decision and the
 * thing being decided sit together.
 */
export function CardView({
  card,
  onReply,
  currency = null,
  disabled = false,
}: {
  card: Card;
  onReply: (text: string) => void;
  currency?: string | null;
  disabled?: boolean;
}) {
  switch (card.kind) {
    case "palette":
      return <PaletteCard options={card.options} onReply={onReply} disabled={disabled} />;
    case "logo":
      return <LogoCard options={card.options} onReply={onReply} disabled={disabled} />;
    case "themes":
      return <ThemesCard options={card.options} onReply={onReply} disabled={disabled} />;
    case "catalog":
      return <CatalogView card={card} currency={currency} />;
    case "gallery":
      return <GalleryView card={card} />;
    case "table":
      return <TableCard title={card.title} columns={card.columns} rows={card.rows} />;
    case "progress":
      return <ProgressCard label={card.label} status={card.status} log={card.log} />;
    case "screen_mock":
      return (
        <figure className="card-block">
          <img src={card.url} alt={card.caption ?? "Screen preview"} className="mock" />
          {card.caption && <figcaption>{card.caption}</figcaption>}
        </figure>
      );
    case "link":
      return (
        <a className="card-block link-card" href={card.href} target="_blank" rel="noreferrer">
          {card.label} ↗
        </a>
      );
    case "attachment":
      return card.mime.startsWith("image/") ? (
        <img src={card.url} alt={card.filename} className="sent-image" />
      ) : (
        <span className="file-chip">{card.filename}</span>
      );
  }
}

const money = (value: number | undefined, currency: string | null): string =>
  value === undefined ? "—" : currency ? `${value} ${currency}` : String(value);

/**
 * The catalog, as sections rather than one long table.
 *
 * A real menu is a hundred rows. Rendered flat it is unreadable, and the owner
 * cannot do the one thing they are being asked to do — check it. What they
 * actually verify is that the *sections* are right and that a few prices in
 * each look familiar, so sections lead, collapsed, with their counts. Opening
 * one shows its items.
 */
function CatalogView({ card, currency }: { card: CatalogCard; currency: string | null }) {
  const [open, setOpen] = useState<number | null>(0);
  const unit = card.currency ?? currency;
  const total = card.categories.reduce((n, c) => n + c.items.length, 0);
  const withIcons = card.categories.filter((c) => c.iconUrl).length;

  return (
    <div className="card-block catalog-card">
      <div className="catalog-head">
        <p className="card-title">{card.title}</p>
        <span className="catalog-meta">
          {card.categories.length} sections · {total} items
          {withIcons > 0 && ` · ${withIcons} icons`}
        </span>
      </div>

      <ul className="sections">
        {card.categories.map((category, i) => {
          const isOpen = open === i;
          return (
            <li key={`${category.name}-${i}`} className={isOpen ? "is-open" : ""}>
              <button
                type="button"
                className="section-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <span className="section-icon">
                  {category.iconUrl ? (
                    <img src={category.iconUrl} alt="" loading="lazy" />
                  ) : (
                    <i className="section-icon-empty" aria-hidden="true" />
                  )}
                </span>
                <span className="section-name">{category.name}</span>
                <span className="section-count">{category.items.length}</span>
                <span className="chev" aria-hidden="true" />
              </button>

              {isOpen && (
                <ul className="items">
                  {category.items.map((item, j) => (
                    <li key={`${item.name}-${j}`}>
                      <span className="item-thumb">
                        {(item.imageUrl ?? card.placeholderUrl) && (
                          <img
                            src={item.imageUrl ?? card.placeholderUrl}
                            alt=""
                            loading="lazy"
                            className={item.imageUrl ? "" : "is-placeholder"}
                          />
                        )}
                      </span>
                      <span className="item-name">{item.name}</span>
                      <span className="item-price">{money(item.price, unit)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A generated set: icons, sample photographs, a placeholder. */
function GalleryView({ card }: { card: GalleryCard }) {
  return (
    <div className="card-block gallery-card">
      <p className="card-title">{card.title}</p>
      {card.caption && <p className="card-sub">{card.caption}</p>}
      <div className="gallery">
        {card.images.map((image, i) => (
          <figure key={`${image.url}-${i}`} className={`shot shot-${image.shape ?? "photo"}`}>
            <img src={image.url} alt={image.label ?? ""} loading="lazy" />
            {image.label && <figcaption>{image.label}</figcaption>}
          </figure>
        ))}
      </div>
    </div>
  );
}

function PaletteCard({
  options,
  onReply,
  disabled,
}: {
  options: Palette[];
  onReply: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="card-block">
      <p className="card-title">Pick a colour scheme</p>
      <div className="palette-grid">
        {options.map((p, i) => (
          <button
            key={i}
            type="button"
            className="palette"
            disabled={disabled}
            onClick={() => onReply(`I'll take ${p.name ?? `option ${i + 1}`} (${p.brand}).`)}
          >
            {/* A miniature of the actual app, not a row of swatches. Four
                rectangles tell you nothing about whether the text will be
                readable on the button. */}
            <div className="palette-preview" style={{ background: p.surface, color: p.onSurface }}>
              <span className="pp-bar" style={{ background: p.brand }} />
              <span className="pp-line" style={{ background: p.onSurface, opacity: 0.85 }} />
              <span className="pp-line short" style={{ background: p.border }} />
              <span className="pp-cta" style={{ background: p.brand, color: p.onBrand }}>
                Order now
              </span>
            </div>
            <span className="palette-name">{p.name ?? `Option ${i + 1}`}</span>
            <span className="palette-hex">{p.brand}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemesCard({
  options,
  onReply,
  disabled,
}: {
  options: Array<{
    id: number;
    name: string;
    description: string;
    business: string;
    screenshots: string[];
  }>;
  onReply: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="card-block">
      <p className="card-title">Pick a layout</p>
      <div className="theme-grid">
        {options.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className="theme"
            disabled={disabled}
            onClick={() => onReply(`Use the ${theme.name} layout (theme ${theme.id}).`)}
          >
            <div className="theme-shots">
              {theme.screenshots.length > 0 ? (
                theme.screenshots.map((src) => (
                  <img key={src} src={src} alt={`${theme.name} preview`} loading="lazy" />
                ))
              ) : (
                <span className="theme-noshot">No preview</span>
              )}
            </div>
            <span className="theme-name">{theme.name}</span>
            {theme.business && <span className="theme-business">{theme.business}</span>}
            {theme.description && <span className="theme-desc">{theme.description}</span>}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="link"
        disabled={disabled}
        onClick={() => onReply("Keep the standard layout.")}
      >
        Keep the standard layout
      </button>
    </div>
  );
}

function LogoCard({
  options,
  onReply,
  disabled,
}: {
  options: string[];
  onReply: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="card-block">
      <p className="card-title">{options.length === 1 ? "How's this?" : "Pick a logo"}</p>
      <div className="logo-grid">
        {options.map((url, i) => (
          <button
            key={url}
            type="button"
            className="logo"
            disabled={disabled}
            onClick={() => onReply(`Use this logo: ${url}`)}
          >
            <img src={url} alt={`Logo option ${i + 1}`} loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

function TableCard({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: string[];
  rows: string[][];
}) {
  return (
    <div className="card-block">
      <p className="card-title">{title}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">{rows.length} rows</p>
    </div>
  );
}

function ProgressCard({
  label,
  status,
  log,
}: {
  label: string;
  status: "running" | "success" | "failed";
  log?: string;
}) {
  return (
    <div className={`card-block build-card is-${status}`}>
      <p className="card-title">
        <span className={`chip chip-${status}`}>
          {status === "running" ? "Working" : status === "success" ? "Done" : "Failed"}
        </span>
        {label}
      </p>
      {status === "running" && (
        <div className="activity-bar is-indeterminate">
          <i />
        </div>
      )}
      {log && <pre className="log">{log}</pre>}
    </div>
  );
}
