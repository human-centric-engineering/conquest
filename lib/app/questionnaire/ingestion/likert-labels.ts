/**
 * Likert label backfill — pure helpers (provider-agnostic).
 *
 * Existing likert questions may have a bounded scale but no per-point labels, so the report
 * renders bare numbers. The backfill script (`scripts/migrations/…-backfill-likert-labels.ts`)
 * asks an LLM, per question, to either (a) name every scale point, or (b) declare the scale
 * purely numeric (no qualitative meaning) — in which case the question is reclassified to the
 * `numeric` type rather than given fabricated words. This module owns the prompt, the strict
 * parse of that decision, and a deterministic generic fallback for when the model is unavailable.
 *
 * Pure: no Prisma / provider / Next imports, so it unit-tests in isolation and the one-off script
 * supplies the LLM plumbing.
 */

import { z } from 'zod';

import type { LlmMessage } from '@/lib/orchestration/llm/types';

/**
 * The per-question outcome: label every point, or treat the scale as numeric. `numeric: true`
 * tells the caller to switch the question's `type` to `numeric` (dropping the labels question).
 */
export type LikertLabelDecision = { numeric: true } | { numeric: false; labels: string[] };

/** A canonical low→high intensity vocabulary the generic fallback samples across. */
const INTENSITY_RAMP = [
  'Very low',
  'Low',
  'Below average',
  'Moderate',
  'Above average',
  'High',
  'Very high',
] as const;

/**
 * A deterministic, word-based label set for an `[min, max]` integer scale — the fallback when the
 * LLM can't be reached. Samples {@link INTENSITY_RAMP} evenly across the points (so a 1–5 scale
 * becomes Very low / Low / Moderate / High / Very high). Always returns one label per point.
 */
export function genericLikertLabels(min: number, max: number): string[] {
  const n = max - min + 1;
  if (n <= 1) return [];
  return Array.from({ length: n }, (_, i) => {
    const idx = Math.round((i / (n - 1)) * (INTENSITY_RAMP.length - 1));
    return INTENSITY_RAMP[idx];
  });
}

/**
 * Build the system + user messages that ask the model to label one likert question's scale (or
 * declare it numeric). The contract is a single JSON object — parsed by
 * {@link parseLikertLabelDecision}.
 */
export function buildLikertLabelMessages(question: {
  prompt: string;
  min: number;
  max: number;
}): LlmMessage[] {
  const pointCount = question.max - question.min + 1;
  const system = `You label the points of a rating scale so a questionnaire report can show words \
instead of bare numbers. You are given one question and its integer scale bounds.

Decide ONE of:
- If each point carries a qualitative meaning (agreement, satisfaction, likelihood, frequency, …), \
return {"numeric": false, "labels": [<one short label per point, ordered from min to max>]}. The \
"labels" array MUST have exactly ${pointCount} entries (max − min + 1) and read naturally from the \
low end to the high end, fitting the question's wording.
- If the scale is a purely numeric rating with no qualitative meaning (e.g. a count, an age, a \
score out of N, "rate 0–10"), return {"numeric": true} and omit "labels".

Respond with ONLY the JSON object — no prose, no code fences.`;

  const user = `Question: ${question.prompt}\nScale: integer ${question.min} to ${question.max} (${pointCount} points).`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Strip an optional ```json code fence so a fenced reply still parses. */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/** The model's reply shape — validated with Zod rather than cast (it's external LLM output). */
const labelReplySchema = z.object({
  numeric: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});

/**
 * Parse the model's reply into a {@link LikertLabelDecision}, validated against the scale bounds.
 * Returns `null` for anything malformed (unparseable JSON, wrong label count, blank labels) so the
 * caller can fall back. A `numeric: true` reply needs no labels; otherwise labels must be exactly
 * one non-empty entry per point.
 */
export function parseLikertLabelDecision(
  raw: string,
  bounds: { min: number; max: number }
): LikertLabelDecision | null {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(raw));
  } catch {
    return null;
  }

  const parsed = labelReplySchema.safeParse(json);
  if (!parsed.success) return null;

  if (parsed.data.numeric === true) return { numeric: true };

  const labels = parsed.data.labels;
  const expected = bounds.max - bounds.min + 1;
  if (labels && labels.length === expected && labels.every((l) => l.trim().length > 0)) {
    return { numeric: false, labels: labels.map((l) => l.trim()) };
  }
  return null;
}
