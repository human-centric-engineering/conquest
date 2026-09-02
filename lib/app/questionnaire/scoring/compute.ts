/**
 * Scoring computation (report kind `cohort`, F14.4) — the I/O layer around the pure {@link scoreSession}.
 *
 * Loads a version's scoring inputs (the numeric bounds per question key, used for reverse-scoring and
 * for C8's common ruler) and a set of sessions' numeric answers, then scores each session. Used two ways: by the cohort
 * dataset to aggregate scores per segment (in-memory, no side effects), and by the recompute path to
 * persist `AppRespondentScore` rows for reuse. Server-side (touches Prisma).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { scoreSession, type ItemBounds } from '@/lib/app/questionnaire/scoring/score';
import { narrowScoringSchemaContent } from '@/lib/app/questionnaire/scoring/schema-validation';
import { narrowConditionalTopicsSettings, type Topic } from '@/lib/app/questionnaire/scope/types';
import { buildSessionScope } from '@/app/api/v1/app/questionnaires/_lib/session-scope';
import { toTopic, TOPIC_SELECT } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
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

/**
 * A version's scoring schema, narrowed — or null when it has none.
 *
 * A one-query read given its own name because two callers outside the scoring pipeline now need it
 * for a reason that has nothing to do with computing a score: the Conditional Topics comparability
 * checks (F17.15) ask which scales routing can leave partially assessed, and the Topics tab and the
 * launch gate must ask it the same way or they will disagree about whether a version is coherent.
 */
export async function loadScoringSchemaContent(
  versionId: string
): Promise<ScoringSchemaContent | null> {
  const row = await prisma.appScoringSchema.findUnique({
    where: { versionId },
    select: { content: true },
  });
  return row ? narrowScoringSchemaContent(row.content) : null;
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

  // Conditional Topics (P17): which items each session's interview actually covered. Only fetched when
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
 * version that never opted into Conditional Topics — and, deliberately, for one whose scope resolved
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
      earlySeatedTopics: true,
      version: { select: { config: { select: { conditionalTopics: true } } } },
    },
  });
  if (sessions.length === 0) return out;

  const settingsByVersion = new Map<string, ReturnType<typeof narrowConditionalTopicsSettings>>();
  for (const session of sessions) {
    if (!settingsByVersion.has(session.versionId)) {
      settingsByVersion.set(
        session.versionId,
        narrowConditionalTopicsSettings(session.version.config?.conditionalTopics)
      );
    }
  }

  // Topics and item weights belong to the VERSION, not the session, so a cohort of hundreds on one
  // instrument reads them once. Only the plan is per session. Without this the loop below fired one
  // topic query — and, for a version with a light-depth topic, two weight queries — per respondent.
  const perVersion = new Map<
    string,
    {
      topics: Topic[];
      weightByQuestionKey: ReadonlyMap<string, number>;
      weightByDataSlotKey: ReadonlyMap<string, number>;
    }
  >();
  for (const [versionId, settings] of settingsByVersion) {
    if (!settings.enabled) continue;
    const [topicRows, questionWeights, dataSlotWeights] = await Promise.all([
      prisma.appQuestionnaireTopic.findMany({
        where: { versionId },
        orderBy: { ordinal: 'asc' },
        select: TOPIC_SELECT,
      }),
      prisma.appQuestionSlot.findMany({
        where: { versionId },
        select: { key: true, weight: true },
      }),
      prisma.appDataSlot.findMany({ where: { versionId }, select: { key: true, weight: true } }),
    ]);
    perVersion.set(versionId, {
      topics: topicRows.map(toTopic),
      weightByQuestionKey: new Map(questionWeights.map((q) => [q.key, q.weight])),
      weightByDataSlotKey: new Map(dataSlotWeights.map((d) => [d.key, d.weight])),
    });
  }

  for (const session of sessions) {
    const settings = settingsByVersion.get(session.versionId);
    if (!settings?.enabled) continue;
    const cached = perVersion.get(session.versionId);
    if (!cached) continue;
    const { scope } = await buildSessionScope(prisma, {
      versionId: session.versionId,
      settings,
      interviewPlan: session.interviewPlan,
      earlySeatedTopics: session.earlySeatedTopics,
      topics: cached.topics,
      weightByQuestionKey: cached.weightByQuestionKey,
      weightByDataSlotKey: cached.weightByDataSlotKey,
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

  // A recompute can change an ALREADY-PUBLISHED number, and it is triggered by any schema save —
  // including one that touched an unrelated scale. `itemBounds` accepting a bounded `numeric` (C8)
  // is exactly such a case: an item carrying `reverse: true` on a numeric question was silently
  // never reversed before, and is reversed now, so its stored score moves with no authoring action
  // aimed at it. The new value is the correct one; the old silence was the defect. What was missing
  // is anyone being told, so read the prior rows and say plainly which sessions moved.
  const previous = await prisma.appRespondentScore.findMany({
    where: { schemaId, sessionId: { in: [...scored.keys()] } },
    select: { sessionId: true, scores: true },
  });
  const priorRawBySession = new Map<string, Record<string, number>>();
  for (const row of previous) {
    const raws: Record<string, number> = {};
    const stored = row.scores as unknown;
    if (stored && typeof stored === 'object') {
      for (const [scaleKey, value] of Object.entries(stored as Record<string, unknown>)) {
        const raw = (value as { raw?: unknown } | null)?.raw;
        if (typeof raw === 'number') raws[scaleKey] = raw;
      }
    }
    priorRawBySession.set(row.sessionId, raws);
  }

  const movedSessionIds: string[] = [];
  for (const [sessionId, scores] of scored) {
    const prior = priorRawBySession.get(sessionId);
    if (prior) {
      const scaleKeys = new Set([...Object.keys(prior), ...Object.keys(scores)]);
      for (const scaleKey of scaleKeys) {
        if (prior[scaleKey] !== scores[scaleKey]?.raw) {
          movedSessionIds.push(sessionId);
          break;
        }
      }
    }
    await prisma.appRespondentScore.upsert({
      where: { sessionId_schemaId: { sessionId, schemaId } },
      create: { sessionId, schemaId, scores: scores as unknown as Prisma.InputJsonValue },
      update: { scores: scores as unknown as Prisma.InputJsonValue },
    });
  }

  if (movedSessionIds.length > 0) {
    logger.warn('scoring: recompute changed already-stored respondent scores', {
      versionId,
      schemaId,
      changedSessionCount: movedSessionIds.length,
      totalScoredCount: scored.size,
      sessionIds: movedSessionIds.slice(0, 20),
    });
  }
  return scored.size;
}
