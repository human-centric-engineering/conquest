/**
 * Zod contract for the scope-structure DTO judges read (F17.21).
 *
 * Single source of truth for the shape of {@link ScopeStructureInput}, shared by two consumers so
 * they can't drift: the `evaluate-scope` capability validates its `structure` arg with it, and the
 * route-local loader (`_lib/scope-evaluation-structure.ts`) builds a value already conforming to it.
 *
 * Pure: Zod only, keyed off the real scope vocabularies from `scope/types.ts`. No Prisma / Next.
 */

import { z } from 'zod';

import {
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_OPERATORS,
  TOPIC_DEPTHS,
  TOPIC_PHASES,
} from '@/lib/app/questionnaire/scope/types';
import type { ScopeStructureInput } from '@/lib/app/questionnaire/scope-evaluation/types';

/** Caps on a serialised scope config — generous for a real instrument, bounded against abuse. */
export const MAX_SCOPE_EVAL_TOPICS = 200;
export const MAX_SCOPE_EVAL_MEMBERS_PER_TOPIC = 500;
export const MAX_SCOPE_EVAL_RULES = 200;
export const MAX_SCOPE_EVAL_ISSUES = 200;

export const scopeStructureTopicSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  phase: z.enum(TOPIC_PHASES),
  criteria: z.string().nullable(),
  depth: z.enum(TOPIC_DEPTHS),
  members: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .max(MAX_SCOPE_EVAL_MEMBERS_PER_TOPIC),
});

export const scopeStructureRuleSchema = z.object({
  id: z.string().min(1),
  sentence: z.string(),
  dataSlotKey: z.string(),
  topicKey: z.string(),
  operator: z.enum(SCOPE_RULE_OPERATORS),
  action: z.enum(SCOPE_RULE_ACTIONS),
});

export const scopeStructureSettingsSchema = z.object({
  maxConditionalTopics: z.number(),
  includeCheckTopic: z.boolean(),
  fallbackTopicKeys: z.array(z.string()),
  minConfidence: z.number(),
  plannerInstructions: z.string(),
  sessionBudgetSeconds: z.number(),
  limitOpeningProbes: z.boolean(),
  maxOpeningProbes: z.number(),
});

export const scopeStructureCostsSchema = z.object({
  budgetSeconds: z.number(),
  alwaysSeconds: z.number(),
  routedAllowanceSeconds: z.number(),
  perTopic: z.array(
    z.object({ key: z.string(), fullSeconds: z.number(), lightSeconds: z.number() })
  ),
});

export const scopeStructureIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  topicKey: z.string().optional(),
});

/**
 * The full scope-structure DTO. The `satisfies z.ZodType<ScopeStructureInput>` clause enforces that
 * this schema and the hand-written {@link ScopeStructureInput} interface (in `types.ts`, kept
 * Zod-free so the pure prompt builder can import it) stay aligned in BOTH directions.
 */
export const scopeStructureSchema = z.object({
  topics: z.array(scopeStructureTopicSchema).max(MAX_SCOPE_EVAL_TOPICS),
  rules: z.array(scopeStructureRuleSchema).max(MAX_SCOPE_EVAL_RULES),
  settings: scopeStructureSettingsSchema,
  costs: scopeStructureCostsSchema,
  knownIssues: z.array(scopeStructureIssueSchema).max(MAX_SCOPE_EVAL_ISSUES),
}) satisfies z.ZodType<ScopeStructureInput>;
