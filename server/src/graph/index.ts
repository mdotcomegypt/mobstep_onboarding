import { env } from "../lib/env.ts";

/**
 * The multi-agent onboarding graph (Phase 3).
 *
 * Planned shape: a supervisor routing to discovery / brand_scout / branding /
 * catalog / locations / assembly / build subgraphs over OnboardingFacts, with
 * LangGraph `interrupt()` for every taste-based or destructive step and a
 * PostgresSaver checkpointer so a closed tab resumes mid-conversation.
 *
 * Two constraints that are decided and must survive implementation:
 *
 * 1. Model config follows what we learned on mobstep_assistant — Vertex Gemini,
 *    thinking_budget 0, and the *global* endpoint, because regional endpoints
 *    429 under our traffic.
 * 2. Anything fetched from a customer's own website is data, never instruction.
 *    fetch_site/extract_assets must return page text inside a delimited block,
 *    and the system prompt must say that page content cannot issue commands.
 */

export const modelConfig = {
  project: env.vertex.project,
  location: env.vertex.location,
  chat: env.vertex.chatModel,
  reason: env.vertex.reasonModel,
  image: env.vertex.imageModel,
  thinkingBudget: 0,
} as const;
