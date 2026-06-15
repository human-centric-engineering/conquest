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
  ANSWER_PROVENANCES,
  ANSWER_SLOT_PANEL_SCOPES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  SESSION_STATUSES,
  narrowToEnum,
  type AnswerProvenance,
  type AnswerSlotPanelScope,
} from '@/lib/app/questionnaire/types';
import {
  buildAnswerPanelView,
  blendedProgressPercent,
  type PanelAnswerInput,
  type PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type {
  AnswerPanelView,
  DataSlotFillHistoryEntry,
  DataSlotPanelGroup,
  PanelRefinementEntry,
} from '@/lib/app/questionnaire/panel/types';
import { DATA_SLOT_FILLED_THRESHOLD } from '@/lib/app/questionnaire/orchestrator';

/** What the route needs: access fields + the rendered panel view. */
export interface LoadedAnswerPanel {
  session: { id: string; respondentUserId: string | null };
  view: AnswerPanelView;
}

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/** Cast a data-slot fill's stored `refinementHistory` Json column back to its entry array. */
function asDataSlotHistory(value: unknown): DataSlotFillHistoryEntry[] {
  return Array.isArray(value) ? (value as DataSlotFillHistoryEntry[]) : [];
}

/** Narrow a stored `provenanceLabel` (free String column) to the provenance enum, or null. */
function asProvenance(value: string | null | undefined): AnswerProvenance | null {
  return value != null && (ANSWER_PROVENANCES as readonly string[]).includes(value)
    ? (value as AnswerProvenance)
    : null;
}

/** Narrow a stored `answerSlotPanelScope` to the enum (default when unknown/absent). */
function asPanelScope(value: string | null | undefined): AnswerSlotPanelScope {
  return value != null && (ANSWER_SLOT_PANEL_SCOPES as readonly string[]).includes(value)
    ? (value as AnswerSlotPanelScope)
    : DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope;
}

/**
 * Load a session's answer-panel state. `null` when the session doesn't exist. When
 * `dataSlotMode` is on, the view's `dataSlotGroups` carries the themed data-slot rows (the
 * respondent-facing abstraction layer) and `answeredCount`/`totalCount` track the background
 * questions; the question section rows are suppressed (the respondent never sees raw answers).
 */
export async function loadAnswerPanelState(
  sessionId: string,
  dataSlotMode = false,
  forForm = false
): Promise<LoadedAnswerPanel | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      version: {
        select: {
          config: { select: { answerSlotPanelScope: true } },
          // Data Slots feature: the version's data slots (rendered when dataSlotMode).
          dataSlots: {
            orderBy: { ordinal: 'asc' },
            select: { id: true, key: true, name: true, description: true, theme: true },
          },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: { key: true, prompt: true, type: true, typeConfig: true, required: true },
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
      // Data Slots feature: the session's fills (the respondent-facing capture). `refinementHistory`
      // carries prior values when the respondent changed their answer, surfaced as "Earlier: …".
      dataSlotFills: {
        select: {
          dataSlotId: true,
          paraphrase: true,
          provenanceLabel: true,
          confidence: true,
          rationale: true,
          provisional: true,
          refinementHistory: true,
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
      typeConfig: q.typeConfig,
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

  // The raw form (P-presentation) always needs the WHOLE structure: every question,
  // answered or not, so it can render and let the respondent edit. `answerSlotPanelScope`
  // is a CHAT-panel setting (it may hide pending prompts there) and must not gate the form
  // — so the form view forces `full_progress` regardless of the version's scope.
  const view = buildAnswerPanelView({
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    scope: forForm ? 'full_progress' : asPanelScope(row.version.config?.answerSlotPanelScope),
    sections,
    answers,
  });

  // Data Slots feature: when in data-slot mode, replace the question rows with themed data-slot
  // groups (paraphrase + confidence). The header/progress keep tracking the BACKGROUND questions
  // — the respondent sees the abstraction layer, never the raw question answers.
  // The form surface is always question-based (P-presentation): even when data slots are on,
  // it edits the underlying questions directly, so it keeps the question sections and never
  // swaps in the data-slot groups. The chat panel still shows the data-slot abstraction.
  if (!forForm && dataSlotMode && row.version.dataSlots.length > 0) {
    const fillByDataSlotId = new Map(
      row.dataSlotFills.map((f) => [
        f.dataSlotId,
        {
          paraphrase: f.paraphrase,
          // The stored column is a free String; narrow to the provenance enum (null when unrecognised).
          provenance: asProvenance(f.provenanceLabel),
          confidence: f.confidence,
          rationale: f.rationale,
          provisional: f.provisional,
          history: asDataSlotHistory(f.refinementHistory),
        },
      ])
    );
    const groups: DataSlotPanelGroup[] = [];
    const byTheme = new Map<string, DataSlotPanelGroup>();
    let filledDataSlots = 0;
    for (const ds of row.version.dataSlots) {
      const fill = fillByDataSlotId.get(ds.id);
      // A slot is covered at a confident fill OR when parked with a provisional best-effort one
      // (the respondent sees forward progress; the marker flags it as tentative).
      const provisional = fill?.provisional ?? false;
      const filled = (fill?.confidence ?? 0) >= DATA_SLOT_FILLED_THRESHOLD || provisional;
      if (filled) filledDataSlots += 1;
      let group = byTheme.get(ds.theme);
      if (!group) {
        group = { theme: ds.theme, slots: [] };
        byTheme.set(ds.theme, group);
        groups.push(group);
      }
      group.slots.push({
        key: ds.key,
        name: ds.name,
        description: ds.description,
        paraphrase: fill?.paraphrase ?? null,
        provenance: fill?.provenance ?? null,
        confidence: fill?.confidence ?? null,
        rationale: fill?.rationale ?? null,
        filled,
        provisional,
        // Prior values, oldest first (only present once the answer changed at least once).
        history: (fill?.history ?? []).map((h) => ({
          paraphrase: h.previousParaphrase,
          confidence: h.previousConfidence,
        })),
      });
    }
    view.dataSlotGroups = groups;
    // Balanced progress: blend the background question coverage (answeredCount/totalCount, already
    // computed by the pure builder) with the data-slot coverage into one percentage. Data-slot mode
    // shows this — never the raw question count, which would leak the structure the respondent
    // never sees.
    view.progressPercent = blendedProgressPercent({
      answeredQuestions: view.answeredCount,
      totalQuestions: view.totalCount,
      filledDataSlots,
      totalDataSlots: row.version.dataSlots.length,
    });
    // Question rows are suppressed in data-slot mode; the header/progress use the blended percent.
    view.sections = [];
  }

  return { session: { id: row.id, respondentUserId: row.respondentUserId }, view };
}
