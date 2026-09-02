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

export interface CatalogDraft {
  categories: Array<{ name: string; items: Array<{ name: string; price?: number; description?: string }> }>;
  source?: "site" | "upload" | "chat";
}

export interface BranchDraft {
  name: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  coverage?: Array<{ area: string; price: number }>;
}

export interface OnboardingFacts {
  business: BusinessFacts;
  brand: {
    logoUrl?: string;
    palette?: Palette;
    suggestions: Palette[];
  };
  catalog: CatalogDraft;
  locations: { branches: BranchDraft[] };
  appId?: number;
  packageName?: string;
  phase: Phase;
}

export const emptyFacts = (): OnboardingFacts => ({
  business: {},
  brand: { suggestions: [] },
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
  | { kind: "progress"; label: string; status: "running" | "success" | "failed"; log?: string }
  | { kind: "link"; label: string; href: string };
