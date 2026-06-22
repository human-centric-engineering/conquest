/**
 * Scoring computation (report kind `cohort`, F14.4) — the I/O layer around the pure {@link scoreSession}.
 *
 * Loads a version's scoring inputs (the likert bounds per question/data-slot key, for reverse-scoring)
 * and a set of sessions' numeric answers, then scores each session. Used two ways: by the cohort
 * dataset to aggregate scores per segment (in-memory, no side effects), and by the recompute path to
 * persist `AppRespondentScore` rows for reuse. Server-side (touches Prisma).
 */

import { prisma } from '@/lib/db/client';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { scoreSession, type ItemBounds } from '@/lib/app/questionnaire/scoring/score';
import type { RespondentScores, ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';
import type { Prisma } from '@prisma/client';

/** Version-level scoring inputs: the keys' numeric bounds + the id→key maps, computed once. */
export interface ScoringInputs {
  /** Likert min/max per question/data-slot key, for reverse-scoring. */
  bounds: Map<string, ItemBounds>;
  /** questionSlot.id → key. */
  questionKeyById: Map<string, string>;
  /** dataSlot.id → key. */
  dataSlotKeyById: Map<string, string>;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read a question's likert bounds from its stored typeConfig, or null when not a bounded likert. */
function likertBounds(type: string, typeConfig: unknown): ItemBounds | null {
  if (type !== 'likert') return null;
  const parsed = typeConfigSchemaFor('likert').safeParse(typeConfig);
  if (!parsed.success) return null;
  const cfg = parsed.data as { min?: number; max?: number };
  if (typeof cfg.min !== 'number' || typeof cfg.max !== 'number') return null;
  return { min: cfg.min, max: cfg.max };
}

/** Build the version-level scoring inputs (bounds + id→key maps). */
export async function buildScoringInputs(versionId: string): Promise<ScoringInputs> {
  const [slots, dataSlots] = await Promise.all([
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      select: { id: true, key: true, type: true, typeConfig: true },
    }),
    prisma.appDataSlot.findMany({ where: { versionId }, select: { id: true, key: true } }),
  ]);

  const bounds = new Map<string, ItemBounds>();
  const questionKeyById = new Map<string, string>();
  for (const s of slots) {
    questionKeyById.set(s.id, s.key);
    const b = likertBounds(s.type, s.typeConfig);
    if (b) bounds.set(s.key, b);
  }
  const dataSlotKeyById = new Map<string, string>();
  for (const d of dataSlots) dataSlotKeyById.set(d.id, d.key);

  return { bounds, questionKeyById, dataSlotKeyById };
}

/**
 * Score a set of sessions against a schema, in memory. Returns a sessionId → scores map for sessions
 * that produced at least one scale. No persistence.
 */
export async function scoreSessions(
  schema: ScoringSchemaContent,
  sessionIds: string[],
  inputs: ScoringInputs
): Promise<Map<string, RespondentScores>> {
  const out = new Map<string, RespondentScores>();
  if (sessionIds.length === 0 || schema.items.length === 0) return out;

  const [answers, fills] = await Promise.all([
    prisma.appAnswerSlot.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, questionSlotId: true, value: true },
    }),
    prisma.appDataSlotFill.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, dataSlotId: true, value: true },
    }),
  ]);

  // Per-session answer map keyed by item ref (question key or data-slot key).
  const bySession = new Map<string, Map<string, number>>();
  const get = (id: string): Map<string, number> => {
    let m = bySession.get(id);
    if (!m) {
      m = new Map();
      bySession.set(id, m);
    }
    return m;
  };
  for (const a of answers) {
    const key = inputs.questionKeyById.get(a.questionSlotId);
    const num = asFiniteNumber(a.value);
    if (key && num !== null) get(a.sessionId).set(key, num);
  }
  for (const f of fills) {
    const key = inputs.dataSlotKeyById.get(f.dataSlotId);
    const num = asFiniteNumber(f.value);
    if (key && num !== null) get(f.sessionId).set(key, num);
  }

  for (const sessionId of sessionIds) {
    const scores = scoreSession(schema, get(sessionId), inputs.bounds);
    if (Object.keys(scores).length > 0) out.set(sessionId, scores);
  }
  return out;
}

/**
 * Recompute + persist `AppRespondentScore` rows for a set of sessions (e.g. after a schema save).
 * Upserts one row per (session, schema). Returns the number of sessions scored.
 */
export async function recomputeSessionScores(params: {
  versionId: string;
  schemaId: string;
  schema: ScoringSchemaContent;
  sessionIds: string[];
}): Promise<number> {
  const { versionId, schemaId, schema, sessionIds } = params;
  const inputs = await buildScoringInputs(versionId);
  const scored = await scoreSessions(schema, sessionIds, inputs);

  for (const [sessionId, scores] of scored) {
    await prisma.appRespondentScore.upsert({
      where: { sessionId_schemaId: { sessionId, schemaId } },
      create: { sessionId, schemaId, scores: scores as unknown as Prisma.InputJsonValue },
      update: { scores: scores as unknown as Prisma.InputJsonValue },
    });
  }
  return scored.size;
}
