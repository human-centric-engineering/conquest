/**
 * Zod validators for inspector dumps.
 *
 * The turn evaluator judges a `TurnInspectorData` dump. That dump arrives from two boundaries:
 * the live drawer POSTs it (untrusted client data) and the saved-trace re-evaluation reads it back
 * from `AppQuestionnaireTurn.inspectorCalls` (persisted JSON, structurally untrusted at the read
 * seam). Both validate against the SAME schema here so the two paths can't drift, and so a malformed
 * or oversized dump is rejected before it reaches the prompt builder.
 *
 * Pure: Zod only, mirrors the `AgentCallTrace` / `InspectorMessage` / `TurnInspectorData` types.
 */

import { z } from 'zod';

/** Upper bound on calls per turn — caps a runaway/garbled dump without constraining a real turn. */
export const MAX_EVALUATED_CALLS = 40;

/** One captured prompt message — mirrors `InspectorMessage`. */
export const inspectorMessageSchema = z.object({
  role: z.string().max(50),
  content: z.string().max(100_000),
});

/** One agent/LLM/embedding call trace — mirrors `AgentCallTrace`. */
export const agentCallTraceSchema = z.object({
  kind: z.enum(['llm', 'embedding']).optional(),
  label: z.string().min(1).max(200),
  model: z.string().max(200),
  provider: z.string().max(200),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  dimensions: z.number().int().nonnegative().optional(),
  prompt: z.array(inspectorMessageSchema).max(50),
  response: z.string().max(200_000),
});

/** A whole turn dump — `{ turnIndex, calls }`, mirroring `TurnInspectorData`. */
export const inspectorTurnSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  calls: z.array(agentCallTraceSchema).min(1).max(MAX_EVALUATED_CALLS),
});
