import { one, query } from "../db/index.ts";
import { emptyFacts, type OnboardingFacts } from "./state.ts";

/**
 * The structured record of what onboarding has learned.
 *
 * Kept in its own table rather than inside the LangGraph checkpoint: the
 * assembly step, the UI and any later support query all need to read it without
 * deserializing an agent checkpoint, and it must survive a prompt or graph
 * rewrite.
 */

/**
 * Fills in anything a stored record predates.
 *
 * The facts are one JSONB blob, so a row written before a field existed comes
 * back without it — and the tools reach straight into nested objects
 * (`facts.artwork.logoOptions.push(...)`). Merging against the empty shape on
 * every read means a schema addition can never turn an in-flight conversation
 * into a TypeError halfway through.
 */
function withDefaults(stored: Partial<OnboardingFacts> | null): OnboardingFacts {
  const base = emptyFacts();
  if (!stored) return base;

  return {
    ...base,
    ...stored,
    business: { ...base.business, ...stored.business },
    brand: { ...base.brand, ...stored.brand },
    artwork: { ...base.artwork, ...stored.artwork },
    catalog: { ...base.catalog, ...stored.catalog },
    locations: { ...base.locations, ...stored.locations },
  };
}

export async function loadFacts(sessionId: number): Promise<OnboardingFacts> {
  const row = await one<{ facts: OnboardingFacts }>(
    "SELECT facts FROM onboarding_facts WHERE session_id = $1",
    [sessionId],
  );
  return withDefaults(row?.facts ?? null);
}

export async function saveFacts(
  sessionId: number,
  facts: OnboardingFacts,
): Promise<void> {
  await query(
    `INSERT INTO onboarding_facts (session_id, facts)
     VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE
        SET facts = EXCLUDED.facts, updated_at = now()`,
    [sessionId, JSON.stringify(facts)],
  );
}

/** Read-modify-write helper for the tools. */
export async function mutateFacts(
  sessionId: number,
  mutate: (facts: OnboardingFacts) => void,
): Promise<OnboardingFacts> {
  const facts = await loadFacts(sessionId);
  mutate(facts);
  await saveFacts(sessionId, facts);
  return facts;
}
