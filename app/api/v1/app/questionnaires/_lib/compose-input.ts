/**
 * Request-body schemas for the generative-authoring routes (compose + refine).
 *
 * Boundary validation: every field the admin sends arrives here as untrusted JSON
 * and is parsed with Zod before any handler work (CLAUDE.md: validate at
 * boundaries). The audience shape reuses the extractor's `audienceShapeSchema` so
 * the admin-supplied audience matches the inferred one exactly.
 */

import { z } from 'zod';

import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';

/** Upper bound on the brief — generous for a paragraph or two, not a pasted document. */
export const MAX_BRIEF_CHARS = 5_000;
/** Upper bound on a single refine instruction. */
export const MAX_INSTRUCTION_CHARS = 1_000;

export const composeRequestSchema = z.object({
  /** Plain-English description of the questionnaire to build. */
  brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS),
  /** Optional admin-chosen title (else derived from the inferred goal / a default). */
  title: z.string().trim().min(1).max(200).optional(),
  /** Optional admin-set goal — the composer uses it verbatim and does not infer. */
  goal: z.string().trim().min(1).max(1_000).optional(),
  /** Optional admin-set audience — inference suppressed per supplied field. */
  audience: audienceShapeSchema.optional(),
  /** DEMO-ONLY: attribute the new questionnaire to this demo client. */
  demoClientId: z.string().min(1).optional(),
});

export type ComposeRequest = z.infer<typeof composeRequestSchema>;

export const refineRequestSchema = z.object({
  /** The admin's plain-English refinement instruction for this turn. */
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
});

export type RefineRequest = z.infer<typeof refineRequestSchema>;
