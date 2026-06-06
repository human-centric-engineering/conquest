/**
 * Route-local turn-context loader for the live respondent surface (F6.1, PR4).
 *
 * The session-scoped equivalent of `buildSelectionContext`: it loads a real session's
 * version structure, config, captured answers, and recent transcript from the DB and maps
 * them into the in-memory shape the pure orchestrator reads. The orchestrator core
 * (`lib/app/questionnaire/orchestrator/**`) stays Prisma-free; this is its DB seam.
 *
 * Unlike the F4.1 preview builder (which takes an answered-set in the request body), this
 * reads `answered`/`existingAnswers` from real `AppAnswerSlot` rows and `recentMessages`
 * from prior `AppQuestionnaireTurn` rows, and surfaces the **active question** (the slot the
 * previous turn asked for) so extraction knows what's being answered. The route adds the
 * per-turn `userMessage` + resolved `flags` to finish the {@link TurnState}.
 */

import { prisma } from '@/lib/db/client';
import {
  ANSWER_PROVENANCES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  QUESTION_TYPES,
  narrowToEnum,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { toConfigView, CONFIG_SELECT } from '@/app/api/v1/app/questionnaires/_lib/detail';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection';
import type { ExistingAnswerView, TurnState } from '@/lib/app/questionnaire/orchestrator';

/** How many prior turns of transcript to feed the capabilities (oldest → newest). */
const RECENT_TURNS_WINDOW = 12;

/** A slot projected into the richer shape the P4 capabilities read (incl. type config). */
export interface CapabilitySlotView {
  id: string;
  key: string;
  sectionId: string;
  prompt: string;
  type: QuestionType;
  required: boolean;
  typeConfig?: unknown;
  guidelines?: string;
}

/** The structural half of a turn — everything but the per-turn `userMessage` + `flags`. */
export type TurnContextBase = Omit<TurnState, 'userMessage' | 'flags'>;

/** What {@link buildTurnContext} resolves for one live turn. */
export interface LoadedTurnContext {
  session: { id: string; status: string; versionId: string; respondentUserId: string | null };
  base: TurnContextBase;
  /** Richer slot views for the capability args (the orchestrator only needs QuestionView). */
  slots: CapabilitySlotView[];
  /** The slot `key` the previous turn asked for — extraction's active question (if any). */
  activeQuestionKey: string | null;
  /** `id → QuestionView` for response enrichment without re-querying. */
  byId: Map<string, QuestionView>;
}

function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/**
 * Load the turn context for a session, or `null` if the session doesn't exist. Maps the
 * persisted version structure + answers + recent turns into the orchestrator's shapes.
 */
export async function buildTurnContext(sessionId: string): Promise<LoadedTurnContext | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      versionId: true,
      respondentUserId: true,
      version: {
        select: {
          config: { select: CONFIG_SELECT },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              ordinal: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: {
                  id: true,
                  key: true,
                  ordinal: true,
                  weight: true,
                  required: true,
                  type: true,
                  prompt: true,
                  guidelines: true,
                  typeConfig: true,
                  tags: { select: { tagId: true } },
                },
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
          questionSlot: { select: { id: true, key: true } },
        },
      },
      turns: {
        orderBy: { ordinal: 'desc' },
        take: RECENT_TURNS_WINDOW,
        select: { userMessage: true, agentResponse: true, targetedQuestionId: true, ordinal: true },
      },
    },
  });
  if (!session) return null;

  const questions: QuestionView[] = [];
  const slots: CapabilitySlotView[] = [];
  for (const section of session.version.sections) {
    for (const slot of section.questions) {
      questions.push({
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        sectionOrdinal: section.ordinal,
        ordinal: slot.ordinal,
        weight: slot.weight,
        required: slot.required,
        type: asQuestionType(slot.type),
        tagIds: slot.tags.map((t) => t.tagId),
        prompt: slot.prompt,
      });
      slots.push({
        id: slot.id,
        key: slot.key,
        sectionId: section.id,
        prompt: slot.prompt,
        type: asQuestionType(slot.type),
        required: slot.required,
        ...(slot.typeConfig !== null ? { typeConfig: slot.typeConfig } : {}),
        ...(slot.guidelines !== null ? { guidelines: slot.guidelines } : {}),
      });
    }
  }

  // Coverage view (questionId + confidence) and the richer value view (for refinement).
  const answered: AnsweredView[] = [];
  const existingAnswers: ExistingAnswerView[] = [];
  for (const a of session.answers) {
    answered.push({ questionId: a.questionSlot.id, confidence: a.confidence });
    existingAnswers.push({
      slotKey: a.questionSlot.key,
      value: a.value,
      provenance: narrowToEnum(a.provenanceLabel, ANSWER_PROVENANCES, 'direct'),
      ...(a.confidence !== null ? { confidence: a.confidence } : {}),
      ...(a.rationale !== null ? { rationale: a.rationale } : {}),
    });
  }

  // Recent transcript oldest → newest: the rows came newest-first, so reverse, then
  // interleave each turn's user message and agent reply.
  const recentMessages: string[] = [];
  for (const turn of [...session.turns].reverse()) {
    if (turn.userMessage.trim().length > 0) recentMessages.push(turn.userMessage);
    if (turn.agentResponse.trim().length > 0) recentMessages.push(turn.agentResponse);
  }

  // The active question is whatever the most recent turn asked for (newest-first → [0]).
  const lastTargetedId = session.turns[0]?.targetedQuestionId ?? null;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const activeQuestionKey = lastTargetedId ? (byId.get(lastTargetedId)?.key ?? null) : null;

  const { saved: _saved, ...config } = toConfigView(session.version.config);
  void _saved;

  return {
    session: {
      id: session.id,
      status: session.status,
      versionId: session.versionId,
      respondentUserId: session.respondentUserId,
    },
    base: {
      sessionId: session.id,
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...config },
      questions,
      answered,
      existingAnswers,
      recentMessages,
      // Monotonic per-turn counter (the engine contract selection-context.ts calls out):
      // the number of turns already taken, so a presented-but-unanswered question isn't re-picked.
      selectionRound: session.turns.length,
    },
    slots,
    activeQuestionKey,
    byId,
  };
}
