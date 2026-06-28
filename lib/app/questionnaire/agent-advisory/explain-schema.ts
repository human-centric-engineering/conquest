/**
 * Schema for the "Explain with AI" structured output (the hybrid layer of the
 * Agent Settings Evaluation surface).
 *
 * The deterministic engine gives the baseline recommendation + rationale; this
 * adds an on-demand LLM explanation for one agent: a plain-language `narrative`
 * and an optional `suggestion` — a small patch the operator can apply. The patch
 * only targets the four tunable per-agent fields; the value is validated loosely
 * here (bounds) and authoritatively by the agent PATCH endpoint when applied.
 *
 * Pure Zod — no Prisma / Next / LLM imports.
 */

import { z } from 'zod';

/** Slug of the seeded agent whose binding powers the "Explain with AI" calls. */
export const AGENT_SETTINGS_ADVISOR_SLUG = 'app-agent-settings-advisor';

export const EXPLAIN_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export interface AgentSettingsSuggestion {
  model: string | null;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: (typeof EXPLAIN_REASONING_EFFORTS)[number] | null;
  rationale: string;
}

export interface AgentSettingsExplanation {
  narrative: string;
  /** Null when the AI judges the current settings already sound. */
  suggestion: AgentSettingsSuggestion | null;
}

const suggestionSchema = z.object({
  model: z.string().min(1).max(100).nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxTokens: z.number().int().min(1).max(200000).nullable().default(null),
  reasoningEffort: z.enum(EXPLAIN_REASONING_EFFORTS).nullable().default(null),
  rationale: z.string().min(1).max(2000),
});

const explanationSchema = z.object({
  narrative: z.string().min(1).max(4000),
  suggestion: suggestionSchema.nullable().default(null),
});

/**
 * Parse + normalise the model's explanation JSON. Returns `null` on a structural
 * mismatch (so `runStructuredCompletion` retries once). A suggestion whose patch
 * has no actionable field (all four null) is collapsed to `null` — prose-only
 * advice belongs in the narrative.
 */
export function validateAgentSettingsExplanation(parsed: unknown): AgentSettingsExplanation | null {
  const result = explanationSchema.safeParse(parsed);
  if (!result.success) return null;

  const { narrative, suggestion } = result.data;
  if (
    suggestion &&
    suggestion.model === null &&
    suggestion.temperature === null &&
    suggestion.maxTokens === null &&
    suggestion.reasoningEffort === null
  ) {
    return { narrative, suggestion: null };
  }
  return { narrative, suggestion };
}
