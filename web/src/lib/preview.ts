import type { PlacedBlock } from "../components/preview/Screen.tsx";

/**
 * Reading the app's real configuration.
 *
 * The browser never talks to Drupal — it has no shared secret and must not get
 * one — so this goes through the onboarding server's own /api/preview, which
 * holds the secret and proxies.
 */

export interface LivePreview {
  /** "live" once the project exists on disk; "projected" before that. */
  stage: "live" | "projected";
  appId: number | null;
  live: {
    package: string;
    coreVersion: string;
    features: string[];
    screens: Record<string, Record<string, PlacedBlock[]>>;
    tokens: Record<string, string>;
    strings: Record<string, string>;
  } | null;
  note?: string;
}

export async function loadPreview(): Promise<LivePreview | null> {
  try {
    const response = await fetch("/api/preview", { credentials: "include" });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      stage: "live" | "projected";
      appId: number | null;
      live: {
        package: string;
        core_version: string;
        features: string[];
        screens: Record<string, Record<string, PlacedBlock[]>>;
        tokens: Record<string, string>;
        strings: Record<string, string>;
      } | null;
      note?: string;
    };

    return {
      stage: body.stage,
      appId: body.appId,
      live: body.live
        ? {
            package: body.live.package,
            coreVersion: body.live.core_version,
            features: body.live.features ?? [],
            screens: body.live.screens ?? {},
            tokens: body.live.tokens ?? {},
            strings: body.live.strings ?? {},
          }
        : null,
      ...(body.note ? { note: body.note } : {}),
    };
  } catch {
    // The pane falls back to the projected view, which is still true about
    // everything the conversation has decided.
    return null;
  }
}

export interface FeatureCatalog {
  coreVersion: string | null;
  features: Record<string, { id: string; label: string; blurb: string }>;
  presets: Record<string, string[]>;
}

export async function loadManifest(): Promise<FeatureCatalog | null> {
  try {
    const response = await fetch("/api/manifest", { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json()) as FeatureCatalog;
  } catch {
    return null;
  }
}
