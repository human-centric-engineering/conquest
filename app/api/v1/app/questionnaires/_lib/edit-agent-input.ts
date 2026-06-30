/**
 * Request-body schemas for the Structure Edit Agent routes (plan + apply).
 *
 * Boundary validation: every field arrives as untrusted JSON and is parsed with Zod before any
 * handler work (CLAUDE.md: validate at boundaries). The apply body is a discriminated union on
 * `mode` so precise (an op list) and rewrite (a full structure) can't be confused; the rewrite
 * structure reuses the extractor's `extractionSchema` — the exact contract `replaceVersionStructure`
 * consumes — so a tampered round-trip can't smuggle an off-shape payload into the writer.
 */

import { z } from 'zod';

import { extractionSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import { editOpSchema } from '@/lib/app/questionnaire/edit-agent/edit-ops';

/** Upper bound on a single edit instruction (same order as a refine instruction). */
export const MAX_EDIT_INSTRUCTION_CHARS = 1_000;

export const editPlanRequestSchema = z.object({
  /** The admin's plain-English instruction for the whole questionnaire. */
  instruction: z.string().trim().min(1).max(MAX_EDIT_INSTRUCTION_CHARS),
  /** `precise` (default) → deterministic edit-ops; `rewrite` → whole-doc LLM regenerate. */
  mode: z.enum(['precise', 'rewrite']).default('precise'),
});
export type EditPlanRequest = z.infer<typeof editPlanRequestSchema>;

export const editApplyRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('precise'),
    operations: z.array(editOpSchema).min(1).max(50),
  }),
  z.object({
    mode: z.literal('rewrite'),
    structure: extractionSchema,
  }),
]);
export type EditApplyRequest = z.infer<typeof editApplyRequestSchema>;
