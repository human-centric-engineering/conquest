/**
 * Transcript replay loader for the respondent chat surface (F7.1 — resume).
 *
 * Rebuilds a session's rendered transcript from its persisted {@link AppQuestionnaireTurn} rows
 * so a resumed surface shows the conversation it left off in — including the per-turn side-band
 * notices (seriousness / support / contradiction) the turn surfaced, which were previously
 * transient and lost on the next input or a reload. Ordinal-ordered; the opening kickoff turn
 * (empty `userMessage`) contributes only its assistant message, matching how the live loop
 * renders it.
 *
 * The `warnings` JSON is validated at this boundary (untyped `Json` from Prisma) and fails soft
 * to "no notices" if a row is somehow malformed — a replayed transcript must never throw.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import type { QuestionnaireTurn } from '@/lib/app/questionnaire/chat/types';
import { REASONING_STEP_KINDS, REASONING_TONES } from '@/lib/app/questionnaire/reasoning';
import { ANSWER_PROVENANCES } from '@/lib/app/questionnaire/types';

/** Persisted per-turn notices — `{ code, message }[]`; anything malformed degrades to `[]`. */
const warningsSchema = z
  .array(z.object({ code: z.string(), message: z.string(), detail: z.string().optional() }))
  .catch([]);

/**
 * Persisted per-turn reasoning trace — validated at this boundary (untyped `Json` from Prisma) and
 * failing soft to "no trace" if a row is malformed. Mirrors {@link warningsSchema}; the enums keep
 * the replayed steps in lockstep with the live wire shape (`parse-session-event.ts`).
 */
const reasoningSchema = z
  .array(
    z.object({
      kind: z.enum(REASONING_STEP_KINDS),
      label: z.string(),
      tone: z.enum(REASONING_TONES),
      detail: z.string().optional(),
      rationale: z.string().optional(),
      sourceQuote: z.string().optional(),
      confidence: z.number().optional(),
      provenance: z.enum(ANSWER_PROVENANCES).optional(),
    })
  )
  .catch([]);

/**
 * Build the rendered transcript for a session from its turn rows, newest last. Each turn yields
 * an optional user bubble (skipped for the empty-message kickoff turn) followed by the assistant
 * reply, with any persisted notices attached so the surface replays them inline beneath the turn.
 */
export async function loadTranscript(sessionId: string): Promise<QuestionnaireTurn[]> {
  const rows = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId },
    orderBy: { ordinal: 'asc' },
    select: { userMessage: true, agentResponse: true, warnings: true, reasoning: true },
  });

  const turns: QuestionnaireTurn[] = [];
  for (const row of rows) {
    if (row.userMessage.trim().length > 0) {
      turns.push({ role: 'user', content: row.userMessage });
    }
    const warnings = warningsSchema.parse(row.warnings);
    const reasoning = reasoningSchema.parse(row.reasoning);
    turns.push({
      role: 'assistant',
      content: row.agentResponse,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
    });
  }
  return turns;
}
