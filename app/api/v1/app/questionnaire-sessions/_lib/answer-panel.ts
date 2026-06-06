/**
 * Answer-slot panel — DB read seam (F7.2).
 *
 * Loads everything the respondent panel needs in ONE query: the session's status +
 * access fields, the version's section/slot structure, the captured answers, and the
 * per-turn ordinals (so an answer's `lastUpdatedTurnId` resolves to a 1-based turn
 * index for click-to-jump). Hands the plain rows to the pure
 * {@link buildAnswerPanelView} for the join + scope filter + count derivation.
 *
 * Returns the `session` access fields (`respondentUserId`) separately from the
 * projected `view`, so the route can run `resolveTurnAccess` without a second query.
 * Returns `null` when the session id doesn't resolve (the route maps that to 404).
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` panel module is Prisma-free.
 */

import { prisma } from '@/lib/db/client';
import {
  ANSWER_SLOT_PANEL_SCOPES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  SESSION_STATUSES,
  narrowToEnum,
  type AnswerSlotPanelScope,
} from '@/lib/app/questionnaire/types';
import {
  buildAnswerPanelView,
  type PanelAnswerInput,
  type PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { AnswerPanelView, PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';

/** What the route needs: access fields + the rendered panel view. */
export interface LoadedAnswerPanel {
  session: { id: string; respondentUserId: string | null };
  view: AnswerPanelView;
}

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/** Narrow a stored `answerSlotPanelScope` to the enum (default when unknown/absent). */
function asPanelScope(value: string | null | undefined): AnswerSlotPanelScope {
  return value != null && (ANSWER_SLOT_PANEL_SCOPES as readonly string[]).includes(value)
    ? (value as AnswerSlotPanelScope)
    : DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope;
}

/**
 * Load a session's answer-panel state. `null` when the session doesn't exist.
 */
export async function loadAnswerPanelState(sessionId: string): Promise<LoadedAnswerPanel | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      version: {
        select: {
          config: { select: { answerSlotPanelScope: true } },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: { key: true, prompt: true, type: true, required: true },
              },
            },
          },
        },
      },
      answers: {
        select: {
          value: true,
          confidence: true,
          provenanceLabel: true,
          rationale: true,
          lastUpdatedTurnId: true,
          refinementHistory: true,
          questionSlot: { select: { key: true } },
        },
      },
      turns: { select: { id: true, ordinal: true } },
    },
  });
  if (!row) return null;

  // Map turn id → 1-based ordinal so an answer's lastUpdatedTurnId becomes a turn index.
  const turnOrdinal = new Map(row.turns.map((t) => [t.id, t.ordinal]));

  const sections: PanelSectionInput[] = row.version.sections.map((s) => ({
    sectionId: s.id,
    title: s.title,
    slots: s.questions.map((q) => ({
      slotKey: q.key,
      prompt: q.prompt,
      type: q.type,
      required: q.required,
    })),
  }));

  const answers: PanelAnswerInput[] = row.answers.map((a) => ({
    slotKey: a.questionSlot.key,
    value: a.value,
    provenance: a.provenanceLabel,
    confidence: a.confidence,
    rationale: a.rationale,
    answeredAtTurnIndex:
      a.lastUpdatedTurnId != null ? (turnOrdinal.get(a.lastUpdatedTurnId) ?? null) : null,
    refinementHistory: asRefinementHistory(a.refinementHistory),
  }));

  const view = buildAnswerPanelView({
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    scope: asPanelScope(row.version.config?.answerSlotPanelScope),
    sections,
    answers,
  });

  return { session: { id: row.id, respondentUserId: row.respondentUserId }, view };
}
