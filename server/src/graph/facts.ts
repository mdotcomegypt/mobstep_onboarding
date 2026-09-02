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

export async function loadFacts(sessionId: number): Promise<OnboardingFacts> {
  const row = await one<{ facts: OnboardingFacts }>(
    "SELECT facts FROM onboarding_facts WHERE session_id = $1",
    [sessionId],
  );
  return row?.facts ?? emptyFacts();
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
