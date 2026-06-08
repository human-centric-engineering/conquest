/**
 * Record-level result export — DB read seam (F8.2).
 *
 * Loads a version's **completed, non-preview** sessions in the analytics window into the
 * pure {@link ResultsExportModel} the serialisers consume. Built on the same scope the
 * F8.1 analytics endpoints take (date window + optional tag filter), so an export
 * mirrors exactly what the admin is viewing. A batched cousin of the single-session PDF
 * loader (`questionnaire-sessions/_lib/session-export.ts`): same anonymous-mode stance,
 * many sessions at once, no per-session identity lookup (no N+1).
 *
 * Anonymous mode (`AppQuestionnaireConfig.anonymousMode`): respondent identity is never
 * queried, and every session's `turns` is dropped to `[]` — raw respondent prose never
 * reaches the export. Both honoured here, at the data boundary, not just the UI.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  ANSWER_PROVENANCES,
  QUESTION_TYPES,
  SESSION_STATUSES,
  narrowToEnum,
  type AnswerProvenance,
  type QuestionType,
  type SessionStatus,
} from '@/lib/app/questionnaire/types';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics';
import type {
  ExportAnswer,
  ExportQuestion,
  ExportSession,
  ExportTurn,
  ResultsExportModel,
} from '@/lib/app/questionnaire/export/results-types';

/** Cap completed sessions per export to bound memory; `capped` flags an over-cap match. */
export const MAX_EXPORT_SESSIONS = 5000;

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/**
 * Load the completed-session results for a version's export. Returns null when the
 * version doesn't exist (the route already 404s via `loadScopedVersion`, but the loader
 * stays self-contained for its own metadata).
 */
export async function loadResultsExport(scope: AnalyticsScope): Promise<ResultsExportModel | null> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  // 1. Version header metadata + the anonymous-mode flag.
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: scope.versionId },
    select: {
      versionNumber: true,
      config: { select: { anonymousMode: true } },
      questionnaire: { select: { title: true } },
    },
  });
  if (!version) return null;
  const anonymous = version.config?.anonymousMode ?? false;

  // 2. The version's question slots (optionally tag-filtered), in display order.
  const slots = await prisma.appQuestionSlot.findMany({
    where: {
      versionId: scope.versionId,
      ...(scope.tagIds.length > 0 ? { tags: { some: { tagId: { in: scope.tagIds } } } } : {}),
    },
    select: {
      id: true,
      key: true,
      prompt: true,
      type: true,
      required: true,
      section: { select: { title: true } },
    },
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
  });

  const questions: ExportQuestion[] = slots.map((slot) => ({
    questionId: slot.id,
    key: slot.key,
    prompt: slot.prompt,
    type: narrowToEnum<QuestionType>(slot.type, QUESTION_TYPES, 'free_text'),
    sectionTitle: slot.section.title,
    required: slot.required,
  }));

  // 3. Completed, non-preview sessions in the window — chronological, capped.
  const where = {
    versionId: scope.versionId,
    isPreview: false,
    status: 'completed' as const,
    createdAt: { gte: scope.from, lt: scope.to },
  };
  const [rows, totalMatching] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: MAX_EXPORT_SESSIONS,
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        respondentUserId: true,
        answers: {
          select: {
            value: true,
            confidence: true,
            provenanceLabel: true,
            provenanceItems: true,
            rationale: true,
            refinementHistory: true,
            lastUpdatedTurnId: true,
            questionSlot: { select: { key: true } },
          },
        },
        // Loaded unconditionally so answers can resolve their capturing-turn ordinal,
        // but the prose fields are dropped from the *output* in anonymous mode (below)
        // — raw respondent messages never leave the server.
        turns: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            ordinal: true,
            userMessage: true,
            agentResponse: true,
            targetedQuestionId: true,
            toolCalls: true,
            sideEffectAnswerIds: true,
            costUsd: true,
            createdAt: true,
          },
        },
        events: {
          where: { toStatus: 'completed' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    }),
    prisma.appQuestionnaireSession.count({ where }),
  ]);

  const capped = totalMatching > MAX_EXPORT_SESSIONS;
  if (capped) {
    logger.warn('Questionnaire results export capped', {
      versionId: scope.versionId,
      totalMatching,
      cap: MAX_EXPORT_SESSIONS,
    });
  }

  // 4. Batch-resolve respondent names — one query, only when not anonymous.
  const nameById = new Map<string, string | null>();
  if (!anonymous) {
    const ids = [
      ...new Set(rows.map((r) => r.respondentUserId).filter((id): id is string => !!id)),
    ];
    if (ids.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      for (const u of users) nameById.set(u.id, u.name ?? null);
    }
  }

  const sessions: ExportSession[] = rows.map((row) => {
    const turnOrdinal = new Map(row.turns.map((t) => [t.id, t.ordinal]));

    const answers: ExportAnswer[] = row.answers.map((a) => ({
      questionKey: a.questionSlot.key,
      value: a.value,
      confidence: a.confidence,
      provenanceLabel: narrowToEnum<AnswerProvenance>(
        a.provenanceLabel,
        ANSWER_PROVENANCES,
        'direct'
      ),
      provenanceItems: a.provenanceItems ?? null,
      rationale: a.rationale,
      refinementHistory: asRefinementHistory(a.refinementHistory),
      lastUpdatedTurnOrdinal:
        a.lastUpdatedTurnId != null ? (turnOrdinal.get(a.lastUpdatedTurnId) ?? null) : null,
    }));

    const turns: ExportTurn[] = anonymous
      ? []
      : row.turns.map((t) => ({
          ordinal: t.ordinal,
          userMessage: t.userMessage,
          agentResponse: t.agentResponse,
          targetedQuestionId: t.targetedQuestionId,
          toolCalls: t.toolCalls,
          sideEffectAnswerIds: t.sideEffectAnswerIds,
          costUsd: t.costUsd,
          createdAt: t.createdAt.toISOString(),
        }));

    const status = narrowToEnum<SessionStatus>(row.status, SESSION_STATUSES, 'completed');
    const completedAt = row.events[0]?.createdAt.toISOString() ?? row.updatedAt.toISOString();
    const respondentName =
      anonymous || !row.respondentUserId ? null : (nameById.get(row.respondentUserId) ?? null);

    return {
      id: row.id,
      status,
      createdAt: row.createdAt.toISOString(),
      completedAt,
      respondentName,
      answers,
      turns,
    };
  });

  return {
    versionId: scope.versionId,
    versionNumber: version.versionNumber,
    questionnaireTitle: version.questionnaire.title,
    range,
    anonymous,
    capped,
    questions,
    sessions,
  };
}
