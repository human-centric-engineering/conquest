/**
 * Scoring computation (report kind `cohort`, F14.4) — the I/O layer around the pure {@link scoreSession}.
 *
 * Loads a version's scoring inputs (the numeric bounds per question key, used for reverse-scoring and
 * for C8's common ruler) and a set of sessions' numeric answers, then scores each session. Used two ways: by the cohort
 * dataset to aggregate scores per segment (in-memory, no side effects), and by the recompute path to
 * persist `AppRespondentScore` rows for reuse. Server-side (touches Prisma).
 */

import { prisma } from '@/lib/db/client';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { scoreSession, type ItemBounds } from '@/lib/app/questionnaire/scoring/score';
import { narrowAdaptiveScopeSettings } from '@/lib/app/questionnaire/scope/types';
import { buildSessionScope } from '@/app/api/v1/app/questionnaires/_lib/session-scope';
import type { RespondentScores, ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';
import type { Prisma } from '@prisma/client';

/** Version-level scoring inputs: the keys' numeric bounds + the id→key maps, computed once. */
export interface ScoringInputs {
  /** Min/max per question key, for reverse-scoring and (under `normalise`) the common ruler. */
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

/**
 * Read a question's numeric bounds from its stored typeConfig, or null when it has none.
 *
 * Two types can supply them. A `likert` always can — bounds are the type. A `numeric` can only when
 * the author set both ends, which is optional on that type: an unbounded "how many reps?" has no
 * ruler to be placed on, and inventing one would be worse than admitting it.
 *
 * `matrix` is deliberately absent despite carrying a shared scale at `typeConfig.scale`. A matrix
 * answer is a composite object (`{ rowKey: point }`), which {@link asFiniteNumber} rejects, so a
 * matrix item contributes nothing to a scale today whether or not it has bounds. Returning bounds
 * for one would imply a capability that does not exist.
 */
export function itemBounds(type: string, typeConfig: unknown): ItemBounds | null {
  if (type !== 'likert' && type !== 'numeric') return null;
  const parsed = typeConfigSchemaFor(type).safeParse(typeConfig ?? {});
  if (!parsed.success) return null;
  const cfg = parsed.data as { min?: number; max?: number } | null;
  if (!cfg || typeof cfg.min !== 'number' || typeof cfg.max !== 'number') return null;
  if (cfg.max <= cfg.min) return null;
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
    const b = itemBounds(s.type, s.typeConfig);
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

  // Adaptive Scope (P17): which items each session's interview actually covered. Only fetched when
  // at least one of these sessions runs on a version that opted in — on a fresh install that is
  // never, so the common path costs one cheap query and no scope resolution at all.
  const inScopeBySession = await loadInScopeRefs(sessionIds);

  for (const sessionId of sessionIds) {
    const scores = scoreSession(
      schema,
      get(sessionId),
      inputs.bounds,
      inScopeBySession.get(sessionId) ?? null
    );
    if (Object.keys(scores).length > 0) out.set(sessionId, scores);
  }
  return out;
}

/**
 * The item refs each session's interview covered — question keys and data-slot keys in one set,
 * because a scoring item's `ref` addresses either.
 *
 * Absent from the map means "everything was asked", which is the answer for every session on a
 * version that never opted into Adaptive Scope — and, deliberately, for one whose scope resolved
 * inert. Resolving scope is per session because the plan is; the settings are resolved once per
 * version so a cohort of hundreds on one instrument does not re-narrow the same blob each time.
 *
 * A session with no plan on an ENABLED version is not "everything was asked": it is the pre-planner
 * state, where only the always-run phases are in scope. `buildSessionScope` already models that, so
 * this passes the null plan through rather than special-casing it into full scope.
 */
async function loadInScopeRefs(sessionIds: string[]): Promise<Map<string, ReadonlySet<string>>> {
  const out = new Map<string, ReadonlySet<string>>();
  if (sessionIds.length === 0) return out;

  const sessions = await prisma.appQuestionnaireSession.findMany({
    where: { id: { in: sessionIds } },
    select: {
      id: true,
      versionId: true,
      interviewPlan: true,
      version: { select: { config: { select: { adaptiveScope: true } } } },
    },
  });
  if (sessions.length === 0) return out;

  const settingsByVersion = new Map<string, ReturnType<typeof narrowAdaptiveScopeSettings>>();
  for (const session of sessions) {
    if (!settingsByVersion.has(session.versionId)) {
      settingsByVersion.set(
        session.versionId,
        narrowAdaptiveScopeSettings(session.version.config?.adaptiveScope)
      );
    }
  }

  for (const session of sessions) {
    const settings = settingsByVersion.get(session.versionId);
    if (!settings?.enabled) continue;
    const { scope } = await buildSessionScope(prisma, {
      versionId: session.versionId,
      settings,
      interviewPlan: session.interviewPlan,
    });
    if (!scope.active) continue;
    out.set(session.id, new Set([...scope.questionKeys, ...scope.dataSlotKeys]));
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
