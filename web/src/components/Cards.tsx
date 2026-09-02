import type { Card, Palette } from "../lib/chat.ts";

/**
 * Chat cards.
 *
 * These are the preview: instead of a live app pane, every proposal the
 * assistant makes is rendered inline where it was made, so the decision and the
 * thing being decided sit together.
 */
export function CardView({ card, onReply }: { card: Card; onReply: (text: string) => void }) {
  switch (card.kind) {
    case "palette":
      return <PaletteCard options={card.options} onReply={onReply} />;
    case "logo":
      return <LogoCard options={card.options} onReply={onReply} />;
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
  }
}

function PaletteCard({
  options,
  onReply,
}: {
  options: Palette[];
  onReply: (text: string) => void;
}) {
  return (
    <div className="card-block">
      <div className="palette-grid">
        {options.map((p, i) => (
          <button
            key={i}
            type="button"
            className="palette"
            onClick={() => onReply(`I'll take ${p.name ?? `option ${i + 1}`} (${p.brand}).`)}
          >
            <div className="swatches">
              <span style={{ background: p.brand }} />
              <span style={{ background: p.surface }} />
              <span style={{ background: p.onSurface }} />
              <span style={{ background: p.border }} />
            </div>
            <div className="palette-preview" style={{ background: p.surface, color: p.onSurface }}>
              <strong>Aa</strong>
              <span className="pill" style={{ background: p.brand, color: p.onBrand }}>
                Order now
              </span>
            </div>
            <span className="palette-name">{p.name ?? `Option ${i + 1}`}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LogoCard({ options, onReply }: { options: string[]; onReply: (text: string) => void }) {
  return (
    <div className="card-block">
      <div className="logo-grid">
        {options.map((url, i) => (
          <button key={url} type="button" className="logo" onClick={() => onReply(`Use logo ${i + 1}.`)}>
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
      <p className="muted small">{rows.length} items</p>
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
    <div className="card-block">
      <p className="card-title">
        <span className={`chip chip-${status}`}>
          {status === "running" ? "Working" : status === "success" ? "Done" : "Failed"}
        </span>
        {label}
      </p>
      {log && <pre className="log">{log}</pre>}
    </div>
  );
}
