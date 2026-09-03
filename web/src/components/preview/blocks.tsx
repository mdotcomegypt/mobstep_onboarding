import type { ReactNode } from "react";

/**
 * The block registry.
 *
 * Roughly twenty-five of Mobstep's 143 blocks carry visual weight — a logo, a
 * category strip, an offers banner. Those get a drawn view. Everything else
 * gets a labelled chip, and that is not a gap: the core gains blocks faster
 * than this file will, and a block the renderer has never heard of still
 * occupies its slot, in the right order, with its real name on it.
 *
 * Rendering nothing for an unknown block would be the one dishonest option —
 * the owner would see a preview missing something their app actually has.
 */

export interface BlockContext {
  /** Design tokens read off the project, or the palette chosen so far. */
  brand: string;
  onBrand: string;
  surface: string;
  onSurface: string;
  border: string;

  shopName: string;
  logoUrl: string | null;
  currency: string;
  placeholderUrl: string | null;

  categories: Array<{
    name: string;
    iconUrl: string | null;
    items: Array<{ name: string; price: number | null; imageUrl: string | null }>;
  }>;
}

export interface BlockProps {
  ctx: BlockContext;
  label: string;
}

type BlockView = (props: BlockProps) => ReactNode;

const money = (value: number | null, currency: string): string =>
  value === null ? "" : currency ? `${value} ${currency}` : String(value);

// ---------------------------------------------------------------- toolbar

const Logo = ({ ctx }: BlockProps) =>
  ctx.logoUrl ? (
    <img className="pv-logo" src={ctx.logoUrl} alt="" />
  ) : (
    <span className="pv-logo pv-logo-empty" aria-hidden="true" />
  );

const ShopName = ({ ctx }: BlockProps) => <span className="pv-name">{ctx.shopName}</span>;

const MenuIcon = () => <span className="pv-icon pv-burger" aria-hidden="true" />;
const Search = () => <span className="pv-search-icon" aria-hidden="true" />;
const Account = () => <span className="pv-icon pv-round" aria-hidden="true" />;

const ServiceType = ({ ctx }: BlockProps) => (
  <span className="pv-segmented" style={{ borderColor: ctx.border }}>
    <b style={{ background: ctx.brand, color: ctx.onBrand }}>Delivery</b>
    <i>Pickup</i>
  </span>
);

// ---------------------------------------------------------------- header

const OffersBanner = ({ ctx }: BlockProps) => (
  <span className="pv-banner" style={{ background: ctx.brand, color: ctx.onBrand }}>
    <b>20% off</b>
    <i>this week only</i>
  </span>
);

const Alert = ({ ctx }: BlockProps) => (
  <span className="pv-alert" style={{ borderColor: ctx.brand, color: ctx.brand }}>
    Open until 2am tonight
  </span>
);

const BranchPicker = ({ ctx }: BlockProps) => (
  <span className="pv-branch" style={{ borderColor: ctx.border }}>
    <b style={{ color: ctx.brand }}>◉</b> Nasr City
  </span>
);

const SearchBar = ({ ctx }: BlockProps) => (
  <span className="pv-searchbar" style={{ borderColor: ctx.border }}>
    Search the menu…
  </span>
);

// ---------------------------------------------------------------- content

const CategoryStrip = ({ ctx }: BlockProps) => {
  const shown = ctx.categories.length > 0 ? ctx.categories.slice(0, 8) : SKELETON_CATEGORIES;
  return (
    <span className="pv-cats">
      {shown.map((category, i) => (
        <span key={i} className={`pv-cat${category.name ? "" : " is-skeleton"}`}>
          <span className="pv-cat-icon" style={{ borderColor: ctx.border }}>
            {category.iconUrl && <img src={category.iconUrl} alt="" loading="lazy" />}
          </span>
          <span className="pv-cat-name">{category.name}</span>
        </span>
      ))}
    </span>
  );
};

const ItemGrid = ({ ctx }: BlockProps) => {
  const items = ctx.categories.flatMap((c) => c.items).slice(0, 6);
  const shown = items.length > 0 ? items : SKELETON_ITEMS;
  return (
    <span className="pv-grid">
      {shown.map((item, i) => (
        <span
          key={i}
          className={`pv-item${item.name ? "" : " is-skeleton"}`}
          style={{ borderColor: ctx.border }}
        >
          <span className="pv-item-img">
            {(item.imageUrl ?? ctx.placeholderUrl) && (
              <img src={item.imageUrl ?? ctx.placeholderUrl ?? ""} alt="" loading="lazy" />
            )}
          </span>
          <span className="pv-item-name">{item.name}</span>
          <span className="pv-item-price" style={{ color: ctx.brand }}>
            {money(item.price, ctx.currency)}
          </span>
        </span>
      ))}
    </span>
  );
};

const Highlights = ({ ctx }: BlockProps) => {
  const items = ctx.categories.flatMap((c) => c.items).slice(0, 3);
  return (
    <span className="pv-highlights">
      {(items.length > 0 ? items : SKELETON_ITEMS.slice(0, 3)).map((item, i) => (
        <span key={i} className="pv-highlight" style={{ borderColor: ctx.border }}>
          {(item.imageUrl ?? ctx.placeholderUrl) && (
            <img src={item.imageUrl ?? ctx.placeholderUrl ?? ""} alt="" loading="lazy" />
          )}
        </span>
      ))}
    </span>
  );
};

const LoyaltyCard = ({ ctx }: BlockProps) => (
  <span className="pv-loyalty" style={{ background: ctx.brand, color: ctx.onBrand }}>
    <b>240 points</b>
    <i>60 more for a free meal</i>
  </span>
);

const ActiveOrders = ({ ctx }: BlockProps) => (
  <span className="pv-strip" style={{ borderColor: ctx.brand }}>
    <b style={{ color: ctx.brand }}>On its way</b>
    <i>Arriving 8:40</i>
  </span>
);

const OrderRating = ({ ctx }: BlockProps) => (
  <span className="pv-strip" style={{ borderColor: ctx.border }}>
    <b>How was your order?</b>
    <i style={{ color: ctx.brand }}>★★★★★</i>
  </span>
);

// ---------------------------------------------------------------- footer

const CartBar = ({ ctx }: BlockProps) => (
  <span className="pv-cta" style={{ background: ctx.brand, color: ctx.onBrand }}>
    View cart · 2 items
  </span>
);

// ---------------------------------------------------------------- side menu

const MenuRow = (text: string, glyph?: string): BlockView =>
  function Row({ ctx }: BlockProps) {
    return (
      <span className="pv-row">
        <i className="pv-row-dot" style={{ background: ctx.brand }} aria-hidden="true">
          {glyph}
        </i>
        {text}
      </span>
    );
  };

// ---------------------------------------------------------------- registry

export const BLOCK_VIEWS: Record<string, BlockView> = {
  // toolbar
  product_catalog_block_logo: Logo,
  product_catalog_block_title: ShopName,
  product_catalog_block_menu_icon: MenuIcon,
  product_catalog_block_search: Search,
  product_catalog_block_account: Account,
  product_catalog_block_service_type: ServiceType,

  // header
  product_catalog_block_offers: OffersBanner,
  product_catalog_block_alert: Alert,
  product_catalog_block_service_selection: ServiceType,
  product_catalog_block_branch: BranchPicker,

  // content
  product_catalog_block_categories: CategoryStrip,
  product_catalog_block_listing_group: ItemGrid,
  product_catalog_block_search_results: SearchBar,
  product_catalog_block_highlights: Highlights,
  product_catalog_block_loyalty_program: LoyaltyCard,
  product_catalog_block_active_orders: ActiveOrders,
  product_catalog_block_order_rating: OrderRating,

  // footer
  product_catalog_block_cart: CartBar,
  product_catalog_block_add_more: CartBar,

  // side menu — rows, which is what they are on screen
  product_catalog_block_user_account: MenuRow("Your account"),
  product_catalog_block_order_history: MenuRow("Past orders"),
  product_catalog_block_coupons: MenuRow("Discount codes"),
  product_catalog_block_branches: MenuRow("Our branches"),
  product_catalog_block_whatsapp: MenuRow("WhatsApp us"),
  product_catalog_block_contact: MenuRow("Call the shop"),
  product_catalog_block_customer_support: MenuRow("Live chat"),
  product_catalog_block_delivery_information: MenuRow("Delivery areas"),
  product_catalog_block_language_switcher: MenuRow("العربية"),
  product_catalog_block_wallet: MenuRow("Store credit"),
  product_catalog_block_login_logout: MenuRow("Sign out"),
};

/**
 * What a block the registry has no view for looks like.
 *
 * Named, present, and visibly a placeholder. The label comes from the Drupal
 * manifest, so this reads "Delivery information" rather than
 * "product_catalog_block_delivery_information".
 */
export function UnknownBlock({ label }: { label: string }): ReactNode {
  return <span className="pv-unknown">{label}</span>;
}

const SKELETON_CATEGORIES = Array.from({ length: 5 }, () => ({
  name: "",
  iconUrl: null,
  items: [],
}));

const SKELETON_ITEMS = Array.from({ length: 4 }, () => ({
  name: "",
  price: null,
  imageUrl: null,
}));
