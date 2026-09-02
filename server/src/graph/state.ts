/**
 * The shared state the onboarding agents read and write.
 *
 * Phase 3 builds the graph itself; this is the contract the routes, the client
 * cards and the tools all agree on, so it lands first.
 */

export type Phase =
  | "discovery"
  | "branding"
  | "catalog"
  | "locations"
  | "assembly"
  | "build"
  | "done";

export interface Palette {
  brand: string;
  onBrand: string;
  surface: string;
  onSurface: string;
  border: string;
  accent?: string;
}

export interface BusinessFacts {
  name?: string;
  type?: string;
  description?: string;
  website?: string;
  socials?: string[];
  country?: string;
  city?: string;
  currency?: string;
  languages?: string[];
}

export interface CatalogItem {
  name: string;
  price?: number;
  description?: string;
  /** A generated photograph, when this item got one. */
  imageUrl?: string;
}

export interface CatalogCategory {
  name: string;
  /** A generated icon, in the brand colour. */
  iconUrl?: string;
  items: CatalogItem[];
}

export interface CatalogDraft {
  categories: CatalogCategory[];
  source?: "site" | "upload" | "chat";
}

export interface BranchDraft {
  name: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  coverage?: Array<{ area: string; price: number }>;
}

/**
 * Everything the app is dressed in.
 *
 * Kept beside the catalog rather than inside it because the placeholder belongs
 * to the app as a whole, and because assembly needs to hand Drupal a single
 * answer to "what image does an item with no image get".
 */
export interface Artwork {
  /** Stands in for every item without a photograph of its own. */
  placeholderUrl?: string;
  /** Generated logo candidates, most recent last. */
  logoOptions: string[];
}

export interface OnboardingFacts {
  business: BusinessFacts;
  brand: {
    logoUrl?: string;
    palette?: Palette;
    suggestions: Palette[];
  };
  artwork: Artwork;
  catalog: CatalogDraft;
  locations: { branches: BranchDraft[] };
  appId?: number;
  packageName?: string;
  /** Chosen template id, or null once the owner has settled on the default. */
  themeId?: number | null;
  phase: Phase;
}

export const emptyFacts = (): OnboardingFacts => ({
  business: {},
  brand: { suggestions: [] },
  artwork: { logoOptions: [] },
  catalog: { categories: [] },
  locations: { branches: [] },
  phase: "discovery",
});

/**
 * Structured messages the chat renders as cards.
 *
 * This is what replaces a live app-preview pane: the preview is part of the
 * conversation, so every proposal the agent makes is reviewable in place.
 */
export type Card =
  | { kind: "text"; text: string }
  | { kind: "palette"; options: Palette[]; chosen?: number }
  | { kind: "logo"; options: string[]; chosen?: number }
  | { kind: "screen_mock"; url: string; caption?: string }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | {
      /** The catalog, drawn as sections with their icons and item counts. */
      kind: "catalog";
      title: string;
      currency?: string;
      placeholderUrl?: string;
      categories: Array<{
        name: string;
        iconUrl?: string;
        items: Array<{ name: string; price?: number; imageUrl?: string }>;
      }>;
    }
  | {
      /** A generated set: icons, item photographs, logo candidates. */
      kind: "gallery";
      title: string;
      caption?: string;
      images: Array<{ url: string; label?: string; shape?: "icon" | "photo" | "tile" }>;
    }
  | { kind: "progress"; label: string; status: "running" | "success" | "failed"; log?: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "attachment"; url: string; filename: string; mime: string }
  | {
      kind: "themes";
      options: Array<{
        id: number;
        name: string;
        description: string;
        business: string;
        screenshots: string[];
      }>;
    };
